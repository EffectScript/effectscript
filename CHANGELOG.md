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
- String, number, and boolean literal types: `"GET" | "POST"`, `1 | 2 | 3`, `true | false`
- Const inference: immutable `let` bindings infer literal types (`let x = "hello"` has type `"hello"`), mutable `let mut` widens to base primitive
- Literal type aliases: `type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"`
- Exhaustive pattern matching on literal union types with E203 for missing patterns
- Literal types in function parameters and return types
- Union simplification: primitive absorbs literals (`string | "hello"` → `string`), `true | false` → `boolean`
- TypeScript interop: string/number/boolean literal types from `.d.ts` files are now preserved (previously collapsed to base primitive)
- DTS emission for literal types and literal union type aliases
- Imported type aliases are now available in type annotation position (fixes cross-file `type` imports)
- Generic type parameter constraints: `<T: { name: string }>` restricts type arguments to satisfy the constraint
- Intersection types: `&` operator for combining record types (e.g., `{ name: string } & { age: number }`)
- Constraint-based field access: accessing fields on a constrained generic inside a function body (e.g., `item.name` when `T: { name: string }`)
- Constraint validation at call sites for both inferred and explicit type arguments (E250)
- ADT type parameter constraints: `type Container<T: { id: string }> = Boxed(value: T)` validates constructor arguments
- DTS emission: constrained type params emit `extends` keyword (e.g., `<T extends { name: string }>`)
- TypeScript interop: generic constraints are extracted from `.d.ts` declarations and enforced when calling imported functions
- Diagnostic code E250 (type does not satisfy constraint) and E251 (non-record intersection member)
- Value parameter semantics: function parameters are deeply immutable by default, rejecting mutation via E240 (mutating method calls) and E241 (property assignment)
- `mut` keyword on function parameters to opt into content mutation: `(mut items: Array<number>)`
- Mutating method detection for `Array` (`push`, `pop`, `shift`, `unshift`, `sort`, `reverse`, `splice`, `fill`), `Set` (`add`, `delete`, `clear`), and `Map` (`set`, `delete`, `clear`)
- Deep immutability enforcement: member chains trace back to the root parameter binding
- Extension function parameters also follow value parameter semantics
- Named arguments at call sites: `greet(name: "Alice", greeting: "Hi")` with Kotlin-style positional-before-named rule
- Named arguments can skip defaulted parameters and reorder arguments for readability
- Diagnostic codes E253 (positional after named), E254 (unknown parameter name), E255 (parameter already provided)
- Range loops: `for (i in 0..<10)` (exclusive) and `for (i in 0..10)` (inclusive) compile to efficient C-style for loops
- Record destructuring in for loops: `for ({ name, age } in users)` binds fields from array elements
- Tuple destructuring in for loops: `for ((key, value) in pairs)` with wildcard support `(_, item)`
- `withIndex()` method on arrays returning `Array<(number, T)>` for indexed iteration
- `withIndex()` in for-loop position optimized to `.entries()` instead of creating intermediate array
- Diagnostic codes E261 (non-number range bound), E262 (cannot destructure type), E263 (tuple arity mismatch), E264 (destructuring with range)

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
