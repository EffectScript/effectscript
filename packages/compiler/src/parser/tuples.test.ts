import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';
import { tokenize } from '../lexer/lexer.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type {
  Program, Expression, Declaration, Statement,
  LetDeclaration, ExpressionStatement,
  NumberLiteral, StringLiteral, BooleanLiteral, Identifier,
  MatchExpr, MatchArm,
  LiteralPattern, BindingPattern, WildcardPattern, NullPattern, TuplePattern,
  ReturnStatement, ArrowFunction, BlockExpr, CallExpr,
} from './ast.js';

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

function parseExpr(source: string): Expression {
  const stmt = parseFirst<ExpressionStatement>(source);
  expect(stmt.kind).toBe('ExpressionStatement');
  return stmt.expression;
}

// ── Parser: TupleExpr ──────────────────────────────────────────────

describe('Parser: TupleExpr', () => {
  it('should parse (1, "hello") as TupleExpr with 2 elements', () => {
    const expr = parseExpr('(1, "hello")');
    expect(expr.kind).toBe('TupleExpr');
    const tuple = expr as Expression & { kind: 'TupleExpr'; elements: readonly Expression[] };
    expect(tuple.elements).toHaveLength(2);
    expect((tuple.elements[0] as NumberLiteral).kind).toBe('NumberLiteral');
    expect((tuple.elements[0] as NumberLiteral).value).toBe(1);
    expect((tuple.elements[1] as StringLiteral).kind).toBe('StringLiteral');
    expect((tuple.elements[1] as StringLiteral).value).toBe('hello');
  });

  it('should parse ("a", 42, true) as TupleExpr with 3 elements', () => {
    const expr = parseExpr('("a", 42, true)');
    expect(expr.kind).toBe('TupleExpr');
    const tuple = expr as Expression & { kind: 'TupleExpr'; elements: readonly Expression[] };
    expect(tuple.elements).toHaveLength(3);
    expect((tuple.elements[0] as StringLiteral).value).toBe('a');
    expect((tuple.elements[1] as NumberLiteral).value).toBe(42);
    expect((tuple.elements[2] as BooleanLiteral).value).toBe(true);
  });

  it('should parse ((1, 2), (3, 4)) as nested TupleExpr', () => {
    const expr = parseExpr('((1, 2), (3, 4))');
    expect(expr.kind).toBe('TupleExpr');
    const tuple = expr as Expression & { kind: 'TupleExpr'; elements: readonly Expression[] };
    expect(tuple.elements).toHaveLength(2);
    expect(tuple.elements[0].kind).toBe('TupleExpr');
    expect(tuple.elements[1].kind).toBe('TupleExpr');
  });

  it('should parse (1, 2,) with trailing comma as 2-element TupleExpr', () => {
    const expr = parseExpr('(1, 2,)');
    expect(expr.kind).toBe('TupleExpr');
    const tuple = expr as Expression & { kind: 'TupleExpr'; elements: readonly Expression[] };
    expect(tuple.elements).toHaveLength(2);
  });

  it('should keep (42) as a parenthesized expression, NOT a tuple', () => {
    const expr = parseExpr('(42)');
    expect(expr.kind).toBe('NumberLiteral');
    expect((expr as NumberLiteral).value).toBe(42);
  });

  it('should keep (a, b) => a + b as an arrow function, NOT a tuple', () => {
    const expr = parseExpr('(a, b) => a + b');
    expect(expr.kind).toBe('ArrowFunction');
  });

  it('should keep <T>(a, b) => a as a generic arrow function', () => {
    const expr = parseExpr('<T>(a: T, b: T) => a');
    expect(expr.kind).toBe('ArrowFunction');
  });

  it('should parse foo((1, 2)) — tuple expression as function argument', () => {
    const expr = parseExpr('foo((1, 2))');
    expect(expr.kind).toBe('CallExpr');
    const call = expr as CallExpr;
    expect(call.args).toHaveLength(1);
    expect(call.args[0].kind).toBe('TupleExpr');
  });
});

// ── Parser: Let Tuple Destructuring ────────────────────────────────

