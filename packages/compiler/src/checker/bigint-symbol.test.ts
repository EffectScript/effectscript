import { describe, it, expect } from 'vitest';
import { check } from './checker.js';
import type { CheckerOutput } from './checker.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import { createPrelude } from '../prelude/prelude.js';
import { resolveType } from './types.js';
import type { Type, PrimitiveType } from './types.js';
import type { Program, LetDeclaration } from '../parser/ast.js';

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
  const output = check({
    ast,
    imports: new Map(),
    prelude,
    diagnostics,
  });
  return { output, diagnostics };
}

function checkSourceWithImports(
  source: string,
  imports: Map<string, import('./types.js').ExportedTypeSignature>,
): { output: CheckerOutput; diagnostics: DiagnosticCollectorImpl } {
  const { ast, diagnostics } = parseSource(source);
  const prelude = createPrelude();
  const output = check({ ast, imports, prelude, diagnostics });
  return { output, diagnostics };
}

function getExprType(source: string): Type | undefined {
  const { output } = checkSource(source);
  for (let i = output.typedAST.body.length - 1; i >= 0; i--) {
    const item = output.typedAST.body[i];
    if (item.kind === 'LetDeclaration') {
      const decl = item as LetDeclaration;
      if ('resolvedType' in decl.initializer) {
        return (decl.initializer as unknown as { resolvedType?: Type }).resolvedType;
      }
    }
  }
  return undefined;
}

function getResolvedType(source: string): Type | undefined {
  const { output } = checkSource(source);
  const firstDecl = output.typedAST.body[0];
  if (firstDecl && 'resolvedType' in firstDecl) {
    return (firstDecl as unknown as { resolvedType?: Type }).resolvedType;
  }
  return undefined;
}

function expectNoErrors(source: string): CheckerOutput {
  const { output, diagnostics } = checkSource(source);
  const errors = diagnostics.getErrors();
  if (errors.length > 0) {
    throw new Error(`Expected no errors but got:\n${errors.map(e => `  ${e.code}: ${e.message}`).join('\n')}`);
  }
  return output;
}

function expectErrors(source: string, ...codes: string[]): void {
  const { diagnostics } = checkSource(source);
  const errorCodes = diagnostics.getErrors().map(e => e.code);
  for (const code of codes) {
    expect(errorCodes).toContain(code);
  }
}

// ── Bigint Happy Path ────────────────────────────────────────────────

