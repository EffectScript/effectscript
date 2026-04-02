/**
 * @module type-mapper
 *
 * Maps TypeScript types (from the TS compiler API) to EffectScript's internal
 * {@link Type} representation. Handles primitives, unions, intersections,
 * arrays, tuples, promises, functions, records, generics, enums, conditional
 * types, and nullable types. Depth-limited (MAX_DEPTH=20) and cycle-safe via
 * memoization and an in-progress set.
 */
import * as ts from 'typescript';
import type {
  Type,
  FunctionType,
  ParamType,
  RecordType,
  LazyRecordType,
  IndexSignatureType,
  InterfaceType,
  TypeParam,
  NullKind,
  LiteralType,
} from '../checker/types.js';
import { NUM, STR, BOOL, VOID, NEVER, BIGINT, SYMBOL, ANY, NULL_TYPE, makePlatform, typesEqual, simplifyUnion } from '../checker/types.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import type { Span } from '../utils/span.js';
import { omitUndefined } from '../utils/type-helpers.js';

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

  /** Total number of lazy field resolutions performed this compilation. */
  private lazyResolutionCount = 0;
  /** Whether W305 has already been emitted this compilation. */
  private budgetWarningEmitted = false;
  /** Whether W304 has already been emitted for this top-level doMap call tree. */
  private w304Emitted = false;
  /** Maximum lazy field resolutions per compilation before budget exhaustion. */
  private readonly budget: number;

  /** @param diagnostics  Collector for W301 (unsupported type) and W302 (overloaded) warnings. */
  constructor(diagnostics: DiagnosticCollector, budget = 500) {
    this.diagnostics = diagnostics;
    this.budget = budget;
  }

  /**
   * Attempt to consume one unit of lazy resolution budget.
   * Returns true if budget is available. Returns false if exhausted
   * (caller should return a platform type). Emits W305 once.
   */
  private consumeBudget(): boolean {
    if (this.lazyResolutionCount >= this.budget) {
      if (!this.budgetWarningEmitted) {
        this.diagnostics.report({
          severity: 'warning',
          code: D.W305,
          message: `Type resolution budget exhausted (${this.lazyResolutionCount}/${this.budget}); remaining properties approximated`,
          span: interopSpan,
        });
        this.budgetWarningEmitted = true;
      }
      return false;
    }
    this.lazyResolutionCount++;
    return true;
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

    // Depth guard — return platform type instead of bare Any
    if (this.depth >= TsTypeMapper.MAX_DEPTH) {
      if (!this.w304Emitted) {
        this.diagnostics.report({
          severity: 'warning',
          code: D.W304,
          message: `Recursive type depth limit reached; type approximated as 'Any!'`,
          span: interopSpan,
        });
        this.w304Emitted = true;
      }
      return makePlatform(ANY, 'recursive-limit');
    }

    // Cycle detection — return platform type instead of bare Any
    if (this.inProgress.has(tsType)) {
      if (!this.w304Emitted) {
        this.diagnostics.report({
          severity: 'warning',
          code: D.W304,
          message: `Recursive type depth limit reached; type approximated as 'Any!'`,
          span: interopSpan,
        });
        this.w304Emitted = true;
      }
      return makePlatform(ANY, 'recursive-limit');
    }

    const isTopLevel = this.depth === 0;
    this.depth++;
    try {
      return this.doMapInner(tsType, checker);
    } finally {
      this.depth--;
      // Reset W304 dedup at top-level exit so next top-level map can emit again
      if (isTopLevel) this.w304Emitted = false;
    }
  }

  /**
   * Dispatches a TS type to the appropriate mapper based on its type flags.
   *
   * Priority order: primitives → literals → bigint/symbol →
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

    // BigInt, ESSymbol → EffectScript primitives
    if (flags & ts.TypeFlags.BigInt || flags & ts.TypeFlags.BigIntLiteral) {
      return BIGINT;
    }
    if (flags & ts.TypeFlags.ESSymbol || flags & ts.TypeFlags.UniqueESSymbol) {
      return SYMBOL;
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

    // Conditional type → try to resolve via 4-strategy pipeline
    if (flags & ts.TypeFlags.Conditional) {
      return this.mapConditionalType(tsType as ts.ConditionalType, checker);
    }

    // Index type (keyof T) → platform(string) with 'indexed-access' reason
    if (flags & ts.TypeFlags.Index) {
      return makePlatform(STR, 'indexed-access');
    }

    // IndexedAccess (T[K]) → platform with 'indexed-access' reason
    if (flags & ts.TypeFlags.IndexedAccess) {
      return makePlatform(ANY, 'indexed-access');
    }

    // TemplateLiteral → string
    if (flags & ts.TypeFlags.TemplateLiteral) {
      return STR;
    }

    // Substitution → platform(baseType) with 'unmappable' reason
    if (flags & ts.TypeFlags.Substitution) {
      const subType = tsType as ts.SubstitutionType;
      const baseResult = this.doMap(subType.baseType, checker);
      return makePlatform(baseResult, 'unmappable');
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
    let indexSigInfo: { keyType: 'string' | 'number'; valueType: Type } | undefined;

    for (const member of members) {
      const mapped = this.doMap(member, checker);
      if (mapped.kind === 'record') {
        for (const [key, val] of mapped.fields) {
          fields.set(key, val);
        }
      } else if (mapped.kind === 'index-signature') {
        // Merge index signature fields and preserve index signature info
        for (const [key, val] of mapped.fields) {
          fields.set(key, val);
        }
        indexSigInfo = { keyType: mapped.keyType, valueType: mapped.valueType };
      } else if (mapped.kind === 'interface') {
        // Merge interface properties and methods into the flat record
        for (const [key, val] of mapped.properties) {
          fields.set(key, val);
        }
        for (const [key, val] of mapped.methods) {
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

    // If any member had an index signature, produce IndexSignatureType
    if (indexSigInfo) {
      return {
        kind: 'index-signature',
        keyType: indexSigInfo.keyType,
        valueType: indexSigInfo.valueType,
        fields,
      } as IndexSignatureType;
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

    // Detect interface/class types and map to InterfaceType (before call signatures,
    // so callable interfaces like `interface Logger { (msg: string): void; level: string }`
    // are mapped as InterfaceType with a __call method, not as a plain function)
    const symbol = tsType.getSymbol();
    if (symbol) {
      const isInterface = !!(symbol.flags & ts.SymbolFlags.Interface);
      const isClass = !!(symbol.flags & ts.SymbolFlags.Class);
      if (isInterface || isClass) {
        return this.mapInterface(tsType, checker, symbol);
      }
    }

    // Function / call signatures (only for non-interface/non-class types)
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

    // Map as record (plain objects)
    return this.mapRecord(tsType, checker);
  }

  /**
   * Maps a TS object type to an EffectScript {@link RecordType} by iterating
   * its public properties. Uses a placeholder in the memo map for cycle
   * detection — self-referencing record fields resolve to the in-progress
   * placeholder rather than recursing infinitely.
   */
  private mapRecord(tsType: ts.Type, checker: ts.TypeChecker): RecordType | LazyRecordType | IndexSignatureType {
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

  /** Returns true if the TS property symbol is NOT readonly (i.e., it is mutable in EffectScript). */
  private isPropertyMutable(prop: ts.Symbol): boolean {
    const declarations = prop.getDeclarations();
    if (declarations && declarations.length > 0) {
      const modifiers = ts.getCombinedModifierFlags(declarations[0]);
      return !(modifiers & ts.ModifierFlags.Readonly);
    }
    // No declaration — conservative: treat as mutable (non-readonly)
    return true;
  }

  /** Build the mutableFields set from TS property symbols. Returns undefined if all fields are immutable. */
  private buildMutableFields(properties: ts.Symbol[]): Set<string> | undefined {
    const mutableFields = new Set<string>();
    for (const prop of properties) {
      if (this.isPropertyMutable(prop)) {
        mutableFields.add(prop.getName());
      }
    }
    return mutableFields.size > 0 ? mutableFields : undefined;
  }

  /**
   * Eagerly maps all properties of a TS type to an EffectScript {@link RecordType}.
   * Used for interfaces below the lazy threshold.
   */
  private mapRecordEager(tsType: ts.Type, checker: ts.TypeChecker, properties: ts.Symbol[]): RecordType | IndexSignatureType {
    // Use a mutable staging object for cycle detection.
    // When a cycle is encountered during field mapping, `doMap` will return the
    // placeholder from memo. We build fields completely before constructing the
    // final RecordType, then update memo with the complete record.
    const cycleGuard: { fields: Map<string, Type> } = { fields: new Map() };
    const mutableFields = this.buildMutableFields(properties);
    // Store a temporary record in memo so cycles resolve to the same object reference.
    // We'll replace it with the final record once fields are built.
    const placeholder = omitUndefined<RecordType>({
      kind: 'record' as const,
      fields: cycleGuard.fields,
      mutableFields,
    });
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

    // Check for index signatures — string takes priority over number (D8)
    const stringIndexType = checker.getIndexTypeOfType(tsType, ts.IndexKind.String);
    const numberIndexType = checker.getIndexTypeOfType(tsType, ts.IndexKind.Number);
    const indexTsType = stringIndexType ?? numberIndexType;
    if (indexTsType) {
      const keyType = stringIndexType ? 'string' as const : 'number' as const;
      const valueType = this.doMap(indexTsType, checker);
      const result: IndexSignatureType = {
        kind: 'index-signature',
        keyType,
        valueType,
        fields: cycleGuard.fields,
      };
      this.memo.set(tsType, result);
      return result;
    }

    // Build the final immutable RecordType with the fully-populated fields map.
    // cycleGuard.fields was already shared with placeholder, so placeholder is also
    // up-to-date — any cycle references already in memo will see the complete fields.
    const result = omitUndefined<RecordType>({
      kind: 'record' as const,
      fields: cycleGuard.fields,
      mutableFields,
    });
    this.memo.set(tsType, result);
    return result;
  }

  /**
   * Maps a TS interface or class instance type to an EffectScript {@link InterfaceType}.
   *
   * Uses the same mutable-staging cycle detection pattern as {@link mapRecordEager}:
   * a placeholder with shared Map instances is inserted into the memo cache before
   * resolving members, so self-referential types resolve to the same object identity.
   *
   * For interfaces above the lazy threshold, falls back to {@link mapRecordLazy}.
   */
  private mapInterface(
    tsType: ts.Type,
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
  ): InterfaceType | LazyRecordType | IndexSignatureType {
    // Check memo cache first
    const cached = this.memo.get(tsType);
    if (cached !== undefined) return cached as InterfaceType;

    const name = symbol.getName();

    // Cycle detection
    if (this.inProgress.has(tsType)) {
      return this.memo.get(tsType) as InterfaceType;
    }

    // Lazy threshold check — large interfaces fall back to LazyRecordType
    let properties: ts.Symbol[];
    try {
      properties = tsType.getProperties() as ts.Symbol[];
    } catch {
      return { kind: 'record', fields: new Map() } as RecordType as unknown as InterfaceType;
    }
    const visibleCount = this.countVisibleProperties(properties);
    if (visibleCount > TsTypeMapper.LAZY_THRESHOLD) {
      return this.mapRecordLazy(tsType, checker, properties, visibleCount);
    }

    // Create mutable staging maps shared between placeholder and final object
    const propMap = new Map<string, Type>();
    const methodMap = new Map<string, FunctionType>();
    const mutableProps = new Set<string>();
    const placeholder: InterfaceType = {
      kind: 'interface', name, methods: methodMap, properties: propMap, typeArgs: [],
    };
    this.memo.set(tsType, placeholder);
    this.inProgress.add(tsType);

    for (const prop of properties) {
      // Skip symbol-keyed members (e.g., [Symbol.iterator])
      if (prop.getName().startsWith('__@')) continue;

      // Skip private/protected
      const declarations = prop.getDeclarations();
      if (declarations && declarations.length > 0) {
        const modifiers = ts.getCombinedModifierFlags(declarations[0]);
        if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      }

      let propType: ts.Type;
      try {
        propType = declarations && declarations.length > 0
          ? checker.getTypeOfSymbolAtLocation(prop, declarations[0])
          : checker.getDeclaredTypeOfSymbol(prop);
      } catch (e: unknown) {
        if (!(e instanceof Error)) throw e;
        propMap.set(prop.getName(), ANY);
        continue;
      }

      // Determine if this is a method or a property
      const isMethod = declarations?.some(d =>
        ts.isMethodDeclaration(d) || ts.isMethodSignature(d),
      ) ?? false;

      if (isMethod) {
        const mapped = this.doMap(propType, checker);
        if (mapped.kind === 'function') {
          methodMap.set(prop.getName(), mapped);
        } else {
          propMap.set(prop.getName(), mapped);
        }
      } else {
        let mapped = this.doMap(propType, checker);
        if (prop.flags & ts.SymbolFlags.Optional) {
          if (mapped.kind !== 'nullable' && mapped.kind !== 'null') {
            mapped = { kind: 'nullable', inner: mapped };
          }
        }
        propMap.set(prop.getName(), mapped);
        // Track mutability: non-readonly properties are mutable
        if (declarations && declarations.length > 0) {
          const mods = ts.getCombinedModifierFlags(declarations[0]);
          if (!(mods & ts.ModifierFlags.Readonly)) {
            mutableProps.add(prop.getName());
          }
        }
      }
    }

    // Map call signatures to __call method (for callable interfaces)
    try {
      const callSigs = tsType.getCallSignatures();
      if (callSigs.length > 0) {
        if (callSigs.length > 1) {
          this.diagnostics.report({
            severity: 'warning',
            code: D.W302,
            message: `Overloaded call signature has ${callSigs.length} signatures; using the most general, ${callSigs.length - 1} dropped`,
            span: interopSpan,
          });
        }
        const callFn = this.mapSignature(this.selectOverload(callSigs), checker);
        methodMap.set('__call', callFn);
      }
    } catch {
      // TS API can throw for unusual types — skip call signatures
    }

    this.inProgress.delete(tsType);

    // Type parameters
    const tsTypeParams = symbol.getDeclarations()?.[0] &&
      (ts.isClassDeclaration(symbol.getDeclarations()![0])
        ? (symbol.getDeclarations()![0] as ts.ClassDeclaration).typeParameters
        : ts.isInterfaceDeclaration(symbol.getDeclarations()![0] as ts.Node)
          ? (symbol.getDeclarations()![0] as ts.InterfaceDeclaration).typeParameters
          : undefined);

    let typeParams: TypeParam[] | undefined;
    if (tsTypeParams && tsTypeParams.length > 0) {
      typeParams = tsTypeParams.map(tp => {
        const constraint = tp.constraint
          ? this.doMap(checker.getTypeFromTypeNode(tp.constraint), checker)
          : undefined;
        return omitUndefined({ name: tp.name.text, constraint });
      });
    }

    // Type arguments (for instantiated generic types)
    const typeArgs: Type[] = [];
    if ((tsType as ts.TypeReference).typeArguments) {
      for (const arg of (tsType as ts.TypeReference).typeArguments!) {
        typeArgs.push(this.doMap(arg, checker));
      }
    }

    // Extended interfaces
    const baseTypes = tsType.getBaseTypes?.();
    let extendsTypes: InterfaceType[] | undefined;
    if (baseTypes && baseTypes.length > 0) {
      extendsTypes = [];
      for (const base of baseTypes) {
        const mapped = this.doMap(base, checker);
        if (mapped.kind === 'interface') {
          extendsTypes.push(mapped);
        }
      }
      if (extendsTypes.length === 0) extendsTypes = undefined;
    }

    // Build the final InterfaceType
    const iface = omitUndefined({
      kind: 'interface' as const,
      name,
      methods: methodMap,
      properties: propMap,
      mutableProperties: mutableProps.size > 0 ? mutableProps : undefined,
      typeArgs,
      typeParams,
      extends: extendsTypes,
    });
    this.memo.set(tsType, iface);
    return iface;
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
  ): LazyRecordType | IndexSignatureType {
    // Check for index signatures before building the lazy record.
    // Per the design doc: types above the lazy threshold with an index signature
    // produce IndexSignatureType with an empty fields map (named fields omitted).
    const stringIndexType = checker.getIndexTypeOfType(tsType, ts.IndexKind.String);
    const numberIndexType = checker.getIndexTypeOfType(tsType, ts.IndexKind.Number);
    const indexTsType = stringIndexType ?? numberIndexType;
    if (indexTsType) {
      const keyType = stringIndexType ? 'string' as const : 'number' as const;
      const valueType = this.doMap(indexTsType, checker);
      const result: IndexSignatureType = {
        kind: 'index-signature',
        keyType,
        valueType,
        fields: new Map(),
      };
      this.memo.set(tsType, result);
      return result;
    }
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
    const self = this;

    const resolveField = (name: string): Type | undefined => {
      // Check cache first
      const cached = resolvedFields.get(name);
      if (cached !== undefined) return cached;

      const prop = propIndex.get(name);
      if (!prop) return undefined;

      // Budget check — return platform(Any) if budget exhausted
      if (!self.consumeBudget()) {
        const result = makePlatform(ANY, 'budget-cap');
        resolvedFields.set(name, result);
        return result;
      }

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

      let mapped = self.doMap(propType, checker);

      // Optional properties → nullable
      if (prop.flags & ts.SymbolFlags.Optional) {
        if (mapped.kind !== 'nullable' && mapped.kind !== 'null') {
          mapped = { kind: 'nullable', inner: mapped };
        }
      }

      resolvedFields.set(name, mapped);
      return mapped;
    };

    const mutableFields = this.buildMutableFields(properties);
    const lazyRecord = omitUndefined<LazyRecordType>({
      kind: 'lazy-record' as const,
      resolvedFields,
      resolveField,
      propertyCount: visibleCount,
      mutableFields,
    });

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

  // ── Conditional type resolution ─────────────────────────────

  /**
   * Resolves a TS conditional type using a 4-strategy pipeline:
   * 1. Single resolved branch (TS evaluated the condition definitively)
   * 2. Base constraint resolution via TS checker API
   * 3. Apparent type resolution via TS checker API
   * 4. Branch union construction (sound over-approximation)
   *
   * Falls back to Any with W301 when all strategies fail.
   */
  private mapConditionalType(tsType: ts.ConditionalType, checker: ts.TypeChecker): Type {
    // Strategy 1: If TS resolved to a single branch, use it directly.
    const trueResolved = tsType.resolvedTrueType;
    const falseResolved = tsType.resolvedFalseType;
    if (trueResolved !== undefined && falseResolved === undefined) {
      const result = this.doMap(trueResolved, checker);
      this.memo.set(tsType, result);
      return result;
    }
    if (falseResolved !== undefined && trueResolved === undefined) {
      const result = this.doMap(falseResolved, checker);
      this.memo.set(tsType, result);
      return result;
    }

    // Strategy 2: Ask TS for the base constraint of the conditional.
    // Guard against conditional (no resolution), any (degenerate), unknown (maps to Any).
    try {
      const baseConstraint = checker.getBaseConstraintOfType(tsType);
      if (baseConstraint
          && !(baseConstraint.getFlags() & ts.TypeFlags.Conditional)
          && !(baseConstraint.getFlags() & ts.TypeFlags.Any)
          && !(baseConstraint.getFlags() & ts.TypeFlags.Unknown)) {
        const result = this.doMap(baseConstraint, checker);
        this.memo.set(tsType, result);
        return result;
      }
    } catch {
      // TS may throw on pathological recursive types. Recovery: try next strategy.
    }

    // Strategy 3: Use getApparentType to resolve through type parameter constraints.
    // Guard against conditional (no resolution) and any (degenerate).
    try {
      const apparent = checker.getApparentType(tsType);
      if (apparent !== tsType
          && !(apparent.getFlags() & ts.TypeFlags.Conditional)
          && !(apparent.getFlags() & ts.TypeFlags.Any)) {
        const result = this.doMap(apparent, checker);
        this.memo.set(tsType, result);
        return result;
      }
    } catch {
      // Same rationale as above. Recovery: try Strategy 4.
    }

    // Strategy 4: Construct a union of both resolved branches (sound over-approximation).
    if (trueResolved !== undefined && falseResolved !== undefined) {
      const result = this.mapConditionalBranches(trueResolved, falseResolved, checker);
      this.memo.set(tsType, result);
      return result;
    }

    // Fallback: unresolvable conditional type
    this.warnUnsupported('unresolvable conditional type');
    return makePlatform(ANY, 'conditional');
  }

  /**
   * Maps both branches of a conditional type and constructs a union.
   * Performs manual `never` elimination since `simplifyUnion` only deduplicates.
   */
  private mapConditionalBranches(
    trueResolved: ts.Type,
    falseResolved: ts.Type,
    checker: ts.TypeChecker,
  ): Type {
    const trueType = this.doMap(trueResolved, checker);
    const falseType = this.doMap(falseResolved, checker);

    // Manual never elimination — simplifyUnion only deduplicates via typesEqual
    if (trueType.kind === 'primitive' && trueType.name === 'never') return falseType;
    if (falseType.kind === 'primitive' && falseType.name === 'never') return trueType;

    // If both branches map to the same type, return it directly
    if (typesEqual(trueType, falseType)) return trueType;

    return simplifyUnion([trueType, falseType]);
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
