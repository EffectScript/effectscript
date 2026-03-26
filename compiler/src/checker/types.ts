/**
 * @module types
 *
 * Internal type representations for the EffectScript type checker.
 *
 * This module defines the Type union and all its variants, plus utility
 * functions for comparing, resolving, and displaying types. These types
 * are distinct from the AST type nodes — they represent the checker's
 * semantic understanding of types after resolution.
 *
 * Key concepts:
 * - **Type variables**: Created during generic instantiation via {@link freshTypeVar}.
 *   They are mutable — the `resolved` field is filled during unification.
 *   Use {@link resolveType} to chase type variable chains (with path compression).
 * - **Assignability**: Structural for records and functions, nominal for ADTs.
 *   See {@link isAssignableTo} for the full algorithm.
 * - **Nullable**: `T?` is represented as `{ kind: 'nullable', inner: T }`.
 *   Helpers: {@link isNullable}, {@link unwrapNullable}, {@link makeNullable}.
 * - **Error type**: A sentinel that silences downstream errors (avoids cascading).
 */

// ── Type Union ──────────────────────────────────────────────

/**
 * Discriminated union of all internal type representations.
 *
 * Every type has a `kind` field for pattern matching. This is the
 * "semantic type" used by the checker — not to be confused with
 * AST type nodes which represent source-level syntax.
 */
export type Type =
  | PrimitiveType
  | AnyType
  | NullType
  | NullableType
  | FunctionType
  | RecordType
  | LazyRecordType
  | ArrayType
  | TupleType
  | UnionType
  | ADTType
  | GenericType
  | TypeVariable
  | PromiseType
  | SetType
  | MapType
  | LiteralType
  | ErrorType;

// ── Type Variants ───────────────────────────────────────────

/** Built-in primitive types: `number`, `string`, `boolean`, `void`, `never`. */
export interface PrimitiveType {
  readonly kind: 'primitive';
  /** Which primitive this represents. */
  readonly name: 'number' | 'string' | 'boolean' | 'void' | 'never';
}

/** The `Any` type — assignable to/from everything (escape hatch for JS interop). */
export interface AnyType {
  readonly kind: 'any';
}

/** The `null` literal type. Distinct from nullable (`T?`). */
export interface NullType {
  readonly kind: 'null';
}

/** A nullable type: `T?` (equivalent to `T | null`). */
export interface NullableType {
  readonly kind: 'nullable';
  /** The non-null inner type. */
  readonly inner: Type;
}

/** Function type with parameters, return type, and optional generic type parameters. */
export interface FunctionType {
  readonly kind: 'function';
  /** Parameter definitions (name, type, optionality). */
  readonly params: readonly ParamType[];
  /** The return type of the function. */
  readonly returnType: Type;
  /** Generic type parameters, e.g. `<T, E>`. Present only for generic functions. */
  readonly typeParams?: readonly TypeParam[];
  /** Rest parameter (variadic): allows unbounded extra arguments of `elementType`. */
  readonly rest?: { readonly name: string; readonly elementType: Type };
}

/** Record (structural object) type with named fields. */
export interface RecordType {
  readonly kind: 'record';
  /** Field name → field type mapping. */
  readonly fields: ReadonlyMap<string, Type>;
}

/**
 * A lazily-resolved record type for large TS interfaces.
 *
 * Stores a field resolver function that maps individual properties on demand
 * rather than eagerly resolving all fields upfront. This prevents OOM when
 * importing packages with massive type surfaces (lodash, express, zod).
 *
 * Fields are cached after first resolution — subsequent lookups for the same
 * field name return the cached result without re-resolving.
 */
export interface LazyRecordType {
  readonly kind: 'lazy-record';
  /** Cache of already-resolved fields. Grows incrementally as fields are accessed. */
  readonly resolvedFields: Map<string, Type>;
  /** Resolves a single field by name. Returns `undefined` if the field does not exist. */
  readonly resolveField: (name: string) => Type | undefined;
  /** The total number of properties on the underlying type (for diagnostics). */
  readonly propertyCount: number;
}

