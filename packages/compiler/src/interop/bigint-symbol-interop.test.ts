import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { TsTypeMapper } from './type-mapper.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Type, FunctionType, NullableType, PrimitiveType } from '../checker/types.js';

// ── Test Helper ─────────────────────────────────────────────

const fixturesDir = path.resolve(import.meta.dirname, '__fixtures__');

function mapFromCode(code: string): { types: Map<string, Type>; diagnostics: DiagnosticCollectorImpl } {
  const tmpFile = path.join(fixturesDir, '__tmp_bigint_symbol.d.ts');
  ts.sys.writeFile(tmpFile, code);
  try {
    const program = ts.createProgram([tmpFile], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      strict: true,
    });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(tmpFile)!;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
    const exports = checker.getExportsOfModule(moduleSymbol);
    const diagnostics = new DiagnosticCollectorImpl();
    const mapper = new TsTypeMapper(diagnostics);

    const types = new Map<string, Type>();
    for (const sym of exports) {
      const type = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
      types.set(sym.getName(), mapper.mapType(type, checker));
    }
    return { types, diagnostics };
  } finally {
    ts.sys.deleteFile!(tmpFile);
  }
}

// ── Interop Tests ────────────────────────────────────────────

describe('interop type mapper — bigint and symbol', () => {
  it('maps TS bigint type to EffectScript bigint primitive', () => {
    const { types } = mapFromCode('export declare const x: bigint;');
    const t = types.get('x');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('bigint');
  });

  it('maps TS symbol type to EffectScript symbol primitive', () => {
    const { types } = mapFromCode('export declare const s: symbol;');
    const t = types.get('s');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('symbol');
  });

  it('maps TS unique symbol type to EffectScript symbol primitive', () => {
    const { types } = mapFromCode('export declare const s: unique symbol;');
    const t = types.get('s');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('symbol');
  });

  it('maps TS bigint literal type (100n) to EffectScript bigint primitive', () => {
    const { types } = mapFromCode('export declare const x: 100n;');
    const t = types.get('x');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('primitive');
    expect((t as PrimitiveType).name).toBe('bigint');
  });

  it('maps TS bigint | null to bigint?', () => {
    const { types } = mapFromCode('export declare const x: bigint | null;');
    const t = types.get('x');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('nullable');
    expect((t as NullableType).inner.kind).toBe('primitive');
    expect(((t as NullableType).inner as PrimitiveType).name).toBe('bigint');
  });

  it('maps TS symbol | undefined to symbol?', () => {
    const { types } = mapFromCode('export declare const s: symbol | undefined;');
    const t = types.get('s');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('nullable');
    expect((t as NullableType).inner.kind).toBe('primitive');
    expect(((t as NullableType).inner as PrimitiveType).name).toBe('symbol');
  });

  it('maps TS function (x: bigint) => symbol correctly', () => {
    const { types } = mapFromCode('export declare function f(x: bigint): symbol;');
    const t = types.get('f');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('function');
    const fn = t as FunctionType;
    expect(fn.params.length).toBe(1);
    expect(fn.params[0].type.kind).toBe('primitive');
    expect((fn.params[0].type as PrimitiveType).name).toBe('bigint');
    expect(fn.returnType.kind).toBe('primitive');
    expect((fn.returnType as PrimitiveType).name).toBe('symbol');
  });

  it('does not emit W301 warnings for bigint or symbol', () => {
    const { diagnostics } = mapFromCode(
      'export declare const x: bigint; export declare const s: symbol;'
    );
    const warnings = diagnostics.getWarnings();
    const w301 = warnings.filter(w => w.code === 'W301');
    expect(w301.length).toBe(0);
  });
});
