# @effectscript/doc — Documentation Generator Overview

## What It Is

`@effectscript/doc` is a documentation generator for EffectScript source files. It
extracts structured documentation from `/** */` doc comments attached to top-level
declarations, enriches the extracted data with type information from the compiler, and
renders it to HTML, Markdown, or JSON output.

It is invoked via `esc doc` and can be integrated into a project's CI/CD pipeline to
automatically publish updated API documentation alongside new releases.

---

## Why a Documentation Generator

EffectScript's value proposition includes being a first-class citizen of the npm
ecosystem — EffectScript libraries should be indistinguishable from TypeScript libraries
to consumers. A TypeScript library without API documentation is incomplete in the
ecosystem; the same standard applies to EffectScript.

The compiler already generates `.d.ts` declaration files that carry type signatures, but
type signatures alone do not explain intent, describe edge cases, or provide usage
examples. Documentation generators fill this gap.

Additionally, the LSP server (post-1.0) will use the same extracted documentation data
to display hover documentation in editors. Building the extraction infrastructure now —
in a lower-stakes context (a generator, not a latency-sensitive server) — validates the
doc comment parsing logic and establishes a shared data model that both the generator
and the LSP server will consume.

---

## Why the Infrastructure Can Be Built Pre-1.0

The documentation generator has an unusually clean decoupling from EffectScript's
evolving syntax: it only cares about **top-level declarations** (the things that can be
documented) and **doc comments** (which are syntax-invariant across all planned language
versions). Adding new syntax forms in v0.4 means adding new declaration types to the
extractor, not rearchitecting the pipeline.

The rendering pipeline, output formats, and the doc comment parsing logic are entirely
independent of the language grammar and can be built, tested, and stabilized pre-1.0.

---

## Doc Comment Format

Doc comments use the `/** */` block comment syntax, positioned immediately before the
declaration they document. This convention is identical to JSDoc/TSDoc, which means:

1. TypeScript consumers of EffectScript libraries see hover documentation in their
   editors via the generated `.d.ts` files (because the TypeScript language server reads
   JSDoc comments from `.d.ts` declarations)
2. Developers familiar with TypeScript know the convention immediately

```
/**
 * Computes the area of a shape.
 *
 * @param shape - The shape to compute the area of.
 * @returns The area in square units.
 *
 * @example
 * let circle = Circle(radius: 5.0)
 * let a = area(circle)  // 78.54
 */
let area = (shape: Shape): number =>
  match shape {
    Circle(r) => 3.14159 * r * r
    Rectangle(w, h) => w * h
  }
```

### Supported Doc Tags (v1)

| Tag | Description |
|-----|-------------|
| `@param <name> - <desc>` | Documents a function parameter |
| `@returns <desc>` | Documents the return value |
| `@example` | A code example (EffectScript syntax) |
| `@deprecated <reason>` | Marks a declaration as deprecated |
| `@since <version>` | Indicates when the declaration was added |
| `@throws <type> - <desc>` | Documents exceptions (for `Any`-returning functions that can throw) |
| `@see <reference>` | Cross-reference to another declaration |
| `@internal` | Marks a declaration as internal (excluded from generated docs by default) |

The tag set is intentionally minimal for v1 and compatible with the TSDoc specification,
which is what TypeScript's language server understands natively.

### What Gets Documented

All exported top-level declarations in a `.efs` file:
- `let` bindings (functions and values)
- `type` declarations (records, ADTs)
- Extension functions (`fun`)

Unexported declarations are not included in generated documentation by default (they are
implementation details). An `--include-internal` flag can override this.

---

## Architecture

### Three-Phase Pipeline

```
.efs source files
    ↓
[Phase 1: Extraction]
Doc comment parsing + declaration AST traversal
    ↓
DocItem[]  (structured intermediate representation)
    ↓
[Phase 2: Enrichment]
Type information added from compiler typed AST
    ↓
EnrichedDocItem[]
    ↓
[Phase 3: Rendering]
HTML | Markdown | JSON
```

### Phase 1: Extraction

The extractor traverses the AST of each `.efs` file and, for each exported top-level
declaration, collects:

- The declaration's name
- The doc comment immediately preceding it (using the trivia preserved in the AST)
- The declaration's AST node (passed to enrichment)
- The source file location (for source links)

Doc comment parsing is a mini-parser that reads the `/** */` block, strips leading
`* ` on each line, and separates the description prose from the `@`-tag annotations. The
description may contain inline Markdown (which is preserved and passed through to
renderers as-is).

The trivia preservation in the EffectScript AST — a deliberate architectural decision
made early in the compiler's development — is the prerequisite that makes doc comment
extraction straightforward. Without it, extracting comments would require reparsing the
source or maintaining a separate comment-position index.

### Phase 2: Enrichment

Enrichment adds type information that the raw AST traversal cannot provide on its own:
the inferred types of `let` bindings, the fully-resolved field types of records, and the
variant payloads of ADTs.

