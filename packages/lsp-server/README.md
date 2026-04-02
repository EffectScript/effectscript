# effectscript-lsp — Language Server Scaffolding Overview

## What It Is

`effectscript-lsp` is a Language Server Protocol (LSP) server for EffectScript. It is a
long-running process that maintains a live model of an EffectScript project's state and
responds to requests from any LSP-capable editor — VS Code, Neovim, Helix, Zed, Emacs,
and others — providing editor intelligence: hover types, go-to-definition, inline
diagnostics, completion, and more.

This document covers the **scaffolding phase** of the LSP server — the work that can and
should be done pre-1.0, before the language syntax stabilizes. The full semantic feature
set (hover, completion, go-to-definition, rename) is documented as a separate concern to
be built after 1.0.

---

## LSP Protocol Background

The Language Server Protocol was created by Microsoft as a way to decouple language
intelligence from individual editors. An LSP server is a standalone process; the editor
runs an LSP client that communicates with it over stdin/stdout or a TCP socket using
JSON-RPC. Because the protocol is editor-agnostic, a single LSP server implementation
provides intelligence in every editor that supports LSP — which is now essentially all of
them.

The protocol has two primary communication patterns:

- **Request/response:** The editor sends a request, the server processes it and replies.
  Examples: `textDocument/hover`, `textDocument/completion`, `textDocument/definition`.

- **Notifications (one-way):** Either party sends a message with no response expected.
  Examples: `textDocument/didOpen`, `textDocument/didChange`, `textDocument/publishDiagnostics`.

Diagnostics in particular are push-based: the server sends `textDocument/publishDiagnostics`
notifications to the client whenever it has new diagnostic information, without being
asked. This is the mechanism for inline error squiggles.

---

## Why Scaffold Now, Not Later

### The Architectural Argument

The LSP server's most important architectural property is that it must operate
incrementally and at low latency. Achieving this requires decisions that interact deeply
with the compiler's internal structure — specifically how the type checker is invoked, how
its results are cached, and how file changes propagate through the project dependency
graph.

These architectural decisions should be proven before 1.0, not after. Building the
scaffolding now — with diagnostic push as the only feature — validates:

1. That the `CompilerHost` API can be driven incrementally (re-checking only changed
   files and their dependents)
2. That the project dependency graph is correctly maintained as files change
3. That the server process lifecycle is stable (no memory leaks, no crashes on malformed
   input)
4. That the editor client integration (VS Code extension wiring) works end-to-end

### The Risk Argument

Every language server that started development after the language was "done" has faced
the same problem: the compiler's internal APIs were not designed with incremental,
multi-file, long-running access patterns in mind, and retrofitting them is expensive.

EffectScript's file-level type checker isolation is the critical property that makes a
correct LSP architecture possible. That isolation was a deliberate architectural decision.
Building the LSP scaffolding now validates that the isolation works as intended under
realistic access patterns and catches any gaps before the architecture is locked at 1.0.

### What "Scaffolding Only" Means

Pre-1.0, the LSP server should implement exactly one semantic feature: **diagnostic push**.
That is, surface compiler errors and warnings as inline squiggles in the editor as files
are opened and edited.

Everything else — hover types, go-to-definition, completion, rename — is deferred until
post-1.0 when:
- The type system is stable enough that the data being surfaced won't keep changing shape
- The compiler preserves enough per-node type information to answer these queries
- The language has enough users to validate that the features work correctly in real
  codebases

The scaffolding phase establishes the server process, the project model, the incremental
update loop, and the diagnostic push pipeline. Post-1.0 features are additions on top of
this foundation.

---

## Core Architecture

### Server Process Model

The LSP server runs as a persistent Node.js process. It is not invoked once-per-request
like the `esc` CLI — it starts when the editor opens an EffectScript project and stays
running until the editor closes or the workspace is changed. This long-running model is
what makes incremental state maintenance possible.

The server communicates with the editor client via **stdio** (default) or a **TCP socket**
(for debugging and remote development). The `vscode-languageserver` npm package handles
the JSON-RPC framing over both transports.

### Project Model

The project model is the server's in-memory representation of the EffectScript project
it is currently serving. It is initialized from `esc.json` and maintained incrementally
as files change. It contains:

