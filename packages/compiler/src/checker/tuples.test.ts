import { describe, it, expect } from 'vitest';
import { check } from './checker.js';
import type { CheckerOutput } from './checker.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import { createPrelude } from '../prelude/prelude.js';
import { resolveType, typeToString } from './types.js';
import type { Type, TupleType } from './types.js';
import type { Program, LetDeclaration, ExpressionStatement } from '../parser/ast.js';

// ── Helpers ──────────────────────────────────────────────────────────

function parseSource(source: string): { ast: Program; diagnostics: DiagnosticCollectorImpl } {
  const diagnostics = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', diagnostics);
  const ast = parse(tokens, 'test.efs', diagnostics);
  return { ast, diagnostics };
}

function checkSource(source: string): { output: CheckerOutput; diagnostics: DiagnosticCollectorImpl } {
  const { ast, diagnostics } = parseSource(source);
  const prelude = createPrelude();
  const output = check({ ast, imports: new Map(), prelude, diagnostics });
  return { output, diagnostics };
}

function getResolvedType(source: string): Type | undefined {
  const { output } = checkSource(source);
  const firstDecl = output.typedAST.body[0];
  if (firstDecl && 'resolvedType' in firstDecl) {
    return (firstDecl as unknown as { resolvedType?: Type }).resolvedType;
  }
  return undefined;
}

function getExprType(source: string): Type | undefined {
  const { output } = checkSource(source);
  for (let i = output.typedAST.body.length - 1; i >= 0; i--) {
    const item = output.typedAST.body[i];
    if (item.kind === 'LetDeclaration') {
      return (item as LetDeclaration).resolvedType;
    }
  }
  return undefined;
}

function getErrors(source: string): string[] {
  const { diagnostics } = checkSource(source);
  return diagnostics.getAll()
    .filter(d => d.severity === 'error')
    .map(d => d.code);
}

function getErrorMessages(source: string): string[] {
  const { diagnostics } = checkSource(source);
  return diagnostics.getAll()
    .filter(d => d.severity === 'error')
    .map(d => d.message);
}

// ── Checker: TupleExpr inference ───────────────────────────────────

describe('Checker: TupleExpr inference', () => {
  it('should infer (1, "hello") as (number, string)', () => {
    const type = getResolvedType('let x = (1, "hello")');
    expect(type).toBeDefined();
    const resolved = resolveType(type!);
    expect(resolved.kind).toBe('tuple');
    const tuple = resolved as TupleType;
    expect(tuple.elements).toHaveLength(2);
    expect(tuple.elements[0].kind).toBe('literal');
    expect(tuple.elements[1].kind).toBe('literal');
  });

  it('should infer (true, 42, "a") as (boolean, number, string)', () => {
    const type = getResolvedType('let x = (true, 42, "a")');
    expect(type).toBeDefined();
    const resolved = resolveType(type!) as TupleType;
    expect(resolved.kind).toBe('tuple');
    expect(resolved.elements).toHaveLength(3);
  });

  it('should infer ((1, 2), (3, 4)) as nested tuple type', () => {
    const type = getResolvedType('let x = ((1, 2), (3, 4))');
    expect(type).toBeDefined();
    const resolved = resolveType(type!) as TupleType;
    expect(resolved.kind).toBe('tuple');
    expect(resolved.elements).toHaveLength(2);
    expect(resolveType(resolved.elements[0]).kind).toBe('tuple');
    expect(resolveType(resolved.elements[1]).kind).toBe('tuple');
  });

  it('should accept bidirectional type: let x: (string, number) = ("hello", 42)', () => {
    const errors = getErrors('let x: (string, number) = ("hello", 42)');
    expect(errors).toHaveLength(0);
  });

  it('should report type mismatch: let x: (string, number) = (42, "hello")', () => {
    const errors = getErrors('let x: (string, number) = (42, "hello")');
    expect(errors).toContain('E200');
  });
});

// ── Checker: positional indexing ───────────────────────────────────

