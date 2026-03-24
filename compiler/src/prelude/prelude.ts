/**
 * @module prelude
 *
 * Built-in declarations automatically available in every EffectScript program.
 *
 * The prelude provides:
 * - **`Result<T, E>`** ADT with `Ok` and `Err` variant constructors.
 * - **`attempt<T>(f: () => T): Result<T, Error>`** — wraps a throwing
 *   function in a `Result`.
 * - **`print(value: Any): void`** — prints a value (maps to `console.log`
 *   in the JS backend).
 *
 * {@link createPrelude} builds the type definitions and {@link registerPrelude}
 * injects them into a {@link ScopeManager} so the checker sees them as
 * immutable, always-referenced bindings.
 */

import type {
  Type,
  FunctionType,
  ADTType,
  GenericType,
  ADTVariant,
  RecordType,
  SetType,
  MapType,
  ArrayType,
} from '../checker/types.js';
import { ANY, VOID } from '../checker/types.js';
import type { ScopeManager, BindingInfo } from '../checker/scope.js';
import type { Span } from '../utils/span.js';

// ── Public API ──────────────────────────────────────────────

/** The prelude's exported declarations, split into types, values, and ADT constructors. */
export interface PreludeDeclarations {
  /** Type definitions (e.g. `Result<T, E>`). */
  readonly types: ReadonlyMap<string, Type>;
  /** Value bindings (functions and constructors: `Ok`, `Err`, `attempt`, `print`). */
  readonly values: ReadonlyMap<string, Type>;
  /** ADT variant constructors (subset of values, used for pattern matching). */
  readonly adtConstructors: ReadonlyMap<string, FunctionType>;
}

/** Prelude identifier names — single source of truth for checker and emitter. */
export const PRELUDE_NAMES = {
  print: 'print',
  Ok: 'Ok',
  Err: 'Err',
  attempt: 'attempt',
  Result: 'Result',
  Set: 'Set',
  Map: 'Map',
} as const;

/** Synthetic source span used for all prelude declarations (`<prelude>` file). */
const preludeSpan: Span = {
  file: '<prelude>',
  start: { offset: 0, line: 0, column: 0 },
  end: { offset: 0, line: 0, column: 0 },
};

/**
 * Create the prelude declarations: `Result<T, E>`, `Ok`, `Err`, `attempt`, and `print`.
 *
 * This builds the full type structure for each built-in, including generic
 * type parameters and ADT variants, and populates the types/values/constructors maps.
 *
 * @returns A {@link PreludeDeclarations} object ready to be registered into a scope.
 */
export function createPrelude(): PreludeDeclarations {
  const types = new Map<string, Type>();
  const values = new Map<string, Type>();
  const adtConstructors = new Map<string, FunctionType>();

  // ── Generic type params ──
  const T: GenericType = { kind: 'generic', name: 'T' };
  const E: GenericType = { kind: 'generic', name: 'E' };
  const errorGeneric: GenericType = { kind: 'generic', name: 'Error' };

  // ── Result<T, E> ADT ──
  const okVariant: ADTVariant = {
    name: 'Ok',
    fields: new Map([['value', T]]),
  };
  const errVariant: ADTVariant = {
    name: 'Err',
    fields: new Map([['error', E]]),
  };
  const resultType: ADTType = {
    kind: 'adt',
    name: 'Result',
    typeArgs: [T, E],
    variants: [okVariant, errVariant],
  };
  types.set('Result', resultType);

  // ── Ok constructor: <T, E>(value: T) => Result<T, E> ──
  const okConstructor: FunctionType = {
    kind: 'function',
    params: [{ name: 'value', type: T, optional: false, hasDefault: false }],
    returnType: resultType,
    typeParams: [{ name: 'T' }, { name: 'E' }],
  };
  adtConstructors.set('Ok', okConstructor);
  values.set('Ok', okConstructor);

  // ── Err constructor: <T, E>(error: E) => Result<T, E> ──
  const errConstructor: FunctionType = {
    kind: 'function',
    params: [{ name: 'error', type: E, optional: false, hasDefault: false }],
    returnType: resultType,
    typeParams: [{ name: 'T' }, { name: 'E' }],
  };
  adtConstructors.set('Err', errConstructor);
  values.set('Err', errConstructor);

  // ── attempt<T>(f: () => T): Result<T, Error> ──
  const attemptReturnType: ADTType = {
    kind: 'adt',
    name: 'Result',
    typeArgs: [T, errorGeneric],
    variants: [okVariant, errVariant],
  };
  const attemptFn: FunctionType = {
    kind: 'function',
    params: [{
      name: 'f',
      type: {
        kind: 'function',
        params: [],
        returnType: T,
      } as FunctionType,
      optional: false,
      hasDefault: false,
    }],
    returnType: attemptReturnType,
    typeParams: [{ name: 'T' }],
  };
  values.set('attempt', attemptFn);

  // ── print(value: Any): void ──
  const printFn: FunctionType = {
    kind: 'function',
    params: [{ name: 'value', type: ANY, optional: false, hasDefault: false }],
    returnType: VOID,
  };
  values.set('print', printFn);

  // ── Set companion: { of: <T>(items: Array<T>) => Set<T> } ──
  const K: GenericType = { kind: 'generic', name: 'K' };
  const V: GenericType = { kind: 'generic', name: 'V' };

  const setOfFn: FunctionType = {
    kind: 'function',
    typeParams: [{ name: 'T' }],
    params: [{
      name: 'items',
      type: { kind: 'array', element: T } as ArrayType,
      optional: false,
      hasDefault: false,
    }],
    returnType: { kind: 'set', element: T } as SetType,
  };
  const setCompanion: RecordType = {
    kind: 'record',
    fields: new Map([['of', setOfFn as Type]]),
  };
  values.set('Set', setCompanion);

  // ── Map companion: { of: <K, V>() => Map<K, V> } ──
  // Map.of() takes no arguments — tuple expression syntax `("a", 1)` does not
  // exist in the parser, so `Map.of([("a", 1)])` is not possible. Users create
  // maps with `Map.of()` and populate via `.set()` calls. When tuple expression
  // syntax is added, the signature can be upgraded to `Map.of(Array<(K,V)>)`.
  const mapOfFn: FunctionType = {
    kind: 'function',
    typeParams: [{ name: 'K' }, { name: 'V' }],
    params: [],
    returnType: { kind: 'map', key: K, value: V } as MapType,
  };
  const mapCompanion: RecordType = {
    kind: 'record',
    fields: new Map([['of', mapOfFn as Type]]),
  };
  values.set('Map', mapCompanion);

  return { types, values, adtConstructors };
}

/**
 * Register prelude declarations into a scope manager.
 *
 * Types are registered via {@link ScopeManager.declareType}. Values (including
 * ADT constructors) are registered as immutable bindings with `referenced: true`
 * so they never trigger unused-variable warnings.
 *
 * @param prelude - The prelude declarations to register.
 * @param scope   - The scope manager to inject declarations into.
 */
export function registerPrelude(prelude: PreludeDeclarations, scope: ScopeManager): void {
  // Register types
  for (const [name, type] of prelude.types) {
    scope.declareType(name, type);
  }

  // Register values (including ADT constructors)
  for (const [name, type] of prelude.values) {
    const info: BindingInfo = {
      type,
      mutable: false,
      declared: preludeSpan,
      referenced: true, // prelude bindings are always considered "referenced"
    };
    scope.declare(name, info);
  }
}
