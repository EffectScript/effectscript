# @effectscript/lint — Linter Framework Overview

## What It Is

`@effectscript/lint` is the extensible static analysis framework for EffectScript. It
provides a rule registration system, an AST visitor infrastructure, a diagnostic sink,
and the `esc lint` command. It does not ship with any lint rules pre-1.0 — the framework
is the deliverable, not a rule set.

Rules will be added after 1.0 when the language syntax has stabilized and the patterns
considered idiomatic versus problematic are well-understood from real usage.

---

## The Distinction Between Compiler and Linter

The compiler is the authority on structural correctness: type safety, null safety,
exhaustive pattern matching, binding immutability. These are hard errors — the compiler
refuses to emit code that violates them.

The linter is the authority on idiomatic usage: patterns that are technically legal but
that violate the spirit of EffectScript's design, accumulate technical debt, or
represent common mistakes that the type system cannot catch. Linter violations are
surfaced as warnings or configurable-severity diagnostics, never as build failures by
default (though `esc lint --strict` can promote them to errors for CI enforcement).

The line between the two is deliberate. Mixing linting concerns into the compiler creates
a more complex compiler that is harder to reason about. Keeping them separate allows the
linter to be optional, configurable, extensible, and even replaceable.

---

## Why Build the Framework Pre-1.0

The linter framework — the rule registration system, the AST visitor infrastructure, and
the diagnostic sink — is entirely decoupled from the language syntax. It is a pattern for
writing analysis passes over an AST, with machinery to collect results and report them.
That pattern doesn't change when a new keyword is added to the language.

What is syntax-dependent is the rules themselves. A rule that warns about unnecessary
`let mut` bindings assumes `let mut` is the final syntax. Since v0.3 is changing this
(replacing `let mut` with `let`/`var`), writing that rule now would mean rewriting it in
v0.3. The framework is syntax-stable; the rules are not.

Building the framework now also establishes the extension point that third-party rule
authors will depend on. Getting this API right before 1.0 — while there are no external
consumers — is much lower cost than changing it after.

---

## Framework Architecture

### Rule Interface

A lint rule is an object implementing the `LintRule` interface:

```typescript
interface LintRule {
  id: string             // unique identifier, e.g., "no-unused-mut"
  name: string           // human-readable name
  description: string    // what the rule checks and why
  severity: 'error' | 'warning' | 'info'  // default severity, can be overridden in config
  category: RuleCategory // 'correctness' | 'style' | 'performance' | 'interop'

  // Called once per file; returns diagnostics found in that file
  check(context: RuleContext): LintDiagnostic[]
}
```

The `check` method receives a `RuleContext` that provides access to the file's typed AST,
source text, file path, and a helper API for common operations (finding all nodes of a
given kind, resolving a type at a given node, etc.). It returns an array of
`LintDiagnostic` objects, which include a location, message, and optional fix suggestion.

### RuleContext

`RuleContext` is the primary API surface that rule authors interact with. It is designed
so that rules can be written without deep knowledge of the compiler's internal AST
structure:

```typescript
interface RuleContext {
  // The typed AST for the current file
  ast: TypedSourceFile

  // Source text (for extracting original strings, whitespace, etc.)
  sourceText: string

  // File metadata
  filePath: string

  // AST traversal helpers
  walk(visitor: ASTVisitor): void
  findAll<T extends ASTNode>(kind: ASTNodeKind): T[]

  // Type system queries
  getTypeAt(node: ASTNode): Type | null
  isNullable(type: Type): boolean
  isAny(type: Type): boolean

  // Symbol resolution
  getDeclarationOf(identifier: IdentifierNode): ASTNode | null
  getReferencesTo(declaration: ASTNode): IdentifierNode[]

  // Reporting (alternative to returning from check())
  report(diagnostic: LintDiagnostic): void
}
```