describe('Checker: positional indexing on tuples', () => {
  it('should infer pair.0 on (number, string) as number', () => {
    const type = getExprType('let pair = (1, "hello")\nlet x = pair.0');
    expect(type).toBeDefined();
    const resolved = resolveType(type!);
    expect(resolved.kind).toBe('literal');
  });

  it('should infer pair.1 on (number, string) as string', () => {
    const type = getExprType('let pair = (1, "hello")\nlet x = pair.1');
    expect(type).toBeDefined();
    const resolved = resolveType(type!);
    expect(resolved.kind).toBe('literal');
  });

  it('should report E270 for pair.2 on a 2-tuple (out of bounds)', () => {
    const errors = getErrors('let pair = (1, "hello")\nlet x = pair.2');
    expect(errors).toContain('E270');
  });

  it('should report E209 for pair.foo on a tuple (no field)', () => {
    const errors = getErrors('let pair = (1, "hello")\nlet x = pair.foo');
    expect(errors).toContain('E209');
  });

  it('should infer pair?.0 on (number, string)? as number?', () => {
    const src = `
      let pair: (number, string)? = null
      let x = pair?.0
    `;
    const type = getExprType(src);
    expect(type).toBeDefined();
    const resolved = resolveType(type!);
    expect(resolved.kind).toBe('nullable');
  });
});

// ── Checker: let destructuring ─────────────────────────────────────

describe('Checker: let tuple destructuring', () => {
  it('should bind a: number, b: string from let (a, b) = (1, "hello")', () => {
    const { output } = checkSource('let (a, b) = (1, "hello")\nlet x = a\nlet y = b');
    const xDecl = output.typedAST.body[1] as LetDeclaration;
    const yDecl = output.typedAST.body[2] as LetDeclaration;
    const xType = resolveType(xDecl.resolvedType!);
    const yType = resolveType(yDecl.resolvedType!);
    expect(xType.kind).toBe('literal');
    expect(yType.kind).toBe('literal');
  });

  it('should not bind _ (wildcard) in let (_, b) = (1, "hello")', () => {
    const errors = getErrors('let (_, b) = (1, "hello")\nlet x = _');
    // _ should not be in scope — it's a wildcard discard, so using it should error
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should report E271 for arity mismatch: let (a, b, c) = (1, "hello")', () => {
    const errors = getErrors('let (a, b, c) = (1, "hello")');
    expect(errors).toContain('E271');
  });

  it('should report E272 for non-tuple: let (a, b) = 42', () => {
    const errors = getErrors('let (a, b) = 42');
    expect(errors).toContain('E272');
  });

  it('should propagate type annotation: let (a, b): (string, number) = ("hello", 42)', () => {
    const errors = getErrors('let (a, b): (string, number) = ("hello", 42)');
    expect(errors).toHaveLength(0);
  });

  it('should report E272 for nullable tuple: let (a, b) = nullablePair', () => {
    const errors = getErrors('let pair: (string, number)? = null\nlet (a, b) = pair');
    expect(errors).toContain('E272');
  });
});

// ── Checker: match tuple patterns ──────────────────────────────────