/** Array type parameterized by element type. */
export interface ArrayType {
  readonly kind: 'array';
  /** The type of each element. */
  readonly element: Type;
}

/** Fixed-length tuple type with ordered element types. */
export interface TupleType {
  readonly kind: 'tuple';
  /** Element types in positional order. */
  readonly elements: readonly Type[];
}

/** Union type: a value that could be any of the member types. */
export interface UnionType {
  readonly kind: 'union';
  /** The member types (always 2+ after simplification). */
  readonly members: readonly Type[];
}

/**
 * Algebraic Data Type (ADT) — a named type with variant constructors.
 *
 * ADTs use nominal typing: two ADTs with the same structure but different
 * names are not assignable to each other.
 */
export interface ADTType {
  readonly kind: 'adt';
  /** The ADT name (e.g. `'Result'`). */
  readonly name: string;
  /** Instantiated type arguments (e.g. `[string, Error]` for `Result<string, Error>`). */
  readonly typeArgs: readonly Type[];
  /** The variant constructors (e.g. `Ok`, `Err`). */
  readonly variants: readonly ADTVariant[];
  /** Type parameter declarations with constraints, used by DTS emitter for `extends` output. */
  readonly typeParams?: readonly TypeParam[];
}

/** A generic type parameter reference (e.g. `T` in a generic function body). */
export interface GenericType {
  readonly kind: 'generic';
  /** The parameter name. */
  readonly name: string;
}

/**
 * A type variable created during generic instantiation.
 *
 * Type variables are mutable: `resolved` is initially `undefined` and is
 * filled in during unification. Use {@link resolveType} to follow chains.
 */
export interface TypeVariable {
  readonly kind: 'typevar';
  /** Unique identifier for this type variable. */
  readonly id: number;
  /** The concrete type this variable resolved to, or `undefined` if still unresolved. */
  resolved?: Type;
}

/** Promise type wrapping an inner value type. */
export interface PromiseType {
  readonly kind: 'promise';
  /** The type of the resolved value. */
  readonly inner: Type;
}

/** Set type parameterized by element type. Maps to JavaScript's native `Set`. */
export interface SetType {
  readonly kind: 'set';
  readonly element: Type;
}

/** Map type parameterized by key and value types. Maps to JavaScript's native `Map`. */
export interface MapType {
  readonly kind: 'map';
  readonly key: Type;
  readonly value: Type;
}

/**
 * A literal type representing a single concrete value (e.g. `"GET"`, `42`, `true`).
 *
 * Literal types are subtypes of their base primitive — `"GET"` is assignable
 * to `string` but not vice versa. Used for precise union types like
 * `"GET" | "POST"` and exhaustive pattern matching on string/number values.
 */
export interface LiteralType {
  readonly kind: 'literal';
  /** Which primitive category this literal belongs to. */
  readonly base: 'string' | 'number' | 'boolean';
  /** The actual literal value. */
  readonly value: string | number | boolean;
}

/**
 * Error sentinel type.
 *
 * Returned when type checking fails for a node. Assignable to/from everything
 * to prevent cascading errors from a single root cause.
 */
export interface ErrorType {
  readonly kind: 'error';
}

// ── Supporting Types ────────────────────────────────────────

/** A single variant (constructor) of an {@link ADTType}. */
export interface ADTVariant {
  /** The variant name (e.g. `'Ok'`, `'Err'`). */
  readonly name: string;
  /** Named fields carried by this variant. Empty map for fieldless variants. */
  readonly fields: ReadonlyMap<string, Type>;
}

/**
 * How a nullable/optional parameter maps to JavaScript at the interop boundary.
 *
 * - `'null'`      — the JS side uses `null`
 * - `'undefined'` — the JS side uses `undefined` (e.g. optional params)
 * - `'either'`    — the JS side accepts both `null` and `undefined`
 */
export type NullKind = 'null' | 'undefined' | 'either';

