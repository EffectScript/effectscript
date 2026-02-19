/**
 * @module compiler
 *
 * Glue layer between the {@link CompilerHost} and the compilation pipeline.
 * Provides {@link runPipeline}, which wraps the lower-level
 * {@link compileProject} with event hooks, timing, and no-emit support.
 */

import type { Program } from './parser/ast.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';
import type { DiagnosticCollector } from './diagnostics/collector.js';
import type { FileSystem } from './filesystem.js';
import type { CodegenBackend, OutputFile } from './codegen/backend.js';
import type { TypeDeclarationProvider } from './interop/provider.js';
import type { PassRegistry } from './passes/registry.js';
import type { ModuleGraph } from './graph/module-graph.js';
import { compileProject } from './pipeline.js';

// ── Types ──────────────────────────────────────────────────

/** Timing data for the overall compilation. Per-phase timing is deferred to post-v0.1. */
export interface PhaseTimings {
  readonly total: { readonly durationMs: number };
  readonly [phase: string]: { readonly durationMs: number };
}

/** Options accepted by {@link runPipeline}. */
export interface RunPipelineOptions {
  /** Absolute paths to `.efs` source files to compile. */
  readonly filePaths: readonly string[];
  /** Whether to generate source maps. */
  readonly sourceMap: boolean;
  /** Output directory for compiled files. */
  readonly outDir: string;
  /** When `true`, skip code generation entirely. */
  readonly noEmit?: boolean;
  /** File system abstraction for reading source files. */
  readonly fileSystem: FileSystem;
  /** Collector for accumulating diagnostics. */
  readonly diagnostics: DiagnosticCollector;
  /** Provider for resolving and extracting external TS/JS declarations. */
  readonly typeProvider: TypeDeclarationProvider;
  /** Registry of custom AST passes. */
  readonly passRegistry: PassRegistry;
  /** Code-generation backend (e.g. JS + DTS). */
  readonly backend: CodegenBackend;
  /** Optional callback fired each time a diagnostic is reported. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Optional callback fired after each source file is compiled. */
  readonly onFileCompiled?: (path: string, output: readonly OutputFile[]) => void;
}

/** Result returned by {@link runPipeline}. */
export interface RunPipelineResult {
  /** `true` when no error diagnostics were emitted. */
  readonly success: boolean;
  /** All generated output files. */
  readonly outputFiles: readonly OutputFile[];
  /** Every diagnostic produced during compilation. */
  readonly diagnostics: readonly Diagnostic[];
  /** The module dependency graph. */
  readonly moduleGraph: ModuleGraph;
  /** Compilation timing data. */
  readonly timings: PhaseTimings;
  /** Parsed ASTs keyed by file path, for reuse by the host. */
  readonly astCache: ReadonlyMap<string, Program>;
}

// ── No-emit backend ────────────────────────────────────────

/**
 * A no-op {@link CodegenBackend} that produces no output files.
 * Used when `noEmit` is `true` (e.g. during `esc check`).
 */
const NO_EMIT_BACKEND: CodegenBackend = {
  name: 'no-emit',
  emit() {
    return { files: [], diagnostics: [] };
  },
};

// ── Intercepting collector ─────────────────────────────────

/**
 * A {@link DiagnosticCollector} decorator that forwards every reported
 * diagnostic to a callback in addition to delegating to the inner collector.
 * Used to fire `onDiagnostic` event hooks during compilation.
 */
class InterceptingCollector implements DiagnosticCollector {
  private readonly inner: DiagnosticCollector;
  private readonly callback: (d: Diagnostic) => void;

  /**
   * @param inner - The underlying collector that stores diagnostics.
   * @param callback - Invoked each time a diagnostic is reported.
   */
  constructor(inner: DiagnosticCollector, callback: (d: Diagnostic) => void) {
    this.inner = inner;
    this.callback = callback;
  }

  /** Report a diagnostic to the inner collector and fire the callback. */
  report(diagnostic: Diagnostic): void {
    this.inner.report(diagnostic);
    this.callback(diagnostic);
  }

