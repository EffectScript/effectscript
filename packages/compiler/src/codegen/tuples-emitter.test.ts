import { describe, it, expect } from 'vitest';
import { emitJS } from './js-emitter.js';
import { emitDTS } from './dts-emitter.js';
import type {
  Program, LetDeclaration,
  NumberLiteral, StringLiteral, BooleanLiteral,
  Identifier, MemberExpr, MatchExpr, MatchArm,
  Expression, Declaration, Statement,
  ExpressionStatement,
} from '../parser/ast.js';
import type { Span } from '../utils/span.js';
import type { TupleType, Type } from '../checker/types.js';

// ── Helpers ─────────────────────────────────────────────────

const span: Span = {
  file: 'test.efs',
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 0, line: 1, column: 0 },
};

function id(name: string): Identifier {
  return { kind: 'Identifier', name, span };
}

function num(value: number): NumberLiteral {
  return { kind: 'NumberLiteral', value, span };
}

function str(value: string): StringLiteral {
  return { kind: 'StringLiteral', value, span };
}

function program(...body: (Declaration | Statement)[]): Program {
  return { kind: 'Program', body, span };
}

function exprStmt(expression: Expression): ExpressionStatement {
  return { kind: 'ExpressionStatement', expression, span };
}

/** Create a TupleExpr node. */
function tupleExpr(...elements: Expression[]): Expression & { kind: 'TupleExpr'; elements: readonly Expression[] } {
  return { kind: 'TupleExpr' as const, elements, span } as Expression & { kind: 'TupleExpr'; elements: readonly Expression[] };
}

function matchExpr(subject: Expression, arms: MatchArm[], exhaustive = false): MatchExpr {
  const node: Record<string, unknown> = { kind: 'MatchExpr', subject, arms, span };
  node['isExhaustive'] = exhaustive;
  return node as unknown as MatchExpr;
}

function matchArm(pattern: MatchArm['pattern'], body: Expression, guard?: Expression): MatchArm {
  const node: Record<string, unknown> = { kind: 'MatchArm', pattern, body, span };
  if (guard !== undefined) node['guard'] = guard;
  return node as unknown as MatchArm;
}

// ── Emitter: TupleExpr → JS array ──────────────────────────────────

describe('Emitter: TupleExpr', () => {
  it('should emit (1, "hello") as [1, "hello"]', () => {
    const prog = program(exprStmt(tupleExpr(num(1), str('hello'))));
    const js = emitJS(prog);
    expect(js).toContain('[1, "hello"]');
  });

  it('should emit nested tuples as nested arrays', () => {
    const prog = program(exprStmt(tupleExpr(tupleExpr(num(1), num(2)), tupleExpr(num(3), num(4)))));
    const js = emitJS(prog);
    expect(js).toContain('[[1, 2], [3, 4]]');
  });
});

// ── Emitter: Tuple positional indexing ─────────────────────────────

describe('Emitter: tuple positional indexing', () => {
  it('should emit pair.0 as pair[0] when object has tuple resolved type', () => {
    const pairId = id('pair');
    const tupleType: TupleType = {
      kind: 'tuple',
      elements: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
      ],
    };
    pairId.resolvedType = tupleType;

    const memberNode: MemberExpr = {
      kind: 'MemberExpr',
      object: pairId,
      property: id('0'),
      optional: false,
      span,
    };

    const prog = program(exprStmt(memberNode));
    const js = emitJS(prog);
    expect(js).toContain('pair[0]');
  });
});

// ── Emitter: nullable tuple positional indexing ─────────────────────

describe('Emitter: nullable tuple positional indexing', () => {
  it('should emit pair?.0 as pair?.[0] when object has nullable tuple type', () => {
    const pairId = id('pair');
    pairId.resolvedType = {
      kind: 'nullable',
      inner: {
        kind: 'tuple',
        elements: [
          { kind: 'primitive', name: 'number' },
          { kind: 'primitive', name: 'string' },
        ],
      },
    };

    const memberNode: MemberExpr = {
      kind: 'MemberExpr',
      object: pairId,
      property: id('0'),
      optional: true,
      span,
    };

    const prog = program(exprStmt(memberNode));
    const js = emitJS(prog);
    expect(js).toContain('pair?.[0]');
    expect(js).not.toContain('pair?.0');
  });
});

// ── Emitter: let tuple destructuring ───────────────────────────────

