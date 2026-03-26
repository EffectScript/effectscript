/**
 * @module type-mapper
 *
 * Maps TypeScript types (from the TS compiler API) to EffectScript's internal
 * {@link Type} representation. Handles primitives, unions, intersections,
 * arrays, tuples, promises, functions, records, generics, enums, and nullable
 * types. Depth-limited (MAX_DEPTH=20) and cycle-safe via memoization and an
 * in-progress set.
 */
import * as ts from 'typescript';
import type {
  Type,
  FunctionType,
  ParamType,
  RecordType,
  LazyRecordType,
  TypeParam,
  NullKind,
  LiteralType,
} from '../checker/types.js';
import { NUM, STR, BOOL, VOID, NEVER, ANY, NULL_TYPE } from '../checker/types.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import type { Span } from '../utils/span.js';

// ── Interfaces ──────────────────────────────────────────────

/**
 * Converts TypeScript compiler API types to EffectScript {@link Type} values.
 */
export interface TypeMapper {
  /**
   * Maps a TS type to an EffectScript type.
   * @param tsType   The TypeScript type to map.
   * @param checker  The TS type checker for resolving symbol information.
   */
  mapType(tsType: ts.Type, checker: ts.TypeChecker): Type;

  /**
   * Extracts the constructor signature from a class type.
   * @returns The constructor as a {@link FunctionType}, or `null` if no public
   *          constructor exists.
   */
  mapConstructor(tsType: ts.Type, checker: ts.TypeChecker): FunctionType | null;
}

// ── Synthetic span for interop diagnostics ──────────────────

/** Placeholder span for diagnostics originating from the type-mapping layer. */
const interopSpan: Span = {
  file: '<interop>',
  start: { offset: 0, line: 0, column: 0 },
  end: { offset: 0, line: 0, column: 0 },
};

// ── Implementation ──────────────────────────────────────────

/**
 * TypeScript compiler API–based implementation of {@link TypeMapper}.
 *
 * Uses memoization (`memo`) to avoid redundant mappings and an `inProgress`
 * set for cycle detection on record types. Recursion is hard-capped at
 * {@link MAX_DEPTH} (20) to prevent stack overflow on deeply nested generics.
 */
export class TsTypeMapper implements TypeMapper {
  private readonly diagnostics: DiagnosticCollector;
  /** Memoized mapping results keyed by TS type identity. */
  private readonly memo = new Map<ts.Type, Type>();
  /** Types currently being mapped — used for cycle detection in record fields. */
  private readonly inProgress = new Set<ts.Type>();
  /** Current recursion depth. */
  private depth = 0;
  /** Maximum recursion depth before bailing to `Any`. */
  private static readonly MAX_DEPTH = 20;
  /**
   * Property count threshold above which record types are resolved lazily.
   * Typical EffectScript records have ~5-15 fields. Large TS interfaces
   * (lodash LoDashStatic ~300, express Request ~50) exceed this threshold
   * and benefit from lazy resolution to avoid OOM.
   */
  private static readonly LAZY_THRESHOLD = 30;

  /** @param diagnostics  Collector for W301 (unsupported type) and W302 (overloaded) warnings. */
  constructor(diagnostics: DiagnosticCollector) {
    this.diagnostics = diagnostics;
  }

  /** @inheritdoc */
  mapType(tsType: ts.Type, checker: ts.TypeChecker): Type {
    return this.doMap(tsType, checker);
  }

  /**
   * Extracts the first public constructor signature from `tsType`.
   * Reports W302 if multiple constructor overloads exist (only the first is used).
   * @returns `null` if no construct signatures exist or the constructor is private.
   */
  mapConstructor(tsType: ts.Type, checker: ts.TypeChecker): FunctionType | null {
    let constructSignatures: readonly ts.Signature[];
    try {
      constructSignatures = tsType.getConstructSignatures();
    } catch {
      return null;
    }
    if (constructSignatures.length === 0) {
      return null;
    }

    const selected = this.selectOverload(constructSignatures);

    // Check for private constructor
    const decl = selected.getDeclaration();
    if (decl) {
      const modifiers = ts.getCombinedModifierFlags(decl as ts.Declaration);
      if (modifiers & ts.ModifierFlags.Private) {
        return null;
      }
    }

    if (constructSignatures.length > 1) {
      this.diagnostics.report({
        severity: 'warning',
        code: D.W302,
        message: `Overloaded constructor has ${constructSignatures.length} signatures; using the most general, ${constructSignatures.length - 1} dropped`,
        span: interopSpan,
      });
    }

    return this.mapSignature(selected, checker);
  }