The `walk` method takes a visitor object and invokes callbacks as the AST is traversed.
Rules that need to analyze patterns in context (e.g., "is this `let mut` ever
reassigned?") use `walk` to accumulate state across nodes. Rules with simpler patterns
(e.g., "find all optional chain operators on non-nullable types") use `findAll`.

### ASTVisitor

The visitor interface mirrors the AST node types. Each method is optional — a visitor
only needs to implement the handlers for the node types it cares about:

```typescript
interface ASTVisitor {
  onLetBinding?(node: LetBindingNode, context: VisitContext): void
  onMutBinding?(node: MutBindingNode, context: VisitContext): void
  onMatchExpression?(node: MatchExpressionNode, context: VisitContext): void
  onFunctionCall?(node: FunctionCallNode, context: VisitContext): void
  onTypeAnnotation?(node: TypeAnnotationNode, context: VisitContext): void
  // ... one method per AST node kind
}
```

The visitor is pre-order by default (parent before children). The `VisitContext`
parameter allows the visitor to skip subtrees (`context.skip()`) or stop traversal
entirely (`context.stop()`), enabling efficient rules that only need to examine certain
parts of the AST.

### LintDiagnostic

```typescript
interface LintDiagnostic {
  ruleId: string
  severity: 'error' | 'warning' | 'info'
  message: string

  // Primary location
  location: SourceLocation

  // Optional: additional context locations (e.g., "this binding was declared here")
  relatedLocations?: { location: SourceLocation, message: string }[]

  // Optional: an automated fix suggestion
  fix?: LintFix
}

interface LintFix {
  description: string  // "Remove mut keyword" or "Replace with let"
  edits: SourceEdit[]  // text edits to apply
}
```

The `fix` field is the foundation for auto-fix support — editors can apply the suggested
edits when the developer invokes "Fix" on a lint diagnostic. This is intentionally
optional in the rule interface: not every rule has an automatable fix, and forcing rule
authors to provide one creates pressure to provide incorrect fixes.

### Rule Runner

The rule runner orchestrates rule execution across a project:

1. Load the project's rule configuration from `esc.json`
2. Instantiate the configured rules (built-in and any installed plugins)
3. For each `.efs` file in scope, construct a `RuleContext` from the typed AST
4. Run each enabled rule against each file, collecting diagnostics
5. Emit diagnostics through the CLI infrastructure's reporter system

Rule execution is parallelizable per file (each file's analysis is independent) but
should be serialized per-file for correctness (a rule's `check` call for a given file
must complete before its results are collected). Node.js worker threads or async
parallelism are both viable approaches.

---

## Configuration System

Linter configuration lives in `esc.json` under a `"lint"` key:

```json
{
  "lint": {
    "rules": {
      "no-unused-mut": "warning",
      "no-implicit-any-escape": "error",
      "prefer-result-over-throw": "info",
      "custom-org-rule": "warning"
    },
    "plugins": [
      "@myorg/effectscript-lint-rules"
    ],
    "include": ["src/**/*.efs"],
    "exclude": ["src/**/*.test.efs"]
  }
}
```

### Severity Override

Each rule has a default severity (`'error'`, `'warning'`, or `'info'`) defined in its
implementation. The config can override this per-rule:
- `"error"` — treated as a build error with `--strict`
- `"warning"` — shown but doesn't affect exit code by default
- `"info"` — shown as informational only
- `"off"` — rule is disabled entirely

### Plugin System

Third-party rule packages are installed as npm dependencies and registered in the
`"plugins"` array. A plugin package exports an array of `LintRule` objects:

```typescript
// @myorg/effectscript-lint-rules/index.ts
export const rules: LintRule[] = [
  noPrivateApiUseRule,
  enforceResultTypeRule,
  // ...
]
```

The linter's plugin loader discovers these by importing the listed packages and reading
their `rules` export. This is the same pattern used by ESLint plugins, which is familiar
to the JavaScript developer audience.

### Per-File Overrides

Files can disable specific rules using inline comments:

```
// esc-lint-disable no-unused-mut
let mut counter = 0  // this specific case is intentional
```

And disable for a block:
```
// esc-lint-disable-next-line no-implicit-any-escape
let rawValue = externalLib.getData()
```

This is a direct parallel to ESLint's `// eslint-disable` comments, which developers
already know. The comment format should be documented as stable post-1.0 because third-
party codebases will embed these comments.

---

## CLI Interface

```
esc lint [path] [options]

Options:
  --rule <id>                 Run only the specified rule (can be repeated)
  --fix                       Apply auto-fix suggestions where available
  --fix-dry-run               Show what --fix would change without applying
  --reporter <pretty|json|github>  Diagnostic output format (shared with esc check)
  --strict                    Treat warnings as errors
  --max-warnings <n>          Exit nonzero if more than n warnings
  --quiet                     Show only errors, suppress warnings and info
```

`esc lint` should share the reporter system with `esc check` and `esc build`. A lint
diagnostic and a type error diagnostic are both `Diagnostic` objects in the reporter's
model — the reporter doesn't need to know whether a diagnostic came from the type checker
or a lint rule.

### `--fix` Mode

When `--fix` is passed, the rule runner collects all `LintFix` objects from all
diagnostics and applies them to the source files. Fix application must be conflict-
aware: if two rules both suggest edits to overlapping source ranges, only one fix can be
applied. The runner should apply non-conflicting fixes and report conflicting ones for
manual resolution.

Fix application writes back to the original `.efs` source files. This is a destructive
operation — the CLI should warn the user if the files are not under version control (no
`.git` directory detectable) or if `--dry-run` should be used first.

---

## Pre-1.0 Rule Candidates (For Reference — Do Not Implement Yet)

These are the rule ideas that are most clearly motivated by EffectScript's design
philosophy. They are documented here to inform the `RuleContext` API design — the API
should be capable of expressing these rules — but they should not be implemented until
post-1.0 when the underlying syntax they reference has stabilized.

**`no-unused-mut`** (style): Warns when a `let mut` (or `var` in v0.3+) binding is
declared but never reassigned. The fix is to remove the `mut`/`var` keyword. This is a
high-signal rule: `let mut` in EffectScript is a deliberate opt-in, and accidentally
opting in defeats the purpose of immutability-by-default.

**`no-implicit-any-escape`** (correctness): Warns when a value of type `Any` flows into
a position that accepts a concrete type without an explicit narrowing step. The compiler
allows this for interop reasons; the linter can warn about it as a code quality signal.

**`prefer-result-over-throw`** (style): Suggests using `Result<T, E>` with `attempt()`
instead of `try/catch` in contexts where the error type is known. Not an absolute rule
(both patterns are supported), but a nudge toward the preferred idiom in non-boundary code.

**`no-redundant-null-check`** (correctness): Warns when `?.` or `?? null` is used on a
value that the type checker knows is non-nullable. This is a semantic correctness issue
that the compiler could in principle catch, but raising it as a warning (rather than an
error) is a policy decision appropriate for the linter.

**`no-shadow-prelude`** (correctness): Warns when a user-defined binding shadows a
prelude name (`print`, `attempt`, `Ok`, `Err`, `Result`). The prelude names are always
in scope; shadowing them creates confusion about which `Ok` is being used.

**`no-deeply-nested-match`** (style): Warns when match expressions are nested beyond a
configurable depth (default: 3). Deeply nested match is usually a sign that the data
model should be refactored.

**`exhaustive-any-annotations`** (interop): Warns when a function parameter or return
type is `Any` without an accompanying doc comment explaining why. Useful for library
authors who want to document every deliberate `Any` escape rather than accumulating
undocumented ones.

---

## Relationship to the Compiler's AST Pass System

The compiler already has an extensible AST pass system with pre-check and post-check
slots. The linter framework is built on top of this, but is distinct from it:

- **Compiler AST passes** are part of the compilation pipeline. They run as part of
  `esc build` and `esc check`, have access to the same internal state as the type
  checker, and can emit compiler diagnostics that affect exit codes and block emit.

- **Lint rules** are separate from the compilation pipeline. They run after the type
  checker completes (they operate on the typed AST, not the raw AST), are only invoked
  by `esc lint` (or `esc build --lint`), and produce diagnostics through a separate
  channel that doesn't block emit.

This distinction matters for the design of `RuleContext`. It should expose the typed AST
(post-type-checking) but should not expose compiler-internal state that lint rules have
no business accessing. The API boundary is also a security boundary for third-party
plugins: a plugin rule can read the typed AST and report diagnostics, but cannot
manipulate the compiler's internal state or emit modified source.
