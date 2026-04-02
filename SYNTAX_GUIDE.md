# EffectScript Syntax Guide

> **Version**: v0.3
> **File extension**: `.efs`
> **Compile target**: JavaScript (ES2020+)

EffectScript is a statically typed language that compiles to JavaScript. It borrows ideas from Kotlin and Rust — null safety, immutability by default, algebraic data types, pattern matching — while maintaining seamless bidirectional TypeScript/JS interop.

This document is a complete reference for writing EffectScript. Every syntactic form the language supports is described here with examples.

---

## Table of Contents

1. [Basics](#1-basics)
2. [Variables](#2-variables)
3. [Types](#3-types)
4. [Functions](#4-functions)
5. [Expressions](#5-expressions)
6. [Control Flow](#6-control-flow)
7. [Pattern Matching](#7-pattern-matching)
8. [Algebraic Data Types (ADTs)](#8-algebraic-data-types-adts)
9. [Records](#9-records)
10. [Interfaces](#10-interfaces)
11. [Collections (Arrays, Sets, Maps)](#11-collections-arrays-sets-maps)
12. [Strings](#12-strings)
13. [Null Safety](#13-null-safety)
14. [Operators](#14-operators)
15. [Error Handling](#15-error-handling)
16. [Modules](#16-modules)
17. [Loops](#17-loops)
18. [Comments](#18-comments)
19. [Built-in Prelude](#19-built-in-prelude)
20. [Built-in Methods](#20-built-in-methods)
21. [JS/TS Interop](#21-jsts-interop)
22. [Compilation Output](#22-compilation-output)
23. [Syntactic Rules and Constraints](#23-syntactic-rules-and-constraints)
24. [Complete Example Programs](#24-complete-example-programs)

---

## 1. Basics

### Hello World

```
let greeting = "hello, world"
print(greeting)
```

- `print` is a built-in function (compiles to `console.log`).
- Semicolons are **optional**. Newlines separate statements.
- There is no `main` function — top-level code executes directly.

### Comments

```
// This is a line comment

/* This is a
   block comment */
```

---

## 2. Variables

### Immutable bindings (default)

```
let x = 42
let name = "Alice"
let nums = [1, 2, 3]
```

Immutable bindings cannot be reassigned. They compile to `const` in JavaScript.

### Mutable bindings

```
var counter = 0
counter = counter + 1
counter = 10
```

`var` allows reassignment. Compiles to `let` in JavaScript. Attempting to reassign an immutable binding is a compile error (E202). Note: `var` in EffectScript is block-scoped (like `let` in JavaScript), NOT function-scoped (like `var` in JavaScript). There is no hoisting.

### Type annotations

Type annotations are optional — types are inferred when omitted.

```
let x: number = 42
let name: string = "Alice"
let flag: boolean = true
let big: bigint = 42n
let sym: symbol = Symbol("desc")   // requires TS interop
var count: number = 0
```

### BigInt literals

BigInt literals use the `n` suffix on integer literals, matching JavaScript syntax:

```
let a = 42n
let b = 0n
let c = 9007199254740993n
let hex = 0xFFn
```

Floating-point bigint literals (`3.14n`) are not allowed and produce a compile error (E006).

### Exporting variables

```
export let greeting = "hello"
export var counter = 0
export let add = (a: number, b: number): number => a + b
```

---

## 3. Types

### Primitive types

| Type | Description | Example values |
|------|-------------|---------------|
| `number` | 64-bit floating point | `42`, `3.14`, `0xFF` |
| `string` | UTF-16 string | `"hello"`, `"hi ${name}"` |
| `boolean` | Boolean | `true`, `false` |
| `bigint` | Arbitrary-precision integer | `42n`, `0n`, `0xFFn` |
| `symbol` | Unique identifier | `Symbol("desc")` (via TS interop) |
| `void` | No meaningful value | (return type of side-effect functions) |
| `never` | Impossible type | (functions that always throw) |
| `Any` | Escape hatch, compatible with all types (W210 warning) | (interop fallback) |
| `null` | Null literal type | `null` |

### `Any` type restrictions

`Any` is bidirectionally assignable (compatible with all types), but the compiler actively discourages its use. Writing an explicit `Any` type annotation anywhere produces warning W210:

```
let x: Any = getValue()         // W210: Explicit 'Any' type annotation
let f: (Any) => string = ...    // W210 on the parameter type
let a: Array<Any> = [1, 2, 3]   // W210 on the nested Any
```

W210 fires on `Any` at any nesting level: type arguments, nullable inner types, function parameters and return types, record fields, union members, tuple elements, intersection members, and generic constraints.

W210 does **not** fire on:
- `Any` inferred from interop (no user annotation to warn on)
- `Any` assigned by error recovery (internal `<error>` type)
- `Any` in prelude-defined types (e.g., `print(value: Any)`)

W210 is a warning, not an error -- code with `Any` annotations still compiles normally.

### BigInt literals

BigInt literals use the `n` suffix on integer literals, matching JavaScript syntax:

```
let a = 42n
let b = 0n
let c = 9007199254740993n    // beyond Number.MAX_SAFE_INTEGER
let hex: bigint = 0xFFn
```

BigInt literals are inferred as type `bigint`. Floating-point bigint literals are not allowed:

```
let bad = 3.14n   // ERROR: BigInt literals cannot have a decimal part
```

Arithmetic operators work within `bigint` but not across `bigint` and `number`:

```
let sum = 10n + 20n   // OK: bigint
let bad = 10n + 5     // ERROR: Operator '+' cannot be applied to types 'bigint' and 'number'
```

Unary negation works on bigint: `-42n` is parsed as `-(42n)` and produces `bigint`.

### Symbol type

The `symbol` type represents unique JavaScript symbols. Symbol values are created via the global `Symbol()` function (available through TS interop):

```
let sym: symbol = Symbol("description")
```

Symbols support only equality comparison (`==`, `!=`). They have no arithmetic operators and no methods.

### Composite types

```
// Array type
Array<number>
Array<string>
Array<Array<number>>

// Set type
Set<string>
Set<number>

// Map type
Map<string, number>
Map<string, Array<number>>

// Promise type
Promise<number>
Promise<string>
Promise<void>

// Nullable type (T or null)
string?
number?
Array<string>?
Set<string>?
Map<string, number>?

// Union type
string | number
string | number | boolean

// Tuple type
(string, number)
(boolean, string, number)

// Function type
(number) => string
(number, string) => boolean
() => void

// Record type (structural)
{ name: string, age: number }
{ name: string, age?: number }     // optional field

// Index signature type (dictionary)
{ [string]: number }
{ [number]: string }
{ status: number, [string]: Any }  // mixed named fields + index

// Intersection type (merges record types)
{ name: string } & { age: number }    // equivalent to { name: string, age: number }
```

### Tuples

Tuples are fixed-length, heterogeneous sequences. They compile to JavaScript arrays.

#### Tuple expressions

Two or more comma-separated expressions inside parentheses create a tuple. A single-element `(expr)` is a grouped expression, not a tuple.

```
let pair = (1, "hello")                    // (number, string)
let triple = ("a", 42, true)              // (string, number, boolean)
let nested = ((1, 2), (3, 4))            // ((number, number), (number, number))
let annotated: (string, number) = ("hi", 1)
```

#### Positional indexing

Access tuple elements by position using dot-numeric syntax:

```
let pair = (1, "hello")
let x = pair.0     // 1 (number)
let y = pair.1     // "hello" (string)
```

Out-of-bounds indices produce a compile-time error (E270).

#### Let tuple destructuring

Destructure a tuple into individual bindings:

```
let pair = (1, "hello")
let (a, b) = pair           // a = 1, b = "hello"
let (_, second) = pair      // skip first element
```

The arity must match the tuple. Destructuring a non-tuple produces E272; arity mismatch produces E271.

#### Tuple patterns in match

Tuple patterns work in match expressions for structural matching:

```
let pair = (1, "hello")
let r = match pair {
  (0, _) => "zero first"
  (n, s) => "other: " + s
}
```

Sub-patterns can be literals, bindings, or wildcards. A tuple pattern where all elements are catch-alls (bindings or wildcards) is itself a catch-all.

### Literal types

Literal types represent a single concrete value. They are subtypes of their base primitive type.

```
// String literal types
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"

// Number literal types
type DiceRoll = 1 | 2 | 3 | 4 | 5 | 6

// Boolean literal types
type True = true
type False = false
```

Literal types enable exhaustive pattern matching on string and number values.

#### Const inference

Immutable `let` bindings infer literal types by default. Mutable `var` bindings widen to the base primitive type.

```
let x = "hello"       // type: "hello" (literal)
var y = "hello"       // type: string (widened — value can change)

let n = 42            // type: 42
var m = 42            // type: number

let t = true          // type: true
var b = true          // type: boolean
```

When an explicit type annotation is present, the annotation takes precedence:

```
let x: string = "hello"   // type: string (annotation wins)
let y = "hello"            // type: "hello" (inferred literal)
```

#### Assignability

Literal types are subtypes of their base primitive:

```
let x = "GET"              // type: "GET"
let y: string = x          // OK — "GET" is assignable to string
let z: "GET" = y           // Error — string is not assignable to "GET"
```

#### Array widening

Array literals widen their element types to the common base type unless an annotation is provided:

```
let methods = ["GET", "POST"]                        // type: Array<string> (widened)
let methods: Array<"GET" | "POST"> = ["GET", "POST"] // OK with annotation
```

#### Union simplification

A primitive type absorbs its literal subtypes in a union:

```
type T = string | "hello"    // simplifies to string
type U = number | 42         // simplifies to number
type V = boolean | true      // simplifies to boolean
```

`true | false` collapses to `boolean`.

**Intersection types** use `&` to combine record types into a single type with all fields. Intersection binds tighter than union (`|`) but looser than nullable (`?`). Only record type intersections are supported.

### Named type aliases

```
type User = { name: string, age: number }
type Config = { host: string, port?: number }
export type Point = { x: number, y: number }
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"
type DiceRoll = 1 | 2 | 3 | 4 | 5 | 6
```

Named type aliases (both record types and literal unions) are structural — they are erased in JS output and emitted as `export type` in `.d.ts` files.

### Algebraic data types (ADTs)

```
type Color = Red | Green | Blue
type Shape = Circle(radius: number) | Rect(width: number, height: number)
type Result<T, E> = Ok(value: T) | Err(error: E)
type Option<T> = Some(value: T) | None
```

See [ADTs](#8-algebraic-data-types-adts) for full details.

---

## 4. Functions

All functions in EffectScript are arrow functions bound with `let`. There is no `function` keyword.

### Basic function

```
let add = (a: number, b: number): number => a + b
let greet = (name: string): string => "hello ${name}"
```

### No parameters

```
let getAnswer = (): number => 42
```

### Block body

When a function needs multiple statements, use a block. The last expression in the block is the return value.

```
let classify = (n: number): string => {
  let abs = if (n < 0) { -n } else { n }
  if (abs > 100) { "big" } else { "small" }
}
```

### Default parameter values

```
let greet = (name: string = "world"): string => "hello ${name}"
greet()        // "hello world"
greet("Alice") // "hello Alice"
```

### Named arguments

At call sites, arguments can be passed by name using `name: value` syntax. Positional arguments must come before named arguments.

```
let createUser = (name: string, admin: boolean = false, verified: boolean = false, age: number = 0): string => name

// Positional (always works)
createUser("Alice", true, false, 30)

// Named arguments — any order
createUser("Alice", admin: true, age: 30)

// All named
createUser(name: "Alice", age: 30, verified: true)
```

Named arguments can skip defaulted parameters — the skipped parameters receive their default values:

```
let f = (a: number, b: number = 0, c: number = 0): number => a + b + c
f(1, c: 3)  // b gets default 0 → compiles to f(1, undefined, 3)
f(1, b: 2)  // c omitted entirely → compiles to f(1, 2)
```

Named arguments work with `new` expressions, generic functions, and extension functions:

```
new User(name: "Alice", age: 30)

let swap = <A, B>(first: A, second: B): B => second
swap(second: "hello", first: 42)  // compiles to swap(42, "hello")

15.clamp(max: 10, min: 0)  // names the extension params
```

**Errors:**
- `E253`: Positional argument cannot follow named argument
- `E254`: Unknown parameter name
- `E255`: Parameter already provided (either duplicate name or positional + named for the same parameter)

**Distinction from records:** `f(x: 10)` is a named argument; `f({ x: 10 })` is a record literal as a positional argument.

### Generic functions

```
let identity = <T>(x: T): T => x
let first = <T, U>(a: T, b: U): T => a
```

### Generic constraints

Type parameters can be constrained using `:` to require a specific shape. Only types satisfying the constraint can be used as type arguments. Inside the function body, the constrained generic provides access to the constraint's fields.

```
// Structural constraint — T must have a `name` field
let getName = <T: { name: string }>(item: T): string => item.name

// Named type constraint
type Printable = { toString: () => string }
let stringify = <T: Printable>(value: T): string => value.toString()

// Multiple constraints via intersection
let process = <T: { name: string } & { age: number }>(item: T): string => {
  "${item.name} is ${item.age}"
}

// Constraint referencing another type parameter
let wrap = <T, U: Array<T>>(item: T, container: U): U => container

// Multiple constrained type parameters
let combine = <A: { value: number }, B: { value: number }>(a: A, b: B): number => {
  a.value + b.value
}
```

Constraint violations produce E240 at call sites:

```
let getName = <T: { name: string }>(item: T): string => item.name
getName(42)  // Error: Type 'number' does not satisfy constraint '{ name: string }'
```

Unconstrained generics have no known fields (E209 on field access).

### Constrained ADT type parameters

ADT type declarations can also have constraints. The constraint is validated when constructing variants:

```
type Container<T: { id: string }> = Boxed(value: T) | Empty

let c = Boxed({ id: "abc", data: 42 })  // OK
let d = Boxed(42)                         // Error E240
```

In `.d.ts` output, `:` constraints emit as `extends`:

```
// EffectScript: <T: { name: string }>
// DTS output:   <T extends { name: string }>
```

### Value parameter semantics

Function parameters are **deeply immutable** by default. The type checker rejects any attempt to mutate a parameter's value, including direct property assignment and calls to known mutating methods. This has zero runtime cost -- enforcement is purely compile-time.

```
// Immutable by default -- mutation is rejected
let process = (items: Array<number>): void => {
  items.push(42)          // E240: Cannot call mutating method 'push' on immutable parameter 'items'
  items.sort()            // E240: Same for sort, pop, shift, unshift, reverse, splice, fill
}

let update = (user: { name: string }): void => {
  user.name = "Bob"       // E241: Cannot mutate immutable parameter 'user'
}
```

To allow mutation, use the `var` keyword before the parameter name:

```
let sort = (var items: Array<number>): void => {
  items.sort()            // OK -- parameter is explicitly mutable
  items.push(42)          // OK
}

let resetName = (var user: { name: string }): void => {
  user.name = "Anonymous" // OK
}
```

**`var` does not allow reassignment.** The `var` keyword on parameters allows content mutation but not rebinding the parameter:

```
let example = (var items: Array<number>): void => {
  items.push(42)          // OK -- content mutation
  items = [1, 2, 3]       // E202 -- reassignment not allowed
}
```

Deep enforcement traces through member chains to the root binding:

```
let process = (config: { db: { host: string } }): void => {
  config.db.host = "localhost"  // E241 -- deep mutation of immutable parameter
}
```

Set and Map parameters also enforce immutability:

```
let process = (names: Set<string>, scores: Map<string, number>): void => {
  names.add("x")          // E240
  scores.set("x", 1)      // E240
  names.has("x")           // OK -- non-mutating
  scores.get("x")          // OK -- non-mutating
}
```

**Aliasing escapes enforcement.** Assigning a parameter to a local variable creates a separate binding:

```
let process = (items: Array<number>): void => {
  let alias = items
  alias.push(42)           // OK -- alias is a local binding, not a parameter
}
```

**Closures inherit parameter immutability.** If a parameter is visible in a closure's scope, mutations are rejected:

```
let process = (items: Array<number>): () => void => {
  let mutator = (): void => { items.push(42) }  // E240 -- parameter still immutable in closure
  mutator
}
```

Non-mutating methods (map, filter, forEach, includes, at, slice) and property reads (length) are always allowed on immutable parameters.

`var` on parameters has no runtime representation -- it compiles identically to a regular parameter and is not reflected in `.d.ts` output.

### Return type annotation

Return types are optional (inferred) for non-recursive functions. **Recursive functions require an explicit return type.**

```
// Inferred return type
let double = (n: number) => n * 2

// Explicit return type (required for recursion)
let factorial = (n: number): number => {
  if (n <= 1) { 1 } else { n * factorial(n - 1) }
}
```

### Higher-order functions

```
let apply = (f: (number) => number, x: number): number => f(x)
let result = apply((n: number) => n * 2, 21)
```

### Trailing commas

Trailing commas are allowed in parameter lists and call arguments.

```
let add = (a: number, b: number,): number => a + b
let result = add(1, 2,)
```

### Early return

```
let findFirst = (nums: Array<number>, target: number): number => {
  for (n in nums) {
    if (n == target) {
      return n
    }
  }
  return -1
}
```

`return` exits the enclosing function immediately. Bare `return` (no value) has type `void`.

### Async functions

Async functions use the `async` keyword before the parameter list and return `Promise<T>`.

```
let fetchUser = async (id: string): Promise<User> => {
  let response = await fetch("/api/users/${id}")
  await response.json()
}
```

#### Expression body

```
let double = async (x: number): Promise<number> => await compute(x)
```

#### Return type inference

When no return type annotation is provided, the checker infers `Promise<T>` from the body type.

```
let f = async (x: number) => x * 2     // inferred: (number) => Promise<number>
```

#### Exported async function

```
export let fetchData = async (url: string): Promise<string> => {
  let response = await fetch(url)
  await response.text()
}
```

#### `await` expression

`await` unwraps a `Promise<T>` to `T`. It is only valid inside an async function body.

```
let f = async (): Promise<number> => {
  let p = async (): Promise<number> => 42
  let result = await p()      // result: number
  result + 1
}
```

**Precedence**: `await` binds at unary level. `await a + b` is `(await a) + b`.

**Restrictions**:
- `await` outside async function → error E231
- `await` on non-Promise type → error E232 (except `Any`)
- Async function with non-`Promise<T>` return type → error E230
- No top-level `await` — use an async IIFE: `(async () => { ... })()`

#### Async `return` semantics

Inside an async function, `return expr` checks `expr` against the inner type `T` of `Promise<T>`. Both `T` and `Promise<T>` are accepted (JavaScript auto-awaits returned promises).

```
let compute = async (): Promise<number> => 42
let f = async (): Promise<number> => {
  return compute()     // OK — Promise<number> auto-awaited
  0
}
```

#### Async attempt

When `attempt` is called with an async function, it returns `Promise<Result<T, Error>>`:

```
let result = await attempt(async (): Promise<string> => {
  let response = await fetch(url)
  await response.text()
})
// result: Result<string, Error>
```

### Lambda parameter types

Lambda parameters **always require explicit type annotations**. There is no contextual type inference from function signatures.

```
// Correct — explicit type on lambda param
nums.map((n: number) => n * 2)

// Wrong — will produce an error
nums.map((n) => n * 2)
```

---

## 5. Expressions

EffectScript is expression-oriented. Most constructs produce values and can be used on the right side of a binding.

### Block expressions

A block evaluates to its last expression.

```
let result = {
  let a = 10
  let b = 20
  a + b    // result = 30
}
```

### If/else expressions

```
let label = if (x > 5) { "big" } else { "small" }
let abs = if (n < 0) { -n } else { n }
```

When used as an expression (assigned to a variable), `if` **must** have an `else` branch.

### Match expressions

```
let label = match color {
  Red => "red"
  Green => "green"
  Blue => "blue"
}
```

See [Pattern Matching](#7-pattern-matching) for full details.

### Try/catch expressions

```
let result = try { riskyOperation() } catch (e) { "fallback" }
```

### Grouped expressions

```
let x = (1 + 2) * 3
```

---

## 6. Control Flow

### If / else

Parentheses around the condition are **required**.

```
if (temperature > 100) {
  print("hot")
}

if (x > 0) {
  print("positive")
} else {
  print("non-positive")
}

// Chained
if (x > 100) {
  print("big")
} else if (x > 0) {
  print("medium")
} else {
  print("small")
}
```

### While loops

Parentheses around the condition are **required**. Body must be a block.

```
var i = 0
while (i < 10) {
  print(i)
  i = i + 1
}
```

### For-in loops

Iterates over arrays. Parentheses around `variable in iterable` are **required**. Body must be a block.

```
let names = ["Alice", "Bob", "Carol"]
for (name in names) {
  print(name)
}
```

The loop variable is immutable within the body.

### Break and continue

```
var i = 0
while (true) {
  if (i >= 5) { break }
  i = i + 1
}

for (n in [1, 2, 3, 4, 5]) {
  if (n == 3) { continue }
  print(n)
}
```

### Throw

```
throw new Error("something went wrong")
```

---

## 7. Pattern Matching

`match` is EffectScript's primary branching construct for ADTs, nullable types, and more.

```
match <subject> {
  <pattern> => <body>
  <pattern> => <body>
}
```

Match arms are separated by newlines (commas optional). Exhaustiveness is checked by the compiler — you must handle all possible cases or the compiler reports an error (E203).

### Pattern types

#### Literal patterns

```
match x {
  42 => "the answer"
  0 => "zero"
  _ => "other"
}

match name {
  "Alice" => "found Alice"
  "Bob" => "found Bob"
  _ => "unknown"
}

match flag {
  true => "yes"
  false => "no"
}
```

#### Wildcard pattern

`_` matches anything and binds nothing.

```
match x {
  0 => "zero"
  _ => "non-zero"
}
```

#### Binding pattern

A lowercase identifier matches anything and binds the value to that name.

```
match x {
  0 => "zero"
  n => "got ${n}"
}
```

#### Null pattern

```
match maybeValue {
  null => "nothing"
  n => "got ${n}"
}
```

#### Variant pattern (ADT destructuring)

```
match shape {
  Circle(r) => 3.14 * r * r
  Rect(w, h) => w * h
}

// Fieldless variants — no parentheses
match color {
  Red => "red"
  Green => "green"
  Blue => "blue"
}
```

#### Record pattern

```
match user {
  { name } => "hello ${name}"
}
```

#### Tuple pattern

```
match pair {
  (0, _) => "zero first"
  (n, s) => "n is ${n}, s is ${s}"
}
```

Sub-patterns can be literals, bindings, wildcards, or nested patterns. The arity must match the tuple type (E271). Matching a non-tuple with a tuple pattern produces E273.

#### Guard clauses

A guard adds an extra condition to a pattern using `if`.

```
match n {
  n if n > 0 => "positive"
  n if n < 0 => "negative"
  _ => "zero"
}
```

### Exhaustiveness

The compiler enforces exhaustive matching. For ADTs, all variants must be covered. For nullable types, both the value and `null` must be handled. For literal union types, all literal members must be covered.

```
type Color = Red | Green | Blue

// Error E203: non-exhaustive — missing Blue
match color {
  Red => "r"
  Green => "g"
}
```

#### Exhaustive match on literal unions

```
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"

let describe = (method: HttpMethod): string =>
  match method {
    "GET" => "Read"
    "POST" => "Create"
    "PUT" => "Update"
    "DELETE" => "Remove"
  }
// Exhaustive — all literal members covered
```

Number literal unions also support exhaustive matching:

```
type Coin = 1 | 5 | 10 | 25
let value = (coin: Coin): string =>
  match coin {
    1 => "penny"
    5 => "nickel"
    10 => "dime"
    25 => "quarter"
  }
```

Bare primitives (`string`, `number`) have infinite domains and require a wildcard.

Use `_` as a catch-all:

```
match color {
  Red => "r"
  _ => "other"
}
```

---

## 8. Algebraic Data Types (ADTs)

ADTs define a type as a fixed set of variants, each optionally carrying data.

### Fieldless variants (enumerations)

```
type Color = Red | Green | Blue
type Direction = North | South | East | West
```

Fieldless variants compile to frozen singleton objects: `Object.freeze({ _tag: "Red" })`.

### Variants with fields

```
type Shape = Circle(radius: number) | Rect(width: number, height: number)
```

Fielded variants compile to factory functions:
```js
const Circle = (radius) => ({ _tag: "Circle", radius });
const Rect = (width, height) => ({ _tag: "Rect", width, height });
```

### Mixed variants

```
type Option<T> = Some(value: T) | None
```

### Generic ADTs

```
type Result<T, E> = Ok(value: T) | Err(error: E)
type Tree<T> = Leaf(value: T) | Node(left: Tree<T>, right: Tree<T>)

// With constraints
type Container<T: { id: string }> = Boxed(value: T) | Empty
```

### Constructing ADT values

```
type Color = Red | Green | Blue
let c = Red                   // fieldless — just the name

type Shape = Circle(radius: number) | Rect(width: number, height: number)
let s = Circle(5)             // fielded — call like a function
let r = Rect(10, 20)
```

### Exporting ADTs

```
export type Shape = Circle(radius: number) | Rect(width: number, height: number)
```

Exporting an ADT also exports its variant constructors.

### Using ADTs with match

```
type Result<T, E> = Ok(value: T) | Err(error: E)

let describe = (r: Result<number, string>): string => {
  match r {
    Ok(v) => "success: ${v}"
    Err(e) => "error: ${e}"
  }
}
```

---

## 9. Records

Records are structural types with named fields.

### Record expressions

```
let user = { name: "Alice", age: 30 }
let point = { x: 1, y: 2 }
```

### Shorthand syntax

When the field name matches a variable name, use shorthand:

```
let name = "Alice"
let age = 30
let user = { name, age }              // equivalent to { name: name, age: age }
let mixed = { name, age: 25 }         // mix shorthand and explicit
```

### Field access

```
let n = user.name
let a = user.age
```

### Record type annotations

```
let user: { name: string, age: number } = { name: "Alice", age: 30 }
```

### Named record type aliases

```
type User = { name: string, age: number }
type Config = { host: string, port?: number }

let user: User = { name: "Alice", age: 30 }
```

Optional fields use `?:`:

```
type Options = { verbose?: boolean, outDir?: string }
```

### Field mutability

Record fields are **immutable by default** (bare fields). Use the `var` prefix to make a field mutable:

```
type User = {
  name: string,          // immutable (default)
  email: string,         // immutable
  var score: number      // mutable — explicitly opted in
}

let user: User = { name: "Alice", email: "a@b.com", score: 0 }
user.score = 100       // ok — var field
user.name = "Bob"      // error E275 — immutable field
```

Inline record type annotations also support `var`:

```
let config: { host: string, var debug: boolean } = { host: "localhost", debug: false }
config.debug = true    // ok
config.host = "other"  // error E275
```

The `var` prefix and `?` optionality marker are independent:

- `name: string` — immutable, required
- `name?: string` — immutable, optional
- `var name: string` — mutable, required
- `var name?: string` — mutable, optional

Record expressions without a type annotation produce all-immutable types:

```
let r = { x: 1, y: 2 }
r.x = 3   // error E275 — inferred type has no mutable fields
```

Field mutability is compile-time only — JavaScript output is unchanged. In `.d.ts` output, immutable fields get `readonly` and mutable fields are bare (matching TypeScript conventions).

### Trailing commas

```
let user = { name: "Alice", age: 30, }
```

### Empty record

```
let empty = {}
```

### Index signatures (dictionary types)

Index signatures describe objects with dynamic string or number keys. They use `[string]: T` or `[number]: T` syntax inside record types.

```
type Config = { [string]: string }
type NumberMap = { [number]: string }
```

Index signatures can be mixed with named fields. Named field types must be compatible with the index signature value type:

```
type ApiResponse = {
  status: number,
  message: string,
  [string]: Any
}
```

Bracket access (`obj["key"]`) is used to read and write index signature values. Index access always returns a nullable type (`T?`) for safety, since there is no static guarantee that a key exists:

```
let config: { [string]: string } = { host: "localhost" }
let host = config["host"]       // string? (nullable)

if (host != null) {
  let len = host.length          // narrowed to string
}
```

String literal bracket access on named fields is non-nullable:

```
let response: { status: number, [string]: Any } = { status: 200 }
let s = response["status"]      // number (non-nullable, resolves named field)
```

Named field dot access works on index signature types:

```
let s = response.status          // number (non-nullable)
```

Assignment to bracket expressions is allowed on mutable bindings:

```
var config: { [string]: string } = {}
config["host"] = "localhost"     // OK
```

Optional chaining with bracket access:

```
let config: { [string]: string }? = null
let host = config?.["host"]      // string? (nullable)
```

Array bracket access also returns nullable:

```
let arr: Array<number> = [1, 2, 3]
let first = arr[0]               // number? (nullable)
```

Only `string` and `number` are valid key types. Using a mismatched key type produces error E290. Using a dynamic key on a record without an index signature produces error E291.

---

## 10. Interfaces

Interfaces define structural type contracts — named sets of method signatures and property requirements. Any type that has all required members with compatible types satisfies the interface structurally (no explicit `implements` required).

### Basic interface

```
interface Serializable {
  fun serialize(): string
}
```

### Interface with properties

Properties use `let` (readonly) or `var` (mutable):

```
interface Named {
  let name: string
  var displayName: string
}
```

### Generic interfaces

```
interface Collection<T> {
  let size: number
  fun contains(item: T): boolean
}
```

### Interface extension

```
interface ReadableCollection<T> extends Collection<T> {
  fun get(index: number): T?
}
```

### Structural satisfaction

Records satisfy interfaces via matching fields — no `implements` clause needed:

```
let s: Serializable = { serialize: () => "json" }
```

### Exported interfaces

```
export interface Validator {
  fun validate(input: string): boolean
}
```

Interfaces are type-erased at runtime (no JS output). They emit `export interface` declarations in `.d.ts` output.

---

## 11. Collections (Arrays, Sets, Maps)

### Array literals

```
let nums = [1, 2, 3]
let names = ["Alice", "Bob", "Carol"]
let empty: Array<number> = []
let nested = [[1, 2], [3, 4]]
```

### Array type annotation

```
let nums: Array<number> = [1, 2, 3]
let names: Array<string> = []
```

### Array methods

```
let nums = [1, 2, 3]

// Properties
nums.length              // 3

// Transformations (return new arrays)
nums.map((n: number) => n * 2)          // [2, 4, 6]
nums.filter((n: number) => n > 1)       // [2, 3]
nums.flatMap((n: number): Array<number> => [n, n * 2])  // [1, 2, 2, 4, 3, 6]

// Queries
nums.first()             // 1 (returns number?, null if empty)
nums.last()              // 3 (returns number?, null if empty)
nums.find((n: number): boolean => n > 2)   // 3 (returns number?, null if not found)
nums.findIndex((n: number): boolean => n > 2) // 2
nums.indexOf(2)          // 1
nums.includes(2)         // true
nums.isEmpty()           // false
nums.at(0)               // 1 (returns number?, null if out of bounds)
nums.every((n: number): boolean => n > 0)  // true
nums.some((n: number): boolean => n > 5)   // false

// Reduction
nums.reduce((acc: number, n: number): number => acc + n, 0)  // 6 (JS arg order)
nums.fold(0, (acc: number, n: number): number => acc + n)     // 6 (functional arg order)

// Iteration
nums.forEach((n: number) => print(n))

// Mutation (only on var arrays)
var items: Array<number> = [1, 2]
items.push(3)            // adds to end
items.unshift(0)         // adds to start
items.pop()              // removes from end, returns number?
items.shift()            // removes from start, returns number?
items.sort()             // sorts in place (string comparison)
items.sort((a: number, b: number): number => a - b)  // sorts with comparator
```

### Set construction and methods

Sets are constructed using the `Set.of(array)` factory method. There is no set literal syntax.

```
// Create a Set from an array
let names = Set.of(["alice", "bob", "carol"])
let empty: Set<string> = Set.of([])

// Type annotation
let s: Set<number> = Set.of([1, 2, 3])
```

```
let s = Set.of(["a", "b", "c"])

// Properties
s.size                   // 3

// Queries
s.has("a")               // true

// Conversion
s.toArray()              // ["a", "b", "c"] (Array<string>)

// Transformations (return new Sets)
s.map((x: string): number => x.length)       // Set<number>
s.filter((x: string): boolean => x != "a")   // Set<string>
s.union(Set.of(["d"]))                        // Set<string> with a, b, c, d
s.intersect(Set.of(["a", "d"]))              // Set<string> with a
s.difference(Set.of(["a"]))                  // Set<string> with b, c

// Iteration
s.forEach((x: string) => print(x))

// Mutation (only on var Sets)
var ms: Set<string> = Set.of(["a"])
ms.add("b")             // void (mutates in place)
ms.delete("a")          // boolean (true if removed)
ms.clear()              // void (removes all elements)
```

### Iterating over a Set

Sets are not directly iterable with `for-in`. Convert to an array first:

```
let names = Set.of(["alice", "bob"])
for (name in names.toArray()) {
  print(name)
}
```

### Map construction and methods

Maps are constructed using the `Map.of()` factory method. There is no map literal syntax.

```
// Create an empty Map
let m: Map<string, number> = Map.of()

// Type annotation
let scores: Map<string, number> = Map.of()
```

```
let m: Map<string, number> = Map.of()

// Properties
m.size                   // 0

// Queries
m.has("alice")           // false
m.get("alice")           // null (returns number? — nullable, since key may not exist)

// Key/value extraction (returns Arrays)
m.keys()                 // Array<string>
m.values()               // Array<number>
m.entries()              // Array<(string, number)>

// Transformation
m.map((v: number, k: string): number => v * 2)  // Map<string, number> (callback order: value, key)

// Iteration
m.forEach((v: number, k: string): void => print(k))  // callback order: value, key (matches JS)

// Mutation (only on var Maps)
var ms: Map<string, number> = Map.of()
ms.set("alice", 100)    // void (mutates in place)
ms.delete("alice")       // boolean (true if removed)
ms.clear()               // void (removes all entries)
```

**Note on Map.get()**: `Map.get(key)` returns `V?` (nullable) because the key might not exist. Always handle the null case:

```
let m: Map<string, number> = Map.of()
let score = m.get("alice")
if (score != null) {
  print(score)   // score is narrowed to number here
}
```

**Note on Map callback order**: `Map.forEach` and `Map.map` use `(value, key)` callback order, matching JavaScript's `Map.prototype.forEach`. This is intentional for direct codegen passthrough.

### Iterating with for-in

```
for (n in [1, 2, 3]) {
  print(n)
}
```

---

## 12. Strings

### String literals

```
let plain = "hello, world"
```

Strings always use double quotes. There are no single-quoted strings.

### Template strings (interpolation)

```
let name = "Alice"
let greeting = "hello ${name}"
let math = "1 + 2 = ${1 + 2}"
let multi = "${firstName} ${lastName}"
```

Template strings use `"..."` with `${expr}` for interpolation. They compile to JavaScript backtick template literals.

### String methods

```
let s = "  Hello, World  "

s.length                    // number (property)
s.trim()                    // "Hello, World"
s.trimStart()               // "Hello, World  "
s.trimEnd()                 // "  Hello, World"
s.toUpperCase()             // "  HELLO, WORLD  "
s.toLowerCase()             // "  hello, world  "
s.includes("World")         // true
s.startsWith("  Hello")     // true
s.endsWith("World  ")       // true
s.indexOf("World")          // number
s.lastIndexOf("l")          // number
s.slice(2, 7)               // "Hello"
s.substring(2, 7)           // "Hello"
s.charAt(2)                 // "H"
s.split(", ")               // Array<string>
s.replace("World", "ES")    // "  Hello, ES  "
s.repeat(2)                 // doubled string
s.concat("!")               // append
s.padStart(20, "*")         // left-pad
s.padEnd(20, "*")           // right-pad
```

---

## 13. Null Safety

EffectScript has first-class null safety. Nullable types must be explicitly annotated and handled.

### Nullable types

A `?` suffix makes any type nullable (can hold `null`).

```
let name: string? = "Alice"
let missing: string? = null
```

### Null checks (narrowing)

The type checker narrows nullable types inside condition branches.

```
let greet = (name: string?): string => {
  if (name != null) {
    // name is narrowed to string here
    "hello ${name}"
  } else {
    "hello stranger"
  }
}
```

Narrowing works with `&&`, `||`, `!=`, `== null`, and `!`:

```
if (x != null && x.length > 0) {
  // x is narrowed to non-null here
}
```

### Optional chaining

Access members on nullable values safely with `?.`:

```
let len = name?.length       // number? — null if name is null
let upper = name?.toUpperCase()
```

### Null coalescing

The `??` operator provides a default value for nullable expressions.

```
let display = name ?? "anonymous"
```

**Important**: `??` cannot be mixed with `&&` or `||` without explicit parentheses.

```
// Error E117
let x = a ?? b || c

// Correct
let x = (a ?? b) || c
let x = a ?? (b || c)
```

### Match on nullable

```
let describe = (x: number?): string => {
  match x {
    null => "nothing"
    n => "got ${n}"
  }
}
```

---

## 14. Operators

### Arithmetic

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Addition / string concatenation | `1 + 2`, `"a" + "b"`, `10n + 20n` |
| `-` | Subtraction | `5 - 3`, `10n - 5n` |
| `*` | Multiplication | `2 * 3`, `10n * 2n` |
| `/` | Division | `10 / 3`, `10n / 3n` |
| `%` | Modulo | `10 % 3`, `10n % 3n` |

Arithmetic operators work within `number` or within `bigint`, but **not** across the two types. Mixed `bigint + number` is a type error (E216). `bigint` does not support `+` with `string` (no implicit coercion).

### Comparison

| Operator | Description |
|----------|-------------|
| `==` | Equality (compiles to `===`) |
| `!=` | Inequality (compiles to `!==`) |
| `<` | Less than |
| `>` | Greater than |
| `<=` | Less than or equal |
| `>=` | Greater than or equal |

### Logical

| Operator | Description |
|----------|-------------|
| `&&` | Logical AND (short-circuit) |
| `\|\|` | Logical OR (short-circuit) |
| `!` | Logical NOT (unary) |

### Null-related

| Operator | Description |
|----------|-------------|
| `??` | Null coalescing — returns left if non-null, otherwise right |
| `?.` | Optional chaining — returns null if left is null |

### Unary operators

| Operator | Description | Example |
|----------|-------------|---------|
| `-` | Arithmetic negation (`number` or `bigint`) | `-x`, `-42n` |
| `!` | Logical NOT (`boolean` only) | `!flag` |

### Type operators

| Operator | Context | Description |
|----------|---------|-------------|
| `?` | Type annotation | Nullable type: `string?` means `string \| null` |
| `\|` | Type annotation | Union type: `string \| number` |
| `&` | Type annotation | Intersection type: `{ name: string } & { age: number }` |

`&` binds tighter than `|` but looser than `?`: `A? & B | C` parses as `(A? & B) | C`.

### Assignment

```
x = newValue           // reassign mutable variable
obj.field = newValue   // reassign mutable field
```

Assignment is a statement, not an expression. Only works with `var` bindings.

### Operator precedence (lowest to highest)

1. `||`
2. `&&`
3. `==`, `!=`, `<`, `>`, `<=`, `>=`
4. `??`
5. `+`, `-`
6. `*`, `/`, `%`
7. Unary (`!`, `-`)
8. Member access (`.`, `?.`), function call, `new`

---

## 15. Error Handling

### Try/catch

```
try {
  riskyOperation()
} catch (e) {
  print("something went wrong")
}
```

- Parentheses around the catch parameter are **required**: `catch (e)`.
- The catch parameter is typed as `{ message: string, name: string, stack: string? }`, representing JavaScript's `Error` interface. This gives immediate access to the three standard Error fields:

```
try { riskyOperation() } catch (e) {
  print(e.message)   // string
  print(e.name)      // string (e.g. "TypeError", "RangeError")
  let s = e.stack    // string? (may be null in some environments)
}
```

- Both `try` and `catch` blocks use `{ }` braces.
- Try/catch can be used as an expression:

```
let result = try { parseInt(input) } catch (e) { 0 }
```

### Throw

```
throw new Error("invalid input")
```

### Result type (prelude)

The preferred way to handle expected errors is with the built-in `Result` type.

```
type Result<T, E> = Ok(value: T) | Err(error: E)
```

Use `attempt` to wrap throwing code into a `Result`:

```
let result = attempt(() => riskyOperation())

match result {
  Ok(value) => print("success: ${value}")
  Err(e) => print("error occurred")
}
```

Constructing results directly:

```
let success = Ok(42)
let failure = Err("something went wrong")

let validate = (n: number): Result<number, string> => {
  if (n > 0) { Ok(n) } else { Err("must be positive") }
}
```

---

## 16. Modules

### Importing from EffectScript files

```
import { add, subtract } from "./math"
import { User } from "./types"
```

- Relative paths start with `./` or `../`.
- The `.efs` extension is **not** included in the import path.

### Default imports

```
import config from "./config"
```

### Combined default + named imports

```
import React, { useState, useEffect } from "react"
import App, { Config } from "./app"
```

### Importing from npm packages

```
import { readFileSync } from "fs"
import { useState } from "react"
```

External packages resolve through Node.js module resolution and `.d.ts` type definitions.

### Exporting

```
// Inline export
export let add = (a: number, b: number): number => a + b
export type Color = Red | Green | Blue
export type User = { name: string, age: number }

// Named export
export { add, subtract }

// Re-export from another module
export { helper } from "./utils"
```

### Module rules

- **Circular imports** between `.efs` files are forbidden (error E501).
- Each file is a module — no global namespace pollution.
- Generated JS adds `.js` extension to relative imports.

---

## 17. Loops

### For-in loop

Iterates over arrays.

```
let items = [1, 2, 3, 4, 5]
for (item in items) {
  print(item)
}
```

- The parentheses around `variable in iterable` are **required**.
- The loop variable is **immutable** within the body.
- The iterable must be an `Array<T>`.

### Range loops

Iterate over numeric ranges using `..` (inclusive) and `..<` (exclusive).

```
// Exclusive range (0 to 9)
for (i in 0..<10) {
  print(i)
}

// Inclusive range (0 to 10)
for (i in 0..10) {
  print(i)
}

// Variable bounds
let n = items.length
for (i in 0..<n) {
  print(items.at(i))
}
```

- Range bounds must be `number` type.
- The loop variable is bound as `number` and is **immutable** within the body.
- Ranges compile to efficient C-style `for` loops: `for (let i = 0; i < 10; i++)`.
- Both bounds are evaluated once before the loop starts (complex end expressions are captured in a temporary variable).
- Empty ranges (e.g., `5..<5`) produce no iterations.
- Backwards ranges (e.g., `10..<0`) produce no iterations (no automatic decrement).

### Destructuring in for loops

#### Record destructuring

```
type User = { name: string, age: number }
let users: Array<User> = [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]

for ({ name, age } in users) {
  print("${name} is ${age}")
}
```

- The iterable must be `Array<RecordType>`.
- Partial destructuring is allowed (only bind the fields you need).
- Unknown fields produce a type error.

#### Tuple destructuring

```
let items = ["a", "b", "c"]
for ((index, item) in items.withIndex()) {
  print("${index}: ${item}")
}
```

- The iterable must be `Array<TupleType>`.
- The number of pattern elements must match the tuple arity.
- Use `_` to discard a position: `for ((_, item) in items.withIndex())`.

#### Nullable element restriction

Destructuring a nullable array element is not allowed. The array element type must be a non-nullable record or tuple:

```
// ERROR: Cannot destructure type 'User?' — expected a record or tuple
let users: Array<User?> = [{ name: "Alice", age: 30 }, null]
for ({ name } in users) { ... }
```

### Indexed iteration with `withIndex()`

The `withIndex()` method on arrays returns `Array<(number, T)>` — an array of `(index, element)` tuples.

```
let items = ["a", "b", "c"]
for ((index, item) in items.withIndex()) {
  print("${index}: ${item}")
}
```

- When `withIndex()` is the direct iterable of a for-loop, the emitter optimizes it to `.entries()` instead of creating an intermediate array.
- In general expression context, `items.withIndex()` compiles to `items.map((v, i) => [i, v])`.

### While loop

```
var count = 0
while (count < 10) {
  print(count)
  count = count + 1
}
```

- The parentheses around the condition are **required**.
- The condition must be `boolean`.

### Break and continue

```
// Break — exit the loop
while (true) {
  if (shouldStop()) { break }
  doWork()
}

// Continue — skip to next iteration
for (n in numbers) {
  if (n % 2 == 0) { continue }
  print(n)    // prints odd numbers only
}
```

### Building arrays with loops

```
var evens: Array<number> = []
for (n in [1, 2, 3, 4, 5, 6]) {
  if (n % 2 == 0) {
    evens.push(n)
  }
}
// evens = [2, 4, 6]
```

---

## 18. Comments

```
// Single-line comment

/*
  Multi-line
  block comment
*/

let x = 42 // Inline comment after code
```

Comments are preserved as trivia on AST nodes and do not appear in compiled output.

---

## 19. Built-in Prelude

These are available in every EffectScript file without importing.

### Types

| Type | Definition |
|------|-----------|
| `Result<T, E>` | `Ok(value: T) \| Err(error: E)` — represents success or failure |
| `Date` | JS Date object with instance methods (`getTime`, `toISOString`, etc.) |

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `Ok` | `<T, E>(value: T) => Result<T, E>` | Construct a success result |
| `Err` | `<T, E>(error: E) => Result<T, E>` | Construct an error result |
| `attempt` | `<T>(f: () => T) => Result<T, Error>` | Wrap a throwing function into a Result |
| `attempt` (async) | `<T>(f: () => Promise<T>) => Promise<Result<T, Error>>` | Async overload — wraps async function into a Result |
| `print` | `(value: Any) => void` | Print to console (compiles to `console.log`) |
| `Date` | `(value?: Any) => Date` | Construct a Date (`new Date()`, `new Date("2026-12-25")`, `new Date(0)`) |

### Companion Objects

| Name | Method | Signature | Description |
|------|--------|-----------|-------------|
| `Set` | `of(items)` | `<T>(Array<T>) => Set<T>` | Create a Set from an array |
| `Map` | `of()` | `() => Map<Any, Any>` | Create an empty Map |
| `Date` | `now()` | `() => number` | Current timestamp in milliseconds |

---

## 20. Built-in Methods

### Array<T> methods

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `length` | `number` | Number of elements |
| `push(item)` | `(T) => void` | Add to end |
| `unshift(item)` | `(T) => void` | Add to start |
| `pop()` | `() => T?` | Remove from end (nullable — empty array returns null) |
| `shift()` | `() => T?` | Remove from start (nullable) |
| `map(fn)` | `<U>((T) => U) => Array<U>` | Transform each element |
| `filter(fn)` | `((T) => boolean) => Array<T>` | Keep elements matching predicate |
| `flatMap(fn)` | `<U>((T) => Array<U>) => Array<U>` | Map then flatten |
| `forEach(fn)` | `((T) => void) => void` | Execute side effect for each element |
| `includes(item)` | `(T) => boolean` | Check if array contains item |
| `at(index)` | `(number) => T?` | Get element at index (nullable) |
| `first()` | `() => T?` | First element (nullable — null if empty) |
| `last()` | `() => T?` | Last element (nullable — null if empty) |
| `find(fn)` | `((T) => boolean) => T?` | First element matching predicate (nullable) |
| `findIndex(fn)` | `((T) => boolean) => number` | Index of first match (-1 if none) |
| `indexOf(item)` | `(T) => number` | Index of item (-1 if not found) |
| `every(fn)` | `((T) => boolean) => boolean` | True if all elements match |
| `some(fn)` | `((T) => boolean) => boolean` | True if any element matches |
| `isEmpty()` | `() => boolean` | True if array has no elements |
| `reduce(fn, init)` | `<U>((U, T) => U, U) => U` | Reduce with JS arg order (fn, init) |
| `fold(init, fn)` | `<U>(U, (U, T) => U) => U` | Reduce with functional arg order (init, fn) |
| `sort(fn?)` | `((T, T) => number)? => void` | Sort in place (optional comparator) |
| `withIndex()` | `() => Array<(number, T)>` | Array of (index, element) tuples |

### Set<T> methods

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `size` | `number` | Number of elements |
| `has(item)` | `(T) => boolean` | Check if set contains item |
| `add(item)` | `(T) => void` | Add element (mutation) |
| `delete(item)` | `(T) => boolean` | Remove element (returns true if removed) |
| `clear()` | `() => void` | Remove all elements (mutation) |
| `toArray()` | `() => Array<T>` | Convert to array |
| `map(fn)` | `<U>((T) => U) => Set<U>` | Transform each element |
| `filter(fn)` | `((T) => boolean) => Set<T>` | Keep elements matching predicate |
| `forEach(fn)` | `((T) => void) => void` | Execute side effect for each element |
| `union(other)` | `(Set<T>) => Set<T>` | Set union |
| `intersect(other)` | `(Set<T>) => Set<T>` | Set intersection |
| `difference(other)` | `(Set<T>) => Set<T>` | Set difference (elements in this but not other) |

### Map<K, V> methods

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `size` | `number` | Number of entries |
| `get(key)` | `(K) => V?` | Get value by key (nullable — null if key missing) |
| `has(key)` | `(K) => boolean` | Check if key exists |
| `set(key, value)` | `(K, V) => void` | Set key-value pair (mutation) |
| `delete(key)` | `(K) => boolean` | Remove entry (returns true if removed) |
| `clear()` | `() => void` | Remove all entries (mutation) |
| `keys()` | `() => Array<K>` | All keys as array |
| `values()` | `() => Array<V>` | All values as array |
| `entries()` | `() => Array<(K, V)>` | All entries as array of tuples |
| `forEach(fn)` | `((V, K) => void) => void` | Execute for each entry (value, key order) |
| `map(fn)` | `<U>((V, K) => U) => Map<K, U>` | Transform values (value, key order) |

### Promise<T> methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `then(fn)` | `<U>((T) => U) => Promise<U>` | Transform the resolved value |
| `catch(fn)` | `<U>((Any) => U) => Promise<T \| U>` | Handle rejection with a recovery value |
| `finally(fn)` | `(() => void) => Promise<T>` | Run cleanup after settlement (preserves type) |

### Date methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `getTime()` | `() => number` | Milliseconds since Unix epoch |
| `toISOString()` | `() => string` | ISO 8601 string (e.g. `"2026-12-25T00:00:00.000Z"`) |
| `toString()` | `() => string` | Human-readable date string |
| `valueOf()` | `() => number` | Primitive value (same as `getTime`) |
| `toLocaleDateString()` | `() => string` | Locale-formatted date |
| `toLocaleTimeString()` | `() => string` | Locale-formatted time |
| `toLocaleString()` | `() => string` | Locale-formatted date and time |
| `toDateString()` | `() => string` | Date portion string |
| `toTimeString()` | `() => string` | Time portion string |
| `toUTCString()` | `() => string` | UTC date string |
| `toJSON()` | `() => string` | JSON-compatible string (same as `toISOString`) |
| `getFullYear()` | `() => number` | Four-digit year |
| `getMonth()` | `() => number` | Month (0-11) |
| `getDate()` | `() => number` | Day of month (1-31) |
| `getDay()` | `() => number` | Day of week (0=Sunday, 6=Saturday) |
| `getHours()` | `() => number` | Hours (0-23) |
| `getMinutes()` | `() => number` | Minutes (0-59) |
| `getSeconds()` | `() => number` | Seconds (0-59) |
| `getMilliseconds()` | `() => number` | Milliseconds (0-999) |

### String methods

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `length` | `number` | Character count |
| `trim()` | `() => string` | Remove leading/trailing whitespace |
| `trimStart()` | `() => string` | Remove leading whitespace |
| `trimEnd()` | `() => string` | Remove trailing whitespace |
| `toUpperCase()` | `() => string` | Convert to uppercase |
| `toLowerCase()` | `() => string` | Convert to lowercase |
| `includes(s)` | `(string) => boolean` | Check if contains substring |
| `startsWith(s)` | `(string) => boolean` | Check prefix |
| `endsWith(s)` | `(string) => boolean` | Check suffix |
| `indexOf(s)` | `(string) => number` | First index of substring |
| `lastIndexOf(s)` | `(string) => number` | Last index of substring |
| `slice(start, end?)` | `(number, number?) => string` | Extract substring by indices |
| `substring(start, end?)` | `(number, number?) => string` | Extract substring by indices |
| `charAt(index)` | `(number) => string` | Character at index |
| `split(sep)` | `(string) => Array<string>` | Split into array |
| `replace(search, rep)` | `(string, string) => string` | Replace first occurrence |
| `repeat(count)` | `(number) => string` | Repeat string |
| `concat(s)` | `(string) => string` | Concatenate strings |
| `padStart(len, fill?)` | `(number, string?) => string` | Left-pad to length |
| `padEnd(len, fill?)` | `(number, string?) => string` | Right-pad to length |

### Number methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `toString()` | `() => string` | Convert to string |
| `toFixed(digits?)` | `(number?) => string` | Fixed-point notation |
| `valueOf()` | `() => number` | Primitive value |

### Boolean methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `toString()` | `() => string` | Convert to string |
| `valueOf()` | `() => boolean` | Primitive value |

---

## 21. JS/TS Interop

EffectScript has bidirectional interop with JavaScript and TypeScript.

### Importing from JS/TS packages

```
import { readFileSync } from "fs"
import { useState } from "react"
import React, { Component } from "react"
```

External packages resolve through Node.js module resolution. Type information is read from `.d.ts` declaration files (including `.d.cts` and `.d.mts` variants).

Packages that use `export = X` (the CommonJS-style TypeScript default export pattern) are supported. The `export =` value is treated as the default import, and any merged namespace members are exposed as named imports:

```
// Works with packages like react, express, lodash, axios
import React from "react"
import express, { Router } from "express"
import _ from "lodash"
```

### Using `new` for JS classes

EffectScript does not have its own class syntax, but you can construct JS/TS classes with `new`:

```
let err = new Error("something went wrong")
let map = new Map<string, number>()
```

### Reserved keywords as member names

Reserved keywords (like `catch`, `delete`, `throw`, `return`) are valid in member access position after `.` and `?.`. This is essential for calling JS methods with keyword names:

```
promise.catch((e: Any): void => print(e))
map.delete("key")
obj?.return
```

Keywords are also valid as record field names when used with a colon:

```
let handlers = { catch: errorHandler, delete: removeItem }
```

### Type mapping

Types from `.d.ts` files are mapped to EffectScript types:
- `string`, `number`, `boolean` → same
- `null`, `undefined` → `null` (EffectScript unifies null and undefined)
- `T | null`, `T | undefined`, `T?` → `T?` (nullable)
- `Array<T>`, `T[]` → `Array<T>`
- `Record<K, V>` → `{ [key: K]: V }`
- Interfaces / object types → record types
- Enums → record types with named member fields (enables `Direction.Up` access)
- `any`, `unknown` → `Any`
- Optional parameters (`param?: T`) → omittable at call sites
- Default parameters (`param = value`) → omittable at call sites
- Rest parameters (`...args: T[]`) → accept zero or more arguments of element type
- Conditional types (`T extends U ? A : B`) → resolved to concrete types when possible (see Conditional Type Evaluation below)
- Recursive types and other unmappable constructs → platform types (see below)

### Platform types

When the compiler cannot fully represent a TypeScript type, it produces a **platform type** instead of falling back to `Any`. Platform types preserve partial structural information from the original type, wrapping it with a flag that indicates the type is approximate.

Platform types have **no user-facing syntax** -- there is no `T!` notation in EffectScript source code. They are purely an internal compiler concept that arises during TypeScript interop. Users interact with platform types through:

1. **Diagnostics**: W303 warnings appear when a platform type is used in a context where the approximation could cause a runtime issue (e.g., passing a platform-typed value to a function expecting an exact type, using it in arithmetic, or returning it from a function with an exact return type annotation).
2. **Type display**: In diagnostic messages, platform types render with a `!` suffix (e.g., `string!`, `{ name: string }!`).
3. **Resolution**: A platform type is eliminated by adding a type annotation, which resolves the platform wrapper to the exact annotated type.

Platform types arise from:
- **Recursive type cycles** in `substitute()` that exceed the depth limit
- **Large type surfaces** (interfaces with many properties) that exceed the resolution budget
- **Unmappable constructs** (template literal types, mapped types, etc.)
- **Unresolvable conditional types** — only when all resolution strategies fail (see Conditional Type Evaluation below)

The fidelity hierarchy is: exact type (full safety) > platform type (partial safety + W303 warnings) > `Any` (no safety).

### Conditional type evaluation

TypeScript conditional types (`T extends U ? A : B`) are the backbone of modern TS type-level programming. EffectScript has no conditional type syntax of its own, but the compiler resolves conditional types from imported TypeScript declarations to their concrete EffectScript equivalents.

When importing types that use `ReturnType<T>`, `NonNullable<T>`, `Extract<T, U>`, `Exclude<T, U>`, `Awaited<T>`, or any other conditional type utility:

- **Concrete instantiations** (e.g., `ReturnType<() => string>`) are fully resolved by TypeScript before the mapper sees them. The result is a concrete type (e.g., `string`).
- **Abstract conditional types** (where the type parameter is not yet known) are resolved using a multi-strategy pipeline that tries TypeScript's internal resolution APIs and, as a last resort, constructs a sound union of both branches. For example, `T extends string ? number : boolean` with abstract `T` maps to `number | boolean`.
- **Distributive conditionals** (e.g., `NonNullable<string | null>`) are distributed by TypeScript's internal evaluation. The mapper receives the resolved result.

Only when all resolution strategies fail does the mapper fall back to `Any` (or a platform type).

---

## 22. Compilation Output

### JavaScript

| EffectScript | JavaScript |
|-------------|-----------|
| `let x = 1` | `const x = 1;` |
| `var x = 1` | `let x = 1;` |
| `==` | `===` |
| `!=` | `!==` |
| `print(x)` | `console.log(x)` |
| `"hello ${name}"` | `` `hello ${name}` `` |
| `Ok(42)` | `{ _tag: "Ok", value: 42 }` |
| `Red` (fieldless ADT) | `Object.freeze({ _tag: "Red" })` |
| `Circle(5)` (fielded ADT) | `Circle(5)` → `{ _tag: "Circle", radius: 5 }` |
| `import { a } from "./mod"` | `import { a } from "./mod.js";` |
| `Set.of([1, 2])` | `new Set([1, 2])` |
| `Map.of()` | `new Map()` |
| `s.toArray()` | `Array.from(s)` |
| `m.get("key")` | `m.get("key") ?? null` |
| `m.keys()` | `Array.from(m.keys())` |
| `arr.first()` | `arr[0] ?? null` |
| `arr.last()` | `arr.at(-1) ?? null` |
| `arr.fold(init, fn)` | `arr.reduce(fn, init)` |
| `arr.isEmpty()` | `arr.length === 0` |
| `let x = 42n` | `const x = 42n;` |
| `type T = "A" \| "B"` | (erased — no JS output) |
| `async (x) => ...` | `async (x) => ...` |
| `await expr` | `await expr` |
| `attempt(async () => ...)` | `__attempt_async(async () => ...)` |

### Declaration files (.d.ts)

Only exported declarations are emitted:
- Functions → `export declare const name: (params) => returnType;`
- Constants → `export declare const name: Type;` (literal type for immutable, primitive for mutable)
- ADTs → interfaces with `_tag` discriminant + union type + constructor declarations
- Named record types → `export type Name = { ... };`
- Literal union type aliases → `export type Name = "A" | "B";`

### Source maps

`.js.map` files are generated (Source Map v3) mapping back to the original `.efs` source.

---

## 23. Syntactic Rules and Constraints

1. **Parentheses required** around conditions: `if (cond)`, `while (cond)`, `for (x in y)`, `catch (e)`.
2. **No ternary operator** — use `if/else` expressions instead.
3. **No `switch` statement** — use `match` instead.
4. **No `function` keyword** — all functions are arrow functions bound with `let`.
5. **No classes** — use records, ADTs, and functions.
6. **Semicolons are optional** — newlines separate statements.
7. **Trailing commas** are allowed in parameter lists, call arguments, array literals, record literals, and import specifiers.
8. **`{ }` alone** parses as an empty record, not an empty block. A block requires at least one `let` or statement: `{ let x = 1; x }`.
9. **Record shorthand**: `{ name }` is equivalent to `{ name: name }`.
10. **Recursive functions** require an explicit return type annotation.
11. **Lambda parameters** can infer types from context (bidirectional type inference), but explicit annotations are always valid.
12. **`??` cannot be mixed with `&&` or `||`** without explicit parentheses (E117).
13. **Immutable by default** — `let` bindings cannot be reassigned; use `var` for mutability.
14. **`var` is block-scoped** — unlike JavaScript's `var`, EffectScript's `var` is block-scoped (like `let` in JS). There is no hoisting or function-scoping.
15. **Double quotes only** — strings use `"..."`, not `'...'` or backticks.
16. **`new` is for JS interop only** — constructing external JS/TS classes.
17. **`async` and `await` are reserved keywords** — cannot be used as identifiers.
18. **`await` is only valid inside `async` functions** — no top-level `await`.
19. **Async functions must return `Promise<T>`** — explicit or inferred.
20. **Reserved keywords are valid after `.`** — `obj.catch`, `obj?.delete`, `{ catch: handler }` are all valid. Keywords cannot be used as standalone identifiers or shorthand record fields.

---

## 24. Complete Example Programs

### FizzBuzz

```
var i = 1
while (i <= 100) {
  let result = if (i % 15 == 0) {
    "FizzBuzz"
  } else if (i % 3 == 0) {
    "Fizz"
  } else if (i % 5 == 0) {
    "Buzz"
  } else {
    "${i}"
  }
  print(result)
  i = i + 1
}
```

### Linked List with ADTs

```
type List<T> = Cons(head: T, tail: List<T>) | Nil

let length = <T>(list: List<T>): number => {
  match list {
    Nil => 0
    Cons(_, tail) => 1 + length(tail)
  }
}

let myList = Cons(1, Cons(2, Cons(3, Nil)))
print(length(myList))
```

### Pipeline Processing

```
let numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

let evenDoubled = numbers
  .filter((n: number) => n % 2 == 0)
  .map((n: number) => n * 2)

for (n in evenDoubled) {
  print(n)
}
```

### Safe Division with Result

```
let safeDivide = (a: number, b: number): Result<number, string> => {
  if (b == 0) {
    Err("division by zero")
  } else {
    Ok(a / b)
  }
}

let result = safeDivide(10, 3)
match result {
  Ok(value) => print("result: ${value}")
  Err(msg) => print("error: ${msg}")
}
```

### State Machine

```
type State = Idle | Loading | Done(data: string) | Failed(error: string)

let transition = (state: State, success: boolean): State => {
  match state {
    Idle => Loading
    Loading => if (success) { Done("data loaded") } else { Failed("network error") }
    Done(d) => Done(d)
    Failed(e) => Failed(e)
  }
}

var state = Idle
state = transition(state, true)
state = transition(state, true)

match state {
  Done(data) => print("finished: ${data}")
  Failed(err) => print("failed: ${err}")
  _ => print("still in progress")
}
```

### Null-Safe String Processing

```
let processName = (input: string?): string => {
  if (input != null) {
    let trimmed = input.trim()
    if (trimmed.length > 0) {
      trimmed.toUpperCase()
    } else {
      "ANONYMOUS"
    }
  } else {
    "ANONYMOUS"
  }
}

print(processName("  alice  "))   // "ALICE"
print(processName(null))          // "ANONYMOUS"
print(processName(""))            // "ANONYMOUS"
```

### Multi-File Project

**math.efs**
```
export let add = (a: number, b: number): number => a + b
export let multiply = (a: number, b: number): number => a * b
```

**types.efs**
```
export type Shape = Circle(radius: number) | Rect(width: number, height: number)

export let area = (shape: Shape): number => {
  match shape {
    Circle(r) => 3.14159 * r * r
    Rect(w, h) => w * h
  }
}
```

**main.efs**
```
import { add, multiply } from "./math"
import { Shape, Circle, Rect, area } from "./types"

let sum = add(1, 2)
let product = multiply(3, 4)
print("sum: ${sum}, product: ${product}")

let shapes = [Circle(5), Rect(3, 4)]
for (s in shapes) {
  let a = area(s)
  print("area: ${a}")
}
```