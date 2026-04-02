import { describe, it, expect } from 'vitest';
import { JSBackend } from './js-backend.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { check } from '../checker/checker.js';
import { createPrelude } from '../prelude/prelude.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Program } from '../parser/ast.js';
import type { ExportedTypeSignature } from '../checker/types.js';

// ── Helper: compile EffectScript source through full pipeline ──

function compile(source: string): { ast: Program; js: string; dts: string; map?: string } {
  const diag = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', diag);
  const ast = parse(tokens, 'test.efs', diag);
  const prelude = createPrelude();
  const imports = new Map<string, ExportedTypeSignature>();
  const { typedAST } = check({ ast, imports, prelude, diagnostics: diag });

  if (diag.hasErrors()) {
    const errors = diag.getErrors().map(e => `${e.code}: ${e.message}`).join('\n');
    throw new Error(`Compilation failed:\n${errors}`);
  }

  const backend = new JSBackend();
  const result = backend.emit(typedAST, {
    sourceMap: true,
    filePath: 'test.efs',
    outDir: 'dist',
  });

  const jsFile = result.files.find(f => f.kind === 'js');
  const dtsFile = result.files.find(f => f.kind === 'dts');
  const mapFile = result.files.find(f => f.kind === 'sourcemap');

  return {
    ast: typedAST,
    js: jsFile?.content ?? '',
    dts: dtsFile?.content ?? '',
    map: mapFile?.content,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('JSBackend', () => {
  it('has correct name', () => {
    const backend = new JSBackend();
    expect(backend.name).toBe('javascript');
  });

  it('produces js, dts, and sourcemap files', () => {
    const backend = new JSBackend();
    const diag = new DiagnosticCollectorImpl();
    const tokens = tokenize('let x = 42', 'test.efs', diag);
    const ast = parse(tokens, 'test.efs', diag);
    const prelude = createPrelude();
    const { typedAST } = check({ ast, imports: new Map(), prelude, diagnostics: diag });

    const result = backend.emit(typedAST, {
      sourceMap: true,
      filePath: 'test.efs',
      outDir: 'dist',
    });

    expect(result.files).toHaveLength(3);
    expect(result.files.map(f => f.kind).sort()).toEqual(['dts', 'js', 'sourcemap']);
    expect(result.files.find(f => f.kind === 'js')?.path).toBe('dist/test.js');
    expect(result.files.find(f => f.kind === 'dts')?.path).toBe('dist/test.d.ts');
    expect(result.files.find(f => f.kind === 'sourcemap')?.path).toBe('dist/test.js.map');
  });

  it('skips sourcemap when disabled', () => {
    const backend = new JSBackend();
    const diag = new DiagnosticCollectorImpl();
    const tokens = tokenize('let x = 42', 'test.efs', diag);
    const ast = parse(tokens, 'test.efs', diag);
    const prelude = createPrelude();
    const { typedAST } = check({ ast, imports: new Map(), prelude, diagnostics: diag });

    const result = backend.emit(typedAST, {
      sourceMap: false,
      filePath: 'test.efs',
      outDir: 'dist',
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.find(f => f.kind === 'sourcemap')).toBeUndefined();
  });
});

describe('Integration: Full Pipeline', () => {
  // ── 1. Simple program ──
  it('compiles let binding + function + call', () => {
    const { js } = compile(`
      let add = (x: number, y: number): number => x + y
      let result = add(1, 2)
    `);
    expect(js).toContain('const add = (x, y) => x + y;');
    expect(js).toContain('const result = add(1, 2);');
  });

  // ── 2. ADT program ──
  it('compiles ADT type declaration + match', () => {
    const { js } = compile(`
      type Color = Red | Green | Blue
      let name = match Red {
        Red => "red"
        Green => "green"
        Blue => "blue"
      }
    `);
    expect(js).toContain('const Red = Object.freeze({ _tag: "Red" });');
    expect(js).toContain('const Green = Object.freeze({ _tag: "Green" });');
    expect(js).toContain('const Blue = Object.freeze({ _tag: "Blue" });');
    expect(js).toContain('._tag === "Red"');
  });

  // ── 3. Module with imports/exports — import rewriting ──
  it('compiles exports correctly', () => {
    const { js, dts } = compile(`
      export let x = 42
      export let add = (a: number, b: number): number => a + b
    `);
    expect(js).toContain('export const x = 42;');
    expect(js).toContain('export const add = (a, b) => a + b;');
    expect(dts).toContain('export declare const x: 42;');
    expect(dts).toContain('export declare const add:');
  });

  // ── 4. Prelude usage ──
  it('compiles prelude Ok/Err/attempt/print usage', () => {
    const { js } = compile(`
      print("hello")
      let result = Ok(42)
    `);
    expect(js).toContain('const Ok = (value) => ({ _tag: "Ok", value });');
    expect(js).toContain('console.log("hello");');
    expect(js).toContain('Ok(42);');
  });

  // ── 5. Multi-construct program ──
  it('compiles program with multiple constructs', () => {
    const { js } = compile(`
      let x = 42
      var y = 0
      let double = (n: number): number => n * 2
      let z = double(x)
      y = z
    `);
    expect(js).toContain('const x = 42;');
    expect(js).toContain('let y = 0;');
    expect(js).toContain('const double = (n) => n * 2;');
    expect(js).toContain('const z = double(x);');
    expect(js).toContain('y = z;');
  });

  // ── Additional: source map is valid JSON ──
  it('produces valid source map JSON', () => {
    const { map } = compile('let x = 42');
    expect(map).toBeDefined();
    const parsed = JSON.parse(map!) as Record<string, unknown>;
    expect(parsed['version']).toBe(3);
    expect(parsed['sources']).toEqual(['test.efs']);
  });

  // ── Additional: if/else expression ──
  it('compiles if/else expression', () => {
    const { js } = compile(`
      let x = 1
      let result = if (x == 1) "one" else "other"
    `);
    expect(js).toContain('x === 1 ? "one" : "other"');
  });

  // ── Additional: ADT with fields ──
  it('compiles ADT with fields', () => {
    const { js } = compile(`
      type Shape = Circle(radius: number) | Rectangle(width: number, height: number)
      let c = Circle(5)
    `);
    expect(js).toContain('const Circle = (radius) => ({ _tag: "Circle", radius });');
    expect(js).toContain('const Rectangle = (width, height) => ({ _tag: "Rectangle", width, height });');
    expect(js).toContain('Circle(5)');
  });

  // ── Additional: while loop ──
  it('compiles while loop', () => {
    const { js } = compile(`
      let condition = true
      while (condition) {
        print("hello")
      }
    `);
    expect(js).toContain('while (condition)');
    expect(js).toContain('console.log("hello");');
  });

  // ── Additional: template string ──
  it('compiles template strings', () => {
    const { js } = compile(`
      let name = "world"
      let greeting = "Hello, \${name}"
    `);
    expect(js).toContain('`Hello, ${name}`');
  });

  // ── Additional: try/catch ──
  it('compiles try/catch', () => {
    const { js } = compile(`
      try {
        print("trying")
      } catch (e) {
        print("caught")
      }
    `);
    expect(js).toContain('try {');
    expect(js).toContain('} catch (e) {');
  });

  // ── Additional: source map URL comment ──
  it('includes source map URL in JS output', () => {
    const { js } = compile('let x = 42');
    expect(js).toContain('//# sourceMappingURL=test.js.map');
  });

  // ── Additional: exported ADT ──
  it('compiles exported ADT with DTS', () => {
    const { js, dts } = compile(`
      export type Color = Red | Green | Blue
    `);
    expect(js).toContain('export const Red = Object.freeze({ _tag: "Red" });');
    expect(dts).toContain('export interface Red');
    expect(dts).toContain('export type Color = Red | Green | Blue;');
  });

  // ── Additional: for loop ──
  it('compiles for loop', () => {
    const { js } = compile(`
      let items = [1, 2, 3]
      for (item in items) {
        print(item)
      }
    `);
    expect(js).toContain('for (const item of items)');
    expect(js).toContain('console.log(item);');
  });

  // ── Additional: block expression ──
  it('compiles block expression', () => {
    const { js } = compile(`
      let x = {
        let a = 1
        let b = 2
        a + b
      }
    `);
    expect(js).toContain('(() => {');
    expect(js).toContain('return a + b;');
  });
});