/** A function parameter with its type information and optionality metadata. */
export interface ParamType {
  /** Parameter name as it appears in the source. */
  readonly name: string;
  /** The declared type of the parameter. */
  readonly type: Type;
  /** Whether the parameter is explicitly marked optional. */
  readonly optional: boolean;
  /** Whether the parameter has a default value. */
  readonly hasDefault: boolean;
  /** For interop params: how the JS side represents the null/absent value. */
  readonly nullKind?: NullKind;
}

/** A generic type parameter declaration (e.g. `T` in `<T>` or `T: Constraint` with an upper bound). */
export interface TypeParam {
  /** The type parameter name. */
  readonly name: string;
  /** Optional constraint (upper bound) for this type parameter. */
  readonly constraint?: Type;
}

// ── Exported Type Signatures ────────────────────────────────

/**
 * The public type signature exported by a module.
 *
 * Used by the module graph to resolve cross-file imports: the importing
 * module receives an {@link ExportedTypeSignature} and looks up the
 * imported names in the appropriate map.
 */
/** Metadata for an exported extension function, keyed by emit name. */
export interface ExportedExtension {
  readonly receiverType: Type;
  readonly methodName: string;
  readonly fnType: FunctionType;
  readonly emitName: string;
}

export interface ExportedTypeSignature {
  /** Exported type aliases and ADT type definitions, keyed by name. */
  readonly types: ReadonlyMap<string, Type>;
  /** Exported value bindings (functions, constants, constructors), keyed by name. */
  readonly values: ReadonlyMap<string, Type>;
  /** Exported ADT variant constructors, keyed by variant name. */
  readonly adtConstructors: ReadonlyMap<string, FunctionType>;
  /** Exported extension functions, keyed by emit name. */
  readonly extensions: ReadonlyMap<string, ExportedExtension>;
}

// ── Shared Type Constants ───────────────────────────────────
// Single source of truth for built-in types. Import these rather than
// constructing `{ kind: 'primitive', name: '...' }` inline.

export const NUM: PrimitiveType = { kind: 'primitive', name: 'number' };
export const STR: PrimitiveType = { kind: 'primitive', name: 'string' };
export const BOOL: PrimitiveType = { kind: 'primitive', name: 'boolean' };
export const VOID: PrimitiveType = { kind: 'primitive', name: 'void' };
export const NEVER: PrimitiveType = { kind: 'primitive', name: 'never' };
export const ANY: AnyType = { kind: 'any' };
export const NULL_TYPE: NullType = { kind: 'null' };
export const ERROR_TYPE: ErrorType = { kind: 'error' };

// ── Type Variable Factory ───────────────────────────────────

let nextTypeVarId = 0;

/** Reset the type variable counter. Call at the start of each compilation to
 *  ensure deterministic IDs across separate compilations (e.g., in tests). */
export function resetTypeVarCounter(): void {
  nextTypeVarId = 0;
}

/**
 * Allocate a fresh, unresolved type variable with a unique ID.
 *
 * @returns A new {@link TypeVariable} with `resolved` set to `undefined`.
 */
export function freshTypeVar(): TypeVariable {
  return { kind: 'typevar', id: nextTypeVarId++ };
}

// ── resolveType ─────────────────────────────────────────────

/**
 * Follow {@link TypeVariable} chains to find the resolved concrete type.
 *
 * Performs path compression: once the end of the chain is found, all
 * intermediate variables are updated to point directly to the final type.
 * This keeps subsequent lookups O(1).
 *
 * @param type - The type to resolve (may or may not be a type variable).
 * @returns The fully resolved type, or the original type if it is not a type variable.
 */
export function resolveType(type: Type): Type {
  if (type.kind === 'typevar') {
    if (type.resolved !== undefined) {
      const resolved = resolveType(type.resolved);
      // Path compression: cache the final resolved type
      type.resolved = resolved;
      return resolved;
    }
    return type;
  }
  return type;
}

// ── Lazy Record Helpers ─────────────────────────────────────

