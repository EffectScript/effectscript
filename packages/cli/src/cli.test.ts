import { describe, it, expect } from 'vitest';
import { parseArgs, handleInit } from './cli.js';
import type { ParsedArgs } from './cli.js';
import { InMemoryFileSystem } from 'effectscript-compiler/filesystem';

// ── parseArgs ────────────────────────────────────────────────

describe('parseArgs', () => {
  it('esc build src/ → command=build, path=src/', () => {
    const result = parseArgs(['build', 'src/']);
    expect(result.command).toBe('build');
    expect(result.path).toBe('src/');
  });

  it('esc check main.efs → command=check, path=main.efs', () => {
    const result = parseArgs(['check', 'main.efs']);
    expect(result.command).toBe('check');
    expect(result.path).toBe('main.efs');
  });

  it('esc run main.efs → command=run, path=main.efs', () => {
    const result = parseArgs(['run', 'main.efs']);
    expect(result.command).toBe('run');
    expect(result.path).toBe('main.efs');
  });

  it('esc init myproject → command=init, path=myproject', () => {
    const result = parseArgs(['init', 'myproject']);
    expect(result.command).toBe('init');
    expect(result.path).toBe('myproject');
  });

  it('esc --help → command=help', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('esc --version → command=version', () => {
    const result = parseArgs(['--version']);
    expect(result.command).toBe('version');
  });

  it('esc unknown → command=unknown', () => {
    const result = parseArgs(['unknown']);
    expect(result.command).toBe('unknown');
    expect(result.path).toBe('unknown');
  });

  it('esc build --outDir dist --no-sourceMap → options parsed', () => {
    const result = parseArgs(['build', 'src/', '--outDir', 'dist', '--no-sourceMap']);
    expect(result.command).toBe('build');
    expect(result.options.outDir).toBe('dist');
    expect(result.options.sourceMap).toBe(false);
  });

  it('esc build --sourceMap → sourceMap=true', () => {
    const result = parseArgs(['build', 'src/', '--sourceMap']);
    expect(result.options.sourceMap).toBe(true);
  });

  it('esc build --config custom.json → config path set', () => {
    const result = parseArgs(['build', 'src/', '--config', 'custom.json']);
    expect(result.options.config).toBe('custom.json');
  });

  it('esc build --no-color → noColor=true', () => {
    const result = parseArgs(['build', '--no-color']);
    expect(result.options.noColor).toBe(true);
  });

  it('esc build --quiet → quiet=true', () => {
    const result = parseArgs(['build', '--quiet']);
    expect(result.options.quiet).toBe(true);
  });

  it('esc build --diagnostics → showDiagnostics=true', () => {
    const result = parseArgs(['build', '--diagnostics']);
    expect(result.options.showDiagnostics).toBe(true);
  });

  it('esc (no args) → command=help', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  it('esc build (no path) → path=undefined', () => {
    const result = parseArgs(['build']);
    expect(result.command).toBe('build');
    expect(result.path).toBeUndefined();
  });

  it('esc build --watch → watch=true', () => {
    const result = parseArgs(['build', 'src/', '--watch']);
    expect(result.command).toBe('build');
    expect(result.options.watch).toBe(true);
  });

  it('esc check --watch → watch=true', () => {
    const result = parseArgs(['check', 'src/', '--watch']);
    expect(result.command).toBe('check');
    expect(result.options.watch).toBe(true);
  });

  it('esc build --no-cache → noCache=true', () => {
    const result = parseArgs(['build', '--no-cache']);
    expect(result.options.noCache).toBe(true);
  });

  it('esc fmt → command=fmt (stub)', () => {
    const result = parseArgs(['fmt']);
    expect(result.command).toBe('fmt');
  });

  it('esc lint → command=lint (stub)', () => {
    const result = parseArgs(['lint']);
    expect(result.command).toBe('lint');
  });
});

// ── handleInit ───────────────────────────────────────────────

describe('handleInit', () => {
  it('creates esc.json and src/main.efs', () => {
    const fs = new InMemoryFileSystem();
    const result = handleInit('/project', fs);
    expect(result.exitCode).toBe(0);
    expect(fs.fileExists('/project/esc.json')).toBe(true);
    expect(fs.fileExists('/project/src/main.efs')).toBe(true);
  });

  it('esc.json contains valid config', () => {
    const fs = new InMemoryFileSystem();
    handleInit('/project', fs);
    const content = fs.readFile('/project/esc.json');
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!);
    expect(parsed.compilerOptions).toBeDefined();
    expect(parsed.compilerOptions.outDir).toBe('./dist');
  });

  it('main.efs contains hello world', () => {
    const fs = new InMemoryFileSystem();
    handleInit('/project', fs);
    const content = fs.readFile('/project/src/main.efs');
    expect(content).toBeDefined();
    expect(content).toContain('print');
    expect(content).toContain('Hello');
  });

  it('does not overwrite existing esc.json', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/project/esc.json', '{"existing": true}');
    const result = handleInit('/project', fs);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('already');
    // Original content preserved
    expect(fs.readFile('/project/esc.json')).toBe('{"existing": true}');
  });

  it('does not overwrite existing effectscript.json', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/project/effectscript.json', '{"existing": true}');
    const result = handleInit('/project', fs);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('already');
  });

  it('creates .gitignore with dist/, node_modules/, and .efs-cache/', () => {
    const fs = new InMemoryFileSystem();
    handleInit('/project', fs);
    const content = fs.readFile('/project/.gitignore');
    expect(content).toBeDefined();
    expect(content).toContain('dist/');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.efs-cache/');
  });

  it('creates package.json with type: module', () => {
    const fs = new InMemoryFileSystem();
    handleInit('/project', fs);
    const content = fs.readFile('/project/package.json');
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!);
    expect(parsed.type).toBe('module');
    expect(parsed.name).toBeDefined();
  });

  it('does not overwrite existing .gitignore or package.json', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/project/.gitignore', 'custom\n');
    fs.writeFile('/project/package.json', '{"custom": true}');
    handleInit('/project', fs);
    expect(fs.readFile('/project/.gitignore')).toBe('custom\n');
    expect(fs.readFile('/project/package.json')).toBe('{"custom": true}');
  });
});

// ── End-to-end (using InMemoryFileSystem) ────────────────────

describe('CLI integration', () => {
  it('build with valid file produces output', async () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'export let x: number = 42');

    // We test through the host directly since the CLI main() uses process.argv
    const { createCompilerHost } = await import('effectscript-compiler/host');
    const host = createCompilerHost({ fileSystem: fs, compilerOptions: { outDir: '/dist', sourceMap: false } });
    const result = await host.compile(['/src/main.efs']);
    expect(result.success).toBe(true);
    expect(result.outputFiles.length).toBeGreaterThan(0);
  });

  it('check with errors returns diagnostics', async () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/bad.efs', 'let x: number = "hello"');

    const { createCompilerHost } = await import('effectscript-compiler/host');
    const host = createCompilerHost({ fileSystem: fs });
    const diags = await host.check(['/src/bad.efs']);
    expect(diags.length).toBeGreaterThan(0);
  });
});
