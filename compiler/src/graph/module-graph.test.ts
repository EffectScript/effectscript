import { describe, it, expect } from 'vitest';
import type { ModuleGraph, ModuleGraphBuilder, ImportEdge } from './module-graph.js';
import { ModuleGraphImpl, fnv1aHash } from './module-graph.js';

// ── Helpers ────────────────────────────────────────────────

function makeBuilder(): ModuleGraphImpl {
  return new ModuleGraphImpl();
}

function makeEdge(specifier: string, resolvedPath: string, names: string[] = [], isDefault = false): ImportEdge {
  return { specifier, resolvedPath, importedNames: names, isDefault };
}

// ── Graph Construction ─────────────────────────────────────

describe('ModuleGraph — construction', () => {
  it('adds and retrieves a single efs node', () => {
    const b = makeBuilder();
    b.addNode('/src/a.efs', 'efs', 'hash-a');
    const graph: ModuleGraph = b.build();

    const node = graph.getNode('/src/a.efs');
    expect(node).not.toBeNull();
    expect(node!.path).toBe('/src/a.efs');
    expect(node!.kind).toBe('efs');
    expect(node!.fileHash).toBe('hash-a');
    expect(node!.dirty).toBe(false);
    expect(node!.exports).toBeNull();
  });

  it('returns null for unknown node', () => {
    const b = makeBuilder();
    const graph = b.build();
    expect(graph.getNode('/nope')).toBeNull();
  });

  it('getAllNodes returns all nodes', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'h1');
    b.addNode('/b.efs', 'efs', 'h2');
    b.addNode('/ext.d.ts', 'external', 'h3');
    const graph = b.build();

    const all = graph.getAllNodes();
    expect(all).toHaveLength(3);
  });

  it('getEfsNodes returns only efs nodes', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'h1');
    b.addNode('/ext.d.ts', 'external', 'h2');
    const graph = b.build();

    const efs = graph.getEfsNodes();
    expect(efs).toHaveLength(1);
    expect(efs[0].kind).toBe('efs');
  });

  it('stores packageName on external node', () => {
    const b = makeBuilder();
    b.addNode('/node_modules/react/index.d.ts', 'external', 'hr', 'react');
    const graph = b.build();

    const node = graph.getNode('/node_modules/react/index.d.ts');
    expect(node!.packageName).toBe('react');
  });

  it('stores fileHash on node', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'abc123');
    const graph = b.build();

    expect(graph.getNode('/a.efs')!.fileHash).toBe('abc123');
  });

  it('duplicate addNode is a no-op', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'hash1');
    b.addNode('/a.efs', 'efs', 'hash2'); // no-op
    const graph = b.build();

    expect(graph.getAllNodes()).toHaveLength(1);
    expect(graph.getNode('/a.efs')!.fileHash).toBe('hash1');
  });

  it('addImportEdge throws for nonexistent source', () => {
    const b = makeBuilder();
    b.addNode('/b.efs', 'efs', 'hb');

    expect(() => {
      b.addImportEdge('/nonexistent.efs', makeEdge('./b', '/b.efs', ['foo']));
    }).toThrow();
  });

  it('adds import edges and getDependencies returns them', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', ['foo']));
    const graph = b.build();

    const deps = graph.getDependencies('/a.efs');
    expect(deps).toHaveLength(1);
    expect(deps[0].path).toBe('/b.efs');
  });

  it('getDependents returns reverse edges', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', ['foo']));
    const graph = b.build();

    const dependents = graph.getDependents('/b.efs');
    expect(dependents).toHaveLength(1);
    expect(dependents[0].path).toBe('/a.efs');
  });

  it('external node is a leaf with no dependencies', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/ext.d.ts', 'external', 'he');
    b.addImportEdge('/a.efs', makeEdge('ext', '/ext.d.ts', ['bar']));
    const graph = b.build();

    expect(graph.getDependencies('/ext.d.ts')).toHaveLength(0);
    expect(graph.getDependents('/ext.d.ts')).toHaveLength(1);
  });

  it('node imports list stores edges', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', ['x', 'y'], false));
    const graph = b.build();

    const node = graph.getNode('/a.efs')!;
    expect(node.imports).toHaveLength(1);
    expect(node.imports[0].specifier).toBe('./b');
    expect(node.imports[0].importedNames).toEqual(['x', 'y']);
    expect(node.imports[0].isDefault).toBe(false);
  });
});

// ── Transitive Dependents ─────────────────────────────────

describe('ModuleGraph — getTransitiveDependents', () => {
  it('returns direct and transitive dependents', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', ['x']));
    b.addImportEdge('/b.efs', makeEdge('./c', '/c.efs', ['y']));
    const graph = b.build();

    const trans = graph.getTransitiveDependents('/c.efs');
    const paths = trans.map(n => n.path).sort();
    expect(paths).toEqual(['/a.efs', '/b.efs']);
  });

  it('returns empty for node with no dependents', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    const graph = b.build();
    expect(graph.getTransitiveDependents('/a.efs')).toHaveLength(0);
  });

  it('handles diamond dependents', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addNode('/d.efs', 'efs', 'hd');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/a.efs', makeEdge('./c', '/c.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./d', '/d.efs', []));
    b.addImportEdge('/c.efs', makeEdge('./d', '/d.efs', []));
    const graph = b.build();

    const trans = graph.getTransitiveDependents('/d.efs');
    const paths = trans.map(n => n.path).sort();
    expect(paths).toEqual(['/a.efs', '/b.efs', '/c.efs']);
  });
});

// ── Topological Sort ───────────────────────────────────────

