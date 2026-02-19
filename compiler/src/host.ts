/**
 * @module host
 *
 * Provides the {@link CompilerHost} interface and its default implementation.
 * CompilerHost is the primary public API surface for embedding the EffectScript
 * compiler — it manages compilation lifecycle, caching, event hooks, and
 * LSP-oriented query stubs.
 */

import type { Program } from './parser/ast.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';
import type { FileSystem } from './filesystem.js';
import type { OutputFile, CodegenBackend } from './codegen/backend.js';
import type { ModuleGraph } from './graph/module-graph.js';
import type { ASTPass } from './passes/pass.js';
import type { Span } from './utils/span.js';
import type { Type } from './checker/types.js';
import { NodeFileSystem } from './filesystem.js';
import { DiagnosticCollectorImpl } from './diagnostics/collector.js';
import { TsCompilerApiProvider } from './interop/provider.js';
import { PassRegistry } from './passes/registry.js';
import { JSBackend } from './codegen/js-backend.js';
import { runPipeline } from './compiler.js';
import type { PhaseTimings } from './compiler.js';
import { DiskBackedDeclarationCache } from './interop/disk-cache.js';

// ── Compiler Options ───────────────────────────────────────

/** Options that control compilation output and behavior. */
export interface CompilerOptions {
  /** Directory to write compiled output files into. */
  readonly outDir: string;
  /** Whether to emit source maps alongside JS output. */
  readonly sourceMap: boolean;
  /** ECMAScript target version (e.g. `"es2020"`). */
  readonly target: string;
  /** When `true`, run the full pipeline but skip code generation. */
  readonly noEmit?: boolean;
  /** Per-pass enable/disable overrides keyed by pass name. */
  readonly passes?: Readonly<Record<string, boolean>>;
}

/** Default compiler options used when no overrides are provided. */
const DEFAULT_OPTIONS: CompilerOptions = {
  outDir: './dist',
  sourceMap: true,
  target: 'es2020',
};

// ── Compilation Result ─────────────────────────────────────

/** The outcome of a single compilation run. */
export interface CompilationResult {
  /** `true` when compilation produced zero errors. */
  readonly success: boolean;
  /** All generated output files (JS, DTS, source maps). */
  readonly outputFiles: readonly OutputFile[];
  /** Every diagnostic emitted during compilation. */
  readonly diagnostics: readonly Diagnostic[];
  /** The module graph built during this compilation. */
  readonly moduleGraph: ModuleGraph;
}

// ── Compilation Stats ──────────────────────────────────────

/** Aggregate statistics from the most recent compilation. */
export interface CompilationStats {
  /** Total number of `.efs` files that were compiled. */
  readonly filesCompiled: number;
  /** Number of files that produced at least one error. */
  readonly filesWithErrors: number;
  /** Diagnostic counts broken down by severity. */
  readonly diagnosticCount: {
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
  };
}

// ── LSP Stub Types ─────────────────────────────────────────

/** A zero-based line/column position within a source file. */
export interface Position {
  /** Zero-based line number. */
  readonly line: number;
  /** Zero-based column offset. */
  readonly column: number;
}

/** Information about a symbol at a given source position. */
export interface SymbolInfo {
  readonly name: string;
  readonly type: Type;
  readonly span: Span;
}

/** A single auto-completion suggestion. */
export interface CompletionItem {
  /** Text shown in the completion list. */
  readonly label: string;
  /** Category of the symbol (e.g. `"variable"`, `"function"`). */
  readonly kind: string;
  /** Optional additional detail (e.g. type signature). */
  readonly detail?: string;
}

/** Hover tooltip information for a source position. */
export interface HoverInfo {
  /** Markdown or plain-text content to display. */
  readonly content: string;
  /** Source span of the hovered token. */
  readonly span: Span;
}

/** Signature help information for a call expression. */
export interface SignatureHelp {
  /** Rendered signature strings. */
  readonly signatures: readonly string[];
  /** Index of the currently active overload. */
  readonly activeSignature: number;
  /** Index of the currently active parameter. */
  readonly activeParameter: number;
}

/** A source location, aliased from {@link Span}. */
export type Location = Span;

// ── Event Callback Types ───────────────────────────────────