- **File registry:** All `.efs` files in scope, with their current source content (either
  read from disk or from the editor's in-memory buffer for unsaved changes)
- **Dependency graph:** Which files import which other files, computed from the AST of
  each file after parsing
- **Compiler result cache:** Per-file type checking results (diagnostics, the typed AST)
  keyed by file content hash

The project model is the shared state that all request handlers read from. It must be
updated correctly when files change and must not be concurrently mutated while a request
handler is reading from it (handled via async queuing — see below).

### Incremental Update Loop

When a file changes (via `textDocument/didChange`), the server:

1. Updates the file's source content in the file registry
2. Re-parses the changed file and updates the dependency graph if imports changed
3. Identifies the set of files that need to be re-type-checked: the changed file plus
   any files that import it (transitively), bounded by the type checker's isolation
   guarantees
4. Re-runs the type checker on the affected set
5. Pushes updated diagnostics for all affected files via `publishDiagnostics`

The key constraint is that steps 3–5 must complete quickly enough that the editor's
error squiggles update while the user is still looking at the screen — ideally within
200–500ms for typical file sizes. For very large files or deep dependency chains, the
server should publish a "checking..." status (via `window/workDoneProgress`) and push
results when ready, rather than blocking.

### Request Queue

LSP requests from the editor can arrive concurrently, but the project model is not
designed for concurrent mutation. The server uses an async request queue to serialize
model updates while allowing read-only request handlers (which will eventually serve
hover and completion) to run concurrently with each other.

The pattern: model updates (file changes) are enqueued and applied sequentially;
read-only queries wait for the queue to drain and then execute against a consistent
snapshot of the model.

---

## Diagnostic Push Pipeline

This is the only semantic feature to implement in the scaffolding phase.

### File Open (`textDocument/didOpen`)

When the editor opens a `.efs` file, the server:

1. Adds the file to the file registry with its current content
2. Type-checks the file (and any newly discovered imports) against the project model
3. Immediately pushes diagnostics for the opened file

### File Change (`textDocument/didChange`)

The editor sends incremental or full-document changes. The server applies them to the in-
memory content (using the incremental delta if available, for efficiency), then runs the
incremental update loop described above.

Debouncing: rapid changes (fast typing) should not trigger a type-check on every
keystroke. A debounce window of 300ms is appropriate — re-check starts 300ms after the
last change in a burst.

### File Close (`textDocument/didClose`)

The server transitions the file back to disk-based content. The file remains in the
project model (it may still be imported by open files), but its content is no longer
synchronized from the editor buffer.

### Diagnostic Format

DAP diagnostics must be translated to LSP's `Diagnostic` format:
```typescript
{
  range: { start: { line, character }, end: { line, character } },
  severity: 1 | 2 | 3 | 4,  // Error, Warning, Information, Hint
  code: string,               // "E0042"
  source: "effectscript",
  message: string,
  relatedInformation?: [{ location, message }]  // for multi-span diagnostics
}
```

The `relatedInformation` field is important for EffectScript's multi-location diagnostics
— for example, an exhaustiveness error that references both the match expression and the
ADT definition where the missing variant is declared. These should be surfaced as related
information, not collapsed into a single-location error.

---

## Workspace and Project Discovery

The server receives a `initialize` request with `rootUri` or `workspaceFolders` when the
editor opens a project. The server should:

1. Search for `esc.json` starting from the root URI (walking up if not found at root)
2. If found, use it to configure the project model
3. If not found, operate in a "loose file mode" where each open `.efs` file is checked
   individually without project-level type information

Loose file mode is important for the use case where a developer opens a single `.efs`
file without a project context — common when evaluating the language or working on
standalone scripts. The server should be useful in this case even without a full project.

### Multi-Root Workspaces

VS Code supports multi-root workspaces (multiple top-level directories in the same
workspace). The server should support multiple concurrent project models — one per
`esc.json` found in workspace folders — and route file events to the correct project
model based on file path prefix.

---

## Server Process Lifecycle

### Startup

The server process is started by the editor client (typically via the VS Code extension's
`serverOptions` configuration). Startup should be fast — under 1 second on typical
hardware — since editors often start the language server while the developer is still
navigating to a file. The `CompilerHost` initialization (which may involve reading and
processing `.d.ts` files for npm dependencies) is the most expensive part of startup and
should be deferred until the first file in the project is opened, not performed eagerly
at process start.

### Shutdown

The editor sends a `shutdown` request followed by an `exit` notification. The server
should clean up any temporary files, flush any pending diagnostic updates, and exit
cleanly. Crash recovery — the ability to restart the server if it crashes — is handled by
the editor client, not the server.

### Telemetry and Logging

The LSP protocol includes a `telemetry/event` notification for structured telemetry and
`window/logMessage` for human-readable log output. The server should use these for:

- Startup time and file count metrics (sent via `telemetry/event`)
- Compilation errors in the server itself (sent via `window/logMessage` at error level)
- Performance warnings when type-checking takes longer than expected

Do not send telemetry to any external endpoint without explicit user opt-in. For pre-1.0,
logging to a local file (configurable, disabled by default) is sufficient.

---

## Client Configuration

The LSP `initialize` request includes `initializationOptions` where the client can pass
tool-specific configuration. The server should accept:

```typescript
{
  escConfigPath?: string,       // override esc.json discovery
  checkOnSave?: boolean,        // default true — check on every save
  checkOnType?: boolean,        // default true — check while typing (debounced)
  diagnosticsDebounceMs?: number, // default 300
  trace?: 'off' | 'messages' | 'verbose'  // for debugging the LSP session
}
```

`trace` is particularly important for debugging LSP issues — setting it to `'verbose'`
should log all request/response pairs to a log file or the LSP output channel.

---

## Technology Choices

**`vscode-languageserver` and `vscode-languageserver-textdocument`:** The Microsoft-
maintained npm packages for building LSP servers in Node.js. Despite the VS Code naming,
these are protocol implementations with no VS Code dependency. They handle JSON-RPC
framing, request routing, and text document synchronization (including incremental delta
application for `textDocument/didChange`). Using these packages means the implementation
focuses on EffectScript-specific logic, not protocol mechanics.

**Node.js:** The server runs on Node.js because the `CompilerHost` is a Node.js/TypeScript
package. The same runtime, no FFI boundary, no serialization overhead for compiler API
calls.

---

## What Is Explicitly Out of Scope Pre-1.0

The following LSP capabilities should not be implemented until after 1.0:

- **`textDocument/hover`** — requires stable per-node type information in the compiler's
  typed AST
- **`textDocument/completion`** — requires stable knowledge of what identifiers are in
  scope at any given position
- **`textDocument/definition`** (go-to-definition) — requires a cross-file symbol index
- **`textDocument/references`** (find references) — same cross-file index requirement
- **`textDocument/rename`** — same, plus workspace edit application
- **`textDocument/codeAction`** (quick fixes) — requires stable diagnostic codes and
  associated fix logic
- **`textDocument/semanticTokens`** — requires stable token type classifications
- **`textDocument/inlayHints`** — requires stable inferred type information per binding

Each of these is a well-defined addition to the scaffolding foundation. Their deferral is
not a permanent decision — it is a boundary that keeps pre-1.0 work syntax-stable.
