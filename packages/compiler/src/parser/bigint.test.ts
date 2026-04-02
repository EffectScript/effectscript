import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';
import { tokenize } from '../lexer/lexer.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type {
  Program, Expression, Declaration, Statement,
  LetDeclaration, ExpressionStatement,
  BinaryExpr, UnaryExpr, NamedType,
} from './ast.js';

// BigIntLiteral interface will be added during implementation
interface BigIntLiteral {
  readonly kind: 'BigIntLiteral';
  readonly raw: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseSource(source: string): { program: Program; diagnostics: readonly Diagnostic[] } {
  const collector = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', collector);
  const program = parse(tokens, 'test.efs', collector);
  return { program, diagnostics: collector.getAll() };
}

function parseOk(source: string): Program {
  const { program, diagnostics } = parseSource(source);
  const errors = diagnostics.filter(d => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Expected no errors but got:\n${errors.map(d => `  ${d.code}: ${d.message}`).join('\n')}`);
  }
  return program;
}

function parseFirst<T extends Declaration | Statement>(source: string): T {
  const program = parseOk(source);
  expect(program.body.length).toBeGreaterThanOrEqual(1);
  return program.body[0] as T;
}

// ── BigInt Parser Tests ─────────────────────────────────────────────

describe('BigInt literal parsing', () => {
  it('parses let x = 42n as LetDeclaration with BigIntLiteral', () => {
    const decl = parseFirst<LetDeclaration>('let x = 42n');
    expect(decl.kind).toBe('LetDeclaration');
    expect(decl.initializer.kind).toBe('BigIntLiteral');
    expect((decl.initializer as unknown as BigIntLiteral).raw).toBe('42');
  });

  it('parses let x: bigint = 42n with bigint type annotation', () => {
    const decl = parseFirst<LetDeclaration>('let x: bigint = 42n');
    expect(decl.kind).toBe('LetDeclaration');
    expect(decl.typeAnnotation).toBeDefined();
    expect((decl.typeAnnotation as NamedType).name.name).toBe('bigint');
    expect(decl.initializer.kind).toBe('BigIntLiteral');
  });

  it('parses -42n as UnaryExpr wrapping BigIntLiteral', () => {
    const decl = parseFirst<LetDeclaration>('let x = -42n');
    expect(decl.kind).toBe('LetDeclaration');
    const unary = decl.initializer as UnaryExpr;
    expect(unary.kind).toBe('UnaryExpr');
    expect(unary.operator).toBe('-');
    expect(unary.operand.kind).toBe('BigIntLiteral');
    expect((unary.operand as unknown as BigIntLiteral).raw).toBe('42');
  });

  it('parses let x: symbol = Symbol("desc") with symbol type annotation', () => {
    const decl = parseFirst<LetDeclaration>('let x: symbol = Symbol("desc")');
    expect(decl.kind).toBe('LetDeclaration');
    expect(decl.typeAnnotation).toBeDefined();
    expect((decl.typeAnnotation as NamedType).name.name).toBe('symbol');
  });

  it('parses 42n + 10n as BinaryExpr with two BigIntLiteral operands', () => {
    const program = parseOk('42n + 10n');
    const stmt = program.body[0] as ExpressionStatement;
    const binary = stmt.expression as BinaryExpr;
    expect(binary.kind).toBe('BinaryExpr');
    expect(binary.operator).toBe('+');
    expect(binary.left.kind).toBe('BigIntLiteral');
    expect(binary.right.kind).toBe('BigIntLiteral');
  });

  it('parses 0xFFn as BigIntLiteral with raw "0xFF"', () => {
    const decl = parseFirst<LetDeclaration>('let x = 0xFFn');
    expect(decl.initializer.kind).toBe('BigIntLiteral');
    expect((decl.initializer as unknown as BigIntLiteral).raw).toBe('0xFF');
  });
});