/**
 * Look up a field on a record-like type (either `RecordType` or `LazyRecordType`).
 *
 * For `RecordType`, reads directly from the `fields` map.
 * For `LazyRecordType`, checks the resolved cache first, then calls the
 * resolver and caches the result.
 *
 * @param type      - A record or lazy-record type.
 * @param fieldName - The field to look up.
 * @returns The field's type, or `undefined` if the field does not exist.
 */
export function lookupRecordField(type: RecordType | LazyRecordType, fieldName: string): Type | undefined {
  if (type.kind === 'record') {
    return type.fields.get(fieldName);
  }
  // Lazy record: check cache first
  const cached = type.resolvedFields.get(fieldName);
  if (cached !== undefined) return cached;

  // Resolve on demand (resolveField handles caching internally)
  return type.resolveField(fieldName);
}

/**
 * Check whether a type is a record-like type (either `RecordType` or `LazyRecordType`).
 */
export function isRecordLike(type: Type): type is RecordType | LazyRecordType {
  return type.kind === 'record' || type.kind === 'lazy-record';
}

// ── Nullable Helpers ────────────────────────────────────────

/**
 * Check whether a type is nullable (`T?`).
 *
 * @param type - The type to test (resolved through type variable chains).
 * @returns `true` if the resolved type has kind `'nullable'`.
 */
export function isNullable(type: Type): boolean {
  const resolved = resolveType(type);
  return resolved.kind === 'nullable';
}

/**
 * Strip one layer of nullability from a type.
 *
 * If `type` is `T?`, returns `T`. Otherwise returns the resolved type unchanged.
 *
 * @param type - The type to unwrap.
 * @returns The inner non-null type, or the original type if not nullable.
 */
export function unwrapNullable(type: Type): Type {
  const resolved = resolveType(type);
  if (resolved.kind === 'nullable') {
    return resolved.inner;
  }
  return resolved;
}

/**
 * Wrap a type in a nullable layer (`T?`), normalizing double-nullable (`T??` → `T?`).
 *
 * @param type - The type to make nullable.
 * @returns A {@link NullableType} wrapping the resolved inner type.
 */
export function makeNullable(type: Type): NullableType {
  const resolved = resolveType(type);
  // Normalize double-nullable: T?? → T?
  if (resolved.kind === 'nullable') {
    return resolved;
  }
  return { kind: 'nullable', inner: resolved };
}

// ── Type Comparison ─────────────────────────────────────────

/** Maximum recursion depth for type comparison and assignability checks. */
const MAX_DEPTH = 32;

/**
 * Structural equality check for two types.
 *
 * Resolves type variables before comparing. Two types are equal when they
 * have the same kind and all recursive sub-components are equal. Comparison
 * is depth-limited to {@link MAX_DEPTH} to guard against infinite recursion
 * on cyclic type variable chains.
 *
 * @param a     - First type to compare.
 * @param b     - Second type to compare.
 * @param depth - Current recursion depth (internal — callers should omit).
 * @returns `true` if the two types are structurally identical.
 */
