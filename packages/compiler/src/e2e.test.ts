import { describe, it, expect } from 'vitest';
import { createCompilerHost } from './host.js';
import { InMemoryFileSystem } from './filesystem.js';
import type { CompilationResult } from './host.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createFS(files: Record<string, string>): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  for (const [path, content] of Object.entries(files)) {
    fs.writeFile(path, content);
  }
  return fs;
}

async function compileFiles(
  files: Record<string, string>,
  entryPaths?: string[],
): Promise<CompilationResult> {
  const fs = createFS(files);
  const host = createCompilerHost({
    fileSystem: fs,
    compilerOptions: { outDir: '/dist', sourceMap: true },
  });
  const paths = entryPaths ?? Object.keys(files);
  return host.compile(paths);
}

function getJS(result: CompilationResult, filename: string): string | undefined {
  return result.outputFiles.find(f => f.path.endsWith(filename) && f.kind === 'js')?.content;
}

function getDTS(result: CompilationResult, filename: string): string | undefined {
  return result.outputFiles.find(f => f.path.endsWith(filename) && f.kind === 'dts')?.content;
}

function getSourceMap(result: CompilationResult, filename: string): string | undefined {
  return result.outputFiles.find(f => f.path.endsWith(filename) && f.kind === 'sourcemap')?.content;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('End-to-end integration tests', () => {
  // ── Basic: Hello World ──────────────────────────────────────────

  describe('basic single-file compilation', () => {
    it('compiles let binding and print', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let greeting = "hello, world"',
          'print(greeting)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const greeting = "hello, world"');
      expect(js).toContain('console.log(greeting)');
    });

    it('compiles function declaration and call', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let add = (a: number, b: number): number => a + b',
          'let result = add(1, 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const add = (a, b) => a + b');
      expect(js).toContain('const result = add(1, 2)');
    });

    it('compiles if/else expression', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 10',
          'let label = if (x > 5) { "big" } else { "small" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('x > 5');
    });

    it('compiles template strings', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let name = "world"',
          'let msg = "hello ${name}"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('`hello ${name}`');
    });
  });

  // ── ADT + Pattern Matching ──────────────────────────────────────

  describe('ADT and pattern matching', () => {
    it('compiles ADT definition with fieldless variants', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Color = Red | Green | Blue',
          'let c = Red',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('Object.freeze({ _tag: "Red" })');
      expect(js).toContain('Object.freeze({ _tag: "Green" })');
      expect(js).toContain('Object.freeze({ _tag: "Blue" })');
    });

    it('compiles ADT with fields and factory functions', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Shape = Circle(radius: number) | Rect(width: number, height: number)',
          'let s = Circle(5)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const Circle = (radius) => ({ _tag: "Circle", radius })');
      expect(js).toContain('const Rect = (width, height) => ({ _tag: "Rect", width, height })');
    });

    it('compiles match expression on ADT', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Color = Red | Green | Blue',
          'let c = Red',
          'let label = match c {',
          '  Red => "red"',
          '  Green => "green"',
          '  Blue => "blue"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('_tag');
    });
  });

  // ── Named Record Type Aliases ───────────────────────────────────

  describe('named record type aliases', () => {
    it('compiles record type alias (erased at runtime)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type User = { name: string, email: string }',
          'let u: User = { name: "Alice", email: "a@b.com" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Record type aliases produce no runtime code
      expect(js).not.toContain('type User');
      // Record expression emitted (possibly wrapped in parens by emitter)
      expect(js).toContain('name: "Alice"');
      expect(js).toContain('email: "a@b.com"');
    });

    it('generates DTS for exported record type alias', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Point = { x: number, y: number }',
          'let p: Point = { x: 1, y: 2 }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export type Point');
    });
  });

  // ── Multi-File Compilation ──────────────────────────────────────

  describe('multi-file compilation', () => {
    it('compiles multiple files with imports', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'export let add = (a: number, b: number): number => a + b',
          'export let PI = 3.14',
        ].join('\n'),
        '/project/main.efs': [
          'import { add, PI } from "./lib"',
          'let result = add(1, 2)',
          'let area = PI',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

      const mainJS = getJS(result, 'main.js');
      expect(mainJS).toBeDefined();
      expect(mainJS).toContain('import { add, PI } from "./lib.js"');
      expect(mainJS).toContain('const result = add(1, 2)');

      const libJS = getJS(result, 'lib.js');
      expect(libJS).toBeDefined();
      expect(libJS).toContain('export const add');
      expect(libJS).toContain('export const PI');
    });

    it('generates DTS for exported bindings', async () => {
      const result = await compileFiles({
        '/project/lib.efs': 'export let add = (a: number, b: number): number => a + b',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'lib.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const add');
    });
  });

  // ── Error Handling ──────────────────────────────────────────────

  describe('error handling constructs', () => {
    it('compiles try/catch expression', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let safe = try { 42 } catch (e) { 0 }',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('try');
      expect(js).toContain('catch');
    });

    it('compiles Result type with Ok/Err', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let good = Ok(42)',
          'let bad = Err("fail")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });
  });

  // ── Error Cases (Expected Diagnostics) ──────────────────────────

  describe('error cases', () => {
    it('reports type error for mismatched annotation', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x: number = "hello"',
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some(e => e.code === 'E200')).toBe(true);
    });

    it('reports error for undefined variable', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x = unknownVar',
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('reports error for duplicate declaration', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 1',
          'let x = 2',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E213')).toBe(true);
    });
  });

  // ── Source Maps ─────────────────────────────────────────────────

  describe('source maps', () => {
    it('generates valid source map JSON', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'print(x)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const map = getSourceMap(result, 'main.js.map');
      expect(map).toBeDefined();
      const parsed = JSON.parse(map!);
      expect(parsed.version).toBe(3);
      expect(parsed.sources).toBeDefined();
      expect(parsed.mappings).toBeDefined();
    });
  });

  // ── Loops ───────────────────────────────────────────────────────

  describe('loops and control flow', () => {
    it('compiles for-in loop', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'for (n in nums) {',
          '  print(n)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for');
    });

    it('compiles while loop', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'var i: number = 0\nwhile (i != 10) { i = i + 1 }',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('while');
    });
  });

  // ── Null Safety ─────────────────────────────────────────────────

  describe('null safety', () => {
    it('compiles nullable types and null coalescing', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: number? = null',
          'let y = x ?? 0',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('??');
    });
  });

  // ── Mutability ───────────────────────────────────────────────

  describe('mutability', () => {
    it('compiles var with reassignment', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var x = 0',
          'x = x + 1',
          'x = x + 2',
          'print(x)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('let x = 0');
      expect(js).toContain('x = x + 1');
      expect(js).toContain('x = x + 2');
    });

    it('reports error when reassigning immutable binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'x = 10',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E202')).toBe(true);
    });

    it('immutable reassignment error includes suggested fix', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'x = 10',
        ].join('\n'),
      });
      const e202 = result.diagnostics.find(d => d.code === 'E202');
      expect(e202).toBeDefined();
      expect(e202!.fix).toBeDefined();
      expect(e202!.fix!.description).toContain('var');
    });

    it('E2E: var counter compiles with JS let output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var counter = 0',
          'counter = counter + 1',
          'print(counter)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('let counter = 0;');
    });

    it('E2E: export var produces correct DTS', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export var y = "hello"',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare let y: string');
    });
  });

  // ── Functions ────────────────────────────────────────────────

  describe('functions', () => {
    it('compiles higher-order function', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let apply = (f: (number) => number, x: number): number => f(x)',
          'let doubled = apply((n: number) => n * 2, 21)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const apply = (f, x) => f(x)');
    });

    it('compiles non-recursive function with block body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let abs = (n: number): number => {',
          '  if (n < 0) { 0 - n } else { n }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('compiles function with default parameter', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let greet = (name: string = "world"): string => "hello ${name}"',
          'let a = greet("Alice")',
          'let b = greet()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('= "world"');
    });

    it('compiles function passed as argument', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let applyTwice = (f: (number) => number, x: number): number => f(f(x))',
          'let inc = (n: number): number => n + 1',
          'let result = applyTwice(inc, 5)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('f(f(x))');
    });

    it('compiles closure capturing outer variable', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let multiplier = 3',
          'let mul = (x: number): number => x * multiplier',
          'let result = mul(10)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('x * multiplier');
    });

    it('compiles multi-line function with block body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let compute = (a: number, b: number): number => {',
          '  let sum = a + b',
          '  let product = a * b',
          '  sum + product',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });
  });

  // ── Expressions as Values ────────────────────────────────────

  describe('expressions as values', () => {
    it('compiles block expression returning last value', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let result = {',
          '  let a = 10',
          '  let b = 20',
          '  a + b',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles if/else as expression in let binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 5',
          'let sign = if (x > 0) { "positive" } else { if (x < 0) { "negative" } else { "zero" } }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles match as expression in let binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Dir = Up | Down | Left | Right',
          'let d = Up',
          'let dx = match d {',
          '  Up => 0',
          '  Down => 0',
          '  Left => -1',
          '  Right => 1',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('compiles try/catch as expression in let binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let safe = try {',
          '  let x = 42',
          '  x',
          '} catch (e) {',
          '  0',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('try');
      expect(js).toContain('catch');
    });
  });

  // ── Pattern Matching (Extended) ──────────────────────────────

  describe('pattern matching (extended)', () => {
    it('matches literal number patterns', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let describe = (n: number): string => {',
          '  match n {',
          '    0 => "zero"',
          '    1 => "one"',
          '    _ => "other"',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('matches string literal patterns', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let respond = (cmd: string): string => {',
          '  match cmd {',
          '    "hello" => "hi there"',
          '    "bye" => "goodbye"',
          '    _ => "unknown"',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('matches boolean literal patterns', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let label = (b: boolean): string => {',
          '  match b {',
          '    true => "yes"',
          '    false => "no"',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles match with guard clauses', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let classify = (n: number): string => {',
          '  match n {',
          '    0 => "zero"',
          '    n if n > 0 => "positive"',
          '    _ => "negative"',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('compiles match with wildcard pattern', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'let label = match x {',
          '  _ => "anything"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles ADT match with field destructuring', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Shape = Circle(radius: number) | Rect(w: number, h: number)',
          'let s = Circle(5)',
          'let area = match s {',
          '  Circle(r) => 3.14 * r * r',
          '  Rect(w, h) => w * h',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('compiles match on nullable type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: string? = null',
          'let label = match x {',
          '  null => "nothing"',
          '  s => "got ${s}"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('reports non-exhaustive match error', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Color = Red | Green | Blue',
          'let c = Red',
          'let label = match c {',
          '  Red => "red"',
          '  Green => "green"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E203')).toBe(true);
    });

    it('non-exhaustive match error includes suggested fix listing missing patterns', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Color = Red | Green | Blue',
          'let c = Red',
          'let label = match c {',
          '  Red => "red"',
          '}',
        ].join('\n'),
      });
      const e203 = result.diagnostics.find(d => d.code === 'E203');
      expect(e203).toBeDefined();
      expect(e203!.fix).toBeDefined();
    });
  });

  // ── Null Safety (Extended) ───────────────────────────────────

  describe('null safety (extended)', () => {
    it('compiles optional chaining', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: string? = "hello"',
          'let len = x?.length',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('?.');
    });

    it('compiles null narrowing in if condition', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: string? = "hello"',
          'if (x != null) {',
          '  print(x)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('reports error accessing nullable without check', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: number? = null',
          'let y: number = x',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E200')).toBe(true);
    });

    it('compiles combined null coalescing and optional chaining', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let name: string? = null',
          'let len = name?.length ?? 0',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('?.');
      expect(js).toContain('??');
    });
  });

  // ── Operators ────────────────────────────────────────────────

  describe('operators', () => {
    it('compiles arithmetic operators', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a = 10 + 5',
          'let b = 10 - 5',
          'let c = 10 * 5',
          'let d = 10 / 5',
          'let e = 10 % 3',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('10 + 5');
      expect(js).toContain('10 - 5');
      expect(js).toContain('10 * 5');
      expect(js).toContain('10 / 5');
      expect(js).toContain('10 % 3');
    });

    it('compiles comparison operators with === and !==', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a = 1 == 1',
          'let b = 1 != 2',
          'let c = 1 < 2',
          'let d = 2 > 1',
          'let e = 1 <= 2',
          'let f = 2 >= 1',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('===');
      expect(js).toContain('!==');
    });

    it('compiles logical operators', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a = true && false',
          'let b = true || false',
          'let c = !true',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('&&');
      expect(js).toContain('||');
      expect(js).toContain('!');
    });

    it('compiles unary negation', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 5',
          'let y = -x',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('-x');
    });

    it('reports error for mixed ?? and || without parentheses', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: number? = null',
          'let y = x ?? 0 || 1',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E117')).toBe(true);
    });
  });

  // ── String Features ──────────────────────────────────────────

  describe('string features', () => {
    it('compiles complex template string interpolation', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let firstName = "Alice"',
          'let age = 30',
          'let msg = "Name: ${firstName}, Age: ${age}"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('`Name: ${firstName}, Age: ${age}`');
    });

    it('compiles string method calls', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = "hello world"',
          'let upper = s.toUpperCase()',
          'let trimmed = s.trim()',
          'let hasHello = s.includes("hello")',
          'let parts = s.split(" ")',
          'let len = s.length',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.toUpperCase()');
      expect(js).toContain('.trim()');
      expect(js).toContain('.includes("hello")');
      expect(js).toContain('.split(" ")');
      expect(js).toContain('.length');
    });

    it('compiles string with no interpolation as plain string', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let s = "plain string"',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('"plain string"');
    });
  });

  // ── Array Features ───────────────────────────────────────────

  describe('array features', () => {
    it('compiles array literal and access', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let first = nums.at(0)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('[1, 2, 3]');
    });

    it('compiles array map method', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let doubled = nums.map((n: number) => n * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.map(');
    });

    it('compiles array filter method', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3, 4, 5]',
          'let evens = nums.filter((n: number) => n % 2 == 0)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.filter(');
    });

    it('compiles array forEach method', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'nums.forEach((n: number) => print(n))',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.forEach(');
    });

    it('compiles array includes and length', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let has2 = nums.includes(2)',
          'let len = nums.length',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.includes(2)');
      expect(js).toContain('.length');
    });

    it('compiles array push on mutable binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = [1, 2]',
          'items.push(3)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.push(3)');
    });

    it('compiles array with initial elements', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = [10, 20, 30]',
          'let first = items.at(0)',
          'let len = items.length',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('[10, 20, 30]');
    });
  });

  // ── ADT Features (Extended) ──────────────────────────────────

  describe('ADT features (extended)', () => {
    it('compiles ADT with multiple fielded variants', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Expr = Lit(value: number) | BinOp(op: string, left: number, right: number)',
          'let x = Lit(42)',
          'let y = BinOp("+", 1, 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('_tag: "Lit"');
      expect(js).toContain('_tag: "BinOp"');
    });

    it('compiles prelude Result with match', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let r = Ok(42)',
          'let value = match r {',
          '  Ok(v) => v',
          '  Err(e) => 0',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles attempt function', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let result = attempt(() => 42)',
          'let value = match result {',
          '  Ok(v) => v',
          '  Err(e) => 0',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('generates DTS for exported ADT', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Shape = Circle(radius: number) | Rect(w: number, h: number)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('_tag');
      expect(dts).toContain('Circle');
      expect(dts).toContain('Rect');
    });

    it('compiles ADT with mixed fieldless and fielded variants', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Token = Number(value: number) | Plus | Minus | EOF',
          'let t = Number(42)',
          'let p = Plus',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Fielded variant -> factory function
      expect(js).toContain('const Number = (value) =>');
      // Fieldless variants -> frozen objects
      expect(js).toContain('Object.freeze({ _tag: "Plus" })');
      expect(js).toContain('Object.freeze({ _tag: "Minus" })');
      expect(js).toContain('Object.freeze({ _tag: "EOF" })');
    });
  });

  // ── Multi-File (Extended) ────────────────────────────────────

  describe('multi-file compilation (extended)', () => {
    it('compiles re-exports', async () => {
      const result = await compileFiles({
        '/project/math.efs': 'export let add = (a: number, b: number): number => a + b',
        '/project/index.efs': 'export { add } from "./math"',
        '/project/main.efs': [
          'import { add } from "./index"',
          'let result = add(1, 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const indexJS = getJS(result, 'index.js');
      expect(indexJS).toBeDefined();
      expect(indexJS).toContain('export');
    });

    it('compiles cross-file ADT usage', async () => {
      const result = await compileFiles({
        '/project/types.efs': [
          'export type Color = Red | Green | Blue',
        ].join('\n'),
        '/project/main.efs': [
          'import { Color, Red, Green, Blue } from "./types"',
          'let c = Red',
          'let label = match c {',
          '  Red => "red"',
          '  Green => "green"',
          '  Blue => "blue"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles diamond import pattern (A imports B and C, both import D)', async () => {
      const result = await compileFiles({
        '/project/base.efs': 'export let BASE = 100',
        '/project/left.efs': [
          'import { BASE } from "./base"',
          'export let leftVal = BASE + 1',
        ].join('\n'),
        '/project/right.efs': [
          'import { BASE } from "./base"',
          'export let rightVal = BASE + 2',
        ].join('\n'),
        '/project/main.efs': [
          'import { leftVal } from "./left"',
          'import { rightVal } from "./right"',
          'let total = leftVal + rightVal',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('reports error for circular imports', async () => {
      const result = await compileFiles({
        '/project/a.efs': [
          'import { b } from "./b"',
          'export let a = 1',
        ].join('\n'),
        '/project/b.efs': [
          'import { a } from "./a"',
          'export let b = 2',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E501')).toBe(true);
    });

    it('reports error for unresolved module', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'import { foo } from "./nonexistent"',
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E500')).toBe(true);
    });

    it('compiles three-file chain (A -> B -> C)', async () => {
      const result = await compileFiles({
        '/project/c.efs': 'export let VALUE = 42',
        '/project/b.efs': [
          'import { VALUE } from "./c"',
          'export let doubled = VALUE * 2',
        ].join('\n'),
        '/project/a.efs': [
          'import { doubled } from "./b"',
          'let result = doubled + 1',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('generates DTS for all exported files', async () => {
      const result = await compileFiles({
        '/project/math.efs': [
          'export let add = (a: number, b: number): number => a + b',
          'export let PI = 3.14',
        ].join('\n'),
        '/project/types.efs': [
          'export type Color = Red | Green | Blue',
        ].join('\n'),
      });
      expect(result.success).toBe(true);

      const mathDTS = getDTS(result, 'math.d.ts');
      expect(mathDTS).toBeDefined();
      expect(mathDTS).toContain('export declare const add');
      expect(mathDTS).toContain('export declare const PI');

      const typesDTS = getDTS(result, 'types.d.ts');
      expect(typesDTS).toBeDefined();
      expect(typesDTS).toContain('Color');
    });
  });

  // ── Error Diagnostics (Extended) ─────────────────────────────

  describe('error diagnostics (extended)', () => {
    it('rejects pipe operator |> with a parse error (removed in v0.2)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let double = (n: number): number => n * 2',
          'let x = 5 |> double',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
    });

    it('reports type mismatch in function argument', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let add = (a: number, b: number): number => a + b',
          'let result = add("hello", 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
    });

    it('reports type mismatch in return type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (x: number): string => x',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E200')).toBe(true);
    });

    it('reports error for accessing property on non-record type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'let y = x.foo',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
    });

    it('reports multiple errors in a single file', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: number = "hello"',
          'let y: string = 42',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });

    it('reports error for prelude shadowing with W203 warning', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let print = 42',
      });
      expect(result.diagnostics.some(d => d.code === 'W203')).toBe(true);
    });

    it('W203 prelude shadowing includes suggested fix', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let print = 42',
      });
      const w203 = result.diagnostics.find(d => d.code === 'W203');
      expect(w203).toBeDefined();
      expect(w203!.fix).toBeDefined();
    });

    it('diagnostics include file path and span', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x: number = "hello"',
      });
      const error = result.diagnostics.find(d => d.severity === 'error');
      expect(error).toBeDefined();
      expect(error!.span).toBeDefined();
      expect(error!.span.file).toBe('/project/main.efs');
    });

    it('errors in one file do not block compilation of independent files', async () => {
      const result = await compileFiles({
        '/project/good.efs': 'export let x = 42',
        '/project/bad.efs': 'let y: number = "oops"',
      });
      // Overall failure because of the bad file
      expect(result.success).toBe(false);
      // But the good file should still produce output
      const goodJS = getJS(result, 'good.js');
      expect(goodJS).toBeDefined();
    });
  });

  // ── Record Types (Extended) ──────────────────────────────────

  describe('record types (extended)', () => {
    it('compiles record expression with shorthand syntax', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let name = "Alice"',
          'let age = 30',
          'let user = { name, age }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('name');
      expect(js).toContain('age');
    });

    it('compiles nested record type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Address = { street: string, city: string }',
          'type Person = { name: string, addr: Address }',
          'let a: Address = { street: "123 Main", city: "Springfield" }',
          'let p: Person = { name: "Alice", addr: a }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles record field access', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let user = { name: "Alice", age: 30 }',
          'let n = user.name',
          'let a = user.age',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('user.name');
      expect(js).toContain('user.age');
    });
  });

  // ── DTS Generation (Extended) ────────────────────────────────

  describe('DTS generation (extended)', () => {
    it('generates DTS for exported function with types', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'export let greet = (name: string): string => "hello ${name}"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'lib.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const greet');
      expect(dts).toContain('string');
    });

    it('generates DTS for exported constant', async () => {
      const result = await compileFiles({
        '/project/lib.efs': 'export let VERSION = "1.0.0"',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'lib.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const VERSION');
    });

    it('does not emit DTS for non-exported bindings', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'let internal = 42',
          'export let public = internal',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'lib.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('public');
      expect(dts).not.toContain('internal');
    });

    it('generates DTS for ADT with fields', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'export type Shape = Circle(radius: number) | Square(side: number)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'lib.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Circle');
      expect(dts).toContain('Square');
      expect(dts).toContain('Shape');
    });
  });

  // ── Return Keyword ───────────────────────────────────────────

  describe('return keyword', () => {
    it('compiles early return from function', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let abs = (n: number): number => {',
          '  if (n < 0) {',
          '    return -n',
          '  }',
          '  n',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('return');
    });

    it('compiles return as statement in block', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let check = (n: number): string => {',
          '  if (n > 0) {',
          '    return "positive"',
          '  }',
          '  "non-positive"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('return');
    });
  });

  // ── Loops (Extended) ─────────────────────────────────────────

  describe('loops (extended)', () => {
    it('compiles for-in loop with array method result', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3, 4, 5]',
          'let evens = nums.filter((n: number) => n % 2 == 0)',
          'for (n in evens) {',
          '  print(n)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles while loop with mutable counter', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var sum = 0',
          'var i = 1',
          'while (i <= 10) {',
          '  sum = sum + i',
          '  i = i + 1',
          '}',
          'print(sum)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('while');
      expect(js).toContain('sum = sum + i');
    });

    it('compiles nested loops', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let rows = [1, 2, 3]',
          'let cols = [4, 5, 6]',
          'for (r in rows) {',
          '  for (c in cols) {',
          '    print(r + c)',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });
  });

  // ── Source Maps (Extended) ───────────────────────────────────

  describe('source maps (extended)', () => {
    it('JS output includes sourceMappingURL comment', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x = 42',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('//# sourceMappingURL=');
    });

    it('source map references the original .efs file', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x = 42',
      });
      expect(result.success).toBe(true);
      const map = getSourceMap(result, 'main.js.map');
      expect(map).toBeDefined();
      const parsed = JSON.parse(map!);
      expect(parsed.sources.some((s: string) => s.includes('main.efs'))).toBe(true);
    });

    it('generates source maps for multi-file compilation', async () => {
      const result = await compileFiles({
        '/project/lib.efs': 'export let x = 42',
        '/project/main.efs': [
          'import { x } from "./lib"',
          'print(x)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(getSourceMap(result, 'lib.js.map')).toBeDefined();
      expect(getSourceMap(result, 'main.js.map')).toBeDefined();
    });
  });

  // ── Compiler Host API ────────────────────────────────────────

  describe('compiler host API', () => {
    it('check() validates without emitting files', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      // check() returns Diagnostic[] — empty means success
      const diagnostics = await host.check(['/project/main.efs']);
      expect(diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('check() reports errors without emitting', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x: number = "oops"',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      // check() returns Diagnostic[] — errors present means failure
      const diagnostics = await host.check(['/project/main.efs']);
      const errors = diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('fires diagnostic events during compilation', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x: number = "oops"',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      const diagnostics: Diagnostic[] = [];
      host.on('diagnostic', (d) => diagnostics.push(d));
      await host.compile(['/project/main.efs']);
      expect(diagnostics.length).toBeGreaterThan(0);
    });

    it('fires fileCompiled events for successful files', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      const compiledFiles: string[] = [];
      host.on('fileCompiled', (path) => compiledFiles.push(path));
      await host.compile(['/project/main.efs']);
      expect(compiledFiles.length).toBeGreaterThan(0);
    });

    it('provides compilation stats', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      await host.compile(['/project/main.efs']);
      const stats = host.getStats();
      expect(stats).toBeDefined();
    });

    it('provides compilation timings', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      await host.compile(['/project/main.efs']);
      const timings = host.getTimings();
      expect(timings).toBeDefined();
    });

    it('exposes module graph after compilation', async () => {
      const fs = createFS({
        '/project/lib.efs': 'export let x = 42',
        '/project/main.efs': [
          'import { x } from "./lib"',
          'print(x)',
        ].join('\n'),
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      await host.compile(['/project/lib.efs', '/project/main.efs']);
      const graph = host.getModuleGraph();
      expect(graph).toBeDefined();
    });

    it('caches AST after compilation', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });
      await host.compile(['/project/main.efs']);
      const ast = host.getAST('/project/main.efs');
      expect(ast).toBeDefined();
    });

    it('supports multiple sequential compilations', async () => {
      const fs = createFS({
        '/project/main.efs': 'let x = 42',
      });
      const host = createCompilerHost({
        fileSystem: fs,
        compilerOptions: { outDir: '/dist', sourceMap: false },
      });

      const result1 = await host.compile(['/project/main.efs']);
      expect(result1.success).toBe(true);

      // Modify the file
      fs.writeFile('/project/main.efs', 'let y = "hello"');
      const result2 = await host.compile(['/project/main.efs']);
      expect(result2.success).toBe(true);

      const js = getJS(result2, 'main.js');
      expect(js).toContain('hello');
    });
  });

  // ── Complex Programs ─────────────────────────────────────────

  describe('complex programs', () => {
    it('compiles ADT with multiple variants and match', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Animal = Dog(name: string) | Cat(name: string) | Fish',
          'let a = Dog("Rex")',
          'let sound = match a {',
          '  Dog(n) => "woof from ${n}"',
          '  Cat(n) => "meow from ${n}"',
          '  Fish => "..."',
          '}',
          'print(sound)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('compiles a program using multiple features together', async () => {
      const result = await compileFiles({
        '/project/utils.efs': [
          'export let double = (n: number): number => n * 2',
          'export let isPositive = (n: number): boolean => n > 0',
        ].join('\n'),
        '/project/main.efs': [
          'import { double, isPositive } from "./utils"',
          'let nums = [1, -2, 3, -4, 5]',
          'let positives = nums.filter((n: number) => isPositive(n))',
          'let doubled = positives.map((n: number) => double(n))',
          'for (n in doubled) {',
          '  print(n)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('compiles a multi-file program with ADTs and pattern matching', async () => {
      const result = await compileFiles({
        '/project/shapes.efs': [
          'export type Shape = Circle(radius: number) | Rect(w: number, h: number)',
        ].join('\n'),
        '/project/main.efs': [
          'import { Shape, Circle, Rect } from "./shapes"',
          'let s = Circle(5)',
          'let area = match s {',
          '  Circle(r) => 3.14 * r * r',
          '  Rect(w, h) => w * h',
          '}',
          'print(area)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('compiles state machine pattern', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type State = Idle | Loading | Done(result: string) | Failed(error: string)',
          'let describe = (s: State): string => {',
          '  match s {',
          '    Idle => "waiting"',
          '    Loading => "loading..."',
          '    Done(r) => "done: ${r}"',
          '    Failed(e) => "error: ${e}"',
          '  }',
          '}',
          'let s1 = Idle',
          'let s2 = Loading',
          'let s3 = Done("data")',
          'let s4 = Failed("timeout")',
          'print(describe(s1))',
          'print(describe(s2))',
          'print(describe(s3))',
          'print(describe(s4))',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('compiles program with null coalescing pipeline', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let name: string? = null',
          'let greeting = name ?? "stranger"',
          'let msg = "Hello, ${greeting}!"',
          'print(msg)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('compiles program with Ok/Err pattern matching', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let r = Ok(42)',
          'let answer = match r {',
          '  Ok(v) => "got ${v}"',
          '  Err(e) => "error"',
          '}',
          'print(answer)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });
  });

  // ── Output File Structure ────────────────────────────────────

  describe('output file structure', () => {
    it('produces JS, DTS, and source map for a single file', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export let x = 42',
      });
      expect(result.success).toBe(true);

      const jsFiles = result.outputFiles.filter(f => f.kind === 'js');
      const dtsFiles = result.outputFiles.filter(f => f.kind === 'dts');
      const mapFiles = result.outputFiles.filter(f => f.kind === 'sourcemap');

      expect(jsFiles).toHaveLength(1);
      expect(dtsFiles).toHaveLength(1);
      expect(mapFiles).toHaveLength(1);

      expect(jsFiles[0].path).toContain('main.js');
      expect(dtsFiles[0].path).toContain('main.d.ts');
      expect(mapFiles[0].path).toContain('main.js.map');
    });

    it('output files use the configured outDir', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export let x = 42',
      });
      expect(result.success).toBe(true);
      for (const file of result.outputFiles) {
        expect(file.path).toMatch(/^\/dist\//);
      }
    });

    it('produces output files for each source file', async () => {
      const result = await compileFiles({
        '/project/a.efs': 'export let a = 1',
        '/project/b.efs': 'export let b = 2',
        '/project/c.efs': 'export let c = 3',
      });
      expect(result.success).toBe(true);

      const jsFiles = result.outputFiles.filter(f => f.kind === 'js');
      expect(jsFiles).toHaveLength(3);
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('compiles empty block expression', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 42',
          'print(x)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles deeply nested if/else', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = 5',
          'let label = if (x > 10) { "big" } else { if (x > 5) { "medium" } else { if (x > 0) { "small" } else { "zero" } } }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles function with many parameters', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: number, c: number, d: number, e: number): number => a + b + c + d + e',
          'let result = f(1, 2, 3, 4, 5)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles boolean expressions in conditions', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a = true',
          'let b = false',
          'let c = a && b || !a',
          'if (c) { print("yes") }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles string with special characters', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = "line1\\nline2\\ttab"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles large array literal', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
          'let len = nums.length',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles negative number literals', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x = -42',
          'let y = -3.14',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('compiles chained method calls', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = "  Hello World  "',
          'let result = s.trim().toLowerCase()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('.trim()');
      expect(js).toContain('.toLowerCase()');
    });
  });

  // ── Bug Fix Regression Tests ──────────────────────────────────────

  describe('bug fix regressions', () => {
    // Issue 3: union/nullable assignability
    it('string | null assignable to string? (nullable return from if/else)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let find = (x: number): string? => {',
          '  if (x == 1) { "yes" } else { null }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    // Issue 6: return statement type propagation
    it('return statement propagates type as block result', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (x: number): number => {',
          '  return x + 1',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    // Issue 1: generic type params in arrow functions
    it('generic identity function compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let identity = <T>(x: T): T => x',
          'let n = identity(42)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('generic wrap function compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let wrap = <T>(x: T): Array<T> => [x]',
          'let items = wrap(42)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    // Issue 2: recursive bindings without let-level annotation
    it('recursive factorial with inline arrow types compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let factorial = (n: number): number => {',
          '  if (n == 0) { 1 } else { n * factorial(n - 1) }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('factorial');
    });

    it('recursive fibonacci with inline arrow types compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let fib = (n: number): number => {',
          '  if (n == 0) { 0 } else { if (n == 1) { 1 } else { fib(n - 1) + fib(n - 2) } }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    // Issue 5: ADT variant union simplification (Result)
    it('Result return from if/else with Ok/Err branches compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let divide = (a: number, b: number): Result<number, string> => {',
          '  if (b == 0) { Err("division by zero") } else { Ok(a / b) }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('Result used in match after Ok/Err construction', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let safeDivide = (a: number, b: number): Result<number, string> => {',
          '  if (b == 0) { Err("cannot divide by zero") } else { Ok(a / b) }',
          '}',
          'let r = safeDivide(10, 2)',
          'let msg = match (r) {',
          '  Ok(n) => "got a number"',
          '  Err(e) => e',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });
  });

  // ── Collection Types: Codegen Tests ───────────────────────────

  describe('collection type codegen', () => {
    // ── Set codegen (7 tests) ──────────────────────────────

    it('Set.of(...) compiles to new Set(...)', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let s = Set.of(["a", "b", "c"])',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Set(["a", "b", "c"])');
    });

    it('s.has(x) compiles to s.has(x) (passthrough)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string> = Set.of(["a", "b"])',
          'let r = s.has("a")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('s.has("a")');
    });

    it('s.add(x) compiles to s.add(x) (passthrough)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var s: Set<string> = Set.of(["a"])',
          's.add("b")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('s.add("b")');
    });

    it('s.toArray() compiles to Array.from(s)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string> = Set.of(["a", "b"])',
          'let arr = s.toArray()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(s)');
    });

    it('s.map(fn) compiles to new Set(Array.from(s).map(fn))', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<number> = Set.of([1, 2, 3])',
          'let doubled = s.map((n: number): number => n * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Set(Array.from(s).map(');
    });

    it('s.union(other) compiles to new Set([...s, ...other])', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s1: Set<string> = Set.of(["a"])',
          'let s2: Set<string> = Set.of(["b"])',
          'let merged = s1.union(s2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Set([...s1, ...s2])');
    });

    it('s.intersect(other) compiles to filtered Set', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s1: Set<string> = Set.of(["a", "b"])',
          'let s2: Set<string> = Set.of(["b", "c"])',
          'let common = s1.intersect(s2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Set(Array.from(s1).filter((__el) => s2.has(__el)))');
    });

    // ── Map codegen (9 tests) ──────────────────────────────

    it('Map.of(...) compiles to new Map(...)', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let m = Map.of()',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Map()');
    });

    it('m.get(key) compiles to m.get(key) ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let v = m.get("alice")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m.get("alice") ?? null');
    });

    it('m.get(key) on Map<string, number?> still emits ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number?> = Map.of()',
          'let v = m.get("key")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m.get("key") ?? null');
    });

    it('m.set(k, v) compiles to m.set(k, v) (passthrough)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var m: Map<string, number> = Map.of()',
          'm.set("alice", 100)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m.set("alice", 100)');
    });

    it('m.keys() compiles to Array.from(m.keys())', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let k = m.keys()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(m.keys())');
    });

    it('m.values() compiles to Array.from(m.values())', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let v = m.values()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(m.values())');
    });

    it('m.entries() compiles to Array.from(m.entries())', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let e = m.entries()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(m.entries())');
    });

    it('m.forEach(fn) compiles to m.forEach(fn) (passthrough)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'm.forEach((v: number, k: string): void => print(k))',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m.forEach(');
    });

    it('m.map(fn) compiles to new Map(Array.from(m.entries()).map(...))', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let doubled = m.map((v: number, k: string): number => v * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Map(Array.from(m.entries()).map(([__k, __v]) => [__k, (');
    });

    // ── New Array codegen (9 tests) ────────────────────────

    it('arr.first() compiles to arr[0] ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let f = nums.first()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums[0] ?? null');
    });

    it('arr.last() compiles to arr.at(-1) ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let l = nums.last()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.at(-1) ?? null');
    });

    it('getItems().first() emits getItems()[0] ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getItems = (): Array<number> => [1, 2, 3]',
          'let f = getItems().first()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('getItems()[0] ?? null');
    });

    it('arr.find(fn) compiles to arr.find(fn) ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let found = nums.find((n: number): boolean => n > 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.find(');
      expect(js).toContain(') ?? null');
    });

    it('arr.reduce(fn, init) compiles as passthrough', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let sum = nums.reduce((acc: number, n: number): number => acc + n, 0)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.reduce(');
    });

    it('arr.fold(init, fn) compiles to arr.reduce(fn, init) with reordered args', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let sum = nums.fold(0, (acc: number, n: number): number => acc + n)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      // fold(init, fn) → reduce(fn, init) — args should be reordered
      expect(js).toMatch(/nums\.reduce\(.*,\s*0\)/s);
    });

    it('arr.isEmpty() compiles to arr.length === 0', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let empty = nums.isEmpty()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.length === 0');
    });

    it('arr.flatMap(fn) compiles as passthrough', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let flat = nums.flatMap((n: number): Array<number> => [n, n * 2])',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.flatMap(');
    });

    it('arr.sort(fn) compiles as passthrough', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var nums = [3, 1, 2]',
          'nums.sort((a: number, b: number): number => a - b)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.sort(');
    });

    // ── Existing Array null-fix codegen (3 tests) ──────────

    it('arr.pop() compiles to arr.pop() ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var nums = [1, 2, 3]',
          'let last = nums.pop()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.pop() ?? null');
    });

    it('arr.shift() compiles to arr.shift() ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var nums = [1, 2, 3]',
          'let first = nums.shift()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.shift() ?? null');
    });

    it('arr.at(i) compiles to arr.at(i) ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let second = nums.at(1)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.at(1) ?? null');
    });
  });

  // ── Collection Types: DTS Emission Tests ──────────────────────

  describe('collection type DTS emission', () => {
    it('exported Set<T> emits Set<T> in .d.ts', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export let names: Set<string> = Set.of(["alice"])',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Set<string>');
    });

    it('exported Map<K, V> emits Map<K, V> in .d.ts', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export let scores: Map<string, number> = Map.of()',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Map<string, number>');
    });

    it('exported function returning Set<string> emits correct .d.ts', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export let getNames = (): Set<string> => Set.of(["a"])',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Set<string>');
    });

    it('ADT variant with Set<T> field — typeUsesGeneric detects T', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Container<T> = Items(items: Set<T>) | Empty',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Set<T>');
    });

    it('ADT variant with Map<K, V> field — typeUsesGeneric detects both K and V', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Lookup<K, V> = Data(data: Map<K, V>) | Missing',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Map<K, V>');
    });
  });

  // ── Collection Types: E2E Integration Tests ───────────────────

  describe('collection type E2E integration', () => {
    it('Set creation, method calls, and output verification', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = Set.of(["a", "b", "c"])',
          'let hasA = s.has("a")',
          'let arr = s.toArray()',
          'let sz = s.size',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('new Set(["a", "b", "c"])');
      expect(js).toContain('s.has("a")');
      expect(js).toContain('Array.from(s)');
      expect(js).toContain('s.size');
    });

    it('Map creation, get with null check, output verification', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let v = m.get("alice")',
          'let exists = m.has("alice")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('new Map()');
      expect(js).toContain('m.get("alice") ?? null');
      expect(js).toContain('m.has("alice")');
    });

    it('Set-to-Array conversion pipeline', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = Set.of([1, 2, 3])',
          'let arr = s.toArray()',
          'let doubled = arr.map((n: number): number => n * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(s)');
      expect(js).toContain('.map(');
    });

    it('Map keys/values/entries extraction', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let k = m.keys()',
          'let v = m.values()',
          'let e = m.entries()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(m.keys())');
      expect(js).toContain('Array.from(m.values())');
      expect(js).toContain('Array.from(m.entries())');
    });

    it('cross-file: exported Set type used in another module', async () => {
      const result = await compileFiles({
        '/project/names.efs': [
          'export let names = Set.of(["alice", "bob"])',
        ].join('\n'),
        '/project/main.efs': [
          'import { names } from "./names"',
          'let hasAlice = names.has("alice")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('cross-file: exported Map type used in another module', async () => {
      const result = await compileFiles({
        '/project/scores.efs': [
          'export let scores: Map<string, number> = Map.of()',
        ].join('\n'),
        '/project/main.efs': [
          'import { scores } from "./scores"',
          'let v = scores.get("alice")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('complex: Array.flatMap pipeline', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let expanded = nums.flatMap((n: number): Array<number> => [n, n * 10])',
          'let s = Set.of(expanded)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.flatMap(');
      expect(js).toContain('new Set(expanded)');
    });

    it('error: type mismatch diagnostics', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string> = Set.of([1, 2, 3])',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('DTS: multi-file with Set/Map exports', async () => {
      const result = await compileFiles({
        '/project/collections.efs': [
          'export let names: Set<string> = Set.of(["a"])',
          'export let scores: Map<string, number> = Map.of()',
        ].join('\n'),
        '/project/main.efs': [
          'import { names, scores } from "./collections"',
          'let arr = names.toArray()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'collections.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Set<string>');
      expect(dts).toContain('Map<string, number>');
    });
  });

  // ── Collection Types: Edge Case Tests ─────────────────────────

  describe('collection type edge cases', () => {
    it('getItems().last() emits getItems().at(-1) ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getItems = (): Array<number> => [1, 2, 3]',
          'let l = getItems().last()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('getItems().at(-1) ?? null');
    });

    it('arr.isEmpty() emits arr.length === 0', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nums = [1, 2, 3]',
          'let empty = nums.isEmpty()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('nums.length === 0');
    });

    it('Map.map codegen uses mangled variable names (__k, __v)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number> = Map.of()',
          'let doubled = m.map((v: number, k: string): number => v * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('__k');
      expect(js).toContain('__v');
    });

    it('s.delete(x) parses correctly — delete is not an EffectScript keyword', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var s: Set<string> = Set.of(["a", "b"])',
          's.delete("a")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('s.delete("a")');
    });

    it('m.delete(key) parses correctly — delete is not an EffectScript keyword', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var m: Map<string, number> = Map.of()',
          'm.delete("alice")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m.delete("alice")');
    });

    it('for (item in s.toArray()) works — Set iteration via array conversion', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string> = Set.of(["a", "b"])',
          'for (item in s.toArray()) {',
          '  print(item)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('Array.from(s)');
    });

    it('Set<string> assignable to Set<string> | Set<number> (union assignability)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string> = Set.of(["a"])',
          'let u: Set<string> | Set<number> = s',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('Set.of([1, 2, 3]) infers s: Set<number> without explicit annotation', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s = Set.of([1, 2, 3])',
          'let hasOne = s.has(1)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('optional chaining on non-passthrough (trivial): s?.toArray()', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string>? = Set.of(["a"])',
          'let arr = s?.toArray()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('s != null ? Array.from(s) : null');
    });

    it('optional chaining on non-passthrough (non-trivial): getSet()?.toArray()', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getSet = (): Set<string>? => Set.of(["a"])',
          'let arr = getSet()?.toArray()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('((__t) => __t != null ? Array.from(__t) : null)(getSet())');
    });

    it('optional chaining on Map.get: m?.get("key")', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number>? = Map.of()',
          'let v = m?.get("key")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m != null ? m.get("key") ?? null : null');
    });

    it('double eval argument: s.intersect(getOther()) emits IIFE', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getOther = (): Set<string> => Set.of(["b"])',
          'let s: Set<string> = Set.of(["a", "b"])',
          'let common = s.intersect(getOther())',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      // Should use IIFE to avoid double evaluation of getOther()
      expect(js).toContain('((__other) =>');
      expect(js).toContain('__other.has(__el)');
      expect(js).toContain(')(getOther())');
    });

    it('double eval argument: s.difference(getOther()) emits IIFE wrapper', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getOther = (): Set<string> => Set.of(["a"])',
          'let s: Set<string> = Set.of(["a", "b"])',
          'let diff = s.difference(getOther())',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('((__other) =>');
      expect(js).toContain('!__other.has(__el)');
      expect(js).toContain(')(getOther())');
    });

    it('trivial argument: s.intersect(other) emits direct form (no IIFE)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s1: Set<string> = Set.of(["a", "b"])',
          'let s2: Set<string> = Set.of(["b", "c"])',
          'let common = s1.intersect(s2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      // Trivial arg — no IIFE, direct s2.has(__el)
      expect(js).toContain('s2.has(__el)');
      expect(js).not.toContain('__other');
    });

    it('s.filter(fn) compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<number> = Set.of([1, 2, 3, 4])',
          'let evens = s.filter((n: number): boolean => n > 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Set(Array.from(s).filter(');
    });

    it('s.difference(other) with trivial arg emits direct form', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s1: Set<string> = Set.of(["a", "b", "c"])',
          'let s2: Set<string> = Set.of(["b"])',
          'let diff = s1.difference(s2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('!s2.has(__el)');
      expect(js).not.toContain('__other');
    });

    it('nested Map<string, Set<number>> codegen with nested operations', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'var m: Map<string, Set<number>> = Map.of()',
          'm.set("primes", Set.of([2, 3, 5]))',
          'let primes = m.get("primes")',
          'let arr = primes?.toArray()',
          'let hasFive = primes?.has(5)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('new Map()');
      expect(js).toContain('m.set("primes", new Set([2, 3, 5]))');
      expect(js).toContain('m.get("primes") ?? null');
      // Optional chaining on nullable Set from Map.get
      expect(js).toContain('Array.from');
      expect(js).toContain('.has(5)');
    });

    it('Array<number?>.find(fn) codegen emits ?? null', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let arr: Array<number?> = [1, null, 3]',
          'let found = arr.find((n: number?): boolean => n != null)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('.find(') ;
      expect(js).toContain('?? null');
    });

    it('optional chaining on arr?.first() emits null guard', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let arr: Array<number>? = [1, 2, 3]',
          'let f = arr?.first()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('arr != null ?');
      expect(js).toContain('[0] ?? null');
      expect(js).toContain(': null');
    });

    it('optional chaining on arr?.isEmpty() emits null guard', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let arr: Array<number>? = [1, 2, 3]',
          'let e = arr?.isEmpty()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('arr != null ?');
      expect(js).toContain('.length === 0');
      expect(js).toContain(': null');
    });

    it('optional chaining on arr?.fold(init, fn) emits null guard', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let arr: Array<number>? = [1, 2, 3]',
          'let sum = arr?.fold(0, (acc: number, n: number): number => acc + n)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('arr != null ?');
      expect(js).toContain('.reduce(');
      expect(js).toContain(': null');
    });

    it('optional chaining on m?.map(fn) emits null guard', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let m: Map<string, number>? = Map.of()',
          'let doubled = m?.map((v: number, k: string): number => v * 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('m != null ?');
      expect(js).toContain('new Map(');
      expect(js).toContain(': null');
    });

    it('optional chaining on s?.intersect(other) emits null guard', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: Set<string>? = Set.of(["a", "b"])',
          'let other: Set<string> = Set.of(["b"])',
          'let common = s?.intersect(other)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('!= null ?');
      expect(js).toContain('.has(__el)');
      expect(js).toContain(': null');
    });
  });

  // ── Async/Await ────────────────────────────────────────────────

  describe('async/await', () => {
    it('simple async function compiles to JS async arrow', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = async (x: number): Promise<number> => x',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async (x) => x');
    });

    it('async function with block body and await', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let compute = async (n: number): Promise<number> => n * 2',
          'let f = async (x: number): Promise<number> => {',
          '  let result = await compute(x)',
          '  result + 1',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async (x) => {');
      expect(js).toContain('await compute(x)');
    });

    it('async with try/catch compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let fetchData = async (): Promise<string> => "data"',
          'let f = async (): Promise<string> => {',
          '  try {',
          '    await fetchData()',
          '  } catch (e) {',
          '    "fallback"',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async () => {');
      expect(js).toContain('await fetchData()');
    });

    it('async with for loop: sequential awaiting', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let process = async (x: string): Promise<void> => { print(x) }',
          'let f = async (items: Array<string>): Promise<void> => {',
          '  for (item in items) {',
          '    await process(item)',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await process(item)');
    });

    it('multiple async functions in one file', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a = async (): Promise<number> => 1',
          'let b = async (): Promise<string> => "hello"',
          'let c = async (): Promise<number> => {',
          '  let x = await a()',
          '  x + 1',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // All three should compile
      expect(js!.match(/async/g)!.length).toBeGreaterThanOrEqual(3);
    });

    it('DTS: async function generates Promise<T> return without async keyword', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let fetchNum = async (s: string): Promise<number> => 42',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('Promise<number>');
      expect(dts).not.toContain('async');
    });

    it('async function with Promise<void> and statement body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let log = async (msg: string): Promise<void> => {',
          '  print(msg)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async (msg) => {');
    });

    it('generic async function end-to-end', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let identity = async <T>(x: T): Promise<T> => x',
          'let f = async (): Promise<number> => {',
          '  await identity(42)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async (x) => x');
    });

    it('async + if/else with await in both branches', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let fetchA = async (): Promise<number> => 1',
          'let fetchB = async (): Promise<number> => 2',
          'let f = async (cond: boolean): Promise<number> => {',
          '  if (cond) await fetchA() else await fetchB()',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await fetchA()');
      expect(js).toContain('await fetchB()');
    });

    it('nested async functions: inner and outer both awaiting', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let outer = async (): Promise<number> => {',
          '  let inner = async (): Promise<string> => "hello"',
          '  let s = await inner()',
          '  s.length',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await inner()');
    });

    it('async function with inferred return type (no annotation)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = async (x: number) => x * 2',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('async (x) => x * 2');
    });

    it('attempt + async compiles to __attempt_async', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = async (): Promise<number> => {',
          '  let result = await attempt(async (): Promise<string> => "hello")',
          '  42',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('__attempt_async');
    });

    it('async + match expression with await in arms (async IIFE emission)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let fetchNum = async (): Promise<number> => 42',
          'let f = async (flag: boolean): Promise<number> => {',
          '  match flag {',
          '    true => await fetchNum()',
          '    false => 0',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await (async () =>');
    });

    it('async + block expression with await (async IIFE emission)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let compute = async (n: number): Promise<number> => n * 2',
          'let f = async (): Promise<number> => {',
          '  let x = {',
          '    let y = await compute(1)',
          '    y + 1',
          '  }',
          '  x',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await (async () =>');
    });

    it('async + try/catch expression with await (async IIFE emission)', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let fetchData = async (): Promise<string> => "data"',
          'let f = async (): Promise<string> => {',
          '  let result = try {',
          '    await fetchData()',
          '  } catch (e) {',
          '    "fallback"',
          '  }',
          '  result',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toContain('await (async () =>');
    });

    it('error: await outside async function → E231', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = async (): Promise<number> => 42',
          'let x = await f()',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E231')).toBe(true);
    });

    it('error: async without Promise return type → E230', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let f = async (): number => 42',
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E230')).toBe(true);
    });

    it('error: await on non-Promise type → E232', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = async (): Promise<number> => {',
          '  await 42',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E232')).toBe(true);
    });
  });

  // ── Result Generic Unification: E2E Tests ─────────────────────

  describe('Result generic unification', () => {
    it('safeDivide pattern compiles and runs correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let safeDivide = (a: number, b: number): Result<number, string> => {',
          '  if (b == 0) { Err("division by zero") } else { Ok(a / b) }',
          '}',
          'let r = safeDivide(10, 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Prelude Ok/Err compile to local factory functions
      expect(js).toContain('Ok(a / b)');
      expect(js).toContain('Err("division by zero")');
    });

    it('multi-branch Result function → correct JS output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let classify = (x: number): Result<string, string> => {',
          '  if (x > 0) { Ok("positive") } else if (x < 0) { Ok("negative") } else { Err("zero") }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Prelude Ok/Err compile to local factory functions
      expect(js).toContain('Ok("positive")');
      expect(js).toContain('Ok("negative")');
      expect(js).toContain('Err("zero")');
    });

    it('custom ADT with partial type args → compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Either<A, B> = Left(value: A) | Right(value: B)',
          'let f = (x: boolean): Either<number, string> => {',
          '  if (x) { Left(42) } else { Right("hello") }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('Result in let binding annotation → compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let r: Result<number, string> = if (true) { Ok(42) } else { Err("no") }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('nested Result-returning functions → compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let inner = (x: number): Result<number, string> => {',
          '  if (x < 0) { Err("negative") } else { Ok(x) }',
          '}',
          'let outer = (x: number): Result<string, string> => {',
          '  let r = inner(x)',
          '  match r {',
          '    Ok(n) => Ok("got it")',
          '    Err(_) => Err("forwarded")',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('cross-file: Result function imported and called', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'export let safeDivide = (a: number, b: number): Result<number, string> => {',
          '  if (b == 0) { Err("division by zero") } else { Ok(a / b) }',
          '}',
        ].join('\n'),
        '/project/main.efs': [
          'import { safeDivide } from "./lib"',
          'let r = safeDivide(10, 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('error case: wrong type in Ok → E200 diagnostic', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (): Result<number, string> => {',
          '  Ok("wrong")',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E200')).toBe(true);
    });

    it('match with Result constructors → compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (x: number): Result<string, string> => {',
          '  match x {',
          '    0 => Err("zero")',
          '    1 => Ok("one")',
          '    _ => Ok("other")',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('block body with Result return → compiles', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (x: boolean): Result<number, string> => {',
          '  let msg = "error"',
          '  if (x) { Ok(42) } else { Err(msg) }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('backward compat: existing Result patterns unchanged', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let good = Ok(42)',
          'let bad = Err("fail")',
          'let r = if (true) { Ok(1) } else { Err("no") }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });
  });

  // ── Extension Functions ──────────────────────────────────────────

  describe('extension functions', () => {
    it('extension function compiles to const with __this', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'fun string.shout(): string => this + "!"',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const string_shout = (__this) => __this + "!";');
    });

    it('extension function with parameters', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'fun number.clamp(min: number, max: number): number => {\n  if (this < min) min\n  else if (this > max) max\n  else this\n}',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const number_clamp = (__this, min, max) => {');
      expect(js).toContain('__this');
    });

    it('extension call emits as static function call', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'fun string.shout(): string => this + "!"',
          'let r = "hello".shout()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('string_shout("hello")');
    });

    it('exported extension function emits export prefix', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export fun string.shout(): string => this + "!"',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('export const string_shout = (__this) => __this + "!";');
    });

    it('exported extension function emits DTS', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export fun string.shout(): string => this + "!"',
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const string_shout: (__this: string) => string;');
    });

    it('async extension function compiles with async prefix', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'async fun string.fetch(): Promise<string> => this',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const string_fetch = async (__this) => __this;');
    });

    it('async extension function with await in body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getData = async (): Promise<string> => "data"',
          'async fun string.fetchInfo(): Promise<string> => {',
          '  let data = await getData()',
          '  data',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const string_fetchInfo = async (__this) => {');
      expect(js).toContain('await getData()');
    });

    it('exported async extension function', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'export async fun string.fetch(): Promise<string> => this',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('export const string_fetch = async (__this) => __this;');
    });

    it('async extension function with non-Promise return type is error', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'async fun string.bad(): string => this',
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter((d: Diagnostic) => d.severity === 'error');
      expect(errors.some((e: Diagnostic) => e.code === 'E230')).toBe(true);
    });

    it('chained extension calls compile correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'fun string.shout(): string => this + "!"',
          'fun string.double(): string => this + this',
          'let r = "hello".shout().double()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Inner call first, then outer
      expect(js).toContain('string_double(string_shout("hello"))');
    });

    it('async extension function define and call with await', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getData = async (): Promise<string> => "data"',
          'async fun string.fetch(): Promise<string> => await getData()',
          'let main = async (): Promise<string> => {',
          '  let body = await "hello".fetch()',
          '  body',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const string_fetch = async (__this)');
      expect(js).toContain('await string_fetch("hello")');
    });
  });

  // ── Generic Constraints E2E ───────────────────────────────────────

  describe('generic constraints', () => {
    it('E2E: define and call constrained generic function, verify JS output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getName = <T: { name: string }>(item: T): string => item.name',
          'let user = { name: "Alice", age: 30 }',
          'let result = getName(user)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Constraints are erased — JS is identical to unconstrained
      expect(js).toContain('const getName = (item) => item.name');
    });

    it('E2E: constraint violation produces E250', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let getName = <T: { name: string }>(item: T): string => item.name',
          'let result = getName(42)',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E250')).toBe(true);
    });

    it('E2E: constraint-based field access in function body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let sum = <T: { x: number, y: number }>(p: T): number => p.x + p.y',
          'let result = sum({ x: 1, y: 2 })',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('p.x + p.y');
    });

    it('E2E: extension function with constrained generic', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'fun <T: { name: string }> Array<T>.names(): Array<string> => {',
          '  this.map((item: T): string => item.name)',
          '}',
          'let users = [{ name: "Alice" }, { name: "Bob" }]',
          'let names = users.names()',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('E2E: ADT with constrained type param', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Container<T: { id: string }> = Boxed(value: T) | Empty',
          'let c = Boxed({ id: "abc", data: 42 })',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('E2E: DTS output with constraints', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let getName = <T: { name: string }>(item: T): string => item.name',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('extends');
      expect(dts).toContain('{ readonly name: string }');
    });

    it('E2E: ADT with constrained type param — DTS output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Container<T: { id: string }> = Boxed(value: T) | Empty',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('T extends { readonly id: string }');
    });

    it('E2E: intersection type in general type position', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = <T: { name: string } & { age: number }>(item: T): string => item.name',
          'let result = f({ name: "Alice", age: 30 })',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });
  });

  // ── Value Parameter Semantics ────────────────────────────────────

  describe('value parameter semantics', () => {
    it('E2E: immutable parameter function compiles and runs correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let process = (items: Array<number>): number => {',
          '  let total = items.length',
          '  total',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const process = (items) =>');
    });

    it('E2E: mutable parameter function compiles and runs correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let sortItems = (var items: Array<number>): void => {',
          '  items.sort()',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // var is erased — JS output is identical
      expect(js).toContain('const sortItems = (items) =>');
    });

    it('E2E: multi-file — imported function with var parameter can be called', async () => {
      const result = await compileFiles({
        '/project/lib.efs': [
          'export let sortItems = (var items: Array<number>): void => {',
          '  items.sort()',
          '}',
        ].join('\n'),
        '/project/main.efs': [
          'import { sortItems } from "./lib"',
          'let items: Array<number> = [3, 1, 2]',
          'sortItems(items)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('E2E: DTS output does not reflect var modifier', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let sortItems = (var items: Array<number>): void => {',
          '  items.sort()',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      // var modifier should not appear in .d.ts
      expect(dts).not.toContain('mut');
      expect(dts).toContain('items: Array<number>');
    });

    it('E2E: immutable param mutation is rejected through full pipeline', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let process = (items: Array<number>): void => {',
          '  items.push(42)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.some(d => d.code === 'E240')).toBe(true);
    });
  });

  // ── Literal and Const Types ──────────────────────────────────────

  describe('literal and const types', () => {
    it('literal type alias and exhaustive match', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"',
          'export let describe = (method: HttpMethod): string =>',
          '  match method {',
          '    "GET" => "Read"',
          '    "POST" => "Create"',
          '    "PUT" => "Update"',
          '    "DELETE" => "Remove"',
          '  }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('if (method === "GET")');
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"');
    });

    it('const inference emits literal type in DTS', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let x = "hello"',
          'export var y = "hello"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const x: "hello"');
      expect(dts).toContain('export declare let y: string');
    });

    it('non-exhaustive match on literal union → error', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type HttpMethod = "GET" | "POST" | "PUT"',
          'let describe = (method: HttpMethod): string =>',
          '  match method {',
          '    "GET" => "Read"',
          '    "POST" => "Create"',
          '  }',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const e203 = result.diagnostics.find((d: Diagnostic) => d.code === 'E203');
      expect(e203).toBeDefined();
    });

    it('wrong literal value assignment → error', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type HttpMethod = "GET" | "POST"',
          'let method: HttpMethod = "PATCH"',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const e200 = result.diagnostics.find((d: Diagnostic) => d.code === 'E200');
      expect(e200).toBeDefined();
    });

    it('number literal type alias with match', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type Coin = 1 | 5 | 10 | 25',
          'export let value = (coin: Coin): string =>',
          '  match coin {',
          '    1 => "penny"',
          '    5 => "nickel"',
          '    10 => "dime"',
          '    25 => "quarter"',
          '  }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export type Coin = 1 | 5 | 10 | 25');
    });

    it('literal type in function param cross-file', async () => {
      const result = await compileFiles({
        '/project/types.efs': [
          'export type HttpMethod = "GET" | "POST"',
        ].join('\n'),
        '/project/main.efs': [
          'import { HttpMethod } from "./types"',
          'export let f = (m: HttpMethod): string => m',
        ].join('\n'),
      });
      expect(result.diagnostics.filter(d => d.severity === 'error').map(d => `${d.code}: ${d.message}`)).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('literal type with nullable', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type HttpMethod = "GET" | "POST"',
          'let method: HttpMethod? = null',
          'if (method != null) {',
          '  print(method)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('literal type erased in JS output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type HttpMethod = "GET" | "POST"',
          'let method: HttpMethod = "GET"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const method = "GET"');
      // Type alias should not appear in JS
      expect(js).not.toContain('HttpMethod');
    });
  });

  // ── Named Arguments ───────────────────────────────────────────

  describe('named arguments', () => {
    it('E2E: named args reordered to positional in JS', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: string, c: boolean): number => a',
          'let r = f(c: true, a: 1, b: "hello")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('f(1, "hello", true)');
    });

    it('E2E: skipped defaulted params emit undefined', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: number = 0, c: number = 0): number => a + b + c',
          'let r = f(1, c: 3)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('f(1, undefined, 3)');
    });

    it('E2E: trailing defaults omitted', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: number = 0, c: number = 0): number => a + b + c',
          'let r = f(1, b: 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('f(1, 2)');
    });

    it('E2E: mixed positional and named', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: number, c: number = 0): number => a + b + c',
          'let r = f(1, c: 3, b: 2)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('f(1, 2, 3)');
    });

    it('E2E: error diagnostics for E253/E254/E255', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = (a: number, b: number): number => a',
          'let r1 = f(a: 1, 2)',            // E253: positional after named
          'let r2 = f(c: 1)',               // E254: unknown param name
          'let r3 = f(a: 1, a: 2)',         // E255: duplicate named arg
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const codes = result.diagnostics.map(d => d.code);
      expect(codes).toContain('E253');
      expect(codes).toContain('E254');
      expect(codes).toContain('E255');
    });

    it('E2E: named args with generic function', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let swap = <A, B>(first: A, second: B): B => second',
          'let r = swap(second: "hello", first: 42)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('swap(42, "hello")');
    });

    it('E2E: cross-file named args', async () => {
      const result = await compileFiles({
        '/project/math.efs': [
          'export let add = (a: number, b: number): number => a + b',
        ].join('\n'),
        '/project/main.efs': [
          'import { add } from "./math"',
          'let r = add(b: 20, a: 10)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('add(10, 20)');
    });

    it('E2E: named args with extension function', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'fun number.clamp(min: number, max: number): number => {',
          '  if (this < min) min',
          '  else if (this > max) max',
          '  else this',
          '}',
          'let clamped = 15.clamp(max: 10, min: 0)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Extension call should be rewritten to static call with args in parameter order
      expect(js).toContain('clamp(15, 0, 10)');
    });
  });

  // ── For-loop Enhancements ──────────────────────────────────────────

  describe('for-loop enhancements', () => {
    it('exclusive range compiles to C-style for loop', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'for (i in 0..<10) {',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (let i = 0; i < 10; i++)');
      expect(js).toContain('console.log(i)');
    });

    it('inclusive range compiles to C-style for loop with <=', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'for (i in 0..5) {',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (let i = 0; i <= 5; i++)');
    });

    it('range with computed bounds', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let n = 10',
          'for (i in 0..<n) {',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('i < n');
    });

    it('record destructuring loop compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type User = { name: string, age: number }',
          'let users: Array<User> = [{ name: "Alice", age: 30 }]',
          'for ({ name, age } in users) {',
          '  print(name)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (const { name, age } of users)');
    });

    it('withIndex loop compiles to .entries()', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = ["a", "b", "c"]',
          'for ((index, item) in items.withIndex()) {',
          '  print(index)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('items.entries()');
      expect(js).not.toContain('withIndex');
    });

    it('empty range produces no iterations', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'for (i in 5..<5) {',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (let i = 5; i < 5; i++)');
    });

    it('nested loops with ranges', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'for (i in 0..<3) {',
          '  for (j in 0..<3) {',
          '    print(i)',
          '  }',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (let i = 0; i < 3; i++)');
      expect(js).toContain('for (let j = 0; j < 3; j++)');
    });

    it('break/continue in range loop', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'for (i in 0..<100) {',
          '  if (i == 50) { break }',
          '  if (i % 2 == 0) { continue }',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('break');
      expect(js).toContain('continue');
    });

    it('wildcard in tuple destructuring', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = ["a", "b", "c"]',
          'for ((_, item) in items.withIndex()) {',
          '  print(item)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (const [, item] of items.entries())');
    });

    it('tuple destructuring loop compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = ["a", "b", "c"]',
          'for ((index, item) in items.withIndex()) {',
          '  print("${index}: ${item}")',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (const [index, item] of items.entries())');
    });

    it('cross-file: loop over imported array', async () => {
      const result = await compileFiles({
        '/project/data.efs': [
          'export let items = [1, 2, 3]',
        ].join('\n'),
        '/project/main.efs': [
          'import { items } from "./data"',
          'for (i in 0..<items.length) {',
          '  print(i)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('i < items.length');
    });
  });

  // ── bigint and symbol primitives ─────────────────────────────

  describe('bigint and symbol primitives', () => {
    it('compiles bigint arithmetic end-to-end', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let a: bigint = 10n',
          'let b: bigint = 20n',
          'let sum = a + b',
          'let diff = a - b',
          'let product = a * b',
          'let neg = -42n',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('10n');
      expect(js).toContain('20n');
      expect(js).toContain('a + b');
      expect(js).toContain('-42n');
    });

    it('compiles symbol type annotations', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let s: symbol? = null',
          'let t: symbol? = null',
          'let eq = s == t',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const s = null');
      expect(js).toContain('const eq = s === t');
    });

    it('template interpolation with negated bigint compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let b: bigint = 42n',
          'let s = "value: ${-b}"',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('-b');
    });

    it('match on bigint-typed value with wildcard — exhaustive', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let x: bigint = 42n',
          'let result = match x {',
          '  _ => "any bigint"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);

      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
    });

    it('bigint hex literal compiles correctly', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x = 0xFFn',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('0xFFn');
    });

    it('very large bigint value preserves precision', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x = 99999999999999999999999999999999999999n',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('99999999999999999999999999999999999999n');
    });

    it('emits bigint and symbol in .d.ts', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let x: bigint = 42n',
          'export let s: symbol? = null',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('bigint');
      expect(dts).toContain('symbol');
    });
  });

  // ── Tuples E2E ──────────────────────────────────────────────────

  describe('tuples', () => {
    it('tuple creation, indexing, and let destructuring', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let pair = (1, "hello")',
          'let x = pair.0',
          'let y = pair.1',
          'let (a, b) = pair',
          'print(a)',
          'print(b)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const pair = [1, "hello"]');
      expect(js).toContain('pair[0]');
      expect(js).toContain('pair[1]');
      expect(js).toContain('const [a, b] = pair');
    });

    it('tuple match pattern with literal and binding', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let pair = (1, "hello")',
          'let r = match pair {',
          '  (0, _) => "zero"',
          '  (n, s) => "other"',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('pair[0] === 0');
    });

    it('nested tuple expression compiles to nested arrays', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let nested = ((1, 2), (3, 4))',
          'let a = nested.0',
          'let b = nested.1',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('[[1, 2], [3, 4]]');
    });

    it('wildcard let destructuring emits holes', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let (_, second) = (1, "hello")',
          'print(second)',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const [, second]');
    });

    it('for-loop tuple destructuring still works after parser changes', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let items = ["a", "b", "c"]',
          'for ((idx, item) in items.withIndex()) {',
          '  print(item)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('for (const [idx, item] of items.entries())');
    });

    it('tuple destructuring inside block body', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let f = () => {',
          '  let (a, b) = (1, "hello")',
          '  print(a)',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const [a, b] = [1, "hello"]');
    });

    it('all-wildcard tuple destructuring emits holes', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let pair = (1, "hello")',
          'let (_, _) = pair',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const [, ] = pair');
    });

    it('exported tuple destructuring emits separate DTS declarations', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export let (a, b) = (1, "hello")',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export declare const a:');
      expect(dts).toContain('export declare const b:');
    });
  });

  // ── Any Type Restrictions (W210) ───────────────────────────────

  describe('Any type restrictions (W210)', () => {
    it('W210 appears in diagnostic output for explicit Any annotation', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x: Any = 42',
      });
      // W210 is a warning, so compilation still succeeds
      expect(result.success).toBe(true);
      const w210 = result.diagnostics.filter(
        (d: Diagnostic) => d.code === 'W210',
      );
      expect(w210.length).toBe(1);
      expect(w210[0].message).toContain('Any');
    });

    it('catch parameter typing works through full pipeline', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let msg = try { "ok" } catch (e) { e.message }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter((d: Diagnostic) => d.severity === 'error').length).toBe(0);
    });

    it('W210 does not affect codegen output', async () => {
      const result = await compileFiles({
        '/project/main.efs': 'let x: Any = 42',
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('const x = 42');
    });
  });

  // ── Structural Interfaces ──────────────────────────────────

  describe('structural interfaces', () => {
    it('defines interface and uses it as type annotation', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export interface Serializable {',
          '  fun serialize(): string',
          '}',
          'let x: Serializable = { serialize: () => "hello" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
      // Interface is type-erased in JS
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).not.toContain('interface');
      expect(js).toContain('const x =');
      // DTS emits the interface
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export interface Serializable');
      expect(dts).toContain('serialize(): string');
    });

    it('generic interface used in type annotations', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export interface Collection<T> {',
          '  let size: number',
          '  fun isEmpty(): boolean',
          '  fun contains(item: T): boolean',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export interface Collection<T>');
      expect(dts).toContain('readonly size: number');
      expect(dts).toContain('isEmpty(): boolean');
      expect(dts).toContain('contains(item: T): boolean');
    });

    it('interface with extends clause', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export interface Named {',
          '  let name: string',
          '}',
          'export interface NamedEntity extends Named {',
          '  let id: number',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('export interface NamedEntity extends Named');
    });

    it('interface satisfaction across module boundaries', async () => {
      const result = await compileFiles({
        '/project/types.efs': [
          'export interface Printable {',
          '  fun toString(): string',
          '}',
        ].join('\n'),
        '/project/main.efs': [
          'import { Printable } from "./types"',
          'let x: Printable = { toString: (): string => "hello" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('record satisfies interface via function-typed fields', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface HasLength {',
          '  let length: number',
          '}',
          'let x: HasLength = { length: 42 }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
    });

    it('reports E200 when record does not satisfy interface', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface HasName {',
          '  let name: string',
          '}',
          'let x: HasName = { age: 42 }',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.code === 'E200')).toBe(true);
    });

    it('empty interface satisfied by any non-null type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface Marker {}',
          'let x: Marker = { foo: 1 }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('reports E283 for circular interface extension', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface A extends B {',
          '  let x: number',
          '}',
          'interface B extends A {',
          '  let y: number',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.some(e => e.code === 'E283')).toBe(true);
    });

    it('reports E282 for duplicate members in interface', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface Foo {',
          '  let x: number',
          '  let x: string',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.some(e => e.code === 'E282')).toBe(true);
    });

    it('reports E285 for reserved __call member name', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'interface Foo {',
          '  fun __call(): string',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(false);
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.some(e => e.code === 'E285')).toBe(true);
    });
  });

  // ── Index Signatures E2E ────────────────────────────────────

  describe('index signatures', () => {
    it('48. declare index signature type, access by key', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Config = { [string]: string }',
          'let config: Config = { host: "localhost", port: "8080" }',
          'let host = config["host"]',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('config["host"]');
    });

    it('50. assign record literal to index signature type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type StringMap = { [string]: string }',
          'let m: StringMap = { a: "hello", b: "world" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Record literal should emit as plain JS object
      expect(js).toContain('{ a: "hello", b: "world" }');
    });

    it('51. null narrowing on index access result', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Config = { [string]: string }',
          'let config: Config = { host: "localhost" }',
          'let host = config["host"]',
          'if (host != null) {',
          '  let len = host.length',
          '}',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
    });

    it('48a. optional bracket access on nullable index signature type', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Config = { [string]: string }',
          'let config: Config? = null',
          'let host = config?.["host"]',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('config?.["host"]');
    });

    it('48b. index signature type declaration is erased in JS output', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Config = { [string]: string }',
          'let c: Config = { x: "y" }',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // Type alias should be erased
      expect(js).not.toContain('Config');
    });

    it('52. generic index signature function', async () => {
      // Generic constraint bracket access inside function bodies requires
      // resolving typevar→constraint, which is a general limitation.
      // Test the simpler case: a generic function that takes an index signature
      // param directly and returns a value from it.
      const result = await compileFiles({
        '/project/main.efs': [
          'let processDict = <T>(d: { [string]: T }, key: string): T? => d[key]',
          'let nums: { [string]: number } = { x: 42 }',
          'let result = processDict(nums, "x")',
        ].join('\n'),
      });
      expect(result.diagnostics.map(d => d.message)).toEqual([]);
      expect(result.success).toBe(true);
    });
  });

  // ── Record Field Mutability E2E ──────────────────────────────

  describe('record field mutability', () => {
    it('compiles named record with mixed mutability — correct JS + DTS', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'export type User = { name: string, var score: number }',
          'let user: User = { name: "Alice", score: 0 }',
          'user.score = 100',
        ].join('\n'),
      });
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
      expect(result.success).toBe(true);

      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      expect(js).toContain('user.score = 100');

      const dts = getDTS(result, 'main.d.ts');
      expect(dts).toBeDefined();
      expect(dts).toContain('readonly name: string');
      expect(dts).not.toContain('readonly score');
      expect(dts).toContain('score: number');
    });

    it('assignment to immutable field produces E275', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type User = { name: string, var score: number }',
          'let user: User = { name: "Alice", score: 0 }',
          'user.name = "Bob"',
        ].join('\n'),
      });
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('E275');
    });

    it('assignment to mutable field compiles successfully', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'type Config = { host: string, var debug: boolean }',
          'let config: Config = { host: "localhost", debug: false }',
          'config.debug = true',
        ].join('\n'),
      });
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it('cross-module: record type with mutableFields preserved across module boundaries', async () => {
      const result = await compileFiles({
        '/project/types.efs': 'export type Config = { host: string, var debug: boolean }',
        '/project/main.efs': [
          'import { Config } from "./types"',
          'let c: Config = { host: "localhost", debug: false }',
          'c.debug = true',
        ].join('\n'),
      });
      expect(result.diagnostics.filter(d => d.severity === 'error')).toHaveLength(0);
      expect(result.success).toBe(true);
    });
  });
});