  /** @inheritdoc */
  getAll(): readonly Diagnostic[] { return this.inner.getAll(); }
  /** @inheritdoc */
  getErrors(): readonly Diagnostic[] { return this.inner.getErrors(); }
  /** @inheritdoc */
  getWarnings(): readonly Diagnostic[] { return this.inner.getWarnings(); }
  /** @inheritdoc */
  hasErrors(): boolean { return this.inner.hasErrors(); }
  /** @inheritdoc */
  clear(): void { this.inner.clear(); }
  /** @inheritdoc */
  rollback(savedCount: number): void { this.inner.rollback(savedCount); }
}

// ── Pipeline runner ────────────────────────────────────────

/**
 * Run the full EffectScript compilation pipeline.
 *
 * Wraps {@link compileProject} with:
 * - Diagnostic interception for `onDiagnostic` event hooks
 * - No-emit backend substitution when `noEmit` is set
 * - Per-file output tracking for `onFileCompiled` event hooks
 * - Wall-clock timing measurement
 *
 * @param options - Pipeline configuration including file paths, backends, and callbacks.
 * @returns Compilation results with output files, diagnostics, timings, and AST cache.
 */
export function runPipeline(options: RunPipelineOptions): RunPipelineResult {
  const {
    filePaths,
    sourceMap,
    outDir,
    noEmit,
    fileSystem,
    typeProvider,
    passRegistry,
    backend,
    onDiagnostic,
    onFileCompiled,
  } = options;

  // Wrap collector to intercept diagnostics for event hooks
  const collector = onDiagnostic
    ? new InterceptingCollector(options.diagnostics, onDiagnostic)
    : options.diagnostics;

  // Choose backend: no-emit for check(), real backend for compile()
  const effectiveBackend = noEmit ? NO_EMIT_BACKEND : backend;

  // Track per-file output for fileCompiled events
  const fileOutputTracker = onFileCompiled ? new FileOutputTracker() : undefined;
  const wrappedBackend = fileOutputTracker
    ? wrapBackendForTracking(effectiveBackend, fileOutputTracker)
    : effectiveBackend;

  const startTime = Date.now();

  const pipelineResult = compileProject(
    filePaths,
    { sourceMap, outDir },
    fileSystem,
    collector,
    typeProvider,
    passRegistry,
    wrappedBackend,
  );

  const endTime = Date.now();

  // Fire fileCompiled events
  if (onFileCompiled && fileOutputTracker) {
    for (const [path, output] of fileOutputTracker.entries()) {
      onFileCompiled(path, output);
    }
  }

  const timings: PhaseTimings = {
    total: { durationMs: endTime - startTime },
  };

  const allDiags = pipelineResult.diagnostics;
  const hasErrors = allDiags.some(d => d.severity === 'error');

  return {
    success: !hasErrors,
    outputFiles: pipelineResult.outputFiles,
    diagnostics: allDiags,
    moduleGraph: pipelineResult.moduleGraph,
    timings,
    astCache: pipelineResult.astCache,
  };
}

// ── File output tracking ───────────────────────────────────

/**
 * Accumulates output files grouped by source file path.
 * Used to collect per-file output so `onFileCompiled` events
 * can report which outputs belong to which source file.
 */
class FileOutputTracker {
  private readonly map = new Map<string, OutputFile[]>();

  /**
   * Record an output file as belonging to the given source file.
   * @param filePath - The source `.efs` file that produced this output.
   * @param file - The generated output file.
   */
  record(filePath: string, file: OutputFile): void {
    let files = this.map.get(filePath);
    if (!files) {
      files = [];
      this.map.set(filePath, files);
    }
    files.push(file);
  }

  /** Iterate over all tracked source paths and their output files. */
  entries(): IterableIterator<[string, OutputFile[]]> {
    return this.map.entries();
  }
}

/**
 * Wrap a {@link CodegenBackend} so that every emitted file is also
 * recorded in the given {@link FileOutputTracker}.
 * @param backend - The real backend to delegate to.
 * @param tracker - Tracker that accumulates output per source file.
 * @returns A new backend that records output and delegates to the original.
 */
function wrapBackendForTracking(
  backend: CodegenBackend,
  tracker: FileOutputTracker,
): CodegenBackend {
  return {
    name: backend.name,
    emit(ast, options) {
      const result = backend.emit(ast, options);
      for (const file of result.files) {
        tracker.record(options.filePath, file);
      }
      return result;
    },
  };
}