export function typesEqual(a: Type, b: Type, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;

  const ra = resolveType(a);
  const rb = resolveType(b);

  // Lazy record identity: same resolver object means same type
  if (ra.kind === 'lazy-record' && rb.kind === 'lazy-record') {
    return ra === rb;
  }

  if (ra.kind !== rb.kind) return false;

  switch (ra.kind) {
    case 'primitive':
      return ra.name === (rb as PrimitiveType).name;

    case 'any':
    case 'null':
    case 'error':
      return true;

    case 'nullable':
      return typesEqual(ra.inner, (rb as NullableType).inner, depth + 1);

    case 'function': {
      const rbf = rb as FunctionType;
      if (ra.params.length !== rbf.params.length) return false;
      for (let i = 0; i < ra.params.length; i++) {
        if (!typesEqual(ra.params[i].type, rbf.params[i].type, depth + 1)) return false;
      }
      const aRest = ra.rest !== undefined;
      const bRest = rbf.rest !== undefined;
      if (aRest !== bRest) return false;
      if (aRest && bRest) {
        if (!typesEqual(ra.rest!.elementType, rbf.rest!.elementType, depth + 1)) return false;
      }
      return typesEqual(ra.returnType, rbf.returnType, depth + 1);
    }

    case 'record': {
      const rbr = rb as RecordType;
      if (ra.fields.size !== rbr.fields.size) return false;
      for (const [key, val] of ra.fields) {
        const otherVal = rbr.fields.get(key);
        if (otherVal === undefined || !typesEqual(val, otherVal, depth + 1)) return false;
      }
      return true;
    }

    case 'lazy-record':
      // Different lazy records with different resolvers are not equal
      // (same-resolver case handled above before the kind check)
      return false;

    case 'array':
      return typesEqual(ra.element, (rb as ArrayType).element, depth + 1);

    case 'tuple': {
      const rbt = rb as TupleType;
      if (ra.elements.length !== rbt.elements.length) return false;
      return ra.elements.every((el, i) => typesEqual(el, rbt.elements[i], depth + 1));
    }

    case 'union': {
      const rbu = rb as UnionType;
      if (ra.members.length !== rbu.members.length) return false;
      return ra.members.every((m, i) => typesEqual(m, rbu.members[i], depth + 1));
    }

    case 'adt': {
      const rba = rb as ADTType;
      if (ra.name !== rba.name) return false;
      if (ra.typeArgs.length !== rba.typeArgs.length) return false;
      return ra.typeArgs.every((arg, i) => typesEqual(arg, rba.typeArgs[i], depth + 1));
    }

    case 'generic':
      return ra.name === (rb as GenericType).name;

    case 'typevar':
      // Both are unresolved type variables
      return ra.id === (rb as TypeVariable).id;

    case 'promise':
      return typesEqual(ra.inner, (rb as PromiseType).inner, depth + 1);

    case 'set':
      return typesEqual(ra.element, (rb as SetType).element, depth + 1);

    case 'map': {
      const rbm = rb as MapType;
      return typesEqual(ra.key, rbm.key, depth + 1) && typesEqual(ra.value, rbm.value, depth + 1);
    }

    case 'literal':
      return ra.base === (rb as LiteralType).base && ra.value === (rb as LiteralType).value;
  }
}

// ── Assignability ───────────────────────────────────────────

/**
 * Check whether `source` is assignable to `target`.
 *
 * The assignability algorithm follows these rules (in priority order):
 * 1. `Any` and `Error` are assignable to/from everything.
 * 2. `never` (bottom type) is assignable to everything.
 * 3. Nothing is assignable to `never`.
 * 4. Exact structural equality via {@link typesEqual}.
 * 5. `T` is assignable to `T?` (and `null` is assignable to any `T?`).
 * 6. Union targets: source must match at least one member.
 * 7. Union sources: every member must be assignable to the target.
 * 8. Records: structural subtyping (width + depth).
 * 9. Functions: contravariant params, covariant return.
 * 10. Arrays/Tuples/Promises: covariant element types.
 * 11. ADTs: nominal — same name with compatible type arguments.
 * 12. Generics: same parameter name.
 *
 * @param source - The type being assigned.
 * @param target - The type being assigned to.
 * @param depth  - Current recursion depth (internal — callers should omit).
 * @returns `true` if the assignment is type-safe.
 */
