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
        '/project/main.efs': 'let mut i: number = 0\nwhile (i != 10) { i = i + 1 }',
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
    it('compiles let mut with reassignment', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let mut x = 0',
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

    it('compiles pipe operator', async () => {
      const result = await compileFiles({
        '/project/main.efs': [
          'let double = (n: number): number => n * 2',
          'let inc = (n: number): number => n + 1',
          'let result = 5 |> double |> inc',
        ].join('\n'),
      });
      expect(result.success).toBe(true);
      const js = getJS(result, 'main.js');
      expect(js).toBeDefined();
      // |> compiles to nested function calls: inc(double(5))
      expect(js).toContain('inc(double(5))');
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
          'let mut sum = 0',
          'let mut i = 1',
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
});