describe('ModuleGraph — getCompilationOrder', () => {
  it('linear chain: A→B→C gives [C, B, A]', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./c', '/c.efs', []));
    const graph = b.build();

    expect(graph.getCompilationOrder()).toEqual(['/c.efs', '/b.efs', '/a.efs']);
  });

  it('diamond: D compiled first, A last', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addNode('/d.efs', 'efs', 'hd');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/a.efs', makeEdge('./c', '/c.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./d', '/d.efs', []));
    b.addImportEdge('/c.efs', makeEdge('./d', '/d.efs', []));
    const graph = b.build();

    const order = graph.getCompilationOrder();
    expect(order[0]).toBe('/d.efs');
    expect(order[order.length - 1]).toBe('/a.efs');
    // B and C in between in alphabetical order
    expect(order[1]).toBe('/b.efs');
    expect(order[2]).toBe('/c.efs');
  });

  it('independent files in alphabetical order', () => {
    const b = makeBuilder();
    b.addNode('/z.efs', 'efs', 'hz');
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/m.efs', 'efs', 'hm');
    const graph = b.build();

    expect(graph.getCompilationOrder()).toEqual(['/a.efs', '/m.efs', '/z.efs']);
  });

  it('single file returns it', () => {
    const b = makeBuilder();
    b.addNode('/only.efs', 'efs', 'ho');
    const graph = b.build();

    expect(graph.getCompilationOrder()).toEqual(['/only.efs']);
  });

  it('empty graph returns empty', () => {
    const b = makeBuilder();
    const graph = b.build();
    expect(graph.getCompilationOrder()).toEqual([]);
  });

  it('excludes external nodes from compilation order', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/ext.d.ts', 'external', 'he');
    b.addImportEdge('/a.efs', makeEdge('ext', '/ext.d.ts', []));
    const graph = b.build();

    const order = graph.getCompilationOrder();
    expect(order).toEqual(['/a.efs']);
  });
});

// ── Cycle Detection ────────────────────────────────────────

describe('ModuleGraph — cycle detection', () => {
  it('detects 2-node cycle A→B→A', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./a', '/a.efs', []));
    const graph = b.build();

    expect(() => graph.getCompilationOrder()).toThrow(/[Cc]ircular|[Cc]ycle/);
  });

  it('detects 3-node cycle A→B→C→A', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./c', '/c.efs', []));
    b.addImportEdge('/c.efs', makeEdge('./a', '/a.efs', []));
    const graph = b.build();

    expect(() => graph.getCompilationOrder()).toThrow(/[Cc]ircular|[Cc]ycle/);
  });

  it('detects self-cycle A→A', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addImportEdge('/a.efs', makeEdge('./a', '/a.efs', []));
    const graph = b.build();

    expect(() => graph.getCompilationOrder()).toThrow(/[Cc]ircular|[Cc]ycle/);
  });

  it('cycle error includes cycle path', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./a', '/a.efs', []));
    const graph = b.build();

    try {
      graph.getCompilationOrder();
      expect.fail('should have thrown');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).toContain('/a.efs');
      expect(msg).toContain('/b.efs');
    }
  });

  it('partial cycle: non-cycled files still compile', () => {
    // d is independent, b→c→b is a cycle, a→b
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    b.addNode('/c.efs', 'efs', 'hc');
    b.addNode('/d.efs', 'efs', 'hd');
    b.addImportEdge('/a.efs', makeEdge('./b', '/b.efs', []));
    b.addImportEdge('/b.efs', makeEdge('./c', '/c.efs', []));
    b.addImportEdge('/c.efs', makeEdge('./b', '/b.efs', []));
    const graph = b.build();

    // Should throw because of the cycle
    expect(() => graph.getCompilationOrder()).toThrow(/[Cc]ircular|[Cc]ycle/);
  });
});

// ── Export Tracking ────────────────────────────────────────

describe('ModuleGraph — export tracking', () => {
  it('setExports and getExports round-trips', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    const graph = b.build();

    const sig = {
      types: new Map(),
      values: new Map([['foo', { kind: 'primitive' as const, name: 'number' as const }]]),
      adtConstructors: new Map(),
    };
    b.setExports('/a.efs', sig);
    expect(graph.getExports('/a.efs')).toBe(sig);
  });

  it('getExports returns null for unknown node', () => {
    const b = makeBuilder();
    const graph = b.build();
    expect(graph.getExports('/unknown')).toBeNull();
  });

  it('getExports returns null before setExports', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    const graph = b.build();
    expect(graph.getExports('/a.efs')).toBeNull();
  });
});

// ── Dirty Tracking ─────────────────────────────────────────

describe('ModuleGraph — dirty tracking', () => {
  it('markDirty sets dirty flag', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    const graph = b.build();

    expect(graph.getDirtyFiles()).toHaveLength(0);
    b.markDirty('/a.efs');
    expect(graph.getDirtyFiles()).toHaveLength(1);
    expect(graph.getDirtyFiles()[0]).toBe('/a.efs');
  });

  it('dirty node shows in getDirtyFiles', () => {
    const b = makeBuilder();
    b.addNode('/a.efs', 'efs', 'ha');
    b.addNode('/b.efs', 'efs', 'hb');
    const graph = b.build();

    b.markDirty('/a.efs');
    const dirty = graph.getDirtyFiles();
    expect(dirty).toEqual(['/a.efs']);
  });
});

// ── Content Hashing ────────────────────────────────────────

describe('fnv1aHash', () => {
  it('returns a string', () => {
    expect(typeof fnv1aHash('hello')).toBe('string');
  });

  it('same input produces same hash', () => {
    expect(fnv1aHash('test')).toBe(fnv1aHash('test'));
  });

  it('different inputs produce different hashes', () => {
    expect(fnv1aHash('abc')).not.toBe(fnv1aHash('def'));
  });

  it('empty string produces a hash', () => {
    expect(fnv1aHash('')).toBeTruthy();
  });
});
