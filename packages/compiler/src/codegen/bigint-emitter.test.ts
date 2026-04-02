import { describe, it, expect } from 'vitest';
import { emitJS } from './js-emitter.js';
import { emitDTS } from './dts-emitter.js';
import type {
  Program, LetDeclaration, ExpressionStatement,
  Identifier, NumberLiteral, BinaryExpr, UnaryExpr,
  Expression, Declaration, Statement,
} from '../parser/ast.js';
import type { Span } from '../utils/span.js';
import type { Type, PrimitiveType } from '../checker/types.js';

// BigIntLiteral interface
interface BigIntLiteral {
  readonly kind: 'BigIntLiteral';
  readonly raw: string;
  readonly span: Span;
  resolvedType?: Type;
}

// ── Helpers ─────────────────────────────────────────────────

const span: Span = {
  file: 'test.efs',
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 0, line: 1, column: 0 },
};

const BIGINT_TYPE: PrimitiveType = { kind: 'primitive', name: 'bigint' };
const SYMBOL_TYPE: PrimitiveType = { kind: 'primitive', name: 'symbol' };

function id(name: string): Identifier {
  return { kind: 'Identifier', name, span };
}

function bigint(raw: string): BigIntLiteral {
  return { kind: 'BigIntLiteral', raw, span, resolvedType: BIGINT_TYPE };
}

function program(...body: (Declaration | Statement)[]): Program {
  return { kind: 'Program', body, span };
}

function letDecl(name: string, init: Expression, opts?: { mutable?: boolean; exported?: boolean }): LetDeclaration {
  return {
    kind: 'LetDeclaration',
    name: id(name),
    mutable: opts?.mutable ?? false,
    initializer: init,
    exported: opts?.exported ?? false,
    span,
  };
}

function exprStmt(expression: Expression): ExpressionStatement {
  return { kind: 'ExpressionStatement', expression, span };
}

// ── JS Emitter Tests ────────────────────────────────────────

describe('JS emitter — BigInt literals', () => {
  it('emits 42n for BigIntLiteral(42)', () => {
    const ast = program(letDecl('x', bigint('42') as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('42n');
  });

  it('emits 0xFFn for BigIntLiteral(0xFF)', () => {
    const ast = program(letDecl('x', bigint('0xFF') as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('0xFFn');
  });

  it('emits 0n for BigIntLiteral(0)', () => {
    const ast = program(letDecl('x', bigint('0') as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('0n');
  });

  it('emits bigint arithmetic without transformation', () => {
    const addExpr: BinaryExpr = {
      kind: 'BinaryExpr',
      operator: '+',
      left: { kind: 'Identifier', name: 'a', span, resolvedType: BIGINT_TYPE } as Expression,
      right: { kind: 'Identifier', name: 'b', span, resolvedType: BIGINT_TYPE } as Expression,
      span,
    };
    const ast = program(exprStmt(addExpr));
    const js = emitJS(ast);
    expect(js).toContain('a + b');
  });

  it('emits unary negation -42n', () => {
    const neg: UnaryExpr = {
      kind: 'UnaryExpr',
      operator: '-',
      operand: bigint('42') as unknown as Expression,
      span,
    };
    const ast = program(letDecl('x', neg));
    const js = emitJS(ast);
    expect(js).toContain('-42n');
  });
});

// ── DTS Emitter Tests ───────────────────────────────────────

describe('DTS emitter — bigint and symbol types', () => {
  it('emits bigint type in .d.ts', () => {
    const decl = letDecl('x', bigint('42') as unknown as Expression, { exported: true });
    decl.resolvedType = BIGINT_TYPE;
    const ast = program(decl);
    const dts = emitDTS(ast);
    expect(dts).toContain('bigint');
  });

  it('emits symbol type in .d.ts', () => {
    const initExpr = id('sym');
    initExpr.resolvedType = SYMBOL_TYPE;
    const decl = letDecl('s', initExpr, { exported: true });
    decl.resolvedType = SYMBOL_TYPE;
    const ast = program(decl);
    const dts = emitDTS(ast);
    expect(dts).toContain('symbol');
  });

  it('emits bigint | null for bigint? in .d.ts', () => {
    const initExpr = id('x');
    const nullableType: Type = { kind: 'nullable', inner: BIGINT_TYPE };
    initExpr.resolvedType = nullableType;
    const decl = letDecl('x', initExpr, { exported: true });
    decl.resolvedType = nullableType;
    const ast = program(decl);
    const dts = emitDTS(ast);
    expect(dts).toContain('bigint | null');
  });

  it('emits function with bigint param in .d.ts', () => {
    const fnType: Type = {
      kind: 'function',
      params: [{ name: 'x', type: BIGINT_TYPE, optional: false, hasDefault: false }],
      returnType: BIGINT_TYPE,
    };
    const body = id('x');
    body.resolvedType = BIGINT_TYPE;
    const arrow: Expression = {
      kind: 'ArrowFunction',
      params: [{ kind: 'FunctionParam', name: id('x'), mutable: false, span }],
      body,
      span,
      resolvedType: fnType,
    } as unknown as Expression;
    const decl = letDecl('f', arrow, { exported: true });
    decl.resolvedType = fnType;
    const ast = program(decl);
    const dts = emitDTS(ast);
    expect(dts).toContain('bigint');
  });
});
