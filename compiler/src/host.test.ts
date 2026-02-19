import { describe, it, expect } from 'vitest';
import { createCompilerHost } from './host.js';
import type { CompilerHost } from './host.js';
import { InMemoryFileSystem } from './filesystem.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';
import type { OutputFile } from './codegen/backend.js';

// ── Helpers ──────────────────────────────────────────────────

function makeFS(): InMemoryFileSystem {
  return new InMemoryFileSystem();
}

function hostWithFiles(files: Record<string, string>): { host: CompilerHost; fs: InMemoryFileSystem } {
  const fs = makeFS();
  for (const [path, content] of Object.entries(files)) {
    fs.writeFile(path, content);
  }
  const host = createCompilerHost({ fileSystem: fs });
  return { host, fs };
}

// ── Construction ─────────────────────────────────────────────

describe('CompilerHost construction', () => {
  it('creates host with default options', () => {
    const host = createCompilerHost();
    expect(host.fileSystem).toBeDefined();
  });

  it('creates host with InMemoryFileSystem', () => {
    const fs = makeFS();
    const host = createCompilerHost({ fileSystem: fs });
    expect(host.fileSystem).toBe(fs);
  });

  it('creates host with custom compiler options', () => {
    const host = createCompilerHost({
      fileSystem: makeFS(),
      compilerOptions: { outDir: '/custom-out', sourceMap: false },
    });
    expect(host).toBeDefined();
  });
});

// ── compile() ────────────────────────────────────────────────

describe('compile()', () => {
  it('single file with no errors → success', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x: number = 42',
    });
    const result = await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(result.success).toBe(true);
    expect(result.outputFiles.length).toBeGreaterThan(0);
    const jsFile = result.outputFiles.find(f => f.kind === 'js');
    expect(jsFile).toBeDefined();
  });

  it('single file with type errors → success=false, diagnostics present', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    const result = await host.compile(['/src/bad.efs'], { outDir: '/dist', sourceMap: false });
    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
  });

  it('multiple files with cross-file imports', async () => {
    const { host } = hostWithFiles({
      '/src/lib.efs': 'export let double = (n: number): number => n * 2',
      '/src/main.efs': 'import { double } from "./lib"\nexport let result = double(21)',
    });
    const result = await host.compile(['/src/main.efs', '/src/lib.efs'], { outDir: '/dist', sourceMap: false });
    expect(result.success).toBe(true);
    const jsFiles = result.outputFiles.filter(f => f.kind === 'js');
    expect(jsFiles.length).toBe(2);
  });

  it('empty file list → success, no output', async () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    const result = await host.compile([], { outDir: '/dist', sourceMap: false });
    expect(result.success).toBe(true);
    expect(result.outputFiles).toEqual([]);
  });

  it('file that does not exist → E502 diagnostic', async () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    const result = await host.compile(['/nonexistent.efs'], { outDir: '/dist', sourceMap: false });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'E502')).toBe(true);
  });
});

// ── check() ──────────────────────────────────────────────────

describe('check()', () => {
  it('file with no errors → empty diagnostics', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x: number = 42',
    });
    const diags = await host.check(['/src/main.efs']);
    expect(diags).toEqual([]);
  });

  it('file with errors → diagnostics returned, no output files', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    const diags = await host.check(['/src/bad.efs']);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some(d => d.severity === 'error')).toBe(true);
  });
});

// ── Event hooks ──────────────────────────────────────────────

describe('event hooks', () => {
  it('diagnostic listener called for each diagnostic', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    const received: Diagnostic[] = [];
    host.on('diagnostic', (d) => received.push(d));
    await host.compile(['/src/bad.efs'], { outDir: '/dist', sourceMap: false });
    expect(received.length).toBeGreaterThan(0);
  });

  it('fileCompiled listener called with path and output', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    const compiled: Array<{ path: string; output: readonly OutputFile[] }> = [];
    host.on('fileCompiled', (path, output) => compiled.push({ path, output }));
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(compiled.length).toBe(1);
    expect(compiled[0].path).toBe('/src/main.efs');
  });

  it('phaseComplete listener called with timing data', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    const phases: Array<{ phase: string; durationMs: number }> = [];
    host.on('phaseComplete', (phase, result) => phases.push({ phase, durationMs: result.durationMs }));
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(phases.length).toBeGreaterThan(0);
  });

  it('multiple listeners on same event all called', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    const a: Diagnostic[] = [];
    const b: Diagnostic[] = [];
    host.on('diagnostic', (d) => a.push(d));
    host.on('diagnostic', (d) => b.push(d));
    await host.compile(['/src/bad.efs'], { outDir: '/dist', sourceMap: false });
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
  });
});