export function isAssignableTo(source: Type, target: Type, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;

  const s = resolveType(source);
  const t = resolveType(target);

  // Any/Error are assignable to/from everything
  if (s.kind === 'any' || s.kind === 'error') return true;
  if (t.kind === 'any' || t.kind === 'error') return true;

  // Unresolved type variables are assignable to/from anything (fresh unknowns)
  if (s.kind === 'typevar') return true;
  if (t.kind === 'typevar') return true;

  // never is assignable to everything (bottom type)
  if (s.kind === 'primitive' && s.name === 'never') return true;

  // Nothing is assignable to never (except never/any/error handled above)
  if (t.kind === 'primitive' && t.name === 'never') return false;

  // Exact same type via typesEqual
  if (typesEqual(s, t, depth)) return true;

  // Literal → base primitive (subtype relationship)
  if (s.kind === 'literal' && t.kind === 'primitive') {
    return s.base === t.name;
  }

  // Base primitive → literal (NOT assignable — widening loses information)
  if (s.kind === 'primitive' && t.kind === 'literal') {
    return false;
  }

  // Union source FIRST: all members must be assignable to target
  // (Must come before nullable-target check so that `string | null` → `string?` works:
  //  each member is checked individually against the nullable target.)
  if (s.kind === 'union') {
    return s.members.every(m => isAssignableTo(m, t, depth + 1));
  }

  // T assignable to T?
  if (t.kind === 'nullable') {
    // null assignable to T?
    if (s.kind === 'null') return true;
    // T assignable to T? if T assignable to inner
    return isAssignableTo(s, t.inner, depth + 1);
  }

  // Union target: source must be assignable to at least one member
  if (t.kind === 'union') {
    return t.members.some(m => isAssignableTo(s, m, depth + 1));
  }

  // Record structural subtyping (width + depth) — includes lazy records
  if (isRecordLike(s) && isRecordLike(t)) {
    if (t.kind === 'record') {
      for (const [key, targetFieldType] of t.fields) {
        const sourceFieldType = lookupRecordField(s, key);
        if (sourceFieldType === undefined) return false;
        if (!isAssignableTo(sourceFieldType, targetFieldType, depth + 1)) return false;
      }
      return true;
    }
    // Target is lazy-record — cannot enumerate target fields without eager resolution.
    // Fall back to identity check (same lazy type is always assignable to itself).
    return s === t;
  }

  // Function subtyping: contravariant params, covariant return
  if (s.kind === 'function' && t.kind === 'function') {
    // Count required params in target
    const sRequiredCount = s.params.filter(p => !p.optional && !p.hasDefault).length;
    const tRequiredCount = t.params.filter(p => !p.optional && !p.hasDefault).length;

    // Source must have at least as many params to satisfy target's required,
    // and target must accept at least as many as source requires.
    // Simpler: source param count must be >= target required count
    // and source required count must be <= target total param count
    if (sRequiredCount > t.params.length) return false;
    if (s.params.length < tRequiredCount) return false;

    // Check param assignability (contravariant): target param type assignable to source param type
    const checkCount = Math.min(s.params.length, t.params.length);
    for (let i = 0; i < checkCount; i++) {
      if (!isAssignableTo(t.params[i].type, s.params[i].type, depth + 1)) return false;
    }

    // Covariant return type
    return isAssignableTo(s.returnType, t.returnType, depth + 1);
  }

  // Array covariance
  if (s.kind === 'array' && t.kind === 'array') {
    return isAssignableTo(s.element, t.element, depth + 1);
  }

  // Set covariance
  if (s.kind === 'set' && t.kind === 'set') {
    return isAssignableTo(s.element, t.element, depth + 1);
  }

  // Map covariance (both key and value)
  if (s.kind === 'map' && t.kind === 'map') {
    return isAssignableTo(s.key, t.key, depth + 1) && isAssignableTo(s.value, t.value, depth + 1);
  }

  // Tuple: same length, each element assignable
  if (s.kind === 'tuple' && t.kind === 'tuple') {
    if (s.elements.length !== t.elements.length) return false;
    return s.elements.every((el, i) => isAssignableTo(el, t.elements[i], depth + 1));
  }

  // ADT: nominal — same name and compatible type arguments
  if (s.kind === 'adt' && t.kind === 'adt') {
    if (s.name !== t.name) return false;
    if (s.typeArgs.length !== t.typeArgs.length) return false;
    return s.typeArgs.every((arg, i) => isAssignableTo(arg, t.typeArgs[i], depth + 1));
  }

  // Promise covariance
  if (s.kind === 'promise' && t.kind === 'promise') {
    return isAssignableTo(s.inner, t.inner, depth + 1);
  }

  // Generic: same name
  if (s.kind === 'generic' && t.kind === 'generic') {
    return s.name === t.name;
  }

  return false;
}

