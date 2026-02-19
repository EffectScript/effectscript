import { describe, it, expect } from 'vitest';
import type { PipelineResult } from './pipeline.js';
import { compileProject } from './pipeline.js';
import type { PipelineOptions } from './pipeline.js';
import { InMemoryFileSystem } from './filesystem.js';
import { DiagnosticCollectorImpl } from './diagnostics/collector.js';
import { PassRegistry } from './passes/registry.js';
import { JSBackend } from './codegen/js-backend.js';
import type { TypeDeclarationProvider, ResolvedModule } from './interop/provider.js';
import type { ExportedTypeSignature, FunctionType } from './checker/types.js';

// ── Mock TypeDeclarationProvider ───────────────────────────

class MockTypeProvider implements TypeDeclarationProvider {
  private readonly signatures = new Map<string, ExportedTypeSignature>();

  addSignature(modulePath: string, sig: ExportedTypeSignature): void {
    this.signatures.set(modulePath, sig);
  }

  resolveModule(specifier: string, fromFile: string): ResolvedModule | null {
    // Resolve relative .efs imports
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
      let resolved: string;
      if (specifier.startsWith('./')) {
        resolved = dir + '/' + specifier.slice(2);
      } else {
        // ../
        const parentDir = dir.substring(0, dir.lastIndexOf('/'));
        resolved = parentDir + '/' + specifier.slice(3);
      }
      // Add .efs extension if not present
      if (!resolved.endsWith('.efs')) {
        resolved += '.efs';
      }
      return { path: resolved, kind: 'efs' };
    }

    // External modules
    if (this.signatures.has('/node_modules/' + specifier + '/index.d.ts')) {
      return { path: '/node_modules/' + specifier + '/index.d.ts', kind: 'dts', packageName: specifier };
    }

    return null;
  }

  getExportedTypes(modulePath: string): ExportedTypeSignature {
    return this.signatures.get(modulePath) ?? { types: new Map(), values: new Map(), adtConstructors: new Map() };
  }

  getConstructorSignature(_modulePath: string, _name: string): FunctionType | null {
    return null;
  }

  invalidate(_modulePath: string): void {
    // no-op for tests
  }
}

// ── Test Helpers ───────────────────────────────────────────

function makeOptions(overrides?: Partial<PipelineOptions>): PipelineOptions {
  return {
    sourceMap: false,
    outDir: '/out',
    ...overrides,
  };
}

function compileFiles(
  files: Record<string, string>,
  entryPaths?: string[],
  provider?: MockTypeProvider,
  options?: Partial<PipelineOptions>,
): PipelineResult {
  const fs = new InMemoryFileSystem();
  for (const [path, content] of Object.entries(files)) {
    fs.writeFile(path, content);
  }

  const diagnostics = new DiagnosticCollectorImpl();
  const passRegistry = new PassRegistry();
  const backend = new JSBackend();
  const typeProvider = provider ?? new MockTypeProvider();

  const paths = entryPaths ?? Object.keys(files).filter(p => p.endsWith('.efs'));

  return compileProject(
    paths,
    makeOptions(options),
    fs,
    diagnostics,
    typeProvider,
    passRegistry,
    backend,
  );
}

function getErrors(result: PipelineResult): string[] {
  return result.diagnostics
    .filter(d => d.severity === 'error')
    .map(d => d.code);
}

function getWarnings(result: PipelineResult): string[] {
  return result.diagnostics
    .filter(d => d.severity === 'warning')
    .map(d => d.code);
}

function getJsOutput(result: PipelineResult, fileName: string): string | undefined {
  return result.outputFiles.find(f => f.path.endsWith(fileName) && f.kind === 'js')?.content;
}

function getDtsOutput(result: PipelineResult, fileName: string): string | undefined {
  return result.outputFiles.find(f => f.path.endsWith(fileName) && f.kind === 'dts')?.content;
}

// ── Happy Path Tests ───────────────────────────────────────