describe('bigint type checking — happy path', () => {
  it('let x: bigint = 42n — no errors, type is bigint', () => {
    const output = expectNoErrors('let x: bigint = 42n');
    const decl = output.typedAST.body[0] as LetDeclaration;
    const t = resolveType(decl.resolvedType!);
    expect(t.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('bigint');
  });

  it('let x = 42n — inferred type is bigint', () => {
    const t = getExprType('let x = 42n');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('bigint');
  });

  it('bigint + bigint => bigint', () => {
    const t = getExprType('let a: bigint = 10n\nlet b: bigint = 20n\nlet c = a + b');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('bigint - bigint => bigint', () => {
    const t = getExprType('let a: bigint = 10n\nlet b = a - 5n');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('bigint * bigint => bigint', () => {
    const t = getExprType('let a: bigint = 10n\nlet b = a * 2n');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('bigint / bigint => bigint', () => {
    const t = getExprType('let a: bigint = 10n\nlet b = a / 3n');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('bigint % bigint => bigint', () => {
    const t = getExprType('let a: bigint = 10n\nlet b = a % 3n');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('unary -42n => bigint', () => {
    const t = getExprType('let x = -42n');
    expect(t).toBeDefined();
    const resolved = resolveType(t!);
    expect(resolved.kind).toBe('primitive');
    expect((resolved as PrimitiveType).name).toBe('bigint');
  });

  it('nullable bigint: let x: bigint? = null', () => {
    expectNoErrors('let x: bigint? = null');
  });

  it('bigint assignable to bigint?: let x: bigint? = 42n', () => {
    expectNoErrors('let x: bigint? = 42n');
  });

  it('var x = 42n — mutable bigint is bigint', () => {
    const output = expectNoErrors('var x = 42n');
    const decl = output.typedAST.body[0] as LetDeclaration;
    const t = resolveType(decl.resolvedType!);
    expect(t.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('bigint');
  });

  it('bigint > bigint => boolean', () => {
    expectNoErrors('let a: bigint = 10n\nlet b: bigint = 5n\nlet c = a > b');
  });

  it('bigint == bigint => boolean', () => {
    expectNoErrors('let a: bigint = 10n\nlet b: bigint = 10n\nlet c = a == b');
  });

  it('bigint != bigint => boolean', () => {
    expectNoErrors('let a: bigint = 10n\nlet b: bigint = 5n\nlet c = a != b');
  });
});

// ── Bigint Error Cases ───────────────────────────────────────────────

describe('bigint type checking — error cases', () => {
  it('number not assignable to bigint (E200)', () => {
    expectErrors('let x: bigint = 42', 'E200');
  });

  it('bigint not assignable to number (E200)', () => {
    expectErrors('let x: number = 42n', 'E200');
  });

  it('mixed bigint + number arithmetic (E216)', () => {
    expectErrors('let a: bigint = 10n\nlet b: number = 5\nlet c = a + b', 'E216');
  });

  it('mixed number + bigint arithmetic (E216)', () => {
    expectErrors('let a: number = 10\nlet b: bigint = 5n\nlet c = a + b', 'E216');
  });

  it('string + bigint (E216)', () => {
    expectErrors('let a: bigint = 10n\nlet b = "hello" + a', 'E216');
  });

  it('!bigint (E216)', () => {
    expectErrors('let a: bigint = 10n\nlet b = !a', 'E216');
  });

  it('!symbol (E216)', () => {
    // Use imports to provide a symbol-typed value since Symbol() is a global
    const imports = new Map<string, import('./types.js').ExportedTypeSignature>();
    imports.set('./sym', {
      types: new Map(),
      values: new Map([['mySym', { kind: 'primitive', name: 'symbol' } as Type]]),
      adtConstructors: new Map(),
      extensions: new Map(),
    });
    const { diagnostics } = checkSourceWithImports(
      'import { mySym } from "./sym"\nlet b = !mySym',
      imports,
    );
    expect(diagnostics.getErrors().some(e => e.code === 'E216')).toBe(true);
  });
});

// ── Symbol Happy Path ────────────────────────────────────────────────

describe('symbol type checking — happy path', () => {
  it('let x: symbol — type annotation resolves via imports', () => {
    // Symbol() is a global function only available via TS interop.
    // Use imports to provide a symbol-typed value.
    const imports = new Map<string, import('./types.js').ExportedTypeSignature>();
    imports.set('./sym', {
      types: new Map(),
      values: new Map([['mySym', { kind: 'primitive', name: 'symbol' } as Type]]),
      adtConstructors: new Map(),
      extensions: new Map(),
    });
    const { output, diagnostics } = checkSourceWithImports(
      'import { mySym } from "./sym"\nlet x: symbol = mySym',
      imports,
    );
    const errors = diagnostics.getErrors();
    expect(errors.length).toBe(0);
    const decl = output.typedAST.body[1] as LetDeclaration;
    const t = resolveType(decl.resolvedType!);
    expect(t.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('symbol');
  });

  it('nullable symbol: let a: symbol? = null', () => {
    expectNoErrors('let a: symbol? = null');
  });

  it('symbol == symbol => boolean', () => {
    const imports = new Map<string, import('./types.js').ExportedTypeSignature>();
    imports.set('./sym', {
      types: new Map(),
      values: new Map([
        ['symA', { kind: 'primitive', name: 'symbol' } as Type],
        ['symB', { kind: 'primitive', name: 'symbol' } as Type],
      ]),
      adtConstructors: new Map(),
      extensions: new Map(),
    });
    const { diagnostics } = checkSourceWithImports(
      'import { symA, symB } from "./sym"\nlet c = symA == symB',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });
});

// ── Symbol Error Cases ───────────────────────────────────────────────

describe('symbol type checking — error cases', () => {
  it('number not assignable to symbol (E200)', () => {
    expectErrors('let x: symbol = 42', 'E200');
  });

  it('symbol not assignable to number (E200)', () => {
    const imports = new Map<string, import('./types.js').ExportedTypeSignature>();
    imports.set('./sym', {
      types: new Map(),
      values: new Map([['mySym', { kind: 'primitive', name: 'symbol' } as Type]]),
      adtConstructors: new Map(),
      extensions: new Map(),
    });
    const { diagnostics } = checkSourceWithImports(
      'import { mySym } from "./sym"\nlet x: number = mySym',
      imports,
    );
    expect(diagnostics.getErrors().some(e => e.code === 'E200')).toBe(true);
  });

  it('symbol < symbol — no error (permissive comparison per D9)', () => {
    const imports = new Map<string, import('./types.js').ExportedTypeSignature>();
    imports.set('./sym', {
      types: new Map(),
      values: new Map([
        ['symA', { kind: 'primitive', name: 'symbol' } as Type],
        ['symB', { kind: 'primitive', name: 'symbol' } as Type],
      ]),
      adtConstructors: new Map(),
      extensions: new Map(),
    });
    const { diagnostics } = checkSourceWithImports(
      'import { symA, symB } from "./sym"\nlet c = symA < symB',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });
});

// ── Bigint Edge Cases ────────────────────────────────────────────────

describe('bigint edge cases', () => {
  it('for range with bigint bounds (E261)', () => {
    expectErrors('for (i in 0n..10n) { }', 'E261');
  });

  it('bigint field access — E209', () => {
    expectErrors('let x: bigint = 42n\nlet s = x.toString()', 'E209');
  });

  it('bigint as boolean condition — E200', () => {
    expectErrors('if (42n) { }', 'E200');
  });

  it('mixed bigint/number comparison — no error (permissive per D3/D9)', () => {
    expectNoErrors('let a: bigint = 10n\nlet b: number = 5\nlet c = a > b');
  });

  it('template interpolation with bigint — no error', () => {
    expectNoErrors('let b: bigint = 42n\nlet s = "value: ${b}"');
  });
});
