# Contributing to EffectScript

Thank you for your interest in contributing to EffectScript! This guide will help you get set up and understand our workflow.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (comes with Node.js)
- Git

### Setup

```bash
git clone https://github.com/effectscript/effectscript.git
cd effectscript
npm install
cd compiler
```

### Common Commands

All commands are run from the `compiler/` directory:

```bash
npm test           # Run all tests (vitest)
npm run test:watch # Run tests in watch mode
npm run typecheck  # Type-check without emitting (tsc --noEmit)
npm run build      # Compile TypeScript to JavaScript
```

## Project Structure

```
compiler/
  src/
    lexer/        # Tokenizer (Phase 2)
    parser/       # Parser and AST definitions (Phase 3)
    passes/       # AST visitor and pass infrastructure (Phase 4)
    checker/      # Type checker (Phase 5)
    prelude/      # Built-in types and functions (Result, print, etc.)
    interop/      # TypeScript interop layer (Phase 6)
    codegen/      # JavaScript and .d.ts code generation (Phase 7)
    graph/        # Module graph and multi-file compilation (Phase 8)
    diagnostics/  # Diagnostic types and Rust/Elm-style formatter
    utils/        # Shared utilities (operators, glob matching)
    cli.ts        # CLI entry point (esc command)
    host.ts       # CompilerHost API
    compiler.ts   # Pipeline orchestration
    config.ts     # Configuration file reader
    filesystem.ts # File system abstraction
    pipeline.ts   # Multi-file compilation pipeline
```

Tests are colocated with their modules as `*.test.ts` files.

## Workflow

### Design First

Every new feature or significant change **must** have a design doc before implementation begins. Design docs live in `docs/designs/` and describe the problem, proposed solution, API surface, and test plan.

Open an issue or discussion to propose the feature before writing the design doc if you're unsure whether it fits the project's direction.

### Test-Driven Development (TDD)

TDD is mandatory. Follow the red-green-refactor cycle:

1. **Red** — Write a failing test that defines the expected behavior.
2. **Green** — Write the minimum code to make the test pass.
3. **Refactor** — Clean up while keeping tests green.

No implementation code should be submitted without corresponding tests.

### Making Changes

1. **Fork the repo** and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. **Write tests first**, then implement.
3. **Run the full test suite** before committing:
   ```bash
   npm test
   npm run typecheck
   ```
4. **Commit with conventional commits** (see below).
5. **Open a pull request** against `main`.

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — A new feature
- `fix:` — A bug fix
- `refactor:` — Code restructuring without behavior change
- `test:` — Adding or updating tests
- `docs:` — Documentation changes
- `chore:` — Build, CI, or tooling changes

Examples:
```
feat: add return statement support
fix: resolve type-arg parsing ambiguity in while conditions
test: add e2e tests for module graph cycle detection
docs: update CLI reference with --watch flag
```

### Pull Requests

- **One logical change per PR** — keep PRs small and focused.
- **Reference the design doc** in the PR description if applicable.
- **Describe what was tested** and how to verify the change.
- All tests and type checks must pass before merging.

## Coding Standards

- **TypeScript strict mode** — no `any` type; use `unknown` with type guards.
- **Immutability by default** — use `const`, `readonly`, and immutable data structures.
- **Pure functions preferred** — minimize side effects and mutation.
- **Explicit error handling** — no empty catch blocks or silently swallowed errors.
- **Small focused modules** — one concern per file with clear boundaries.
- **Descriptive names** — prefer clear names over comments.
- **No dead code** — delete unused code rather than commenting it out.

## Reporting Bugs

Open an issue on [GitHub Issues](https://github.com/effectscript/effectscript/issues) with:

- A short description of the bug.
- The EffectScript source code (`.efs`) that triggers it.
- Expected vs. actual behavior.
- Your Node.js version and OS.

## Suggesting Features

Open an issue or a [GitHub Discussion](https://github.com/effectscript/effectscript/discussions) with:

- The problem you're trying to solve.
- How you'd expect the feature to work (example syntax or API if applicable).
- Whether you'd be interested in implementing it.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards. Report concerns to hello@effectscript.org.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).