  /**
   * Core recursive mapping entry point. Checks the memo cache, enforces the
   * depth limit, and detects cycles before delegating to {@link doMapInner}.
   */
  private doMap(tsType: ts.Type, checker: ts.TypeChecker): Type {
    // Check memoization
    const cached = this.memo.get(tsType);
    if (cached !== undefined) {
      return cached;
    }

    // Depth guard
    if (this.depth >= TsTypeMapper.MAX_DEPTH) {
      return ANY;
    }

    // Cycle detection for non-record types
    if (this.inProgress.has(tsType)) {
      return ANY;
    }

    this.depth++;
    try {
      return this.doMapInner(tsType, checker);
    } finally {
      this.depth--;
    }
  }

  /**
   * Dispatches a TS type to the appropriate mapper based on its type flags.
   *
   * Priority order: primitives → literals → bigint/symbol (unsupported) →
   * type parameters → unions → intersections → object types → conditional/
   * indexed/template/substitution → fallback.
   */
  private doMapInner(tsType: ts.Type, checker: ts.TypeChecker): Type {
    const flags = tsType.getFlags();

    // Primitives
    if (flags & ts.TypeFlags.String) return STR;
    if (flags & ts.TypeFlags.Number) return NUM;
    if (flags & ts.TypeFlags.Boolean) return BOOL;
    if (flags & ts.TypeFlags.Void) return VOID;
    if (flags & ts.TypeFlags.Never) return NEVER;
    if (flags & ts.TypeFlags.Null) return NULL_TYPE;
    if (flags & ts.TypeFlags.Undefined) return NULL_TYPE;
    if (flags & ts.TypeFlags.Any) return ANY;
    if (flags & ts.TypeFlags.Unknown) return ANY;

    // String/number/boolean literals → LiteralType
    if (flags & ts.TypeFlags.StringLiteral) {
      const value = (tsType as ts.StringLiteralType).value;
      return { kind: 'literal', base: 'string', value } as LiteralType;
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      const value = (tsType as ts.NumberLiteralType).value;
      return { kind: 'literal', base: 'number', value } as LiteralType;
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      // TS represents true/false as separate boolean literal types
      const intrinsicName = (tsType as unknown as { intrinsicName?: string }).intrinsicName;
      const value = intrinsicName === 'true';
      return { kind: 'literal', base: 'boolean', value } as LiteralType;
    }

    // BigInt, ESSymbol → Any with warning
    if (flags & ts.TypeFlags.BigInt || flags & ts.TypeFlags.BigIntLiteral) {
      this.warnUnsupported('bigint');
      return ANY;
    }
    if (flags & ts.TypeFlags.ESSymbol || flags & ts.TypeFlags.UniqueESSymbol) {
      this.warnUnsupported('symbol');
      return ANY;
    }

    // Type parameters → GenericType
    if (flags & ts.TypeFlags.TypeParameter) {
      const symbol = tsType.getSymbol();
      const name = symbol ? symbol.getName() : 'T';
      return { kind: 'generic', name };
    }

    // Union types (including boolean which TS represents as true|false union)
    if (tsType.isUnion()) {
      return this.mapUnion(tsType as ts.UnionType, checker);
    }

    // Intersection types
    if (tsType.isIntersection()) {
      return this.mapIntersection(tsType as ts.IntersectionType, checker);
    }

    // Object types (arrays, tuples, functions, classes, interfaces, Promise)
    if (flags & ts.TypeFlags.Object) {
      return this.mapObject(tsType as ts.ObjectType, checker);
    }

    // Conditional type → Any
    if (flags & ts.TypeFlags.Conditional) {
      this.warnUnsupported('conditional type');
      return ANY;
    }

    // Index / IndexedAccess → Any
    if (flags & ts.TypeFlags.Index || flags & ts.TypeFlags.IndexedAccess) {
      this.warnUnsupported('indexed access type');
      return ANY;
    }

    // TemplateLiteral → string
    if (flags & ts.TypeFlags.TemplateLiteral) {
      return STR;
    }

    // Substitution → Any
    if (flags & ts.TypeFlags.Substitution) {
      this.warnUnsupported('substitution type');
      return ANY;
    }

    // Fallback
    this.warnUnsupported(`type with flags ${flags}`);
    return ANY;
  }

