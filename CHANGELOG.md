# Changelog

## [0.2.0] - Unreleased

### Added
- Extension functions: `fun Type.method(): ReturnType => body` adds methods to existing types
- `fun` and `this` keywords for extension function declarations
- `this` refers to the receiver inside extension function bodies
- Extension calls compile to static function calls: `"hello".shout()` → `string_shout("hello")`
- Cross-module extension support via emit name imports (`import { string_shout } from "./utils"`)
- Generic extension functions: `fun <T> Array<T>.first(): T? => this.at(0)`
- Diagnostic codes E220-E223 for extension function errors
- `async` and `await` keywords for asynchronous programming
- `Promise<T>` as a built-in type in type annotations
- Async arrow functions: `async (params): Promise<T> => body`
- `await` expression to unwrap `Promise<T>` to `T`
- Type checking: E230 (async must return Promise), E231 (await outside async), E232 (await non-Promise)
- Async-aware IIFEs for `match`, `block`, `try/catch`, and `if` in expression position inside async functions
- Async `attempt` overload: `attempt(async () => ...)` returns `Promise<Result<T, Error>>`
- `__attempt_async` runtime helper emitted only when async attempt is used
- Return type validation for sync functions (prerequisite for async)
- `esc run` now emits `package.json` with `"type": "module"` for ESM support
- `Set<T>` built-in collection type with 12 methods (has, add, delete, toArray, map, filter, union, intersect, difference, forEach, clear, size)
- `Map<K, V>` built-in collection type with 11 methods (get, has, set, delete, clear, keys, values, entries, forEach, map, size)
- Factory methods: `Set.of(items)` and `Map.of()` for constructing collections
- Null-safe `Map.get()` returns `V?` (nullable)
- Non-passthrough codegen for collection methods (e.g. `s.toArray()` → `Array.from(s)`, `m.get(k)` → `m.get(k) ?? null`)
- 12 new `Array<T>` methods: first, last, find, findIndex, indexOf, flatMap, reduce, fold, every, some, isEmpty, sort
- TypeScript interop: `Set`/`ReadonlySet`/`Map`/`ReadonlyMap` mapped from `.d.ts` files
- DTS emission for `Set<T>` and `Map<K, V>` types
- Unresolved type variables are now assignable to any type (enables `Map.of([])` / `Set.of([])` with type annotation)
- Reserved keywords are now valid in member access position (`.catch()`, `.delete()`, `.throw()`, `.return()`, `.for()`, `.new()`, `.import()`), record expression fields (`{ catch: handler }`), and record patterns
- Rest parameters for imported TypeScript functions: variadic arguments are type-checked against the rest element type
- `Any` type is now callable, supports binary operators, member access, and `new` expressions (returns `Any` in all cases)
- Alias re-exports (`import * as z from "./lib"; export { z }`) are now resolved via `getAliasedSymbol()` instead of being silently dropped
- Overloaded TypeScript functions now use the most general (last) signature instead of the first, matching TypeScript's convention
- Enum member access: TypeScript enums are mapped to record types with named fields (e.g., `Direction.Up` resolves correctly)
- Static class members are now extracted from TypeScript classes (e.g., `Promise.resolve()`)
- Branded intersections (`string & { __brand: "X" }`) now map to the base type instead of losing it

### Removed
- Pipe operator (`|>`). Use nested function calls (`g(f(x))`) or method chaining instead.

### Fixed
- `Ok()` and `Err()` constructors in different branches of `if/else`, `match`, and `try/catch` now properly unify their generic type parameters when checked against a `Result<T, E>` return type or binding annotation
- Optional parameters from TypeScript declarations are now correctly detected (including `questionToken` patterns), allowing calls with fewer arguments
- `typeToString()` no longer crashes with stack overflow on recursive type definitions (e.g. React's `ReactNode`, Express's `Request`, Axios's `AxiosPromise`)
- DTS emission for ADT variants with parameterized types (e.g. `Set<T>`, `Map<K, V>` fields) now includes generic type arguments
- `export = X` (CommonJS-style default export) now recognized as a default import, unblocking React, Express, Lodash, Axios, and other major npm packages
- Namespace members merged from `export = X` + `declare namespace X` patterns are exposed as named exports (matching TypeScript's `esModuleInterop` behavior)
- `.d.cts` and `.d.mts` declaration files are now correctly classified as declaration files (were misclassified as `'js'`)