/** Fired when a compilation phase finishes, reporting its duration. */
type PhaseCompleteCallback = (phase: string, result: { durationMs: number }) => void;
/** Fired each time a diagnostic is reported during compilation. */
type DiagnosticCallback = (diagnostic: Diagnostic) => void;
/** Fired after a single source file has been compiled, with its output files. */
type FileCompiledCallback = (path: string, output: readonly OutputFile[]) => void;

// ── CompilerHost Interface ─────────────────────────────────

/**
 * Primary API for embedding the EffectScript compiler.
 *
 * Manages compilation, caching, event hooks, and LSP-oriented queries.
 * Obtain an instance via {@link createCompilerHost}.
 */
export interface CompilerHost {
  /** The file system abstraction used for reading and writing files. */
  readonly fileSystem: FileSystem;

  /**
   * Compile the given source files and emit output.
   * @param files - Absolute paths to `.efs` source files.
   * @param options - Per-invocation option overrides.
   * @returns The compilation result including output files and diagnostics.
   */
  compile(files: readonly string[], options?: Partial<CompilerOptions>): Promise<CompilationResult>;

  /**
   * Type-check the given source files without emitting output.
   * @param files - Absolute paths to `.efs` source files.
   * @param options - Per-invocation option overrides.
   * @returns All diagnostics produced by the check.
   */
  check(files: readonly string[], options?: Partial<CompilerOptions>): Promise<readonly Diagnostic[]>;

  /** Returns the module graph from the most recent compilation, or `null` if none. */
  getModuleGraph(): ModuleGraph | null;

  /**
   * Mark a file as dirty so it will be recompiled on the next {@link recompileDirty} call.
   * @param path - Absolute path to the changed file.
   */
  invalidateFile(path: string): void;

  /** Recompile all files marked dirty via {@link invalidateFile}. In v0.1 this rebuilds everything. */
  recompileDirty(): Promise<CompilationResult>;

  /** LSP stub: get symbol information at a position. Returns `null` in v0.1. */
  getSymbolAtPosition(file: string, position: Position): SymbolInfo | null;
  /** LSP stub: get completions at a position. Returns `[]` in v0.1. */
  getCompletionsAtPosition(file: string, position: Position): readonly CompletionItem[];
  /** LSP stub: go-to-definition. Returns `null` in v0.1. */
  getDefinitionAtPosition(file: string, position: Position): Location | null;
  /** LSP stub: find-all-references. Returns `[]` in v0.1. */
  getReferencesAtPosition(file: string, position: Position): readonly Location[];
  /** LSP stub: hover info. Returns `null` in v0.1. */
  getHoverInfo(file: string, position: Position): HoverInfo | null;
  /** LSP stub: signature help. Returns `null` in v0.1. */
  getSignatureHelp(file: string, position: Position): SignatureHelp | null;

  /**
   * Retrieve the parsed (untyped) AST for a file from the cache.
   * @param file - Absolute path to the source file.
   * @returns The cached AST, or `null` if the file was not part of the last compilation.
   */
  getAST(file: string): Program | null;

  /**
   * Retrieve the type-annotated AST for a file from the cache.
   * In v0.1 the checker mutates in place, so this returns the same object as {@link getAST}.
   * @param file - Absolute path to the source file.
   */
  getTypedAST(file: string): Program | null;

  /** Register an event listener for compilation lifecycle events. */
  on(event: 'phaseComplete', cb: PhaseCompleteCallback): void;
  on(event: 'diagnostic', cb: DiagnosticCallback): void;
  on(event: 'fileCompiled', cb: FileCompiledCallback): void;

  /** Returns phase timing information from the most recent compilation. */
  getTimings(): PhaseTimings;
  /** Returns aggregate statistics from the most recent compilation. */
  getStats(): CompilationStats;

  /**
   * Register a custom AST pass to run during compilation.
   * @param pass - The pass to add to the pipeline.
   */
  registerPass(pass: ASTPass): void;

  /**
   * Replace the default code-generation backend.
   * @param backend - The backend to use for future compilations.
   */
  registerBackend(backend: CodegenBackend): void;
}

// ── CompilerHost Options ───────────────────────────────────

/** Configuration passed to {@link createCompilerHost} to customize the host. */
export interface CompilerHostOptions {
  /** File system implementation to use. Defaults to {@link NodeFileSystem}. */
  readonly fileSystem?: FileSystem;
  /** Default compiler options applied to every compilation unless overridden. */
  readonly compilerOptions?: Partial<CompilerOptions>;
  /** Absolute path to the project root (used for cache directory location). */
  readonly basePath?: string;
  /** When true, disables the disk-backed declaration cache. */
  readonly noCache?: boolean;
}