  /**
   * Maps a TS union type. Separates null/undefined members from the rest,
   * wraps the non-nullish part in a `nullable` type when appropriate, and
   * collapses boolean literal unions into a single `boolean`.
   */
  private mapUnion(tsType: ts.UnionType, checker: ts.TypeChecker): Type {
    const members = tsType.types;
    const nullish: ts.Type[] = [];
    const rest: ts.Type[] = [];

    for (const member of members) {
      const f = member.getFlags();
      if (f & ts.TypeFlags.Null || f & ts.TypeFlags.Undefined) {
        nullish.push(member);
      } else {
        rest.push(member);
      }
    }

    // If all rest members are boolean literals → boolean
    if (rest.length >= 2 && rest.every(m => m.getFlags() & ts.TypeFlags.BooleanLiteral)) {
      const inner: Type = BOOL;
      return nullish.length > 0 ? { kind: 'nullable', inner } : inner;
    }

    // Check if all rest members are enum literals of the same enum
    if (rest.length > 0 && rest.every(m => m.getFlags() & ts.TypeFlags.EnumLiteral)) {
      return this.mapEnumUnion(rest, nullish.length > 0);
    }

    let innerType: Type;
    if (rest.length === 0) {
      innerType = NULL_TYPE;
    } else if (rest.length === 1) {
      innerType = this.doMap(rest[0], checker);
    } else {
      const mappedMembers = rest.map(m => this.doMap(m, checker));
      const unique = this.deduplicateTypes(mappedMembers);
      innerType = unique.length === 1 ? unique[0] : { kind: 'union', members: unique };
    }

    if (nullish.length > 0) {
      if (innerType.kind === 'null') return innerType;
      return { kind: 'nullable', inner: innerType };
    }
    return innerType;
  }

  /**
   * Maps a union of enum literal types to a single primitive type (`number` or
   * `string`). Reports W301 for mixed (number + string) enums.
   */
  private mapEnumUnion(members: ts.Type[], isNullable: boolean): Type {
    let hasNumber = false;
    let hasString = false;

    for (const m of members) {
      const f = m.getFlags();
      if (f & ts.TypeFlags.NumberLiteral) hasNumber = true;
      else if (f & ts.TypeFlags.StringLiteral) hasString = true;
    }

    let inner: Type;
    if (hasNumber && hasString) {
      this.diagnostics.report({
        severity: 'warning',
        code: D.W301,
        message: 'Mixed enum mapped to Any',
        span: interopSpan,
      });
      inner = ANY;
    } else if (hasString) {
      inner = STR;
    } else {
      inner = NUM;
    }

    return isNullable ? { kind: 'nullable', inner } : inner;
  }

  /**
   * Removes duplicate types from a mapped union by comparing `kind` and,
   * for primitives, their `name`. Used to collapse e.g. `string | string`
   * after mapping multiple TS string literal types.
   */
  private deduplicateTypes(types: Type[]): Type[] {
    const result: Type[] = [];
    for (const t of types) {
      const isDuplicate = result.some(existing => {
        if (existing.kind !== t.kind) return false;
        if (existing.kind === 'primitive' && t.kind === 'primitive') return existing.name === t.name;
        if (existing.kind === 'null' && t.kind === 'null') return true;
        if (existing.kind === 'any' && t.kind === 'any') return true;
        return false;
      });
      if (!isDuplicate) result.push(t);
    }
    return result;
  }

