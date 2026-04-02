# effectscript-vite — Vite Plugin Overview

## What It Is

`effectscript-vite` is a Vite plugin that enables `.efs` files to participate as
first-class modules in any Vite-powered project. A developer adds the plugin to their
`vite.config.ts`, and from that point forward, `.efs` files can be imported anywhere in
the project — React components, utility modules, shared types — with full Hot Module
Replacement (HMR) support and source map integration.

The plugin is a thin integration layer. It does not reimplement any compilation logic; it
delegates entirely to the `CompilerHost` API from the `effectscript` compiler package.
Its job is to translate between Vite's plugin lifecycle and the compiler's transform
interface.

---

## Why Vite First

Vite is the dominant build tool for modern frontend JavaScript development as of 2025,
used by default in Vue, SvelteKit, Astro, and increasingly React projects (via frameworks
like Remix and TanStack Start). Its plugin API is well-documented, stable across major
versions, and has a large existing ecosystem of plugins to reference.

More importantly, Vite is where EffectScript's most likely early adopters live: teams
using React or Vue who are dissatisfied with TypeScript's safety guarantees and are open
to a safer alternative that stays fully within the npm ecosystem.

The plugin is also the single highest adoption-unlock investment available during pre-1.0.
Without it, EffectScript in a real frontend project requires a manual two-step build
process — `esc build` followed by the Vite build — which is enough friction to prevent
evaluation.

---

## How Vite Plugins Work (Context for Architecture)

Vite's plugin system is built on top of Rollup's plugin API with Vite-specific hooks
added. A plugin is an object (or factory function returning an object) with named hook
functions. The hooks most relevant to `effectscript-vite` are:

- **`resolveId`** — intercept module resolution for `.efs` imports and tell Vite how to
  find the file
- **`load`** — read the `.efs` file content (Vite can do this automatically, but custom
  load hooks allow for virtual modules)
- **`transform`** — receive file content, return transformed JS content plus a source map

Vite separates its operation into two modes: **dev server** (using native ES modules and
transforming files on demand) and **build** (using Rollup for bundling). A plugin's
transform hook runs in both modes, which means a single implementation covers both use
cases.

HMR in Vite works via a client-server protocol where the dev server watches for file
changes and the browser client receives update notifications. Plugins that want fine-
grained HMR (accepting module updates without a full page reload) implement the
`handleHotUpdate` hook and inject `import.meta.hot` accept calls into their transformed
output.

---

## Core Responsibilities

### 1. File Transform Pipeline

The primary function: receive an `.efs` file's source content, call the `CompilerHost`
transform API, and return the emitted JavaScript plus source map to Vite. The source map
must be in Vite's expected format (a `SourceMap` object or a base64-encoded inline map)
so that Vite's own source map merging (which chains plugin source maps together) works
correctly.

Error handling: if the compiler emits diagnostics at error severity, the plugin must
surface these to Vite's error overlay in dev mode. Vite has a standardized `error` event
format with a `loc` field (file, line, column) and a `frame` field (source context
around the error). The compiler's existing structured diagnostics map cleanly to this
format.

### 2. Module Resolution

Vite resolves imports using Node's module resolution algorithm augmented by its own alias
and base URL configuration. The plugin needs to teach Vite that `.efs` extensions are
resolvable — both bare imports (`import { foo } from "./utils"` where `utils.efs` exists)
and explicit imports (`import { foo } from "./utils.efs"`).

The resolution hook should respect the project's `esc.json` configuration for things like
path aliases, if any are defined.

### 3. TypeScript Declaration Handling

The compiler emits `.d.ts` files alongside `.js` output. In a Vite context, the
TypeScript language server (running separately in the editor) needs to see these
declarations to provide type checking for `.efs` imports used in `.ts` and `.tsx` files.

The plugin should optionally trigger declaration emit on transform (or on a configurable
schedule), writing `.d.ts` files to a configured output directory that the project's
`tsconfig.json` includes. This is the bridge that makes EffectScript modules fully typed
from a TypeScript consumer's perspective without any manual steps.

