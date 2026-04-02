# effectscript-dap — Debug Adapter Overview

## What It Is

`effectscript-dap` is a Debug Adapter Protocol (DAP) server that enables interactive
debugging of EffectScript programs in any editor or IDE that supports DAP — including VS
Code, Neovim (via nvim-dap), and others. It allows developers to set breakpoints in
`.efs` source files, step through execution, and inspect variables — all while EffectScript
code is actually executing as compiled JavaScript in Node.js.

The adapter is not a new debugger. It is a translation layer between the DAP protocol
(spoken by the editor) and the Node.js inspector protocol (spoken by V8), using
EffectScript's source maps to remap all source locations between the two domains.

---

## Why a DAP Adapter (and Why Now)

### The Problem Without It

Without a DAP adapter, debugging EffectScript means debugging compiled JavaScript.
Developers must mentally map JS line numbers back to `.efs` source, navigate through
generated code rather than their own, and lose all context about EffectScript-specific
constructs like ADT variant names and match expression structure.

Source maps exist in the compiler output already, but source maps are passive artifacts —
they only help if the debugging toolchain knows to use them and is configured to do so.
The DAP adapter is what makes the source map useful interactively.

### Why This Can Be Built Pre-1.0

The DAP adapter is decoupled from EffectScript's syntax in a meaningful way: it operates
on source maps (which map compiled JS locations to source locations), not on the source
language itself. The source map format (`sourceMappingURL`, VLQC-encoded mappings) is a
stable external standard. When the EffectScript language adds new syntax in v0.4 or v0.5,
the compiled JS still uses V8, the source maps still use the same format, and the DAP
adapter still does the same translation.

The only EffectScript-specific logic in the adapter is the source file extension (`.efs`)
and any presentation-layer decisions about how to display EffectScript types in the
variable inspector panel. Both are trivially updated.

Building the adapter pre-1.0 also validates that the compiler's source map output is
correct and complete — bugs in source maps are much easier to find when you're actively
using them for debugging than when you're generating them speculatively.

---

## Background: The DAP Protocol

DAP is a JSON-RPC protocol originally created by Microsoft for VS Code and subsequently
adopted by most major editors. It defines a standard interface between editors (DAP
clients) and language-specific debug adapters (DAP servers). The protocol covers:

- Session lifecycle (launch, attach, disconnect)
- Breakpoint management (set, remove, verify)
- Execution control (continue, next, stepIn, stepOut, pause)
- State inspection (stack frames, scopes, variables, evaluate)
- Output events (stdout, stderr, console output from the debuggee)

An adapter receives requests from the editor, translates them into operations on the
actual runtime being debugged, and sends back responses and events. The editor never
communicates directly with the runtime.

---

## How the Adapter Works

### The Translation Stack

```
Editor (VS Code, Neovim, etc.)
    ↕ DAP protocol (JSON-RPC over stdio or TCP)
effectscript-dap adapter
    ↕ Node.js inspector protocol (CDP over WebSocket)
Node.js / V8 (executing compiled .js)
    ↕ Source maps
.efs source files
```

The adapter sits between two well-defined protocols and uses source maps to translate
location references between them. This is its entire function.

### Session Lifecycle

**Launch mode:** The editor sends a `launch` request with configuration (path to the
`.efs` entry file, Node arguments, environment variables, etc.). The adapter:

1. Compiles the `.efs` entry file (and its dependencies) to a temp directory via the
   `CompilerHost` API
2. Spawns a Node.js process with `--inspect-brk` (paused at entry, waiting for debugger)
3. Connects to the Node.js inspector via the Chrome DevTools Protocol (CDP) WebSocket
4. Completes the DAP handshake with the editor

**Attach mode:** The editor sends an `attach` request with a port number. The adapter
connects to an already-running Node.js process with inspector enabled (`--inspect`).
Useful for debugging long-running servers where the developer starts Node separately.

### Source Location Translation

Every location reference that crosses the adapter boundary must be translated:

- **Editor → adapter (e.g., set breakpoint at `src/utils.efs:14:5`):** Translate to the
  corresponding compiled JS file and line using the source map. Forward the translated
  location to V8 via CDP.

- **Adapter → editor (e.g., paused at `dist/utils.js:28:3`):** Translate back to the
  `.efs` source location using the reverse source map lookup. Send the `.efs` location
  to the editor in DAP responses.