The enriched representation includes:
- The function signature as a typed string (`(shape: Shape) => number`)
- For ADTs: each variant's name and payload types
- For records: each field's name, type, and nullability
- Deprecation status (from `@deprecated` tag, used to render a visual indicator)

Enrichment requires running the type checker, which means it requires a `CompilerHost`
invocation. This is the same infrastructure used by `esc build` and `esc check`. The
generator is not a standalone text processor — it is a compiler consumer.

### Phase 3: Rendering

Renderers consume `EnrichedDocItem[]` and produce output files. Each renderer is a
separate implementation against a common renderer interface:

```typescript
interface DocRenderer {
  render(items: EnrichedDocItem[], config: DocConfig): Promise<void>
}
```

#### HTML Renderer

Produces a static HTML documentation site. The HTML is self-contained (no external
dependencies beyond a single embedded CSS file) and can be hosted on any static file
server or GitHub Pages.

Structure:
- `index.html` — entry page listing all documented modules
- `<module-name>.html` — per-module page with all exported declarations
- `search.json` — a JSON index used by embedded client-side search

The visual design should be clean, functional, and consistent with the EffectScript brand.
It should present syntax-highlighted code examples (using the same token categories as the
TextMate grammar will define post-1.0, or a simpler manual highlighter for now).

#### Markdown Renderer

Produces Markdown files suitable for GitHub wikis, README inclusion, or any Markdown-
based documentation system (Docusaurus, VitePress, etc.).

One Markdown file per module, with standard heading hierarchy (`##` for declarations,
`###` for parameters). Code blocks use ` ```effectscript ``` ` fencing so that syntax
highlighting works in any host that supports the TextMate grammar.

#### JSON Renderer

Produces a structured JSON file representing the entire project's documented API surface.
This is the machine-readable format for:
- Third-party tooling that wants to consume EffectScript documentation
- The LSP server's hover documentation feature (which will query this data at runtime)
- Search index generation for hosted documentation sites

The JSON schema should be versioned (`"schemaVersion": 1`) and documented.

Example schema fragment:
```json
{
  "schemaVersion": 1,
  "module": "src/shape.efs",
  "exports": [
    {
      "kind": "function",
      "name": "area",
      "signature": "(shape: Shape) => number",
      "description": "Computes the area of a shape.",
      "params": [
        { "name": "shape", "type": "Shape", "description": "The shape to compute the area of." }
      ],
      "returns": { "type": "number", "description": "The area in square units." },
      "examples": ["let circle = Circle(radius: 5.0)\nlet a = area(circle)  // 78.54"],
      "deprecated": false,
      "since": null,
      "location": { "file": "src/shape.efs", "line": 12 }
    }
  ]
}
```

---

## CLI Interface

```
esc doc [path] [options]

Options:
  --format <html|markdown|json>   Output format (default: html)
  --out <dir>                     Output directory (default: ./docs)
  --include-internal              Include @internal declarations
  --source-links                  Link declaration headings to source on GitHub
  --source-base-url <url>         Base URL for source links (e.g., GitHub blob URL)
  --title <string>                Project title for HTML output
  --watch                         Regenerate on source changes
```

`--source-links` with `--source-base-url` is the convention used by Rust's `rustdoc` and
Kotlin's Dokka to provide "view source" links in generated documentation. It is low-
effort to implement and high-value for open-source EffectScript libraries.

---

## Integration Points

### With esc.json

Documentation generator configuration can be stored in `esc.json` under a `"doc"` key,
avoiding the need for a separate config file:

```json
{
  "doc": {
    "format": "html",
    "out": "./docs",
    "sourceBaseUrl": "https://github.com/user/repo/blob/main",
    "title": "My Library"
  }
}
```

### With CI/CD

`esc doc` should exit with a nonzero code if any documented declaration has a doc comment
that references a `@param` not present in the function signature, or references a type
name that doesn't exist. These are documentation correctness errors and should surface in
CI, not silently produce incorrect documentation.

### With the LSP Server (Post-1.0)

The LSP server will use the JSON renderer's output as its source of hover documentation.
At startup, the LSP server reads `docs.json` (or an equivalent in-memory representation
computed by the doc generator library) and uses it to answer `textDocument/hover`
requests for declarations that have doc comments. This sharing is why the JSON output
format's schema stability matters — it's a contract between two different tools.

---

## What Is Deferred

The following capabilities are lower priority and should be deferred until the core
pipeline is working:

- **Cross-reference resolution** (`@see` links between modules) — requires a cross-file
  symbol index
- **Inherited documentation** (extension functions inheriting doc from the type they
  extend) — requires a deeper understanding of extension function relationships
- **Full-text search** in HTML output — client-side search with `search.json` can be
  a simple post-load script; a more sophisticated solution is a later investment
- **PDF output** — relevant for enterprise contexts; deferred
- **TSDoc compatibility testing** — formally testing that the generated `.d.ts` files
  render correctly in TypeScript's language server; important before 1.0 but requires
  a real test harness against `typescript-language-server`