// ── Display ─────────────────────────────────────────────────

/**
 * Convert a type to its human-readable string representation for diagnostics.
 *
 * Resolves type variables before rendering. Unresolved type variables are
 * displayed as `?T<id>` (e.g. `?T0`). Uses a visited set to detect cycles
 * in self-referential types (e.g. recursive record fields) — cycles render
 * as `<recursive>` instead of recursing infinitely.
 *
 * @param type    - The type to render.
 * @param visited - Types currently being rendered (cycle detection). Callers should omit.
 * @returns A display string (e.g. `"string?"`, `"(number, string) => boolean"`).
 */
export function typeToString(type: Type, visited: Set<Type> = new Set()): string {
  const resolved = resolveType(type);

  // Cycle detection: if we're already rendering this type, break the cycle
  if (visited.has(resolved)) {
    return '<recursive>';
  }

  // Only `record` and `function` add themselves to `visited` before recursing.
  // Other wrapper types (nullable, array, union, etc.) are constructed bottom-up
  // with fully resolved sub-types, so object-identity cycles cannot form through them.
  switch (resolved.kind) {
    case 'primitive':
      return resolved.name;
    case 'any':
      return 'Any';
    case 'null':
      return 'null';
    case 'error':
      return '<error>';
    case 'nullable':
      return `${typeToString(resolved.inner, visited)}?`;
    case 'function': {
      visited.add(resolved);
      const paramParts = resolved.params.map(p => typeToString(p.type, visited));
      if (resolved.rest) {
        paramParts.push(`...${typeToString(resolved.rest.elementType, visited)}[]`);
      }
      const result = `(${paramParts.join(', ')}) => ${typeToString(resolved.returnType, visited)}`;
      visited.delete(resolved);
      return result;
    }
    case 'record': {
      visited.add(resolved);
      const fields = Array.from(resolved.fields.entries())
        .map(([name, t]) => `${name}: ${typeToString(t, visited)}`)
        .join(', ');
      visited.delete(resolved);
      return `{ ${fields} }`;
    }
    case 'lazy-record': {
      // Do NOT trigger eager resolution — show only already-resolved fields
      if (resolved.resolvedFields.size === 0) {
        return `{ ... (${resolved.propertyCount} properties) }`;
      }
      visited.add(resolved);
      const lazyFields = Array.from(resolved.resolvedFields.entries())
        .map(([name, t]) => `${name}: ${typeToString(t, visited)}`)
        .join(', ');
      visited.delete(resolved);
      const remaining = resolved.propertyCount - resolved.resolvedFields.size;
      const suffix = remaining > 0 ? `, ... (+${remaining})` : '';
      return `{ ${lazyFields}${suffix} }`;
    }
    case 'array':
      return `Array<${typeToString(resolved.element, visited)}>`;
    case 'tuple': {
      const elements = resolved.elements.map(e => typeToString(e, visited)).join(', ');
      return `(${elements})`;
    }
    case 'union':
      return resolved.members.map(m => typeToString(m, visited)).join(' | ');
    case 'adt': {
      if (resolved.typeArgs.length === 0) return resolved.name;
      const args = resolved.typeArgs.map(a => typeToString(a, visited)).join(', ');
      return `${resolved.name}<${args}>`;
    }
    case 'generic':
      return resolved.name;
    case 'typevar':
      return `?T${resolved.id}`;
    case 'promise':
      return `Promise<${typeToString(resolved.inner, visited)}>`;
    case 'set':
      return `Set<${typeToString(resolved.element, visited)}>`;
    case 'map':
      return `Map<${typeToString(resolved.key, visited)}, ${typeToString(resolved.value, visited)}>`;
    case 'literal':
      return resolved.base === 'string' ? `"${resolved.value}"` : String(resolved.value);
  }
}

// ── Literal Utilities ───────────────────────────────────────