describe('Parser: let tuple destructuring', () => {
  it('should parse let (x, y) = expr as LetDeclaration with tuplePattern', () => {
    const decl = parseFirst<LetDeclaration>('let (x, y) = (1, 2)');
    expect(decl.kind).toBe('LetDeclaration');
    expect(decl.tuplePattern).toBeDefined();
    expect(decl.tuplePattern!.kind).toBe('TuplePattern');
    expect(decl.tuplePattern!.elements).toHaveLength(2);
  });

  it('should parse let (_, y) = expr with wildcard discard', () => {
    const decl = parseFirst<LetDeclaration>('let (_, y) = (1, 2)');
    expect(decl.tuplePattern).toBeDefined();
    const elems = decl.tuplePattern!.elements;
    expect(elems[0].kind).toBe('WildcardPattern');
    expect(elems[1].kind).toBe('Identifier');
    expect((elems[1] as Identifier).name).toBe('y');
  });

  it('should parse let (a, b): (number, string) = expr with type annotation', () => {
    const decl = parseFirst<LetDeclaration>('let (a, b): (number, string) = ("hello", 42)');
    expect(decl.tuplePattern).toBeDefined();
    expect(decl.typeAnnotation).toBeDefined();
    expect(decl.typeAnnotation!.kind).toBe('TupleType');
  });

  it('should reject let mut (a, b) = expr as a parse error', () => {
    const { diagnostics } = parseSource('var (a, b) = (1, 2)');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject let (a) = expr (single-element tuple destructuring)', () => {
    const { diagnostics } = parseSource('let (a) = 42');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── Parser: Match Tuple Patterns ───────────────────────────────────

describe('Parser: match tuple patterns', () => {
  it('should parse (0, _) as TuplePattern with LiteralPattern and WildcardPattern', () => {
    const expr = parseExpr('match x { (0, _) => "a" }');
    expect(expr.kind).toBe('MatchExpr');
    const match = expr as MatchExpr;
    const arm = match.arms[0];
    expect(arm.pattern.kind).toBe('TuplePattern');
    const tuple = arm.pattern as TuplePattern;
    expect(tuple.elements).toHaveLength(2);
    expect(tuple.elements[0].kind).toBe('LiteralPattern');
    expect(tuple.elements[1].kind).toBe('WildcardPattern');
  });

  it('should parse (n, s) as TuplePattern with BindingPattern sub-patterns', () => {
    const expr = parseExpr('match x { (n, s) => "b" }');
    const match = expr as MatchExpr;
    const tuple = match.arms[0].pattern as TuplePattern;
    expect(tuple.elements[0].kind).toBe('BindingPattern');
    expect(tuple.elements[1].kind).toBe('BindingPattern');
    expect((tuple.elements[0] as BindingPattern).name.name).toBe('n');
    expect((tuple.elements[1] as BindingPattern).name.name).toBe('s');
  });

  it('should parse ((0, _), _) as nested TuplePattern', () => {
    const expr = parseExpr('match x { ((0, _), _) => "c" }');
    const match = expr as MatchExpr;
    const outerTuple = match.arms[0].pattern as TuplePattern;
    expect(outerTuple.elements).toHaveLength(2);
    expect(outerTuple.elements[0].kind).toBe('TuplePattern');
    expect(outerTuple.elements[1].kind).toBe('WildcardPattern');
    const innerTuple = outerTuple.elements[0] as TuplePattern;
    expect(innerTuple.elements[0].kind).toBe('LiteralPattern');
    expect(innerTuple.elements[1].kind).toBe('WildcardPattern');
  });

  it('should parse (null, x) as TuplePattern with NullPattern sub-pattern', () => {
    const expr = parseExpr('match x { (null, y) => "d" }');
    const match = expr as MatchExpr;
    const tuple = match.arms[0].pattern as TuplePattern;
    expect(tuple.elements[0].kind).toBe('NullPattern');
    expect(tuple.elements[1].kind).toBe('BindingPattern');
  });
});

// ── Parser: return with tuple ──────────────────────────────────────

describe('Parser: return with tuple', () => {
  it('should parse return (1, 2) inside a function body as TupleExpr', () => {
    const expr = parseExpr('(x: number) => { return (1, 2) }');
    expect(expr.kind).toBe('ArrowFunction');
    const fn = expr as ArrowFunction;
    const block = fn.body as BlockExpr;
    const ret = block.body[0] as ReturnStatement;
    expect(ret.kind).toBe('ReturnStatement');
    expect(ret.value!.kind).toBe('TupleExpr');
  });
});
