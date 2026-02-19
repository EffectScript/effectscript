/**
 * @module registry
 *
 * Pass registry for managing and executing compiler passes.
 *
 * The {@link PassRegistry} maintains an ordered collection of {@link ASTPass}
 * instances. Passes are registered by name and execute in registration order
 * within their phase (pre-check or post-check). Individual passes can be
 * disabled via {@link PassOptions}.
 *
 * Pass execution is fault-tolerant: if a pass throws, the error is logged
 * but the pipeline continues with the remaining passes.
 */

import type { ASTPass, PassContext } from './pass.js';
import type { Program } from '../parser/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';

/** Result of running all passes in a single phase (pre-check or post-check). */
export interface PassPhaseResult {
  /** Final AST after all passes in this phase have run. */
  readonly ast: Program;
  /** Aggregated diagnostics from all passes in this phase. */
  readonly diagnostics: readonly Diagnostic[];
  /** Whether any pass requested early termination. */
  readonly halted: boolean;
  /** Name of the pass that requested halt, if any. */
  readonly haltedBy?: string;
}

/**
 * Manages pass registration and ordered execution.
 *
 * Passes are stored by name and maintain insertion order for deterministic
 * execution. The registry provides separate entry points for pre-check
 * and post-check phases.
 */
export class PassRegistry {
  /** Map of pass name → pass instance. */
  private readonly passes = new Map<string, ASTPass>();
  /** Pass names in registration order. */
  private readonly order: string[] = [];

  /** Register a pass. Throws if a pass with the same name already exists. */
  register(pass: ASTPass): void {
    if (this.passes.has(pass.name)) {
      throw new Error(`Pass "${pass.name}" is already registered`);
    }
    this.passes.set(pass.name, pass);
    this.order.push(pass.name);
  }

  /** Unregister a pass by name. No-op if not found. */
  unregister(name: string): void {
    if (!this.passes.has(name)) return;
    this.passes.delete(name);
    const idx = this.order.indexOf(name);
    if (idx !== -1) {
      this.order.splice(idx, 1);
    }
  }

  /** Get all registered pre-check passes in execution order. */
  getPreCheckPasses(): readonly ASTPass[] {
    return this.getPassesByPhase('pre-check');
  }

  /** Get all registered post-check passes in execution order. */
  getPostCheckPasses(): readonly ASTPass[] {
    return this.getPassesByPhase('post-check');
  }

  /** Look up a pass by name. Returns undefined if not found. */
  getPass(name: string): ASTPass | undefined {
    return this.passes.get(name);
  }

  /** Run all pre-check passes in order. */
  runPreCheckPasses(ast: Program, context: PassContext): PassPhaseResult {
    return this.runPhase('pre-check', ast, context);
  }

  /** Run all post-check passes in order. */
  runPostCheckPasses(ast: Program, context: PassContext): PassPhaseResult {
    return this.runPhase('post-check', ast, context);
  }

  /**
   * Filter registered passes by phase, preserving registration order.
   *
   * @param phase - The phase to filter for.
   * @returns Passes matching the given phase, in registration order.
   */
  private getPassesByPhase(phase: 'pre-check' | 'post-check'): readonly ASTPass[] {
    const result: ASTPass[] = [];
    for (const name of this.order) {
      const pass = this.passes.get(name);
      if (pass !== undefined && pass.phase === phase) {
        result.push(pass);
      }
    }
    return result;
  }

  /**
   * Execute all passes for a given phase in order.
   *
   * Each pass receives the current AST (which may have been transformed by
   * preceding passes) and the shared context. Passes can be disabled via
   * `context.options.passes`. If a pass returns `halt: true`, execution
   * stops and the result is returned with `halted: true`.
   *
   * Errors thrown by passes are caught and logged — they don't crash the pipeline.
   *
   * @param phase   - Which phase to execute.
   * @param ast     - The input AST.
   * @param context - Shared pass context (file path, diagnostics, options).
   * @returns The final AST and aggregated diagnostics.
   */
  private runPhase(phase: 'pre-check' | 'post-check', ast: Program, context: PassContext): PassPhaseResult {
    const passes = this.getPassesByPhase(phase);
    let currentAST = ast;
    const allDiagnostics: Diagnostic[] = [];

    for (const pass of passes) {
      // Check enablement
      if (context.options.passes !== undefined) {
        const enabled = context.options.passes[pass.name];
        if (enabled === false) continue;
      }

      try {
        const result = pass.run(currentAST, context);
        currentAST = result.ast;

        for (const diag of result.diagnostics) {
          allDiagnostics.push(diag);
          context.diagnostics.report(diag);
        }

        if (result.halt === true) {
          return {
            ast: currentAST,
            diagnostics: allDiagnostics,
            halted: true,
            haltedBy: pass.name,
          };
        }
      } catch (err: unknown) {
        console.error(`Pass "${pass.name}" threw an error:`, err);
      }
    }

    return {
      ast: currentAST,
      diagnostics: allDiagnostics,
      halted: false,
    };
  }
}
