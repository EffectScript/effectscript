# EffectScript

A safer JavaScript that compiles to clean JS with full TypeScript interop.

EffectScript brings ideas from Kotlin and Rust — immutability by default, null safety, algebraic data types, pattern matching — while keeping seamless bidirectional interop with the TypeScript/JavaScript ecosystem.

## Features

- **Immutable by default** — `let` bindings are immutable; opt into mutation with `var`
- **Null safety** — nullable types are explicit (`Type?`), with `?.`, `??`, and exhaustive pattern matching
- **Algebraic data types** — define variants with named or positional fields
- **Pattern matching** — exhaustive `match` expressions with destructuring
- **Expression-oriented** — `if`/`else`, `match`, `try`/`catch`, and blocks all return values
- **Extension functions** — add methods to existing types with `fun Type.method()`, Kotlin-style
- **Async/await** — native `async` functions with `Promise<T>` types and `await` expressions
- **Named arguments** — call functions with `name: value` syntax for readability; skip defaulted parameters
- **Generic constraints** — bound type parameters with `<T: { name: string }>` for type-safe generic code
- **BigInt and Symbol** — first-class `bigint` literals (`42n`) with type-safe arithmetic, and `symbol` type for JS interop
- **Built-in collections** — `Set<T>` and `Map<K, V>` with null-safe methods, plus expanded `Array<T>` methods
- **Tuples** — fixed-length heterogeneous sequences with expressions `(1, "hello")`, positional indexing `.0`, destructuring, and match patterns
- **Enhanced for loops** — range loops (`for (i in 0..<10)`), record/tuple destructuring, and `withIndex()` iteration
- **TypeScript interop** — import `.d.ts` types directly; generates `.js` + `.d.ts` output; conditional types (`ReturnType<T>`, `NonNullable<T>`, etc.) are resolved to concrete types; platform types preserve partial type info for remaining unmappable TS constructs
- **Familiar syntax** — if you know TypeScript, you can read EffectScript

## Quick Look

```
// Immutable by default
let name = "world"
let greeting = "Hello, ${name}"

// Mutable when needed
var counter = 0
counter = counter + 1

// Null safety
let user: User? = findUser(id)
let displayName = user?.name ?? "Anonymous"

// Algebraic data types + pattern matching
type Shape = Circle(radius: number) | Rectangle(width: number, height: number)

let area = (shape: Shape): number =>
  match shape {
    Circle(r) => 3.14159 * r * r
    Rectangle(w, h) => w * h
  }

// Everything is an expression
let status = if (isActive) "on" else "off"

let result = try {
  riskyOperation()
} catch (e) {
  fallbackValue
}
```

## Getting Started

### Install

```sh
npm install effectscript-compiler
```

### Create a Project

```sh
npx esc init my-project
cd my-project
```

This creates:

```
my-project/
  esc.json          # Compiler configuration
  package.json
  .gitignore
  src/
    main.efs        # Entry point
```

### Build and Run

```sh
# Compile .efs files to .js + .d.ts
npx esc build

# Type-check without emitting output
npx esc check

# Compile and run a single file
npx esc run src/main.efs
```

## CLI Reference

```
esc build [path]       Compile .efs files to JS + DTS
esc check [path]       Type-check without emitting
esc run <file>         Compile and execute a .efs file
esc init [dir]         Scaffold a new project

Options:
  --outDir <dir>       Output directory
  --sourceMap          Enable source maps
  --watch              Watch for changes and recompile
  --config <path>      Path to config file
  --quiet              Suppress warnings
  --diagnostics        Show compiler timing and stats
  --no-cache           Disable declaration cache
  --no-color           Disable ANSI colors
  --help               Show help
  --version            Show version
```

## Configuration

Projects are configured with `esc.json`:

```json
{
  "compilerOptions": {
    "outDir": "./dist",
    "sourceMap": true,
    "target": "es2020"
  },
  "include": ["src/**/*.efs"],
  "exclude": ["node_modules"]
}
```

## TypeScript Interop

EffectScript reads `.d.ts` declaration files to type-check imports from npm packages and TypeScript projects. The compiled output includes `.d.ts` files so TypeScript projects can import EffectScript modules.

```
// Import from npm packages
import { readFileSync } from "fs"

// Import from TypeScript
import { MyComponent } from "./component"

// EffectScript exports are usable from TypeScript
export let greet = (name: string): string => "Hello, ${name}"
```

## Documentation

- [Language Overview](docs/overview.md) — syntax, types, and concepts
- [v0.1 Specification](docs/requirements.md) — detailed language requirements
- [Feature Designs](docs/designs/) — design docs for implemented features
- [Contributing](CONTRIBUTING.md) — how to contribute
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and development workflow. The project follows a design-first, TDD approach with conventional commits.

## License

[MIT](LICENSE)