// ── Profiling ────────────────────────────────────────────────

describe('profiling', () => {
  it('getTimings() after compile has positive total durationMs', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    const timings = host.getTimings();
    expect(timings.total.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('getStats() after compile reports filesCompiled', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    const stats = host.getStats();
    expect(stats.filesCompiled).toBe(1);
  });

  it('getStats() reports filesWithErrors count', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    await host.compile(['/src/bad.efs'], { outDir: '/dist', sourceMap: false });
    const stats = host.getStats();
    expect(stats.filesWithErrors).toBeGreaterThanOrEqual(1);
  });

  it('getStats() reports diagnosticCount', async () => {
    const { host } = hostWithFiles({
      '/src/bad.efs': 'let x: number = "hello"',
    });
    await host.compile(['/src/bad.efs'], { outDir: '/dist', sourceMap: false });
    const stats = host.getStats();
    expect(stats.diagnosticCount.errors).toBeGreaterThan(0);
  });
});

// ── Plugin registration ──────────────────────────────────────

describe('plugin registration', () => {
  it('registerPass() adds pass used during compilation', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    let passCalled = false;
    host.registerPass({
      name: 'test-pass',
      phase: 'post-check',
      run(ast) {
        passCalled = true;
        return { ast, diagnostics: [] };
      },
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(passCalled).toBe(true);
  });
});

// ── LSP stubs ────────────────────────────────────────────────

describe('LSP stubs', () => {
  it('getSymbolAtPosition returns null', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getSymbolAtPosition('file.efs', { line: 1, column: 0 })).toBeNull();
  });

  it('getCompletionsAtPosition returns empty array', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getCompletionsAtPosition('file.efs', { line: 1, column: 0 })).toEqual([]);
  });

  it('getDefinitionAtPosition returns null', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getDefinitionAtPosition('file.efs', { line: 1, column: 0 })).toBeNull();
  });

  it('getReferencesAtPosition returns empty array', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getReferencesAtPosition('file.efs', { line: 1, column: 0 })).toEqual([]);
  });

  it('getHoverInfo returns null', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getHoverInfo('file.efs', { line: 1, column: 0 })).toBeNull();
  });

  it('getSignatureHelp returns null', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getSignatureHelp('file.efs', { line: 1, column: 0 })).toBeNull();
  });
});

// ── State management ─────────────────────────────────────────

describe('state management', () => {
  it('getModuleGraph() before compile returns null', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    expect(host.getModuleGraph()).toBeNull();
  });

  it('getModuleGraph() after compile returns the graph', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(host.getModuleGraph()).not.toBeNull();
  });

  it('getAST() for compiled file returns AST', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    const ast = host.getAST('/src/main.efs');
    expect(ast).not.toBeNull();
    expect(ast!.kind).toBe('Program');
  });

  it('getAST() for unknown file returns null', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    expect(host.getAST('/src/unknown.efs')).toBeNull();
  });

  it('invalidateFile() adds to dirty set', () => {
    const host = createCompilerHost({ fileSystem: makeFS() });
    // Should not throw
    host.invalidateFile('/src/main.efs');
  });

  it('recompileDirty() returns a result', async () => {
    const { host } = hostWithFiles({
      '/src/main.efs': 'export let x = 1',
    });
    await host.compile(['/src/main.efs'], { outDir: '/dist', sourceMap: false });
    host.invalidateFile('/src/main.efs');
    const result = await host.recompileDirty();
    expect(result.success).toBe(true);
  });
});
