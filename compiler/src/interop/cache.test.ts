import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeclarationCache } from './cache.js';
import type { ExportedTypeSignature, FunctionType, Type } from '../checker/types.js';

function makeSig(values?: Record<string, Type>): ExportedTypeSignature {
  return {
    types: new Map(),
    values: new Map(Object.entries(values ?? {})),
    adtConstructors: new Map(),
    extensions: new Map(),
  };
}

const NUM: Type = { kind: 'primitive', name: 'number' };
const STR: Type = { kind: 'primitive', name: 'string' };

describe('InMemoryDeclarationCache', () => {
  let cache: InMemoryDeclarationCache;

  beforeEach(() => {
    cache = new InMemoryDeclarationCache();
  });

  it('returns null on cache miss', () => {
    expect(cache.get('/path/to/module.d.ts')).toBeNull();
  });

  it('returns cached signature on cache hit', () => {
    const sig = makeSig({ foo: NUM });
    cache.set('/path/to/module.d.ts', sig);
    expect(cache.get('/path/to/module.d.ts')).toBe(sig);
  });

  it('stores separate paths independently', () => {
    const sig1 = makeSig({ foo: NUM });
    const sig2 = makeSig({ bar: STR });
    cache.set('/path/a.d.ts', sig1);
    cache.set('/path/b.d.ts', sig2);
    expect(cache.get('/path/a.d.ts')).toBe(sig1);
    expect(cache.get('/path/b.d.ts')).toBe(sig2);
  });

  it('invalidates a single entry', () => {
    const sig = makeSig({ foo: NUM });
    cache.set('/path/a.d.ts', sig);
    cache.set('/path/b.d.ts', makeSig({ bar: STR }));
    cache.invalidate('/path/a.d.ts');
    expect(cache.get('/path/a.d.ts')).toBeNull();
    expect(cache.get('/path/b.d.ts')).not.toBeNull();
  });

  it('clears all entries and resets stats', () => {
    cache.set('/a.d.ts', makeSig({ x: NUM }));
    cache.get('/a.d.ts'); // hit
    cache.get('/b.d.ts'); // miss
    cache.clear();
    expect(cache.getStats()).toEqual({ hits: 0, misses: 0 });
    expect(cache.get('/a.d.ts')).toBeNull();
  });

  it('tracks hit/miss stats accurately', () => {
    const sig = makeSig({ foo: NUM });
    cache.set('/a.d.ts', sig);
    cache.get('/a.d.ts'); // hit
    cache.get('/a.d.ts'); // hit
    cache.get('/b.d.ts'); // miss
    cache.get('/c.d.ts'); // miss
    cache.get('/d.d.ts'); // miss
    expect(cache.getStats()).toEqual({ hits: 2, misses: 3 });
  });

  describe('constructor cache', () => {
    it('returns undefined for uncached constructor', () => {
      expect(cache.getConstructor('/a.d.ts', 'Foo')).toBeUndefined();
    });

    it('returns null for explicitly cached null constructor', () => {
      cache.setConstructor('/a.d.ts', 'Foo', null);
      expect(cache.getConstructor('/a.d.ts', 'Foo')).toBeNull();
    });

    it('returns cached FunctionType constructor', () => {
      const ctor: FunctionType = {
        kind: 'function',
        params: [{ name: 'x', type: NUM, optional: false, hasDefault: false }],
        returnType: { kind: 'record', fields: new Map() },
      };
      cache.setConstructor('/a.d.ts', 'Foo', ctor);
      expect(cache.getConstructor('/a.d.ts', 'Foo')).toBe(ctor);
    });

    it('invalidate removes constructors for that module', () => {
      const ctor: FunctionType = {
        kind: 'function',
        params: [],
        returnType: { kind: 'record', fields: new Map() },
      };
      cache.setConstructor('/a.d.ts', 'Foo', ctor);
      cache.setConstructor('/b.d.ts', 'Bar', ctor);
      cache.invalidate('/a.d.ts');
      expect(cache.getConstructor('/a.d.ts', 'Foo')).toBeUndefined();
      expect(cache.getConstructor('/b.d.ts', 'Bar')).toBe(ctor);
    });

    it('clear removes all constructors', () => {
      const ctor: FunctionType = {
        kind: 'function',
        params: [],
        returnType: { kind: 'record', fields: new Map() },
      };
      cache.setConstructor('/a.d.ts', 'Foo', ctor);
      cache.clear();
      expect(cache.getConstructor('/a.d.ts', 'Foo')).toBeUndefined();
    });
  });
});