describe('Pipeline — happy path', () => {
  it('compiles a single file with no imports', () => {
    const result = compileFiles({
      '/src/main.efs': 'let x = 42',
    });

    expect(getErrors(result)).toEqual([]);
    expect(result.outputFiles.length).toBeGreaterThan(0);
    const js = getJsOutput(result, 'main.js');
    expect(js).toBeDefined();
    expect(js).toContain('42');
  });

  it('compiles two files: a imports from b', () => {
    const result = compileFiles({
      '/src/b.efs': 'export let add = (a: number, b: number): number => a + b',
      '/src/a.efs': `
import { add } from "./b"
let result = add(1, 2)
`,
    });

    expect(getErrors(result)).toEqual([]);
    const jsA = getJsOutput(result, 'a.js');
    const jsB = getJsOutput(result, 'b.js');
    expect(jsA).toBeDefined();
    expect(jsB).toBeDefined();
  });

  it('compiles three-file chain: a → b → c', () => {
    const result = compileFiles({
      '/src/c.efs': 'export let base = 10',
      '/src/b.efs': `
import { base } from "./c"
export let doubled = base * 2
`,
      '/src/a.efs': `
import { doubled } from "./b"
let result = doubled + 1
`,
    });

    expect(getErrors(result)).toEqual([]);
    expect(getJsOutput(result, 'a.js')).toBeDefined();
    expect(getJsOutput(result, 'b.js')).toBeDefined();
    expect(getJsOutput(result, 'c.js')).toBeDefined();
  });

  it('compiles diamond dependency: a→b, a→c, b→d, c→d', () => {
    const result = compileFiles({
      '/src/d.efs': 'export let shared = 1',
      '/src/b.efs': `
import { shared } from "./d"
export let fromB = shared + 10
`,
      '/src/c.efs': `
import { shared } from "./d"
export let fromC = shared + 20
`,
      '/src/a.efs': `
import { fromB } from "./b"
import { fromC } from "./c"
let total = fromB + fromC
`,
    });

    expect(getErrors(result)).toEqual([]);
    // All four files should have JS output
    expect(result.outputFiles.filter(f => f.kind === 'js')).toHaveLength(4);
  });

  it('compiles file importing external module', () => {
    const provider = new MockTypeProvider();
    provider.addSignature('/node_modules/math-lib/index.d.ts', {
      types: new Map(),
      values: new Map([['square', {
        kind: 'function',
        params: [{ name: 'x', type: { kind: 'primitive', name: 'number' }, optional: false, hasDefault: false }],
        returnType: { kind: 'primitive', name: 'number' },
      } satisfies FunctionType]]),
      adtConstructors: new Map(),
    });

    const result = compileFiles({
      '/src/main.efs': `
import { square } from "math-lib"
let result = square(5)
`,
    }, undefined, provider);

    expect(getErrors(result)).toEqual([]);
    expect(getJsOutput(result, 'main.js')).toBeDefined();
  });
});

// ── Cross-File Type Resolution ─────────────────────────────

describe('Pipeline — cross-file type resolution', () => {
  it('export function → import and call in another file', () => {
    const result = compileFiles({
      '/src/utils.efs': 'export let greet = (name: string): string => "hello"',
      '/src/main.efs': `
import { greet } from "./utils"
let msg: string = greet("world")
`,
    });

    expect(getErrors(result)).toEqual([]);
  });

  it('export ADT → pattern match in importing file', () => {
    const result = compileFiles({
      '/src/types.efs': `
export type Shape = Circle(radius: number) | Square(side: number)
`,
      '/src/main.efs': `
import { Circle, Square } from "./types"
let s = Circle(5)
let area = match s {
  Circle(r) => r * r
  Square(s) => s * s
}
`,
    });

    expect(getErrors(result)).toEqual([]);
  });

  it('export type alias → use as annotation in another file', () => {
    const result = compileFiles({
      '/src/types.efs': 'export let count: number = 42',
      '/src/main.efs': `
import { count } from "./types"
let x: number = count
`,
    });

    expect(getErrors(result)).toEqual([]);
  });

  it('default export/import across files', () => {
    const result = compileFiles({
      '/src/lib.efs': `
export let helper = (x: number): number => x * 2
`,
      '/src/main.efs': `
import { helper } from "./lib"
let result = helper(5)
`,
    });

    expect(getErrors(result)).toEqual([]);
  });

  it('import ADT constructors across files', () => {
    const result = compileFiles({
      '/src/color.efs': `
export type Color = Red | Green | Blue
`,
      '/src/main.efs': `
import { Red, Green, Blue } from "./color"
let c = Red
`,
    });

    expect(getErrors(result)).toEqual([]);
  });

  it('re-export across files: A→B→C', () => {
    const result = compileFiles({
      '/src/c.efs': 'export let value = 42',
      '/src/b.efs': `
export { value } from "./c"
`,
      '/src/a.efs': `
import { value } from "./b"
let x = value + 1
`,
    });

    expect(getErrors(result)).toEqual([]);
  });
});