  /**
   * Maps a TS intersection type by merging all object-type members into a
   * single record. Falls back to `Any` with a warning if the intersection
   * contains non-object types.
   */
  private mapIntersection(tsType: ts.IntersectionType, checker: ts.TypeChecker): Type {
    const members = tsType.types;
    const fields = new Map<string, Type>();
    const nonRecordMembers: Type[] = [];
    let hasLazyMember = false;

    for (const member of members) {
      const mapped = this.doMap(member, checker);
      if (mapped.kind === 'record') {
        for (const [key, val] of mapped.fields) {
          fields.set(key, val);
        }
      } else if (mapped.kind === 'lazy-record') {
        // Lazy records in intersections: merge already-resolved fields
        for (const [key, val] of mapped.resolvedFields) {
          fields.set(key, val);
        }
        hasLazyMember = true;
      } else {
        nonRecordMembers.push(mapped);
      }
    }

    const allObjects = nonRecordMembers.length === 0;

    // Branded intersection detection: if we have non-record members AND
    // all record fields are brand-like (prefixed with `_` or `__`), discard
    // the brand fields and return the first non-record member as the base type.
    if (!allObjects && fields.size > 0) {
      const allBrand = Array.from(fields.keys()).every(k => k.startsWith('_'));
      if (allBrand) {
        return nonRecordMembers[0];
      }
    }

    if (!allObjects && fields.size === 0 && !hasLazyMember) {
      this.warnUnsupported('non-object intersection');
      return ANY;
    }

    return { kind: 'record', fields };
  }

  /**
   * Maps a TS object type. Dispatches to specialized handlers in priority order:
   * tuple → array → Promise/ReadonlyArray references → function (call signatures) →
   * record (class instances, interfaces, plain objects).
   */
  private mapObject(tsType: ts.ObjectType, checker: ts.TypeChecker): Type {
    const objectFlags = tsType.objectFlags;

    // Tuple check (before array — tuples are also references)
    if (checker.isTupleType(tsType)) {
      const typeRef = tsType as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(typeRef);
      const elements = typeArgs.map(arg => this.doMap(arg, checker));
      return { kind: 'tuple', elements };
    }

    // Array check
    if (checker.isArrayType(tsType)) {
      const typeRef = tsType as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(typeRef);
      const element = typeArgs.length > 0 ? this.doMap(typeArgs[0], checker) : ANY;
      return { kind: 'array', element };
    }

    // Reference type (could be Promise, class, etc.)
    if (objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = tsType as ts.TypeReference;
      const target = typeRef.target;
      const symbol = target.getSymbol();
      const name = symbol?.getName();

      // Promise
      if (name === 'Promise') {
        const typeArgs = checker.getTypeArguments(typeRef);
        const inner = typeArgs.length > 0 ? this.doMap(typeArgs[0], checker) : ANY;
        return { kind: 'promise', inner };
      }

      // Set / ReadonlySet
      if (name === 'Set' || name === 'ReadonlySet') {
        const typeArgs = checker.getTypeArguments(typeRef);
        const element = typeArgs.length > 0 ? this.doMap(typeArgs[0], checker) : ANY;
        return { kind: 'set', element };
      }

      // Map / ReadonlyMap
      if (name === 'Map' || name === 'ReadonlyMap') {
        const typeArgs = checker.getTypeArguments(typeRef);
        const key = typeArgs.length > 0 ? this.doMap(typeArgs[0], checker) : ANY;
        const value = typeArgs.length > 1 ? this.doMap(typeArgs[1], checker) : ANY;
        return { kind: 'map', key, value };
      }

      // ReadonlyArray
      if (name === 'ReadonlyArray') {
        const typeArgs = checker.getTypeArguments(typeRef);
        const element = typeArgs.length > 0 ? this.doMap(typeArgs[0], checker) : ANY;
        return { kind: 'array', element };
      }
    }

    // Function / call signatures (but skip if also has construct signatures — it's a class)
    let callSignatures: readonly ts.Signature[];
    let constructSignatures: readonly ts.Signature[];
    try {
      callSignatures = tsType.getCallSignatures();
      constructSignatures = tsType.getConstructSignatures();
    } catch {
      return this.mapRecord(tsType, checker);
    }
    if (callSignatures.length > 0 && constructSignatures.length === 0) {
      if (callSignatures.length > 1) {
        this.diagnostics.report({
          severity: 'warning',
          code: D.W302,
          message: `Overloaded function has ${callSignatures.length} signatures; using the most general, ${callSignatures.length - 1} dropped`,
          span: interopSpan,
        });
      }
      return this.mapSignature(this.selectOverload(callSignatures), checker);
    }

    // Map as record (class instances, interfaces, plain objects)
    return this.mapRecord(tsType, checker);
  }

