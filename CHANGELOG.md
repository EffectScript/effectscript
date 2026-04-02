# Changelog

## [0.3.0] - Unreleased

### Added
- Tuple expressions: `let pair = (1, "hello")` creates a tuple value (compiles to JS array)
- Tuple positional indexing: `pair.0`, `pair.1` access tuple elements by position (compiles to bracket access)
- Let tuple destructuring: `let (a, b) = pair` destructures into individual bindings
- Tuple patterns in match: `(0, _) => "zero"` for structural matching on tuples
- Bidirectional type inference for tuple expressions with expected type context
- Diagnostic codes E270 (index out of bounds), E271 (arity mismatch), E272 (expected tuple for destructuring), E273 (expected tuple for pattern)
- Generic inference through tuples: `<T>(x: (T, T)): T` correctly infers from tuple arguments
- `bigint` primitive type: type annotations (`let x: bigint = 42n`), bigint literals (`42n`, `0xFFn`), type-safe arithmetic (`+`, `-`, `*`, `/`, `%` between bigint values), unary negation, nullable `bigint?`
- `symbol` primitive type: type annotations (`let x: symbol`), nullable `symbol?`, equality comparison
- BigInt literal tokenization in the lexer (`BigIntLiteral` token kind)
- `BigIntLiteral` AST node with string-based `raw` field for precision preservation
- Mixed `bigint`/`number` arithmetic is rejected with E216
- TypeScript interop: `bigint`, `symbol`, `unique symbol`, and bigint literal types now map to proper EffectScript primitives instead of `Any` (no more W301 warnings)
- Diagnostic E006: BigInt literals cannot have a decimal part (`3.14n` is rejected)

### Added (continued)
- Record field mutability: fields are immutable by default (bare), use `var` prefix for mutable fields (`type T = { name: string, var score: number }`)
- Diagnostic E275: assignment to immutable record field with fix suggestion and related span pointing to field declaration
- Value type checking on member expression assignments (bundled fix for pre-existing gap)
- DTS emitter: immutable fields emit `readonly`, mutable fields emit bare (matching TypeScript conventions)
- TypeScript interop: `readonly` properties map to immutable fields, non-`readonly` properties map to mutable fields
- `typeToString` shows `var` prefix on mutable fields in diagnostic messages (e.g., `{ var score: number }`)
- `typesEqual` considers `mutableFields` for exact type identity (records with different mutability are different types)
- Generic instantiation preserves `mutableFields` through type parameter substitution
- Structural interfaces: `interface Serializable { fun serialize(): string }` defines type contracts with methods and properties
- Interface extension: `interface ReadableCollection<T> extends Collection<T> { ... }` for interface inheritance
- Generic interfaces with type parameter substitution: `interface Box<T> { let value: T }`
- Interface structural satisfaction: records satisfy interfaces via matching properties/fields (no explicit `implements` required)
- `export interface` declarations emit `export interface` in `.d.ts` output; type-erased in JS (no runtime cost)
- Readonly (`let`) and mutable (`var`) interface properties with assignment enforcement
- `interface` and `extends` are now reserved keywords
- TS `declare class` imports are now constructable via `new ClassName(args)` — classes map to `InterfaceType` with constructor signatures instead of degraded record types
- TS interfaces map to `InterfaceType` preserving method signatures, optional members, readonly/mutable properties, and extends hierarchy
- TS callable interfaces (call signatures) map to `__call` method entries, enabling `obj()` syntax on interface-typed values
- Static vs instance member separation for TS classes: `typeof Command` (class value) vs `Command` (instance type)
- Diagnostic codes E282 (duplicate interface member), E283 (circular extends), E284 (no constructor for `new`), E285 (reserved `__call` name)
- W210 warning on explicit `Any` type annotations: `let x: Any = ...` emits a warning encouraging more specific types
- W210 detects `Any` at all nesting levels: type arguments (`Array<Any>`), nullable (`Any?`), function types, record fields, union members, tuple elements, intersection members, and generic constraints
- Catch parameters now typed as `{ message: string, name: string, stack: string? }` instead of `Any`, providing safe access to standard Error fields
- Index signature types (dictionary types): `{ [string]: T }` and `{ [number]: T }` for dynamic key-value patterns
- Mixed named fields with index signatures: `{ status: number, [string]: Any }`
- `IndexExpr` bracket access: `obj["key"]`, `obj[variable]`, `obj?.["key"]` for optional chaining
- Index access returns nullable (`T?`) for null safety — string literal bracket access on named fields returns the field type (non-nullable)
- Assignment to bracket expressions on mutable bindings: `config["key"] = "value"`
- Array bracket access: `arr[0]` returns `T?` (nullable element type)
- Tuple bracket access: `pair[0]` returns exact element type (non-nullable); dynamic index returns nullable union
- Generic index signature type aliases: `type Container<T> = { [string]: T }` with proper instantiation
- TypeScript interop: TS index signatures (`{ [key: string]: T }`, `Record<string, T>`) now map to `IndexSignatureType` instead of empty record types
- Diagnostic codes E120 (invalid index signature key type), E290 (key type mismatch), E291 (no index signature), E292 (field incompatible with index value type), E293 (duplicate index signature)
- Platform types: unmappable TypeScript types (conditional types, recursive cycles, budget-capped interfaces) now produce platform types (`T!`) instead of falling back to `Any`, preserving partial structural type information
- W303 warning when platform-typed values are used in contexts where the approximation could cause runtime issues (function arguments, return values, arithmetic, match subjects, assignments to exact-typed bindings)
- W304 warning when recursive type substitution exceeds the depth limit (emitted once per substitution)
- W305 warning when lazy property resolution exceeds the budget cap on large interfaces
- `typeToString` renders platform types with `!` suffix in diagnostic messages (e.g., `string!`, `{ name: string }!`)
- Platform-aware type checker: field access, null narrowing, pattern matching, `await`, `for` loops, and binary operators all unwrap platform types to operate on the inner type
- `makePlatform` factory normalizes nested platform wrappers and collapses error type wrapping
- `substitute()` depth limit (MAX_SUBSTITUTE_DEPTH=40) with cycle detection returns platform types instead of `Any` on recursive type cycles
- Conditional type evaluation: TypeScript conditional types (`T extends U ? A : B`) are now resolved to concrete EffectScript types instead of falling back to `Any`. Uses a 4-strategy resolution pipeline: single resolved branch, base constraint, apparent type, and branch union construction. Enables type-safe interop with TS libraries using `ReturnType<T>`, `NonNullable<T>`, `Extract<T, U>`, `Exclude<T, U>`, `Awaited<T>`, and other conditional utility types.

