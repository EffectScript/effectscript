import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ExportedTypeSignature, FunctionType, Type } from '../checker/types.js';
import {
  serializeSignature,
  deserializeSignature,
  DiskBackedDeclarationCache,
} from './disk-cache.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSig(
  types: Record<string, Type> = {},
  values: Record<string, Type> = {},
  adtConstructors: Record<string, FunctionType> = {},
): ExportedTypeSignature {
  return {
    types: new Map(Object.entries(types)),
    values: new Map(Object.entries(values)),
    adtConstructors: new Map(Object.entries(adtConstructors)),
    extensions: new Map(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'efs-cache-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Serialization Tests ─────────────────────────────────────────────

describe('serializeSignature / deserializeSignature', () => {
  it('round-trips empty signature', () => {
    const sig = makeSig();
    const json = serializeSignature(sig);
    const restored = deserializeSignature(json);
    expect(restored.types.size).toBe(0);
    expect(restored.values.size).toBe(0);
    expect(restored.adtConstructors.size).toBe(0);
  });

  it('round-trips signature with primitive types', () => {
    const sig = makeSig(
      { MyNum: { kind: 'primitive', name: 'number' } },
      { myStr: { kind: 'primitive', name: 'string' } },
    );
    const restored = deserializeSignature(serializeSignature(sig));
    expect(restored.types.get('MyNum')).toEqual({ kind: 'primitive', name: 'number' });
    expect(restored.values.get('myStr')).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('round-trips signature with RecordType (Map fields)', () => {
    const fields = new Map<string, Type>([
      ['name', { kind: 'primitive', name: 'string' }],
      ['age', { kind: 'primitive', name: 'number' }],
    ]);
    const sig = makeSig({ User: { kind: 'record', fields } });
    const restored = deserializeSignature(serializeSignature(sig));
    const user = restored.types.get('User');
    expect(user).toBeDefined();
    expect(user!.kind).toBe('record');
    const rec = user as import('../checker/types.js').RecordType;
    expect(rec.fields).toBeInstanceOf(Map);
    expect(rec.fields.get('name')).toEqual({ kind: 'primitive', name: 'string' });
    expect(rec.fields.get('age')).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('round-trips signature with FunctionType and ADT', () => {
    const fn: FunctionType = {
      kind: 'function',
      params: [{ name: 'x', type: { kind: 'primitive', name: 'number' }, optional: false, hasDefault: false }],
      returnType: { kind: 'primitive', name: 'string' },
    };
    const adt: Type = {
      kind: 'adt',
      name: 'Color',
      typeArgs: [],
      variants: [
        { name: 'Red', fields: new Map() },
        { name: 'Green', fields: new Map() },
      ],
    };
    const sig = makeSig({ Color: adt }, { myFn: fn }, { Red: fn });
    const restored = deserializeSignature(serializeSignature(sig));
    expect(restored.values.get('myFn')).toEqual(fn);
    expect(restored.adtConstructors.get('Red')).toEqual(fn);
    // Check ADT variant fields are Maps
    const color = restored.types.get('Color') as import('../checker/types.js').ADTType;
    expect(color.variants[0].fields).toBeInstanceOf(Map);
  });

  it('round-trips signature with nullable, array, union, tuple types', () => {
    const sig = makeSig({}, {
      nullable: { kind: 'nullable', inner: { kind: 'primitive', name: 'string' } },
      arr: { kind: 'array', element: { kind: 'primitive', name: 'number' } },
      union: { kind: 'union', members: [{ kind: 'primitive', name: 'string' }, { kind: 'primitive', name: 'number' }] },
      tuple: { kind: 'tuple', elements: [{ kind: 'primitive', name: 'string' }, { kind: 'primitive', name: 'number' }] },
      promise: { kind: 'promise', inner: { kind: 'primitive', name: 'string' } },
      any: { kind: 'any' },
      nil: { kind: 'null' },
      err: { kind: 'error' },
      generic: { kind: 'generic', name: 'T' },
    });
    const restored = deserializeSignature(serializeSignature(sig));
    expect(restored.values.get('nullable')).toEqual({ kind: 'nullable', inner: { kind: 'primitive', name: 'string' } });
    expect(restored.values.get('arr')).toEqual({ kind: 'array', element: { kind: 'primitive', name: 'number' } });
    expect(restored.values.get('any')).toEqual({ kind: 'any' });
  });

  it('round-trips function with rest parameter', () => {
    const fnWithRest: import('../checker/types.js').FunctionType = {
      kind: 'function',
      params: [{ name: 'msg', type: { kind: 'primitive', name: 'string' }, optional: false, hasDefault: false }],
      returnType: { kind: 'primitive', name: 'void' },
      rest: { name: 'args', elementType: { kind: 'primitive', name: 'string' } },
    };
    const sig = makeSig({}, { log: fnWithRest });
    const restored = deserializeSignature(serializeSignature(sig));
    const restoredFn = restored.values.get('log') as import('../checker/types.js').FunctionType;
    expect(restoredFn.rest).toBeDefined();
    expect(restoredFn.rest!.name).toBe('args');
    expect(restoredFn.rest!.elementType).toEqual({ kind: 'primitive', name: 'string' });
  });
});

// ── DiskBackedDeclarationCache Tests ────────────────────────────────

describe('DiskBackedDeclarationCache', () => {
  function createDtsFile(content: string): string {
    const dtsPath = path.join(tmpDir, 'test.d.ts');
    fs.writeFileSync(dtsPath, content);
    return dtsPath;
  }

  it('cache miss returns null on empty cache dir', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    expect(cache.get('/some/module.d.ts')).toBeNull();
  });

  it('cache hit returns correct signature after set', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    cache.set(dtsPath, sig);

    // New cache instance reads from disk
    const cache2 = new DiskBackedDeclarationCache(cacheDir);
    const result = cache2.get(dtsPath);
    expect(result).not.toBeNull();
    expect(result!.values.get('x')).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('hash mismatch triggers cache invalidation', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    const cache = new DiskBackedDeclarationCache(cacheDir);
    cache.set(dtsPath, sig);

    // Change the .d.ts file content
    fs.writeFileSync(dtsPath, 'export declare const x: string;');

    // New cache instance should miss due to hash mismatch
    const cache2 = new DiskBackedDeclarationCache(cacheDir);
    expect(cache2.get(dtsPath)).toBeNull();
  });

  it('disabled mode skips disk operations', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir, true);
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    cache.set(dtsPath, sig);

    // Cache dir should not be created
    expect(fs.existsSync(cacheDir)).toBe(false);

    // In-memory still works within same instance
    expect(cache.get(dtsPath)).not.toBeNull();
  });

  it('corrupted cache file treated as miss', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const declDir = path.join(cacheDir, 'declarations');
    fs.mkdirSync(declDir, { recursive: true });

    const dtsPath = createDtsFile('export declare const x: number;');

    // Write a corrupted manifest
    const manifest = {
      version: 1,
      entries: { [dtsPath]: { hash: 'fakehash', cachedAt: Date.now() } },
    };
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest));
    // Write corrupted cache file
    fs.writeFileSync(path.join(declDir, 'fakehash.json'), 'not valid json{{{');

    const cache = new DiskBackedDeclarationCache(cacheDir);
    // Should not throw — treats as miss
    expect(cache.get(dtsPath)).toBeNull();
  });

  it('missing cache directory is created on write', () => {
    const cacheDir = path.join(tmpDir, 'deep', 'nested', '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    cache.set(dtsPath, sig);

    expect(fs.existsSync(path.join(cacheDir, 'declarations'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'manifest.json'))).toBe(true);
  });

  it('tracks hit/miss stats', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    cache.get(dtsPath); // miss
    cache.set(dtsPath, sig);
    cache.get(dtsPath); // hit

    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it('invalidate removes from both memory and disk', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    const dtsPath = createDtsFile('export declare const x: number;');
    const sig = makeSig({}, { x: { kind: 'primitive', name: 'number' } });

    cache.set(dtsPath, sig);
    expect(cache.get(dtsPath)).not.toBeNull();

    cache.invalidate(dtsPath);
    expect(cache.get(dtsPath)).toBeNull();

    // Also removed from disk
    const cache2 = new DiskBackedDeclarationCache(cacheDir);
    expect(cache2.get(dtsPath)).toBeNull();
  });

  it('clear removes all entries', () => {
    const cacheDir = path.join(tmpDir, '.efs-cache');
    const cache = new DiskBackedDeclarationCache(cacheDir);
    const dtsPath = createDtsFile('export declare const x: number;');
    cache.set(dtsPath, makeSig({}, { x: { kind: 'primitive', name: 'number' } }));

    cache.clear();
    expect(cache.get(dtsPath)).toBeNull();
    expect(cache.getStats()).toEqual({ hits: 0, misses: 1 });
  });
});
