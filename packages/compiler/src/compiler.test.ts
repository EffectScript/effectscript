import { describe, it, expect } from 'vitest';
import { runPipeline } from './compiler.js';
import type { RunPipelineOptions } from './compiler.js';
import { InMemoryFileSystem } from './filesystem.js';
import { DiagnosticCollectorImpl } from './diagnostics/collector.js';
import { TsCompilerApiProvider } from './interop/provider.js';
import { PassRegistry } from './passes/registry.js';
import { JSBackend } from './codegen/js-backend.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';
import type { OutputFile } from './codegen/backend.js';

// ── Helpers ──────────────────────────────────────────────────

function makeOptions(
  fs: InMemoryFileSystem,
  files: readonly string[],
  overrides?: Partial<RunPipelineOptions>,
): RunPipelineOptions {
  return {
    filePaths: files,
    sourceMap: false,
    outDir: '/dist',
    fileSystem: fs,
    diagnostics: new DiagnosticCollectorImpl(),
    typeProvider: new TsCompilerApiProvider({
      basePath: '/',
      diagnostics: new DiagnosticCollectorImpl(),
      fileSystem: fs,
    }),
    passRegistry: new PassRegistry(),
    backend: new JSBackend(),
    onDiagnostic: overrides?.onDiagnostic,
    onFileCompiled: overrides?.onFileCompiled,
    ...overrides,
  };
}

// ── runPipeline ──────────────────────────────────────────────

describe('runPipeline', () => {
  it('compiles a single file end-to-end', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x: number = 42');
    const opts = makeOptions(fs, ['/src/main.efs']);
    const result = runPipeline(opts);
    expect(result.success).toBe(true);
    expect(result.outputFiles.length).toBeGreaterThan(0);
    const jsFile = result.outputFiles.find(f => f.kind === 'js');
    expect(jsFile).toBeDefined();
    expect(jsFile!.content).toContain('42');
  });

  it('returns diagnostics for file with errors', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/bad.efs', 'let x: number = "hello"');
    const opts = makeOptions(fs, ['/src/bad.efs']);
    const result = runPipeline(opts);
    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
  });

  it('multi-file project compiles correctly', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/lib.efs', 'export let double = (n: number): number => n * 2');
    fs.writeFile('/src/main.efs', 'import { double } from "./lib"\nexport let result = double(21)');
    const opts = makeOptions(fs, ['/src/main.efs', '/src/lib.efs']);
    const result = runPipeline(opts);
    expect(result.success).toBe(true);
    // Should produce output for both files
    const jsFiles = result.outputFiles.filter(f => f.kind === 'js');
    expect(jsFiles.length).toBe(2);
  });

  it('returns module graph in result', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x = 1');
    const opts = makeOptions(fs, ['/src/main.efs']);
    const result = runPipeline(opts);
    expect(result.moduleGraph).toBeDefined();
    expect(result.moduleGraph.getEfsNodes().length).toBe(1);
  });

  it('fires onDiagnostic callback for each diagnostic', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/bad.efs', 'let x: number = "hello"');
    const diagnostics: Diagnostic[] = [];
    const opts = makeOptions(fs, ['/src/bad.efs'], {
      onDiagnostic: (d) => diagnostics.push(d),
    });
    runPipeline(opts);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('fires onFileCompiled callback for each file', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x = 1');
    const compiled: Array<{ path: string; output: readonly OutputFile[] }> = [];
    const opts = makeOptions(fs, ['/src/main.efs'], {
      onFileCompiled: (path, output) => compiled.push({ path, output }),
    });
    runPipeline(opts);
    expect(compiled.length).toBe(1);
    expect(compiled[0].path).toBe('/src/main.efs');
  });

  it('records timing with positive durationMs', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x = 1');
    const opts = makeOptions(fs, ['/src/main.efs']);
    const result = runPipeline(opts);
    expect(result.timings.total.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('empty file list succeeds with no output', () => {
    const fs = new InMemoryFileSystem();
    const opts = makeOptions(fs, []);
    const result = runPipeline(opts);
    expect(result.success).toBe(true);
    expect(result.outputFiles).toEqual([]);
  });

  it('noEmit skips output file generation', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x = 1');
    const opts = makeOptions(fs, ['/src/main.efs'], { noEmit: true });
    const result = runPipeline(opts);
    expect(result.success).toBe(true);
    expect(result.outputFiles).toEqual([]);
    // But diagnostics still work
    expect(result.diagnostics).toEqual([]);
  });
});