describe('Emitter: let tuple destructuring', () => {
  it('should emit let (a, b) = pair as const [a, b] = pair', () => {
    const tuplePattern = {
      kind: 'TuplePattern' as const,
      elements: [id('a'), id('b')],
      span,
    };
    const decl: Record<string, unknown> = {
      kind: 'LetDeclaration',
      name: id('_tuple'),
      mutable: false,
      initializer: id('pair'),
      exported: false,
      tuplePattern,
      span,
    };
    const prog = program(decl as unknown as Declaration);
    const js = emitJS(prog);
    expect(js).toContain('const [a, b] = pair');
  });

  it('should emit let (_, b) = pair as const [, b] = pair', () => {
    const tuplePattern = {
      kind: 'TuplePattern' as const,
      elements: [
        { kind: 'WildcardPattern' as const, span },
        id('b'),
      ],
      span,
    };
    const decl: Record<string, unknown> = {
      kind: 'LetDeclaration',
      name: id('_tuple'),
      mutable: false,
      initializer: id('pair'),
      exported: false,
      tuplePattern,
      span,
    };
    const prog = program(decl as unknown as Declaration);
    const js = emitJS(prog);
    expect(js).toContain('const [, b] = pair');
  });
});

// ── Emitter: match tuple patterns ──────────────────────────────────

describe('Emitter: match tuple pattern condition', () => {
  it('should emit condition subject[0] === 0 for literal at index 0', () => {
    const subject = id('pair');
    subject.resolvedType = { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' }] };

    const pat = {
      kind: 'TuplePattern' as const,
      elements: [
        { kind: 'LiteralPattern' as const, literal: num(0), span },
        { kind: 'WildcardPattern' as const, span },
      ],
      span,
    };

    const arm = matchArm(pat as unknown as MatchArm['pattern'], str('zero'));
    const catchAll = matchArm(
      { kind: 'WildcardPattern' as const, span } as unknown as MatchArm['pattern'],
      str('other'),
    );
    const match = matchExpr(subject, [arm, catchAll], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    expect(js).toContain('pair[0] === 0');
  });

  it('should emit binding: const n = subject[0]', () => {
    const subject = id('pair');
    subject.resolvedType = { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' }] };

    const pat = {
      kind: 'TuplePattern' as const,
      elements: [
        { kind: 'BindingPattern' as const, name: id('n'), span },
        { kind: 'BindingPattern' as const, name: id('s'), span },
      ],
      span,
    };

    const arm = matchArm(pat as unknown as MatchArm['pattern'], id('n'));
    const match = matchExpr(subject, [arm], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    expect(js).toContain('const n = pair[0]');
    expect(js).toContain('const s = pair[1]');
  });
});

// ── Emitter: isCatchAllPattern for TuplePattern ────────────────────

describe('Emitter: isCatchAllPattern for TuplePattern', () => {
  it('should recognize (a, b) (all bindings) as catch-all in else block', () => {
    const subject = id('pair');
    subject.resolvedType = { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' }] };

    const litArm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'LiteralPattern' as const, literal: num(0), span },
        { kind: 'WildcardPattern' as const, span },
      ], span } as unknown as MatchArm['pattern'],
      str('zero'),
    );
    const catchAllArm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'BindingPattern' as const, name: id('a'), span },
        { kind: 'BindingPattern' as const, name: id('b'), span },
      ], span } as unknown as MatchArm['pattern'],
      str('other'),
    );

    const match = matchExpr(subject, [litArm, catchAllArm], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    // The all-binding tuple pattern should be in an else block, not if (true)
    expect(js).toContain('else {');
  });

  it('should NOT recognize (0, _) as catch-all', () => {
    const subject = id('pair');
    subject.resolvedType = { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' }] };

    const arm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'LiteralPattern' as const, literal: num(0), span },
        { kind: 'WildcardPattern' as const, span },
      ], span } as unknown as MatchArm['pattern'],
      str('zero'),
    );
    const fallback = matchArm(
      { kind: 'WildcardPattern' as const, span } as unknown as MatchArm['pattern'],
      str('other'),
    );

    const match = matchExpr(subject, [arm, fallback], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    // (0, _) should be in an if block, not else
    expect(js).toContain('if (');
    expect(js).toContain('pair[0] === 0');
  });
});

// ── Emitter: nested tuple pattern ───────────────────────────────────

