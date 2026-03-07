# EffectScript Syntax Guide

> **Version**: v0.1
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
10. [Arrays](#10-arrays)
11. [Strings](#11-strings)
12. [Null Safety](#12-null-safety)
13. [Operators](#13-operators)
14. [Error Handling](#14-error-handling)
15. [Modules](#15-modules)
16. [Loops](#16-loops)
17. [Comments](#17-comments)
18. [Built-in Prelude](#18-built-in-prelude)
19. [Built-in Methods](#19-built-in-methods)
20. [JS/TS Interop](#20-jsts-interop)
21. [Compilation Output](#21-compilation-output)
22. [Syntactic Rules and Constraints](#22-syntactic-rules-and-constraints)
23. [Complete Example Programs](#23-complete-example-programs)

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
let mut counter = 0
counter = counter + 1
counter = 10
```

`let mut` allows reassignment. Compiles to `let` in JavaScript. Attempting to reassign an immutable binding is a compile error (E202).

### Type annotations

Type annotations are optional — types are inferred when omitted.

```
let x: number = 42
let name: string = "Alice"
let flag: boolean = true
let mut count: number = 0
```

### Exporting variables

```
export let greeting = "hello"
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
| `void` | No meaningful value | (return type of side-effect functions) |
| `never` | Impossible type | (functions that always throw) |
| `Any` | Escape hatch, compatible with all types | (catch parameters, interop) |
| `null` | Null literal type | `null` |

### Composite types

```
// Array type
Array<number>
Array<string>
Array<Array<number>>

// Nullable type (T or null)
string?
number?
Array<string>?

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
```

### Named type aliases

```
type User = { name: string, age: number }
type Config = { host: string, port?: number }
export type Point = { x: number, y: number }
```

Named record type aliases are structural — they are erased in JS output and emitted as `export type` in `.d.ts` files.

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

### Generic functions

```
let identity = <T>(x: T): T => x
let first = <T, U>(a: T, b: U): T => a
```

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
let mut i = 0
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
let mut i = 0
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

The compiler enforces exhaustive matching. For ADTs, all variants must be covered. For nullable types, both the value and `null` must be handled.

```
type Color = Red | Green | Blue

// Error E203: non-exhaustive — missing Blue
match color {
  Red => "r"
  Green => "g"
}
```

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

### Trailing commas

```
let user = { name: "Alice", age: 30, }
```

### Empty record

```
let empty = {}
```

---

## 10. Arrays

### Array literals

```
let nums = [1, 2, 3]
let names = ["Alice", "Bob", "Carol"]
let empty: Array<number> = []
let nested = [[1, 2], [3, 4]]
```

### Type annotation

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

// Iteration
nums.forEach((n: number) => print(n))

// Queries
nums.includes(2)         // true
nums.at(0)               // 1 (returns number?, null if out of bounds)

// Mutation (only on let mut arrays)
let mut items: Array<number> = [1, 2]
items.push(3)            // adds to end
items.unshift(0)         // adds to start
items.pop()              // removes from end, returns number?
items.shift()            // removes from start, returns number?
```

### Iterating with for-in

```
for (n in [1, 2, 3]) {
  print(n)
}
```

---

## 11. Strings

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

## 12. Null Safety

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

## 13. Operators

### Arithmetic

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Addition / string concatenation | `1 + 2`, `"a" + "b"` |
| `-` | Subtraction | `5 - 3` |
| `*` | Multiplication | `2 * 3` |
| `/` | Division | `10 / 3` |
| `%` | Modulo | `10 % 3` |

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

### Pipe operator

The pipe operator `|>` enables left-to-right function composition.

```
let result = value |> transform |> format

// Equivalent to:
let result = format(transform(value))
```

Longer chains:

```
let output = data
  |> parse
  |> validate
  |> transform
  |> serialize
```

### Unary operators

| Operator | Description | Example |
|----------|-------------|---------|
| `-` | Arithmetic negation | `-x` |
| `!` | Logical NOT | `!flag` |

### Assignment

```
x = newValue           // reassign mutable variable
obj.field = newValue   // reassign mutable field
```

Assignment is a statement, not an expression. Only works with `let mut` bindings.

### Operator precedence (lowest to highest)

1. `||`
2. `&&`
3. `==`, `!=`, `<`, `>`, `<=`, `>=`
4. `??`
5. `|>` (pipe)
6. `+`, `-`
7. `*`, `/`, `%`
8. Unary (`!`, `-`)
9. Member access (`.`, `?.`), function call, `new`

---

## 14. Error Handling

### Try/catch

```
try {
  riskyOperation()
} catch (e) {
  print("something went wrong")
}
```

- Parentheses around the catch parameter are **required**: `catch (e)`.
- The catch parameter is typed as `Any`.
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

## 15. Modules

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

## 16. Loops

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

### While loop

```
let mut count = 0
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
let mut evens: Array<number> = []
for (n in [1, 2, 3, 4, 5, 6]) {
  if (n % 2 == 0) {
    evens.push(n)
  }
}
// evens = [2, 4, 6]
```

---

## 17. Comments

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

## 18. Built-in Prelude

These are available in every EffectScript file without importing.

### Types

| Type | Definition |
|------|-----------|
| `Result<T, E>` | `Ok(value: T) \| Err(error: E)` — represents success or failure |

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `Ok` | `<T, E>(value: T) => Result<T, E>` | Construct a success result |
| `Err` | `<T, E>(error: E) => Result<T, E>` | Construct an error result |
| `attempt` | `<T>(f: () => T) => Result<T, Error>` | Wrap a throwing function into a Result |
| `print` | `(value: Any) => void` | Print to console (compiles to `console.log`) |

---

## 19. Built-in Methods

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
| `forEach(fn)` | `((T) => void) => void` | Execute side effect for each element |
| `includes(item)` | `(T) => boolean` | Check if array contains item |
| `at(index)` | `(number) => T?` | Get element at index (nullable) |

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

## 20. JS/TS Interop

EffectScript has bidirectional interop with JavaScript and TypeScript.

### Importing from JS/TS packages

```
import { readFileSync } from "fs"
import { useState } from "react"
import React, { Component } from "react"
```

External packages resolve through Node.js module resolution. Type information is read from `.d.ts` declaration files.

### Using `new` for JS classes

EffectScript does not have its own class syntax, but you can construct JS/TS classes with `new`:

```
let err = new Error("something went wrong")
let map = new Map<string, number>()
```

### Type mapping

Types from `.d.ts` files are mapped to EffectScript types:
- `string`, `number`, `boolean` → same
- `null`, `undefined` → `null` (EffectScript unifies null and undefined)
- `T | null`, `T | undefined`, `T?` → `T?` (nullable)
- `Array<T>`, `T[]` → `Array<T>`
- `Record<K, V>` → `{ [key: K]: V }`
- Interfaces / object types → record types
- Enums → union types or ADTs
- `any`, `unknown` → `Any`

---

## 21. Compilation Output

### JavaScript

| EffectScript | JavaScript |
|-------------|-----------|
| `let x = 1` | `const x = 1;` |
| `let mut x = 1` | `let x = 1;` |
| `==` | `===` |
| `!=` | `!==` |
| `x \|> f \|> g` | `g(f(x))` |
| `print(x)` | `console.log(x)` |
| `"hello ${name}"` | `` `hello ${name}` `` |
| `Ok(42)` | `{ _tag: "Ok", value: 42 }` |
| `Red` (fieldless ADT) | `Object.freeze({ _tag: "Red" })` |
| `Circle(5)` (fielded ADT) | `Circle(5)` → `{ _tag: "Circle", radius: 5 }` |
| `import { a } from "./mod"` | `import { a } from "./mod.js";` |

### Declaration files (.d.ts)

Only exported declarations are emitted:
- Functions → `export declare const name: (params) => returnType;`
- Constants → `export declare const name: Type;`
- ADTs → interfaces with `_tag` discriminant + union type + constructor declarations
- Named record types → `export type Name = { ... };`

### Source maps

`.js.map` files are generated (Source Map v3) mapping back to the original `.efs` source.

---

## 22. Syntactic Rules and Constraints

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
11. **Lambda parameters** always require explicit type annotations (no contextual inference).
12. **`??` cannot be mixed with `&&` or `||`** without explicit parentheses (E117).
13. **Immutable by default** — `let` bindings cannot be reassigned; use `let mut` for mutability.
14. **No `var`** — only `let` and `let mut`.
15. **Double quotes only** — strings use `"..."`, not `'...'` or backticks.
16. **`new` is for JS interop only** — constructing external JS/TS classes.

---

## 23. Complete Example Programs

### FizzBuzz

```
let mut i = 1
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

let mut state = Idle
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