### Fixed
- Arrow function callees in call expressions now emit valid IIFE syntax with wrapping parentheses: `(async () => { ... })()` instead of `async () => { ... }()`
- `Date` is now available as a built-in global: `new Date()`, `new Date("2026-12-25")`, `new Date(0)`, `Date.now()`, and instance methods (`getTime`, `toISOString`, `getFullYear`, etc.)
- `Promise<T>` now has built-in `.then()`, `.catch()`, and `.finally()` methods (previously produced E209 "Property does not exist on type 'Promise<T>'")
- Rest parameters on generic imported functions now correctly substitute type parameters (e.g., `arrayOf<T>(...items: T[])` works with inferred and explicit type args)
- Function type substitution (`substituteTypeParams` and `substitute`) now preserves rest parameter fields instead of dropping them
- Disk cache serialization/deserialization now round-trips rest parameter metadata
- DTS emitter now includes rest parameters in emitted function type signatures (e.g., `(msg: string, ...args: string[]) => void`)
- Function assignability (`isAssignableTo`) now correctly handles rest parameters on source and target types
- Recursive type definitions (e.g., React's `ReactNode`) no longer crash the compiler with stack overflow in `substitute()`, `substituteType()`, `flattenUnion()`, or `typeToString()` — cycles are detected via visited sets and broken by returning `Any`
- Large type surfaces (lodash, hono) no longer cause out-of-memory crashes — interfaces above 30 properties use lazy on-demand resolution instead of eagerly mapping all properties

### Changed
- **Breaking**: `let mut` syntax replaced with `var` for mutable variable declarations (`var counter = 0`)
- **Breaking**: `mut` keyword on function parameters renamed to `var` (`(var items: Array<number>)`)
- `mut` is no longer a reserved keyword and can be used as an identifier
- **Breaking**: Catch parameter `e` in `try { } catch (e) { }` is now typed as `{ message: string, name: string, stack: string? }` instead of `Any`. Code that relied on `e` being `Any` (e.g., `let s: string = e`) will now get E200 type errors. Use `e.message` for the error message string.

### Verified
- Optional parameters from TypeScript `.d.ts` files are correctly omittable at call sites (regression tests added for direct calls, interface method calls, all-optional params, and hasDefault params)

## [0.2.0] - 2026-03-25

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
