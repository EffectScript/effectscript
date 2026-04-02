import { describe, it, expect, vi } from 'vitest';
import { PassRegistry } from './registry.js';
import type { ASTPass, PassContext, PassResult } from './pass.js';
import type { Program, Identifier, ExpressionStatement } from '../parser/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type { Span } from '../utils/span.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';

// ── Helpers ──────────────────────────────────────────────────────────

const span: Span = {
  file: 'test.efs',
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 1, line: 1, column: 1 },
};

function makeProgram(body: Program['body'] = []): Program {
  return { kind: 'Program', body, span };
}

function makeWarning(message: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'W001',
    message,
    span,
  };
}

function makeError(message: string): Diagnostic {
  return {
    severity: 'error',
    code: 'E001',
    message,
    span,
  };
}

function makePassContext(overrides?: { passes?: Record<string, boolean> }): PassContext {
  const collector = new DiagnosticCollectorImpl();
  const result: Record<string, unknown> = {
    filePath: 'test.efs',
    diagnostics: collector,
    options: {},
  };
  if (overrides?.passes !== undefined) {
    result['options'] = { passes: overrides.passes };
  }
  return result as unknown as PassContext;
}

function makePass(name: string, phase: 'pre-check' | 'post-check', run: ASTPass['run']): ASTPass {
  return { name, phase, run };
}

// ── Registration Tests ───────────────────────────────────────────────