/**
 * Widen a literal type to its base primitive type.
 *
 * Used for `let mut` bindings where the value can change, so the type
 * should be the wider primitive rather than the specific literal value.
 *
 * @param type - The type to widen.
 * @returns The base primitive if the type is a literal, otherwise the resolved type unchanged.
 */
export function widenLiteral(type: Type): Type {
  const resolved = resolveType(type);
  if (resolved.kind === 'literal') {
    return { kind: 'primitive', name: resolved.base } as PrimitiveType;
  }
  return resolved;
}

// ── Union Utilities ─────────────────────────────────────────

/**
 * Recursively flatten nested union types into a single flat list of members.
 *
 * For example, `(A | B) | C` becomes `[A, B, C]`.
 *
 * @param members - The union members to flatten.
 * @returns A flat array of non-union member types.
 */
export function flattenUnion(members: readonly Type[]): readonly Type[] {
  const result: Type[] = [];
  for (const member of members) {
    const resolved = resolveType(member);
    if (resolved.kind === 'union') {
      result.push(...flattenUnion(resolved.members));
    } else {
      result.push(resolved);
    }
  }
  return result;
}

/**
 * Flatten and deduplicate a list of union members into a simplified type.
 *
 * - Nested unions are flattened via {@link flattenUnion}.
 * - Duplicate members (by {@link typesEqual}) are removed.
 * - If zero members remain, returns `never`.
 * - If one member remains, returns it directly (no union wrapper).
 * - Otherwise returns a {@link UnionType} with the deduplicated members.
 *
 * @param members - The union members to simplify.
 * @returns The simplified type.
 */
export function simplifyUnion(members: readonly Type[]): Type {
  const flat = flattenUnion(members);

  // Deduplicate
  const unique: Type[] = [];
  for (const t of flat) {
    if (!unique.some(u => typesEqual(t, u))) {
      unique.push(t);
    }
  }

  if (unique.length === 0) {
    return { kind: 'primitive', name: 'never' } as PrimitiveType;
  }
  if (unique.length === 1) {
    return unique[0];
  }

  // Primitive absorbs literals: `string | "hello"` → `string`
  const afterAbsorption = unique.filter(t => {
    if (t.kind !== 'literal') return true;
    return !unique.some(u => u.kind === 'primitive' && u.name === t.base);
  });

  if (afterAbsorption.length === 0) {
    return { kind: 'primitive', name: 'never' } as PrimitiveType;
  }
  if (afterAbsorption.length === 1) {
    return afterAbsorption[0];
  }

  // Boolean literal collapse: `true | false` → `boolean`
  let hasTrueLit = false;
  let hasFalseLit = false;
  for (const t of afterAbsorption) {
    if (t.kind === 'literal' && t.base === 'boolean') {
      if (t.value === true) hasTrueLit = true;
      if (t.value === false) hasFalseLit = true;
    }
  }
  let simplified = afterAbsorption;
  if (hasTrueLit && hasFalseLit) {
    simplified = afterAbsorption.filter(t => !(t.kind === 'literal' && t.base === 'boolean'));
    simplified.push(BOOL);
  }

  if (simplified.length === 1) {
    return simplified[0];
  }

  // ADT unification: if all members are the same ADT, merge type args
  if (simplified.length >= 2 && simplified.every(t => t.kind === 'adt')) {
    const adts = simplified as ADTType[];
    const firstName = adts[0].name;
    if (adts.every(a => a.name === firstName && a.typeArgs.length === adts[0].typeArgs.length)) {
      const mergedArgs: Type[] = [];
      for (let i = 0; i < adts[0].typeArgs.length; i++) {
        const argCandidates = adts.map(a => resolveType(a.typeArgs[i]));
        // Pick the first concrete (non-typevar) arg, or fall back to the first one
        const concrete = argCandidates.find(a => a.kind !== 'typevar');
        mergedArgs.push(concrete ?? argCandidates[0]);
      }
      return {
        kind: 'adt',
        name: firstName,
        typeArgs: mergedArgs,
        variants: adts[0].variants,
      };
    }
  }

  return { kind: 'union', members: simplified };
}