// ── Factory ────────────────────────────────────────────────

/**
 * Create a new {@link CompilerHost} with the given options.
 * @param options - Optional configuration for file system, compiler options, and caching.
 * @returns A fully initialized compiler host ready for {@link CompilerHost.compile} calls.
 */
export function createCompilerHost(options?: CompilerHostOptions): CompilerHost {
  return new CompilerHostImpl(options);
}

// ── Implementation ─────────────────────────────────────────

/**
 * Default {@link CompilerHost} implementation.
 *
 * Stateful: caches ASTs, module graph, timings, and stats across
 * compilations. State is cleared at the start of each {@link compile} call.
 */
class CompilerHostImpl implements CompilerHost {
  readonly fileSystem: FileSystem;
  private readonly defaultOptions: CompilerOptions;
  private readonly basePath: string;
  private readonly noCache: boolean;
  private readonly passRegistry = new PassRegistry();
  private backend: CodegenBackend = new JSBackend();

  // State
  private moduleGraph: ModuleGraph | null = null;
  private astCache = new Map<string, Program>();
  private timings: PhaseTimings = { total: { durationMs: 0 } };
  private stats: CompilationStats = {
    filesCompiled: 0,
    filesWithErrors: 0,
    diagnosticCount: { errors: 0, warnings: 0, info: 0 },
  };
  private invalidatedFiles = new Set<string>();
  private lastFiles: readonly string[] = [];
  private lastOptions: Partial<CompilerOptions> = {};

  // Event listeners
  private phaseCompleteListeners: PhaseCompleteCallback[] = [];
  private diagnosticListeners: DiagnosticCallback[] = [];
  private fileCompiledListeners: FileCompiledCallback[] = [];

  constructor(options?: CompilerHostOptions) {
    this.fileSystem = options?.fileSystem ?? new NodeFileSystem();
    this.defaultOptions = {
      ...DEFAULT_OPTIONS,
      ...options?.compilerOptions,
    };
    this.basePath = options?.basePath ?? '/';
    this.noCache = options?.noCache ?? false;
  }

  /** @inheritdoc */
  async compile(
    files: readonly string[],
    options?: Partial<CompilerOptions>,
  ): Promise<CompilationResult> {
    const merged = this.mergeOptions(options);
    this.lastFiles = files;
    this.lastOptions = options ?? {};

    // Reset per-compilation state
    this.astCache.clear();
    this.invalidatedFiles.clear();

    const collector = new DiagnosticCollectorImpl();
    const cacheDir = this.basePath.endsWith('/')
      ? `${this.basePath}.efs-cache`
      : `${this.basePath}/.efs-cache`;
    const declCache = new DiskBackedDeclarationCache(cacheDir, this.noCache);
    const typeProvider = new TsCompilerApiProvider({
      basePath: this.basePath,
      diagnostics: new DiagnosticCollectorImpl(),
      fileSystem: this.fileSystem,
      cache: declCache,
    });

    const onDiagnostic = this.diagnosticListeners.length > 0
      ? (d: Diagnostic) => { for (const cb of this.diagnosticListeners) cb(d); }
      : undefined;

    const onFileCompiled = this.fileCompiledListeners.length > 0
      ? (path: string, output: readonly OutputFile[]) => {
          for (const cb of this.fileCompiledListeners) cb(path, output);
        }
      : undefined;

    const pipelineOpts: Record<string, unknown> = {
      filePaths: files,
      sourceMap: merged.sourceMap,
      outDir: merged.outDir,
      fileSystem: this.fileSystem,
      diagnostics: collector,
      typeProvider,
      passRegistry: this.passRegistry,
      backend: this.backend,
    };
    if (merged.noEmit !== undefined) pipelineOpts['noEmit'] = merged.noEmit;
    if (onDiagnostic !== undefined) pipelineOpts['onDiagnostic'] = onDiagnostic;
    if (onFileCompiled !== undefined) pipelineOpts['onFileCompiled'] = onFileCompiled;

    const result = runPipeline(pipelineOpts as unknown as import('./compiler.js').RunPipelineOptions);

    // Update state
    this.moduleGraph = result.moduleGraph;
    this.timings = result.timings;

    // Reuse the AST cache produced by the pipeline (avoids double-parsing)
    for (const [path, ast] of result.astCache) {
      this.astCache.set(path, ast);
    }

    // Compute stats
    const errorFiles = new Set<string>();
    for (const d of result.diagnostics) {
      if (d.severity === 'error') errorFiles.add(d.span.file);
    }

    this.stats = {
      filesCompiled: files.length,
      filesWithErrors: errorFiles.size,
      diagnosticCount: {
        errors: result.diagnostics.filter(d => d.severity === 'error').length,
        warnings: result.diagnostics.filter(d => d.severity === 'warning').length,
        info: result.diagnostics.filter(d => d.severity === 'info').length,
      },
    };

    // Fire phaseComplete events
    for (const cb of this.phaseCompleteListeners) {
      cb('compilation', { durationMs: result.timings.total.durationMs });
    }

    return {
      success: result.success,
      outputFiles: result.outputFiles,
      diagnostics: result.diagnostics,
      moduleGraph: result.moduleGraph,
    };
  }