The source map library used must support both directions of lookup. The `source-map` npm
package (Mozilla's implementation) supports this via `originalPositionFor` (JS → source)
and `generatedPositionFor` (source → JS).

### Variable Presentation

When the editor requests variable inspection (via DAP's `variables` request), the adapter
receives structured variable data from V8 via CDP and formats it for display. This is
where the adapter has an opportunity to present EffectScript values idiomatically rather
than exposing the compiled JS representation:

**ADT variants:** In compiled JS, an ADT value is `{ _tag: "Ok", value: 42 }`. The
adapter should present this as `Ok(42)` in the variable panel — collapsing the internal
tagged object representation into the source-level ADT syntax.

**Null values:** JS `null` and EffectScript `null` are the same at runtime, so no
translation is needed.

**Records:** A compiled record is a plain JS object. The adapter can present its fields
with their EffectScript field names (which are preserved in the compiled output) and
their inferred types (if type information is available from the compilation step).

This presentation layer is optional for v1 and can be skipped for a simpler initial
implementation that presents raw JS values. It is, however, a significant quality-of-life
improvement and should be documented as a known gap if deferred.

---

## Compilation During Debug Sessions

### When to Compile

In launch mode, the adapter must compile the project before starting the debug session.
The compilation should use the same `CompilerHost` instance as the adapter's own process,
not a subprocess, to avoid startup overhead.

If the project has already been built (`.js` and `.map` files exist and are current),
the adapter should offer a configuration option to skip recompilation and use the
existing build. This is important for projects with long build times.

### Watch Mode Integration

For development workflows where the developer is iterating rapidly, the adapter should
optionally watch for source file changes and recompile automatically. When a `.efs` file
changes during a debug session:

1. Recompile the changed file and its dependents
2. Notify the editor that source maps may have changed
3. If Node.js supports hot reload for the changed module (which it does not natively for
   all cases), attempt to reload; otherwise, prompt the user to restart the session

This is a complex area with significant edge cases (e.g., what happens to existing
breakpoints when a file is recompiled and line numbers shift). A conservative v1
implementation can simply notify the user to restart the session when sources change,
with automatic hot reload as a later enhancement.

---

## Configuration Interface

The adapter is configured via a `launch.json` in the `.vscode/` directory for VS Code,
or an equivalent configuration object for other editors. The fields:

```json
{
  "type": "effectscript",
  "request": "launch",
  "name": "Debug EffectScript",
  "program": "${workspaceFolder}/src/main.efs",
  "args": [],
  "env": {},
  "cwd": "${workspaceFolder}",
  "runtimeArgs": [],
  "skipCompilation": false,
  "sourceMaps": true,
  "stopOnEntry": false,
  "escConfig": "${workspaceFolder}/esc.json"
}
```

For attach mode:
```json
{
  "type": "effectscript",
  "request": "attach",
  "name": "Attach to EffectScript",
  "port": 9229,
  "host": "localhost",
  "sourceMaps": true,
  "escConfig": "${workspaceFolder}/esc.json"
}
```

---

## Integration With VS Code Extension

The DAP adapter is a standalone process — it speaks DAP over stdio and has no VS Code
dependency. However, the VS Code extension is the primary distribution mechanism: the
extension registers the `effectscript` debug type, specifies the adapter executable path,
and provides the `launch.json` schema for IntelliSense on debug configuration fields.

The adapter should be distributable as a standalone npm package (`effectscript-dap`) so
that non-VS Code editors (Neovim, Helix) can install it and configure it independently
without the VS Code extension.

---

## Implementation Approach

### Building on vscode-debugadapter

The `@vscode/debugadapter` npm package provides a TypeScript base class
(`DebugSession`) that handles the DAP protocol framing — JSON serialization,
request/response correlation, event dispatch — and exposes a clean method-override API.
Implementing `effectscript-dap` on top of this package means the implementation focuses
on Node.js inspector translation and source map handling, not protocol mechanics.

This package has no VS Code dependency despite its name; it is a standalone protocol
implementation.

### Chrome DevTools Protocol (CDP)

The Node.js inspector speaks CDP, the same protocol used by Chrome DevTools. The
`chrome-remote-interface` npm package provides a Node.js CDP client. Alternatively,
VS Code's `vscode-js-debug` (the JavaScript debugger in VS Code) is open source and can
serve as a reference implementation for the CDP-to-DAP translation.

The adapter does not need to implement the full CDP surface — only the subset relevant to
Node.js debugging: `Debugger`, `Runtime`, and `Console` domains.

---

## Scope Limitations (v1)

A v1 DAP adapter should cover the core debugging loop reliably before adding more
sophisticated features:

**In scope for v1:**
- Launch and attach modes for Node.js
- Set, remove, and verify breakpoints in `.efs` files
- Continue, next, stepIn, stepOut, pause
- Stack frame inspection with `.efs` source locations
- Variable inspection (raw JS values, with ADT presentation if feasible)
- stdout/stderr forwarding to the editor's debug console

**Deferred to later versions:**
- Conditional breakpoints (V8 supports these via CDP; exposing them through DAP is
  additional work)
- Logpoints (breakpoints that print a message without pausing)
- Exception breakpoints with EffectScript `Result` type awareness
- Hot reload during debug sessions
- Browser/Deno/Bun targets (v1 is Node.js only)
- Source map quality diagnostics (detecting when source maps are stale or missing)