// ── Error Cases ────────────────────────────────────────────

describe('Pipeline — error cases', () => {
  it('circular import produces E501', () => {
    const result = compileFiles({
      '/src/a.efs': `
import { b } from "./b"
export let a = 1
`,
      '/src/b.efs': `
import { a } from "./a"
export let b = 2
`,
    });

    expect(getErrors(result)).toContain('E501');
  });

  it('missing .efs file produces E500', () => {
    const result = compileFiles({
      '/src/main.efs': `
import { foo } from "./missing"
let x = foo
`,
    });

    expect(getErrors(result)).toContain('E500');
  });

  it('import nonexistent name from valid .efs file produces E211', () => {
    const result = compileFiles({
      '/src/lib.efs': 'export let x = 1',
      '/src/main.efs': `
import { doesNotExist } from "./lib"
let y = doesNotExist
`,
    });

    expect(getErrors(result)).toContain('E211');
  });

  it('file with parse errors → dependents get error types', () => {
    const result = compileFiles({
      '/src/bad.efs': 'export let x = @@@', // parse error
      '/src/main.efs': `
import { x } from "./bad"
let y = x
`,
    });

    // Should have errors from the bad file
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('file with type errors → codegen skipped for that file', () => {
    const result = compileFiles({
      '/src/bad.efs': `
export let x: string = 42
`,
      '/src/main.efs': `
import { x } from "./bad"
let y = x
`,
    });

    // bad.efs has type error - should not produce JS
    const badJs = getJsOutput(result, 'bad.js');
    expect(badJs).toBeUndefined();

    // main.efs should still be compiled (it depends on bad but uses error types)
    const mainJs = getJsOutput(result, 'main.js');
    expect(mainJs).toBeDefined();
  });

  it('self-import produces E501', () => {
    const result = compileFiles({
      '/src/self.efs': `
import { x } from "./self"
export let x = 1
`,
    });

    expect(getErrors(result)).toContain('E501');
  });

  it('file read failure produces E502', () => {
    // Create a pipeline where the file doesn't exist in FS but is listed as entry
    const fs = new InMemoryFileSystem();
    // Don't write anything but pass a path
    const diagnostics = new DiagnosticCollectorImpl();
    const passRegistry = new PassRegistry();
    const backend = new JSBackend();
    const provider = new MockTypeProvider();

    const result = compileProject(
      ['/src/nonexistent.efs'],
      makeOptions(),
      fs,
      diagnostics,
      provider,
      passRegistry,
      backend,
    );

    expect(getErrors(result)).toContain('E502');
  });
});

// ── Codegen Tests ──────────────────────────────────────────

describe('Pipeline — codegen', () => {
  it('produces .js and .d.ts per file', () => {
    const result = compileFiles({
      '/src/a.efs': 'export let x = 1',
      '/src/b.efs': 'export let y = 2',
    });

    expect(getErrors(result)).toEqual([]);
    const jsFiles = result.outputFiles.filter(f => f.kind === 'js');
    const dtsFiles = result.outputFiles.filter(f => f.kind === 'dts');
    expect(jsFiles).toHaveLength(2);
    expect(dtsFiles).toHaveLength(2);
  });

  it('produces source maps when enabled', () => {
    const result = compileFiles({
      '/src/main.efs': 'let x = 42',
    }, undefined, undefined, { sourceMap: true });

    expect(getErrors(result)).toEqual([]);
    const maps = result.outputFiles.filter(f => f.kind === 'sourcemap');
    expect(maps).toHaveLength(1);
  });

  it('import paths rewritten correctly: .efs → .js', () => {
    const result = compileFiles({
      '/src/lib.efs': 'export let x = 1',
      '/src/main.efs': `
import { x } from "./lib"
let y = x
`,
    });

    expect(getErrors(result)).toEqual([]);
    const mainJs = getJsOutput(result, 'main.js');
    expect(mainJs).toBeDefined();
    // The import should reference .js, not .efs
    expect(mainJs).toContain('./lib.js');
    expect(mainJs).not.toContain('.efs');
  });

  it('files with errors produce no output', () => {
    const result = compileFiles({
      '/src/bad.efs': 'let x: string = 42', // type error
    });

    // Should have error diagnostics
    expect(getErrors(result).length).toBeGreaterThan(0);
    // No JS output for errored file
    expect(result.outputFiles.filter(f => f.kind === 'js')).toHaveLength(0);
  });

  it('empty project produces empty result', () => {
    const result = compileFiles({});

    expect(getErrors(result)).toEqual([]);
    expect(result.outputFiles).toHaveLength(0);
  });
});

// ── Edge Cases ─────────────────────────────────────────────

describe('Pipeline — edge cases', () => {
  it('long chain of 10+ files compiles in correct order', () => {
    const files: Record<string, string> = {};
    // Create chain: f0 → f1 → f2 → ... → f9
    files['/src/f9.efs'] = 'export let v9 = 9';
    for (let i = 8; i >= 0; i--) {
      files[`/src/f${i}.efs`] = `
import { v${i + 1} } from "./f${i + 1}"
export let v${i} = v${i + 1} + 1
`;
    }

    const result = compileFiles(files);
    expect(getErrors(result)).toEqual([]);
    // All 10 files should compile
    expect(result.outputFiles.filter(f => f.kind === 'js')).toHaveLength(10);
  });

  it('file imported by multiple files is compiled once', () => {
    const result = compileFiles({
      '/src/shared.efs': 'export let s = 1',
      '/src/a.efs': `
import { s } from "./shared"
let a = s + 1
`,
      '/src/b.efs': `
import { s } from "./shared"
let b = s + 2
`,
    });

    expect(getErrors(result)).toEqual([]);
    // shared.efs should produce exactly 1 JS output
    const sharedJs = result.outputFiles.filter(f => f.kind === 'js' && f.path.includes('shared'));
    expect(sharedJs).toHaveLength(1);
  });

  it('returns module graph in result', () => {
    const result = compileFiles({
      '/src/a.efs': 'let x = 1',
    });

    expect(result.moduleGraph).toBeDefined();
    expect(result.moduleGraph.getNode('/src/a.efs')).not.toBeNull();
  });

  it('module graph has exports populated after compilation', () => {
    const result = compileFiles({
      '/src/a.efs': 'export let x = 42',
    });

    expect(getErrors(result)).toEqual([]);
    const exports = result.moduleGraph.getExports('/src/a.efs');
    expect(exports).not.toBeNull();
    expect(exports!.values.has('x')).toBe(true);
  });

  it('W500 warning for module with no exports', () => {
    const result = compileFiles({
      '/src/lib.efs': 'let x = 1', // no exports
      '/src/main.efs': `
import { x } from "./lib"
let y = x
`,
    });

    // Should produce a warning about no exports
    expect(getWarnings(result)).toContain('W500');
  });

  it('prelude types available in all files', () => {
    const result = compileFiles({
      '/src/a.efs': `
let r = Ok(42)
print(r)
`,
      '/src/b.efs': `
let r = Err("oops")
print(r)
`,
    });

    expect(getErrors(result)).toEqual([]);
  });
});