describe('Checker: match tuple patterns', () => {
  it('should check literal sub-patterns in match tuple pattern', () => {
    const errors = getErrors(`
      let pair = (1, "hello")
      let r = match pair {
        (0, _) => "a"
        (n, s) => "b"
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it('should bind sub-patterns with correct types', () => {
    const { output } = checkSource(`
      let pair = (1, "hello")
      let r = match pair {
        (n, s) => n
      }
    `);
    const rDecl = output.typedAST.body[1] as LetDeclaration;
    expect(rDecl.resolvedType).toBeDefined();
  });

  it('should handle exhaustive match with catch-all tuple pattern', () => {
    const errors = getErrors(`
      let pair = (1, "hello")
      let r = match pair {
        (0, _) => "a"
        (n, s) => "b"
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it('should report E273 when matching non-tuple with tuple pattern', () => {
    const errors = getErrors(`
      let x = 42
      let r = match x {
        (a, b) => "nope"
      }
    `);
    expect(errors).toContain('E273');
  });

  it('should report E271 for tuple pattern arity mismatch in match', () => {
    const errors = getErrors(`
      let pair = (1, "hello")
      let r = match pair {
        (0, _, _) => "a"
        _ => "b"
      }
    `);
    expect(errors).toContain('E271');
  });

  it('should support guard clauses with tuple patterns', () => {
    const errors = getErrors(`
      let pair = (1, "hello")
      let r = match pair {
        (n, s) if n > 0 => "positive"
        _ => "other"
      }
    `);
    // n should be bound and usable in guard
    expect(errors).toHaveLength(0);
  });
});

// ── Checker: generic inference through tuples ──────────────────────

describe('Checker: generic inference through tuples', () => {
  it('should infer T = number for <T>(x: (T, T)) => T called with (1, 2)', () => {
    const { output, diagnostics } = checkSource(`
      let fn = <T>(x: (T, T)): T => x.0
      let r = fn((1, 2))
    `);
    const errors = diagnostics.getAll().filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('should infer K = string, V = number for <K, V>(entry: (K, V)) => K called with ("a", 1)', () => {
    const { diagnostics } = checkSource(`
      let fn = <K, V>(entry: (K, V)): K => entry.0
      let r = fn(("a", 1))
    `);
    const errors = diagnostics.getAll().filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ── Checker: exhaustiveness for tuples ──────────────────────────────

describe('Checker: exhaustiveness for tuples', () => {
  it('should recognize (a, b) catch-all as exhaustive', () => {
    const { diagnostics } = checkSource(`
      let pair = (1, "hello")
      let r = match pair {
        (a, b) => a
      }
    `);
    const warnings = diagnostics.getAll().filter(d => d.severity === 'warning');
    expect(warnings.every(w => !w.message.includes('exhaustive'))).toBe(true);
  });
});

// ── Checker: all-wildcard let destructuring ─────────────────────────

describe('Checker: all-wildcard let destructuring', () => {
  it('should allow let (_, _) = pair without errors', () => {
    const errors = getErrors('let pair = (1, "hello")\nlet (_, _) = pair');
    expect(errors).toHaveLength(0);
  });
});

// ── Checker: TuplePattern inside VariantPattern guard ───────────────

describe('Checker: TuplePattern inside VariantPattern', () => {
  it('should report E273 for TuplePattern as sub-pattern of VariantPattern', () => {
    const { diagnostics } = checkSource(`
      type Wrap = Box(value: number) | Empty
      let w: Wrap = Box(42)
      let z = match w {
        Box((a, b)) => "yes"
        Empty => "no"
      }
    `);
    const all = diagnostics.getAll();
    const errorCodes = all.filter(d => d.severity === 'error').map(d => d.code);
    expect(errorCodes).toContain('E273');
  });
});

// ── Error message quality ──────────────────────────────────────────

describe('Error message quality', () => {
  it('E270 includes tuple arity and out-of-bounds index', () => {
    const msgs = getErrorMessages('let pair = (1, "hello")\nlet x = pair.2');
    expect(msgs.some(m => m.includes('2') && m.includes('out of bounds'))).toBe(true);
  });

  it('E271 includes tuple arity and pattern count', () => {
    const msgs = getErrorMessages('let (a, b, c) = (1, "hello")');
    expect(msgs.some(m => m.includes('2') && m.includes('3'))).toBe(true);
  });

  it('E272 includes the actual type found', () => {
    const msgs = getErrorMessages('let (a, b) = 42');
    expect(msgs.some(m => m.includes('number') || m.includes('42'))).toBe(true);
  });

  it('E273 includes the actual type found', () => {
    const msgs = getErrorMessages(`
      let x = 42
      let r = match x {
        (a, b) => "nope"
      }
    `);
    expect(msgs.some(m => m.includes('number') || m.includes('42'))).toBe(true);
  });
});
