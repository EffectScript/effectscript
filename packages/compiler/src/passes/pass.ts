/**
 * @module pass
 *
 * Compiler pass interface definitions.
 *
 * A "pass" is a self-contained transformation or analysis that operates
 * on the AST. Passes run in a pipeline managed by {@link PassRegistry}
 * (see `registry.ts`). Each pass receives the AST and a context, and
 * returns a (potentially transformed) AST plus any diagnostics.
 *
 * Passes are divided into two phases:
 * - **pre-check**: runs before the type checker (e.g. desugaring, lint)
 * - **post-check**: runs after the type checker (e.g. optimization, codegen prep)
 */

import type { Program } from '../parser/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';

/** Context available to all passes during execution. */
export interface PassContext {
  /** Absolute path of the file being processed. */
  readonly filePath: string;
  /** Shared diagnostic collector. */
  readonly diagnostics: DiagnosticCollector;
  /** Compiler options (pass enablement, etc.). */
  readonly options: PassOptions;
}

/** Compiler options relevant to pass execution. */
export interface PassOptions {
  /** Per-pass enablement. Key = pass name, value = enabled. */
  readonly passes?: Readonly<Record<string, boolean>>;
}

/** Result of running a single pass. */
export interface PassResult {
  /** The (potentially transformed) AST. */
  readonly ast: Program;
  /** Diagnostics discovered by this pass. */
  readonly diagnostics: readonly Diagnostic[];
  /** If true, stop the pipeline after this pass (exceptional). */
  readonly halt?: boolean;
}

/** A compiler pass that operates on the AST. */
export interface ASTPass {
  /** Unique name identifying this pass. */
  readonly name: string;
  /** When this pass runs in the pipeline. */
  readonly phase: 'pre-check' | 'post-check';
  /** Reserved for future pass ordering constraints. */
  readonly dependencies?: readonly string[];
  /** Execute the pass. */
  run(ast: Program, context: PassContext): PassResult;
}