### 4. HMR Support

When an `.efs` file changes, Vite's default behavior is a full module graph invalidation
for that file. For most use cases this is acceptable, but the plugin should implement the
`handleHotUpdate` hook to:

- Invalidate the module in Vite's module graph
- Propagate the invalidation to modules that import the changed `.efs` file
- Inject `import.meta.hot.accept()` boundary declarations into transformed output for
  modules that export only pure values (records, functions, ADT constructors) — these can
  accept hot updates without side effects

### 5. Configuration Interface

The plugin should accept a configuration object that maps to the relevant subset of
`esc.json`/`CompilerHost` options:

- Path to `esc.json` (defaults to project root)
- Whether to emit `.d.ts` files during dev (default: false, emit only on build)
- Whether to emit source maps in dev mode (default: true)
- Log level for compiler diagnostics
- Whether to fail the build on warnings (default: false)

---

## Integration Points

**With the EffectScript compiler:** The plugin imports `effectscript` (the compiler
package) directly as a Node.js dependency. It does not shell out to the `esc` CLI. This
is essential for performance — the CLI has startup overhead that's acceptable for one-off
builds but not for transform hooks that run on every file in the module graph.

**With Vite's error overlay:** In dev mode, Vite renders a browser overlay for transform
errors. The plugin translates compiler diagnostics into Vite's `ViteDevServer.ws.send`
error format so errors appear in the overlay with source context, not just in the
terminal.

**With TypeScript:** The project's `tsconfig.json` needs to know about `.efs` files. The
plugin should either provide guidance or automatically generate a `tsconfig` path mapping
that points TypeScript at the emitted `.d.ts` files.

**With Vite's caching:** Vite maintains a transform cache at `.vite/` in the project
root. The plugin should participate correctly in cache invalidation — a cache hit should
only be used if the `.efs` source content and the compiler version are both unchanged.
The compiler version should be embedded as a cache key alongside the content hash.

---

## Operational Constraints

**Performance:** Transform hooks run synchronously in Vite's hot path. The `CompilerHost`
API must support single-file transforms that don't require re-checking the entire project.
File-level type checker isolation (already an architectural property of the EffectScript
compiler) is the prerequisite for this. If the transform triggers a full project check,
the dev server will be unusably slow for large projects.

**Compatibility:** Vite's plugin API has been stable across Vite 3, 4, and 5 with minor
additions. The plugin should declare a minimum Vite version (likely 4.x) and be tested
against the current major at time of release. Use Vite's `enforce` property to ensure
correct ordering relative to Vue/React plugins if present.

**Error recovery:** If the compiler crashes (unhandled exception, not a diagnostic), the
plugin must catch this and surface it as a Vite error rather than crashing the dev server
process. Dev servers that crash on malformed input frustrate developers and damage trust
in the toolchain.

---

## Relationship to Other Build Plugins

`effectscript-vite`, `effectscript-esbuild`, and `effectscript-rollup` share a core
transform concern. Once the Vite plugin is working, the shared logic (CompilerHost
invocation, diagnostic formatting, source map handling) should be extracted into an
internal `@effectscript/plugin-core` package that all three plugins depend on. This
prevents the same bug from being fixed in one plugin and left broken in the others.

The Vite plugin should be developed first; the shared core should be extracted after the
Vite plugin is working and before the esbuild plugin is started.

---

## Non-Goals

- **Bundling EffectScript projects standalone** — this is `esc build`'s job. The Vite
  plugin operates within a Vite project, not as a general-purpose bundler.
- **Running the LSP server** — editor intelligence is handled by a separate process.
- **Type-checking at build time** — the plugin surfaces compiler errors but is not a
  substitute for `esc check` in CI. The distinction is: transform errors (which block the
  build) vs. type-check warnings (which `esc check` catches comprehensively).