describe('Emitter: nested tuple pattern', () => {
  it('should emit nested condition subject[0][0] === 0 for ((0, _), _)', () => {
    const subject = id('nested');
    subject.resolvedType = {
      kind: 'tuple',
      elements: [
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
      ],
    };

    const pat = {
      kind: 'TuplePattern' as const,
      elements: [
        {
          kind: 'TuplePattern' as const,
          elements: [
            { kind: 'LiteralPattern' as const, literal: num(0), span },
            { kind: 'WildcardPattern' as const, span },
          ],
          span,
        },
        { kind: 'WildcardPattern' as const, span },
      ],
      span,
    };

    const arm = matchArm(pat as unknown as MatchArm['pattern'], str('hit'));
    const catchAll = matchArm(
      { kind: 'WildcardPattern' as const, span } as unknown as MatchArm['pattern'],
      str('miss'),
    );
    const match = matchExpr(subject, [arm, catchAll], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    expect(js).toContain('nested[0][0] === 0');
  });

  it('should emit nested binding const y = nested[1][1]', () => {
    const subject = id('nested');
    subject.resolvedType = {
      kind: 'tuple',
      elements: [
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
      ],
    };

    const pat = {
      kind: 'TuplePattern' as const,
      elements: [
        { kind: 'WildcardPattern' as const, span },
        {
          kind: 'TuplePattern' as const,
          elements: [
            { kind: 'WildcardPattern' as const, span },
            { kind: 'BindingPattern' as const, name: id('y'), span },
          ],
          span,
        },
      ],
      span,
    };

    const arm = matchArm(pat as unknown as MatchArm['pattern'], id('y'));
    const match = matchExpr(subject, [arm], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    expect(js).toContain('const y = nested[1][1]');
  });

  it('should emit null check for (null, x) pattern', () => {
    const subject = id('pair');
    subject.resolvedType = {
      kind: 'tuple',
      elements: [
        { kind: 'nullable', inner: { kind: 'primitive', name: 'string' } },
        { kind: 'primitive', name: 'number' },
      ],
    };

    const pat = {
      kind: 'TuplePattern' as const,
      elements: [
        { kind: 'NullPattern' as const, span },
        { kind: 'BindingPattern' as const, name: id('x'), span },
      ],
      span,
    };

    const arm = matchArm(pat as unknown as MatchArm['pattern'], id('x'));
    const catchAll = matchArm(
      { kind: 'WildcardPattern' as const, span } as unknown as MatchArm['pattern'],
      str('other'),
    );
    const match = matchExpr(subject, [arm, catchAll], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    expect(js).toContain('pair[0] === null');
  });
});

// ── Emitter: isCatchAllPattern nested edge cases ────────────────────

describe('Emitter: isCatchAllPattern nested edge cases', () => {
  it('should recognize ((a, b), (c, d)) as catch-all (nested all-bindings)', () => {
    const subject = id('nested');
    subject.resolvedType = {
      kind: 'tuple',
      elements: [
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
      ],
    };

    const litArm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'TuplePattern' as const, elements: [
          { kind: 'LiteralPattern' as const, literal: num(0), span },
          { kind: 'WildcardPattern' as const, span },
        ], span },
        { kind: 'WildcardPattern' as const, span },
      ], span } as unknown as MatchArm['pattern'],
      str('zero'),
    );
    const catchAllArm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'TuplePattern' as const, elements: [
          { kind: 'BindingPattern' as const, name: id('a'), span },
          { kind: 'BindingPattern' as const, name: id('b'), span },
        ], span },
        { kind: 'TuplePattern' as const, elements: [
          { kind: 'BindingPattern' as const, name: id('c'), span },
          { kind: 'BindingPattern' as const, name: id('d'), span },
        ], span },
      ], span } as unknown as MatchArm['pattern'],
      str('other'),
    );

    const match = matchExpr(subject, [litArm, catchAllArm], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    // Nested all-binding tuple should be in else block
    expect(js).toContain('else {');
  });

  it('should NOT recognize (_, (0, _)) as catch-all (nested literal)', () => {
    const subject = id('nested');
    subject.resolvedType = {
      kind: 'tuple',
      elements: [
        { kind: 'primitive', name: 'number' },
        { kind: 'tuple', elements: [{ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'number' }] },
      ],
    };

    const arm = matchArm(
      { kind: 'TuplePattern' as const, elements: [
        { kind: 'WildcardPattern' as const, span },
        { kind: 'TuplePattern' as const, elements: [
          { kind: 'LiteralPattern' as const, literal: num(0), span },
          { kind: 'WildcardPattern' as const, span },
        ], span },
      ], span } as unknown as MatchArm['pattern'],
      str('hit'),
    );
    const fallback = matchArm(
      { kind: 'WildcardPattern' as const, span } as unknown as MatchArm['pattern'],
      str('miss'),
    );

    const match = matchExpr(subject, [arm, fallback], true);
    const prog = program(exprStmt(match));
    const js = emitJS(prog);
    // Should be in if block with a condition, not else
    expect(js).toContain('if (');
    expect(js).toContain('[1][0] === 0');
  });
});

// ── Emitter: DTS for exported tuple destructuring ──────────────────

describe('Emitter: DTS for exported tuple destructuring', () => {
  it('should emit separate declarations for export let (a, b) = (1, "hello")', () => {
    const tuplePattern = {
      kind: 'TuplePattern' as const,
      elements: [id('a'), id('b')],
      span,
    };
    const aType: Type = { kind: 'primitive', name: 'number' };
    const bType: Type = { kind: 'primitive', name: 'string' };

    const decl: Record<string, unknown> = {
      kind: 'LetDeclaration',
      name: id('_tuple'),
      mutable: false,
      initializer: tupleExpr(num(1), str('hello')),
      exported: true,
      tuplePattern,
      resolvedType: { kind: 'tuple', elements: [aType, bType] },
      span,
    };
    const prog = program(decl as unknown as Declaration);
    const dts = emitDTS(prog);
    expect(dts).toContain('export declare const a: number;');
    expect(dts).toContain('export declare const b: string;');
  });
});