  /**
   * Maps a TS object type to an EffectScript {@link RecordType} by iterating
   * its public properties. Uses a placeholder in the memo map for cycle
   * detection — self-referencing record fields resolve to the in-progress
   * placeholder rather than recursing infinitely.
   */
  private mapRecord(tsType: ts.Type, checker: ts.TypeChecker): RecordType | LazyRecordType {
    // Count properties to decide between eager and lazy resolution.
    let properties: ts.Symbol[];
    try {
      properties = tsType.getProperties() as ts.Symbol[];
    } catch {
      // TS API can overflow on deeply recursive generic types
      return { kind: 'record', fields: new Map() };
    }

    // Count visible (non-private/protected) properties
    const visibleCount = this.countVisibleProperties(properties);

    if (visibleCount > TsTypeMapper.LAZY_THRESHOLD) {
      return this.mapRecordLazy(tsType, checker, properties, visibleCount);
    }

    return this.mapRecordEager(tsType, checker, properties);
  }

  /** Count properties that would be mapped (skipping private/protected). */
  private countVisibleProperties(properties: ts.Symbol[]): number {
    let count = 0;
    for (const prop of properties) {
      const declarations = prop.getDeclarations();
      if (declarations && declarations.length > 0) {
        const modifiers = ts.getCombinedModifierFlags(declarations[0]);
        if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
          continue;
        }
      }
      count++;
    }
    return count;
  }

  /**
   * Eagerly maps all properties of a TS type to an EffectScript {@link RecordType}.
   * Used for interfaces below the lazy threshold.
   */
  private mapRecordEager(tsType: ts.Type, checker: ts.TypeChecker, properties: ts.Symbol[]): RecordType {
    // Use a mutable staging object for cycle detection.
    // When a cycle is encountered during field mapping, `doMap` will return the
    // placeholder from memo. We build fields completely before constructing the
    // final RecordType, then update memo with the complete record.
    const cycleGuard: { fields: Map<string, Type> } = { fields: new Map() };
    // Store a temporary record in memo so cycles resolve to the same object reference.
    // We'll replace it with the final record once fields are built.
    const placeholder: RecordType = { kind: 'record', fields: cycleGuard.fields };
    this.memo.set(tsType, placeholder);
    this.inProgress.add(tsType);

    for (const prop of properties) {
      // Skip private/protected members
      const declarations = prop.getDeclarations();
      if (declarations && declarations.length > 0) {
        const modifiers = ts.getCombinedModifierFlags(declarations[0]);
        if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
          continue;
        }
      }

      let propType: ts.Type;
      try {
        if (declarations && declarations.length > 0) {
          propType = checker.getTypeOfSymbolAtLocation(prop, declarations[0]);
        } else {
          propType = checker.getDeclaredTypeOfSymbol(prop);
        }
      } catch {
        // TS API can overflow on recursive generic types
        cycleGuard.fields.set(prop.getName(), ANY);
        continue;
      }
      let mapped = this.doMap(propType, checker);

      // Optional properties → nullable
      if (prop.flags & ts.SymbolFlags.Optional) {
        if (mapped.kind !== 'nullable' && mapped.kind !== 'null') {
          mapped = { kind: 'nullable', inner: mapped };
        }
      }

      cycleGuard.fields.set(prop.getName(), mapped);
    }

    this.inProgress.delete(tsType);

    // Build the final immutable RecordType with the fully-populated fields map.
    // cycleGuard.fields was already shared with placeholder, so placeholder is also
    // up-to-date — any cycle references already in memo will see the complete fields.
    const result: RecordType = { kind: 'record', fields: cycleGuard.fields };
    this.memo.set(tsType, result);
    return result;
  }

  /**
   * Creates a {@link LazyRecordType} that resolves fields on demand.
   * Used for interfaces above the lazy threshold to avoid OOM on large type surfaces.
   *
   * The field resolver captures the `ts.Type` and `ts.TypeChecker` references and
   * maps individual properties when they are accessed by the checker's `lookupField`.
   * Resolved fields are cached in `resolvedFields` to avoid redundant mapping.
   */
  private mapRecordLazy(
    tsType: ts.Type,
    checker: ts.TypeChecker,
    properties: ts.Symbol[],
    visibleCount: number,
  ): LazyRecordType {
    // Build a property lookup index: name → ts.Symbol (for on-demand resolution)
    const propIndex = new Map<string, ts.Symbol>();
    for (const prop of properties) {
      const declarations = prop.getDeclarations();
      if (declarations && declarations.length > 0) {
        const modifiers = ts.getCombinedModifierFlags(declarations[0]);
        if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
          continue;
        }
      }
      propIndex.set(prop.getName(), prop);
    }

    const resolvedFields = new Map<string, Type>();
    // Capture `this` for the resolver closure
    const mapper = this;

    const resolveField = (name: string): Type | undefined => {
      // Check cache first
      const cached = resolvedFields.get(name);
      if (cached !== undefined) return cached;

      const prop = propIndex.get(name);
      if (!prop) return undefined;

      // Map the single property on demand
      const declarations = prop.getDeclarations();
      let propType: ts.Type;
      try {
        if (declarations && declarations.length > 0) {
          propType = checker.getTypeOfSymbolAtLocation(prop, declarations[0]);
        } else {
          propType = checker.getDeclaredTypeOfSymbol(prop);
        }
      } catch {
        resolvedFields.set(name, ANY);
        return ANY;
      }

      let mapped = mapper.doMap(propType, checker);

      // Optional properties → nullable
      if (prop.flags & ts.SymbolFlags.Optional) {
        if (mapped.kind !== 'nullable' && mapped.kind !== 'null') {
          mapped = { kind: 'nullable', inner: mapped };
        }
      }

      resolvedFields.set(name, mapped);
      return mapped;
    };

    const lazyRecord: LazyRecordType = {
      kind: 'lazy-record',
      resolvedFields,
      resolveField,
      propertyCount: visibleCount,
    };

    this.memo.set(tsType, lazyRecord);
    return lazyRecord;
  }

  /**
   * Maps a single TS call/construct signature to an EffectScript {@link FunctionType}.
   * Handles parameter types, optionality, defaults, null-kind detection, return type,
   * and generic type parameters.
   */
  /**
   * Select the best overload from a list of signatures.
   * Prefers the last overload that has type parameters; if none have type
   * parameters, uses the absolute last (most general by TS convention).
   */
  private selectOverload(signatures: readonly ts.Signature[]): ts.Signature {
    if (signatures.length === 1) return signatures[0];
    // Prefer the last overload that has type parameters
    for (let i = signatures.length - 1; i >= 0; i--) {
      const typeParams = signatures[i].getTypeParameters();
      if (typeParams && typeParams.length > 0) return signatures[i];
    }
    // No generic overloads — use the absolute last
    return signatures[signatures.length - 1];
  }

  private mapSignature(sig: ts.Signature, checker: ts.TypeChecker): FunctionType {
    const allParams = sig.getParameters();
    let restInfo: { name: string; elementType: Type } | undefined;

    // Detect rest parameter (last param with dotDotDotToken)
    if (allParams.length > 0) {
      const lastParam = allParams[allParams.length - 1];
      const lastDecl = lastParam.getDeclarations()?.[0];
      if (lastDecl && ts.isParameter(lastDecl) && lastDecl.dotDotDotToken) {
        // Rest parameter: extract element type from the array type
        const restType = checker.getTypeOfSymbolAtLocation(lastParam, lastDecl);
        let elementType: Type;
        // Rest params in TS are always array types — extract the element
        if (checker.isArrayType(restType)) {
          const typeArgs = (restType as ts.TypeReference).typeArguments;
          elementType = typeArgs && typeArgs.length > 0
            ? this.doMap(typeArgs[0], checker)
            : { kind: 'any' };
        } else {
          elementType = this.doMap(restType, checker);
        }
        restInfo = { name: lastParam.getName(), elementType };
      }
    }

    // Map non-rest params (exclude last if it's a rest param)
    const paramSymbols = restInfo ? allParams.slice(0, -1) : allParams;
    const params: ParamType[] = paramSymbols.map(param => {
      const declarations = param.getDeclarations();
      const decl = declarations?.[0];
      let paramType: ts.Type;
      if (decl) {
        paramType = checker.getTypeOfSymbolAtLocation(param, decl);
      } else {
        paramType = checker.getDeclaredTypeOfSymbol(param);
      }
      const mapped = this.doMap(paramType, checker);

      // Detect optionality: SymbolFlags.Optional covers object properties,
      // but for function params we also check the declaration's questionToken.
      let isOptional = !!(param.flags & ts.SymbolFlags.Optional);
      let hasDefault = false;
      if (decl && ts.isParameter(decl)) {
        if (decl.questionToken) isOptional = true;
        hasDefault = decl.initializer !== undefined;
      }

      // Determine nullKind for interop null/undefined handling
      const nullKind = this.detectNullKind(paramType, isOptional, checker);

      const pResult: Record<string, unknown> = {
        name: param.getName(),
        type: mapped,
        optional: isOptional,
        hasDefault,
      };
      if (nullKind !== undefined) pResult['nullKind'] = nullKind;
      return pResult as unknown as ParamType;
    });

    const returnType = this.doMap(sig.getReturnType(), checker);

    // Type parameters
    const tsTypeParams = sig.getTypeParameters();
    const result: Record<string, unknown> = {
      kind: 'function',
      params,
      returnType,
    };
    if (tsTypeParams && tsTypeParams.length > 0) {
      const typeParams: TypeParam[] = tsTypeParams.map(tp => {
        const constraint = tp.getConstraint();
        const mappedConstraint = constraint ? this.doMap(constraint, checker) : undefined;
        const param: Record<string, unknown> = {
          name: tp.getSymbol()?.getName() ?? 'T',
        };
        if (mappedConstraint !== undefined) param['constraint'] = mappedConstraint;
        return param as unknown as TypeParam;
      });
      result['typeParams'] = typeParams;
    }
    if (restInfo) {
      result['rest'] = restInfo;
    }

    return result as unknown as FunctionType;
  }

  /**
   * Determines how a nullable TS parameter maps to EffectScript's null semantics.
   *
   * - Optional params accept `undefined` in TS; if the type also includes `null`,
   *   returns `'either'`, otherwise `'undefined'`.
   * - Non-optional union params: inspects members for `null` and/or `undefined`.
   *
   * @returns The {@link NullKind} for interop emission, or `undefined` if the
   *          parameter is not nullable.
   */
  private detectNullKind(paramType: ts.Type, isOptional: boolean, _checker: ts.TypeChecker): NullKind | undefined {
    // Optional params always accept undefined in TS
    if (isOptional) {
      // Check if the type also includes null
      const hasNull = paramType.isUnion()
        ? paramType.types.some(t => !!(t.flags & ts.TypeFlags.Null))
        : !!(paramType.flags & ts.TypeFlags.Null);
      return hasNull ? 'either' : 'undefined';
    }

    // Check union members for null/undefined
    if (paramType.isUnion()) {
      const hasNull = paramType.types.some(t => !!(t.flags & ts.TypeFlags.Null));
      const hasUndefined = paramType.types.some(t => !!(t.flags & ts.TypeFlags.Undefined));
      if (hasNull && hasUndefined) return 'either';
      if (hasNull) return 'null';
      if (hasUndefined) return 'undefined';
    }

    return undefined;
  }

  /** Reports a W301 warning for a TypeScript type that has no EffectScript equivalent. */
  private warnUnsupported(description: string): void {
    this.diagnostics.report({
      severity: 'warning',
      code: D.W301,
      message: `Unsupported TypeScript type (${description}) mapped to Any`,
      span: interopSpan,
    });
  }
}