describe('PassRegistry', () => {
  describe('Registration', () => {
    it('should register a pre-check pass', () => {
      const registry = new PassRegistry();
      const pass = makePass('test-pass', 'pre-check', (ast) => ({
        ast,
        diagnostics: [],
      }));

      registry.register(pass);

      expect(registry.getPreCheckPasses()).toHaveLength(1);
      expect(registry.getPreCheckPasses()[0]).toBe(pass);
      expect(registry.getPostCheckPasses()).toHaveLength(0);
    });

    it('should register a post-check pass', () => {
      const registry = new PassRegistry();
      const pass = makePass('test-pass', 'post-check', (ast) => ({
        ast,
        diagnostics: [],
      }));

      registry.register(pass);

      expect(registry.getPostCheckPasses()).toHaveLength(1);
      expect(registry.getPreCheckPasses()).toHaveLength(0);
    });

    it('should register multiple passes of different phases', () => {
      const registry = new PassRegistry();
      const pre1 = makePass('pre1', 'pre-check', (ast) => ({ ast, diagnostics: [] }));
      const pre2 = makePass('pre2', 'pre-check', (ast) => ({ ast, diagnostics: [] }));
      const post1 = makePass('post1', 'post-check', (ast) => ({ ast, diagnostics: [] }));

      registry.register(pre1);
      registry.register(pre2);
      registry.register(post1);

      expect(registry.getPreCheckPasses()).toHaveLength(2);
      expect(registry.getPostCheckPasses()).toHaveLength(1);
    });

    it('should throw on duplicate pass names', () => {
      const registry = new PassRegistry();
      const pass1 = makePass('dup', 'pre-check', (ast) => ({ ast, diagnostics: [] }));
      const pass2 = makePass('dup', 'post-check', (ast) => ({ ast, diagnostics: [] }));

      registry.register(pass1);

      expect(() => registry.register(pass2)).toThrow();
    });

    it('should unregister a pass', () => {
      const registry = new PassRegistry();
      const pass = makePass('test-pass', 'pre-check', (ast) => ({ ast, diagnostics: [] }));

      registry.register(pass);
      registry.unregister('test-pass');

      expect(registry.getPass('test-pass')).toBeUndefined();
      expect(registry.getPreCheckPasses()).toHaveLength(0);
    });

    it('should handle unregistering a nonexistent pass without error', () => {
      const registry = new PassRegistry();

      expect(() => registry.unregister('nonexistent')).not.toThrow();
    });

    it('should look up a pass by name', () => {
      const registry = new PassRegistry();
      const pass = makePass('my-pass', 'pre-check', (ast) => ({ ast, diagnostics: [] }));

      registry.register(pass);

      expect(registry.getPass('my-pass')).toBe(pass);
    });

    it('should return undefined for unknown pass name', () => {
      const registry = new PassRegistry();

      expect(registry.getPass('unknown')).toBeUndefined();
    });
  });

  describe('Execution — Pre-check Passes', () => {
    it('should return original AST when no passes are registered', () => {
      const registry = new PassRegistry();
      const ast = makeProgram();
      const context = makePassContext();

      const result = registry.runPreCheckPasses(ast, context);

      expect(result.ast).toBe(ast);
      expect(result.diagnostics).toHaveLength(0);
      expect(result.halted).toBe(false);
    });

    it('should run a single analysis pass', () => {
      const registry = new PassRegistry();
      const warning = makeWarning('unused variable');
      const pass = makePass('lint', 'pre-check', (ast) => ({
        ast,
        diagnostics: [warning],
      }));

      registry.register(pass);
      const ast = makeProgram();
      const context = makePassContext();

      const result = registry.runPreCheckPasses(ast, context);

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toBe(warning);
      // Should also report to the shared collector
      expect(context.diagnostics.getAll()).toContainEqual(warning);
    });

    it('should run a transformation pass', () => {
      const registry = new PassRegistry();
      const transformedAst = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);
      const pass = makePass('transform', 'pre-check', (_ast) => ({
        ast: transformedAst,
        diagnostics: [],
      }));

      registry.register(pass);
      const ast = makeProgram();
      const context = makePassContext();

      const result = registry.runPreCheckPasses(ast, context);

      expect(result.ast).toBe(transformedAst);
      expect(result.ast).not.toBe(ast);
    });

    it('should chain passes — second sees first pass output', () => {
      const registry = new PassRegistry();
      const intermediateAst = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 1, span },
        span,
      }]);
      const finalAst = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 2, span },
        span,
      }]);

      let secondPassInput: Program | undefined;

      const pass1 = makePass('first', 'pre-check', (_ast) => ({
        ast: intermediateAst,
        diagnostics: [],
      }));
      const pass2 = makePass('second', 'pre-check', (ast) => {
        secondPassInput = ast;
        return { ast: finalAst, diagnostics: [] };
      });

      registry.register(pass1);
      registry.register(pass2);
      const context = makePassContext();

      const result = registry.runPreCheckPasses(makeProgram(), context);

      expect(secondPassInput).toBe(intermediateAst);
      expect(result.ast).toBe(finalAst);
    });

    it('should halt when a pass returns halt: true', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass1 = makePass('halter', 'pre-check', (ast) => {
        runOrder.push('halter');
        return { ast, diagnostics: [makeWarning('halting')], halt: true };
      });
      const pass2 = makePass('after', 'pre-check', (ast) => {
        runOrder.push('after');
        return { ast, diagnostics: [] };
      });

      registry.register(pass1);
      registry.register(pass2);
      const context = makePassContext();

      const result = registry.runPreCheckPasses(makeProgram(), context);

      expect(result.halted).toBe(true);
      expect(result.haltedBy).toBe('halter');
      expect(runOrder).toEqual(['halter']);
      expect(result.diagnostics).toHaveLength(1);
    });

    it('should continue when a pass throws', () => {
      const registry = new PassRegistry();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runOrder: string[] = [];

      const pass1 = makePass('thrower', 'pre-check', () => {
        runOrder.push('thrower');
        throw new Error('pass exploded');
      });
      const pass2 = makePass('after', 'pre-check', (ast) => {
        runOrder.push('after');
        return { ast, diagnostics: [makeWarning('from after')] };
      });

      registry.register(pass1);
      registry.register(pass2);
      const ast = makeProgram();
      const context = makePassContext();

      const result = registry.runPreCheckPasses(ast, context);

      expect(runOrder).toEqual(['thrower', 'after']);
      expect(errorSpy).toHaveBeenCalled();
      // The thrown error does not produce a diagnostic
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toBe('from after');
      expect(result.halted).toBe(false);

      errorSpy.mockRestore();
    });

    it('should skip disabled passes', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass = makePass('disabled-pass', 'pre-check', (ast) => {
        runOrder.push('disabled-pass');
        return { ast, diagnostics: [] };
      });

      registry.register(pass);
      const context = makePassContext({ passes: { 'disabled-pass': false } });

      const result = registry.runPreCheckPasses(makeProgram(), context);

      expect(runOrder).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('should run passes enabled by default (no options entry)', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass = makePass('default-pass', 'pre-check', (ast) => {
        runOrder.push('default-pass');
        return { ast, diagnostics: [] };
      });

      registry.register(pass);
      const context = makePassContext();

      registry.runPreCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['default-pass']);
    });

    it('should run explicitly enabled passes', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass = makePass('enabled-pass', 'pre-check', (ast) => {
        runOrder.push('enabled-pass');
        return { ast, diagnostics: [] };
      });

      registry.register(pass);
      const context = makePassContext({ passes: { 'enabled-pass': true } });

      registry.runPreCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['enabled-pass']);
    });

    it('should not run post-check passes during runPreCheckPasses', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const prePass = makePass('pre', 'pre-check', (ast) => {
        runOrder.push('pre');
        return { ast, diagnostics: [] };
      });
      const postPass = makePass('post', 'post-check', (ast) => {
        runOrder.push('post');
        return { ast, diagnostics: [] };
      });

      registry.register(prePass);
      registry.register(postPass);
      const context = makePassContext();

      registry.runPreCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['pre']);
    });
  });

  describe('Execution — Post-check Passes', () => {
    it('should return original AST when no passes are registered', () => {
      const registry = new PassRegistry();
      const ast = makeProgram();
      const context = makePassContext();

      const result = registry.runPostCheckPasses(ast, context);

      expect(result.ast).toBe(ast);
      expect(result.diagnostics).toHaveLength(0);
      expect(result.halted).toBe(false);
    });

    it('should run only post-check passes', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const prePass = makePass('pre', 'pre-check', (ast) => {
        runOrder.push('pre');
        return { ast, diagnostics: [] };
      });
      const postPass = makePass('post', 'post-check', (ast) => {
        runOrder.push('post');
        return { ast, diagnostics: [makeWarning('post-check warning')] };
      });

      registry.register(prePass);
      registry.register(postPass);
      const context = makePassContext();

      const result = registry.runPostCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['post']);
      expect(result.diagnostics).toHaveLength(1);
    });

    it('should halt on post-check pass halt', () => {
      const registry = new PassRegistry();
      const pass = makePass('halt-post', 'post-check', (ast) => ({
        ast,
        diagnostics: [],
        halt: true,
      }));

      registry.register(pass);
      const context = makePassContext();

      const result = registry.runPostCheckPasses(makeProgram(), context);

      expect(result.halted).toBe(true);
      expect(result.haltedBy).toBe('halt-post');
    });

    it('should continue when post-check pass throws', () => {
      const registry = new PassRegistry();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runOrder: string[] = [];

      const pass1 = makePass('thrower', 'post-check', () => {
        runOrder.push('thrower');
        throw new Error('boom');
      });
      const pass2 = makePass('survivor', 'post-check', (ast) => {
        runOrder.push('survivor');
        return { ast, diagnostics: [] };
      });

      registry.register(pass1);
      registry.register(pass2);
      const context = makePassContext();

      const result = registry.runPostCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['thrower', 'survivor']);
      expect(result.halted).toBe(false);

      errorSpy.mockRestore();
    });

    it('should skip disabled post-check passes', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass = makePass('disabled-post', 'post-check', (ast) => {
        runOrder.push('disabled-post');
        return { ast, diagnostics: [] };
      });

      registry.register(pass);
      const context = makePassContext({ passes: { 'disabled-post': false } });

      registry.runPostCheckPasses(makeProgram(), context);

      expect(runOrder).toHaveLength(0);
    });
  });

  describe('Diagnostic Handling', () => {
    it('should report pass diagnostics to shared collector', () => {
      const registry = new PassRegistry();
      const warning = makeWarning('test warning');
      const pass = makePass('diag-pass', 'pre-check', (ast) => ({
        ast,
        diagnostics: [warning],
      }));

      registry.register(pass);
      const context = makePassContext();

      registry.runPreCheckPasses(makeProgram(), context);

      expect(context.diagnostics.getWarnings()).toContainEqual(warning);
    });

    it('should collect diagnostics from multiple passes in order', () => {
      const registry = new PassRegistry();
      const diag1 = makeWarning('from pass 1');
      const diag2 = makeWarning('from pass 2');
      const diag3 = makeError('from pass 3');

      const pass1 = makePass('p1', 'pre-check', (ast) => ({
        ast,
        diagnostics: [diag1],
      }));
      const pass2 = makePass('p2', 'pre-check', (ast) => ({
        ast,
        diagnostics: [diag2],
      }));
      const pass3 = makePass('p3', 'pre-check', (ast) => ({
        ast,
        diagnostics: [diag3],
      }));

      registry.register(pass1);
      registry.register(pass2);
      registry.register(pass3);
      const context = makePassContext();

      const result = registry.runPreCheckPasses(makeProgram(), context);

      expect(result.diagnostics).toHaveLength(3);
      expect(result.diagnostics[0]).toBe(diag1);
      expect(result.diagnostics[1]).toBe(diag2);
      expect(result.diagnostics[2]).toBe(diag3);
    });

    it('should not halt on error-severity diagnostics (without halt flag)', () => {
      const registry = new PassRegistry();
      const runOrder: string[] = [];

      const pass1 = makePass('error-pass', 'pre-check', (ast) => {
        runOrder.push('error-pass');
        return { ast, diagnostics: [makeError('something broke')] };
      });
      const pass2 = makePass('next-pass', 'pre-check', (ast) => {
        runOrder.push('next-pass');
        return { ast, diagnostics: [] };
      });

      registry.register(pass1);
      registry.register(pass2);
      const context = makePassContext();

      const result = registry.runPreCheckPasses(makeProgram(), context);

      expect(runOrder).toEqual(['error-pass', 'next-pass']);
      expect(result.halted).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
    });
  });
});
