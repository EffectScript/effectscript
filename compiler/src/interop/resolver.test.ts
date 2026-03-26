import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { NodeModuleResolver } from './resolver.js';
import { InMemoryFileSystem } from '../filesystem.js';

const fixturesDir = path.resolve(import.meta.dirname, '__fixtures__');
// basePath should be the compiler root (where node_modules lives)
const basePath = path.resolve(import.meta.dirname, '../..');

// Create temp files for testing
const tmpDir = path.join(fixturesDir, '__tmp_resolver');

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'utils.d.ts'), 'export declare const x: number;');
  fs.writeFileSync(path.join(tmpDir, 'helper.ts'), 'export const y = 1;');
  fs.writeFileSync(path.join(tmpDir, 'script.js'), 'export const z = 1;');
  fs.writeFileSync(path.join(tmpDir, 'cjs-module.d.cts'), 'declare const x: number; export = x;');
  fs.writeFileSync(path.join(tmpDir, 'esm-module.d.mts'), 'export declare const x: number;');
  fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'subdir', 'index.d.ts'), 'export declare const w: string;');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('NodeModuleResolver', () => {
  it('resolves relative .efs import via FileSystem', () => {
    const memFs = new InMemoryFileSystem();
    memFs.writeFile(path.join(tmpDir, 'mymod.efs'), 'let x = 1');
    const resolver = new NodeModuleResolver({ basePath }, memFs);
    const result = resolver.resolve('./mymod', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('efs');
    expect(result!.path).toBe(path.join(tmpDir, 'mymod.efs'));
  });

  it('resolves relative .d.ts import', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./utils', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.path).toBe(path.join(tmpDir, 'utils.d.ts'));
  });

  it('resolves relative index.d.ts import', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./subdir', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.path).toBe(path.join(tmpDir, 'subdir', 'index.d.ts'));
  });

  it('returns null for non-existent relative path', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./nonexistent', path.join(tmpDir, 'source.efs'));
    expect(result).toBeNull();
  });

  it('prioritizes .efs over .d.ts', () => {
    const memFs = new InMemoryFileSystem();
    memFs.writeFile(path.join(tmpDir, 'utils.efs'), 'let x = 1');
    const resolver = new NodeModuleResolver({ basePath }, memFs);
    const result = resolver.resolve('./utils', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('efs');
  });

  it('resolves bare package (typescript as known installed package)', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('typescript', path.join(basePath, 'src', 'source.ts'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.packageName).toBe('typescript');
  });

  it('returns null for non-existent bare package', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('totally-nonexistent-package-xyz', path.join(basePath, 'src', 'source.ts'));
    expect(result).toBeNull();
  });

  it('returns null for empty specifier', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('', path.join(tmpDir, 'source.efs'));
    expect(result).toBeNull();
  });

  it('extracts package name from simple specifier', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('typescript', path.join(basePath, 'src', 'source.ts'));
    expect(result).not.toBeNull();
    expect(result!.packageName).toBe('typescript');
  });

  it('resolves relative .js import', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./script', path.join(tmpDir, 'source.efs'));
    // .d.ts doesn't exist for 'script', .ts doesn't exist either, falls to .js
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('js');
  });

  it('resolves relative .ts import as dts kind', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./helper', path.join(tmpDir, 'source.efs'));
    // helper.ts exists — treated as dts kind (TS API can read it)
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
  });

  it('resolves parent directory relative paths', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('../utils', path.join(tmpDir, 'subdir', 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.path).toBe(path.join(tmpDir, 'utils.d.ts'));
  });

  // ── .d.cts / .d.mts classification ─────────────────────────

  it('resolves relative .d.cts import as dts kind', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./cjs-module', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.path).toBe(path.join(tmpDir, 'cjs-module.d.cts'));
  });

  it('resolves relative .d.mts import as dts kind', () => {
    const resolver = new NodeModuleResolver({ basePath });
    const result = resolver.resolve('./esm-module', path.join(tmpDir, 'source.efs'));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dts');
    expect(result!.path).toBe(path.join(tmpDir, 'esm-module.d.mts'));
  });
});
