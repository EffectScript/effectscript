import { describe, it, expect } from 'vitest';
import { loadConfig, resolveConfig, DEFAULT_CONFIG } from './config.js';
import type { ProjectConfig } from './config.js';
import { InMemoryFileSystem } from './filesystem.js';

// ── Helpers ──────────────────────────────────────────────────

function fsWithFile(path: string, content: string): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  fs.writeFile(path, content);
  return fs;
}

// ── loadConfig ───────────────────────────────────────────────

describe('loadConfig', () => {
  it('loads valid esc.json', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: './build' },
      include: ['src/**/*.efs'],
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe('/project/build');
    expect(config.include).toEqual(['src/**/*.efs']);
  });

  it('loads valid effectscript.json', () => {
    const fs = fsWithFile('/project/effectscript.json', JSON.stringify({
      compilerOptions: { sourceMap: false },
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.sourceMap).toBe(false);
  });

  it('esc.json takes priority when both exist', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: './from-esc' },
    }));
    fs.writeFile('/project/effectscript.json', JSON.stringify({
      compilerOptions: { outDir: './from-effectscript' },
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe('/project/from-esc');
  });

  it('returns defaults when no config file exists', () => {
    const fs = new InMemoryFileSystem();
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe(DEFAULT_CONFIG.compilerOptions.outDir);
    expect(config.compilerOptions.sourceMap).toBe(DEFAULT_CONFIG.compilerOptions.sourceMap);
    expect(config.compilerOptions.target).toBe(DEFAULT_CONFIG.compilerOptions.target);
    expect(config.include).toEqual(DEFAULT_CONFIG.include);
    expect(config.exclude).toEqual(DEFAULT_CONFIG.exclude);
  });

  it('loads from explicit config path', () => {
    const fs = fsWithFile('/custom/myconfig.json', JSON.stringify({
      compilerOptions: { outDir: './out' },
    }));
    const config = loadConfig('/project', fs, '/custom/myconfig.json');
    expect(config.compilerOptions.outDir).toBe('/custom/out');
  });

  it('throws on invalid JSON in config file', () => {
    const fs = fsWithFile('/project/esc.json', '{invalid json}');
    expect(() => loadConfig('/project', fs)).toThrow();
  });

  it('throws on explicit config path that does not exist', () => {
    const fs = new InMemoryFileSystem();
    expect(() => loadConfig('/project', fs, '/missing/config.json')).toThrow();
  });
});

// ── Validation ───────────────────────────────────────────────

describe('config validation', () => {
  it('unknown fields are accepted and ignored', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: './build' },
      unknownField: 'ignored',
      anotherUnknown: 42,
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe('/project/build');
  });

  it('outDir non-string falls back to default (resolved)', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: 42 },
    }));
    const config = loadConfig('/project', fs);
    // Default outDir "./dist" is resolved relative to config dir
    expect(config.compilerOptions.outDir).toBe('/project/dist');
  });

  it('sourceMap non-boolean falls back to default', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { sourceMap: 'yes' },
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.sourceMap).toBe(DEFAULT_CONFIG.compilerOptions.sourceMap);
  });

  it('include non-array falls back to default', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      include: 'not-an-array',
    }));
    const config = loadConfig('/project', fs);
    expect(config.include).toEqual(DEFAULT_CONFIG.include);
  });

  it('exclude non-array falls back to default', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      exclude: 42,
    }));
    const config = loadConfig('/project', fs);
    expect(config.exclude).toEqual(DEFAULT_CONFIG.exclude);
  });

  it('include array of strings is kept', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      include: ['lib/**/*.efs', 'src/**/*.efs'],
    }));
    const config = loadConfig('/project', fs);
    expect(config.include).toEqual(['lib/**/*.efs', 'src/**/*.efs']);
  });

  it('exclude array of strings is kept', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      exclude: ['test', 'node_modules'],
    }));
    const config = loadConfig('/project', fs);
    expect(config.exclude).toEqual(['test', 'node_modules']);
  });
});

// ── Path resolution ──────────────────────────────────────────

describe('path resolution', () => {
  it('outDir relative path resolved relative to config dir', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: './dist' },
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe('/project/dist');
  });

  it('outDir absolute path kept as-is', () => {
    const fs = fsWithFile('/project/esc.json', JSON.stringify({
      compilerOptions: { outDir: '/absolute/output' },
    }));
    const config = loadConfig('/project', fs);
    expect(config.compilerOptions.outDir).toBe('/absolute/output');
  });

  it('config in subdirectory resolves outDir relative to config dir', () => {
    const fs = fsWithFile('/project/sub/esc.json', JSON.stringify({
      compilerOptions: { outDir: './build' },
    }));
    const config = loadConfig('/project', fs, '/project/sub/esc.json');
    expect(config.compilerOptions.outDir).toBe('/project/sub/build');
  });
});

// ── resolveConfig (CLI merging) ──────────────────────────────

describe('resolveConfig', () => {
  it('CLI options override config file options', () => {
    const base: ProjectConfig = {
      compilerOptions: { outDir: '/project/dist', sourceMap: true, target: 'es2020' },
      include: ['src/**/*.efs'],
      exclude: ['node_modules'],
    };
    const result = resolveConfig(base, { outDir: '/project/out', sourceMap: false });
    expect(result.compilerOptions.outDir).toBe('/project/out');
    expect(result.compilerOptions.sourceMap).toBe(false);
    expect(result.compilerOptions.target).toBe('es2020'); // not overridden
  });

  it('partial CLI options — missing fields use config values', () => {
    const base: ProjectConfig = {
      compilerOptions: { outDir: '/project/dist', sourceMap: true, target: 'es2020' },
      include: ['src/**/*.efs'],
      exclude: ['node_modules'],
    };
    const result = resolveConfig(base, { sourceMap: false });
    expect(result.compilerOptions.outDir).toBe('/project/dist');
    expect(result.compilerOptions.sourceMap).toBe(false);
  });

  it('empty CLI options — config values preserved', () => {
    const base: ProjectConfig = {
      compilerOptions: { outDir: '/project/dist', sourceMap: true, target: 'es2020' },
      include: ['src/**/*.efs'],
      exclude: ['node_modules'],
    };
    const result = resolveConfig(base, {});
    expect(result.compilerOptions).toEqual(base.compilerOptions);
  });
});
