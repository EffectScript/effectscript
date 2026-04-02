/**
 * @module backend
 *
 * Code generation backend interface and supporting types.
 *
 * Defines the {@link CodegenBackend} interface that all code generation
 * backends must implement. Currently the only implementation is
 * {@link JSBackend} (in `js-backend.ts`), which produces `.js`, `.d.ts`,
 * and optionally `.js.map` files.
 */

import type { Program } from '../parser/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';

/** A single output file produced by code generation. */
export interface OutputFile {
  /** Absolute or relative path where the file should be written. */
  readonly path: string;
  /** The file content as a string. */
  readonly content: string;
  /** The kind of output file (JavaScript, TypeScript declarations, or source map). */
  readonly kind: 'js' | 'dts' | 'sourcemap';
}

/** Options controlling code generation behavior. */
export interface CodegenOptions {
  /** Whether to generate a `.js.map` source map file. */
  readonly sourceMap: boolean;
  /** Path to the source `.efs` file being compiled. */
  readonly filePath: string;
  /** Output directory for generated files. */
  readonly outDir: string;
}

/** Result of code generation for a single source file. */
export interface CodegenResult {
  /** The output files produced (JS, DTS, and optionally source map). */
  readonly files: readonly OutputFile[];
  /** Any diagnostics (errors or warnings) encountered during code generation. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Backend interface for code generation.
 *
 * A backend takes a typed AST and produces output files (JS, DTS, source maps).
 * The pipeline calls {@link emit} once per source file.
 */
export interface CodegenBackend {
  /** Human-readable name of this backend (e.g. `'javascript'`). */
  readonly name: string;
  /**
   * Emit output files for the given AST.
   *
   * @param ast     - The type-checked AST.
   * @param options - Code generation options (source map, paths).
   * @returns The generated files and any diagnostics.
   */
  emit(ast: Program, options: CodegenOptions): CodegenResult;
}