  /** @inheritdoc */
  async check(
    files: readonly string[],
    options?: Partial<CompilerOptions>,
  ): Promise<readonly Diagnostic[]> {
    const result = await this.compile(files, { ...options, noEmit: true });
    return result.diagnostics;
  }

  /** @inheritdoc */
  getModuleGraph(): ModuleGraph | null {
    return this.moduleGraph;
  }

  /** @inheritdoc */
  invalidateFile(path: string): void {
    this.invalidatedFiles.add(path);
  }

  /** @inheritdoc */
  async recompileDirty(): Promise<CompilationResult> {
    // v0.1: rebuild everything
    return this.compile(this.lastFiles, this.lastOptions);
  }

  // LSP stubs — all return null/empty in v0.1
  /** @inheritdoc */
  getSymbolAtPosition(_file: string, _position: Position): SymbolInfo | null { return null; }
  /** @inheritdoc */
  getCompletionsAtPosition(_file: string, _position: Position): readonly CompletionItem[] { return []; }
  /** @inheritdoc */
  getDefinitionAtPosition(_file: string, _position: Position): Location | null { return null; }
  /** @inheritdoc */
  getReferencesAtPosition(_file: string, _position: Position): readonly Location[] { return []; }
  /** @inheritdoc */
  getHoverInfo(_file: string, _position: Position): HoverInfo | null { return null; }
  /** @inheritdoc */
  getSignatureHelp(_file: string, _position: Position): SignatureHelp | null { return null; }

  /** @inheritdoc */
  getAST(file: string): Program | null {
    return this.astCache.get(file) ?? null;
  }

  /** @inheritdoc */
  getTypedAST(file: string): Program | null {
    // In v0.1 the typed AST is the same object (checker mutates in place)
    return this.astCache.get(file) ?? null;
  }

  /** @inheritdoc */
  on(event: 'phaseComplete', cb: PhaseCompleteCallback): void;
  on(event: 'diagnostic', cb: DiagnosticCallback): void;
  on(event: 'fileCompiled', cb: FileCompiledCallback): void;
  on(event: string, cb: (...args: never[]) => void): void {
    switch (event) {
      case 'phaseComplete':
        this.phaseCompleteListeners.push(cb as PhaseCompleteCallback);
        break;
      case 'diagnostic':
        this.diagnosticListeners.push(cb as DiagnosticCallback);
        break;
      case 'fileCompiled':
        this.fileCompiledListeners.push(cb as FileCompiledCallback);
        break;
    }
  }

  /** @inheritdoc */
  getTimings(): PhaseTimings {
    return this.timings;
  }

  /** @inheritdoc */
  getStats(): CompilationStats {
    return this.stats;
  }

  /** @inheritdoc */
  registerPass(pass: ASTPass): void {
    this.passRegistry.register(pass);
  }

  /** @inheritdoc */
  registerBackend(backend: CodegenBackend): void {
    this.backend = backend;
  }

  /**
   * Merge per-invocation options with the host's default options.
   * @param options - Per-call overrides, if any.
   * @returns A fully-populated {@link CompilerOptions} object.
   */
  private mergeOptions(options?: Partial<CompilerOptions>): CompilerOptions {
    return {
      ...this.defaultOptions,
      ...options,
    };
  }
}
