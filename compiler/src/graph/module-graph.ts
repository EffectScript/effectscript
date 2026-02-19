/**
 * @module graph/module-graph
 *
 * Module dependency graph for multi-file compilation. Tracks import relationships
 * between EffectScript and external modules, computes topological compilation order,
 * detects circular imports, and manages per-module export signatures.
 */

import type { ExportedTypeSignature } from '../checker/types.js';

// ── Types ──────────────────────────────────────────────────

/** A directed edge representing one import statement in the source. */
export interface ImportEdge {
  /** The raw import specifier as written in source (e.g. `"./utils"` or `"lodash"`). */
  readonly specifier: string;
  /** The fully-resolved absolute path to the imported module. */
  readonly resolvedPath: string;
  /** The named bindings imported (e.g. `["foo", "bar"]` from `import { foo, bar }`). */
  readonly importedNames: string[];
  /** Whether this is a default import (`import Foo from "mod"`). */
  readonly isDefault: boolean;
}

/** A node in the module graph representing a single module (source file or external package). */
export interface ModuleNode {
  /** Absolute path to the module file. */
  readonly path: string;
  /** Whether this is an EffectScript source file or an external (npm) dependency. */
  readonly kind: 'efs' | 'external';
  /** Import edges originating from this module. */
  readonly imports: readonly ImportEdge[];
  /** FNV-1a hash of the file content, for future incremental compilation support. */
  readonly fileHash: string;
  /** Whether this module needs recompilation (content changed since last build). */
  readonly dirty: boolean;
  /** For external modules, the npm package name (e.g. `"lodash"`). */
  readonly packageName?: string;
  /** The module's exported type signature, populated after type checking. */
  exports: ExportedTypeSignature | null;
}

// ── Query API ──────────────────────────────────────────────

/** Read-only query interface for traversing the module dependency graph. */
export interface ModuleGraph {
  /** Look up a module node by its absolute path. Returns `null` if not found. */
  getNode(path: string): ModuleNode | null;
  /** Return all nodes in the graph (both `.efs` and external). */
  getAllNodes(): readonly ModuleNode[];
  /** Return only EffectScript (`.efs`) nodes. */
  getEfsNodes(): readonly ModuleNode[];
  /** Return the direct dependencies (imports) of the given module. */
  getDependencies(path: string): readonly ModuleNode[];
  /** Return modules that directly import the given module. */
  getDependents(path: string): readonly ModuleNode[];
  /** Return all modules that transitively depend on the given module (BFS). */
  getTransitiveDependents(path: string): readonly ModuleNode[];
  /** Return the exported type signature for a module, or `null` if unavailable. */
  getExports(path: string): ExportedTypeSignature | null;
  /**
   * Compute a topological compilation order for all `.efs` modules using Kahn's algorithm.
   * Nodes at the same level are sorted alphabetically for determinism.
   * @throws If a circular import is detected among `.efs` modules.
   */
  getCompilationOrder(): readonly string[];
  /** Return paths of all modules marked as dirty (needing recompilation). */
  getDirtyFiles(): readonly string[];
}

// ── Builder API ────────────────────────────────────────────

/** Mutation interface for constructing a module graph incrementally during compilation. */
export interface ModuleGraphBuilder {
  /** Register a new module node. No-op if the path already exists. */
  addNode(path: string, kind: 'efs' | 'external', fileHash: string, packageName?: string): void;
  /**
   * Add an import edge from one module to another.
   * @throws If the source node (`fromPath`) has not been added yet.
   */
  addImportEdge(fromPath: string, edge: ImportEdge): void;
  /** Attach an exported type signature to a module after type checking. */
  setExports(path: string, exports: ExportedTypeSignature): void;
  /** Flag a module as needing recompilation. */
  markDirty(path: string): void;
  /** Finalize the graph and return a read-only query interface. */
  build(): ModuleGraph;
}

// ── Internal mutable node ──────────────────────────────────

/** Internal mutable variant of {@link ModuleNode} used during graph construction. */
interface MutableNode extends ModuleNode {
  imports: ImportEdge[];
  dirty: boolean;
  exports: ExportedTypeSignature | null;
}

// ── Implementation ─────────────────────────────────────────

/**
 * Concrete implementation of both {@link ModuleGraph} and {@link ModuleGraphBuilder}.
 *
 * Stores module nodes in a `Map` keyed by absolute path. The same instance
 * serves as both the mutable builder (during graph construction) and the
 * read-only query interface (after `build()` returns `this`).
 */
export class ModuleGraphImpl implements ModuleGraph, ModuleGraphBuilder {
  private readonly nodes = new Map<string, MutableNode>();

  // ── Builder methods ──

  /** @inheritDoc */
  addNode(path: string, kind: 'efs' | 'external', fileHash: string, packageName?: string): void {
    if (this.nodes.has(path)) return; // no-op for duplicates

    const node: Record<string, unknown> = {
      path,
      kind,
      imports: [],
      fileHash,
      dirty: false,
      exports: null,
    };
    if (packageName !== undefined) node['packageName'] = packageName;
    this.nodes.set(path, node as unknown as MutableNode);
  }

  /** @inheritDoc */
  addImportEdge(fromPath: string, edge: ImportEdge): void {
    const node = this.nodes.get(fromPath);
    if (!node) {
      throw new Error(`Cannot add import edge: source node '${fromPath}' does not exist`);
    }
    node.imports.push(edge);
  }

  /** @inheritDoc */
  setExports(path: string, exports: ExportedTypeSignature): void {
    const node = this.nodes.get(path);
    if (node) {
      node.exports = exports;
    }
  }

  /** @inheritDoc */
  markDirty(path: string): void {
    const node = this.nodes.get(path);
    if (node) {
      node.dirty = true;
    }
  }

  /** @inheritDoc */
  build(): ModuleGraph {
    return this;
  }

  // ── Query methods ──

  /** @inheritDoc */
  getNode(path: string): ModuleNode | null {
    return this.nodes.get(path) ?? null;
  }

  /** @inheritDoc */
  getAllNodes(): readonly ModuleNode[] {
    return [...this.nodes.values()];
  }

  /** @inheritDoc */
  getEfsNodes(): readonly ModuleNode[] {
    return [...this.nodes.values()].filter(n => n.kind === 'efs');
  }

  /** @inheritDoc */
  getDependencies(path: string): readonly ModuleNode[] {
    const node = this.nodes.get(path);
    if (!node) return [];

    const deps: ModuleNode[] = [];
    const seen = new Set<string>();
    for (const edge of node.imports) {
      if (!seen.has(edge.resolvedPath)) {
        seen.add(edge.resolvedPath);
        const dep = this.nodes.get(edge.resolvedPath);
        if (dep) deps.push(dep);
      }
    }
    return deps;
  }

  /** @inheritDoc */
  getDependents(path: string): readonly ModuleNode[] {
    const dependents: ModuleNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.path === path) continue;
      for (const edge of node.imports) {
        if (edge.resolvedPath === path) {
          dependents.push(node);
          break;
        }
      }
    }
    return dependents;
  }

  /** @inheritDoc */
  getTransitiveDependents(path: string): readonly ModuleNode[] {
    const visited = new Set<string>();
    const queue: string[] = [path];
    visited.add(path);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const directDeps = this.getDependents(current);
      for (const dep of directDeps) {
        if (!visited.has(dep.path)) {
          visited.add(dep.path);
          queue.push(dep.path);
        }
      }
    }

    visited.delete(path); // exclude self
    return [...visited].map(p => this.nodes.get(p)!);
  }

  /** @inheritDoc */
  getExports(path: string): ExportedTypeSignature | null {
    const node = this.nodes.get(path);
    if (!node) return null;
    return node.exports;
  }

  /** @inheritDoc */
  getCompilationOrder(): readonly string[] {
    // Kahn's algorithm on .efs nodes only.
    // In-degree = number of unique .efs dependencies (files this node imports).
    // Nodes with in-degree 0 have no .efs dependencies and can be compiled first.
    const efsNodes = new Map<string, MutableNode>();
    for (const [path, node] of this.nodes) {
      if (node.kind === 'efs') {
        efsNodes.set(path, node);
      }
    }

    if (efsNodes.size === 0) return [];

    // Compute in-degree for each node: count of unique .efs imports
    const inDegree = new Map<string, number>();
    for (const [_path, node] of efsNodes) {
      const efsDeps = new Set<string>();
      for (const edge of node.imports) {
        if (efsNodes.has(edge.resolvedPath)) {
          efsDeps.add(edge.resolvedPath);
        }
      }
      inDegree.set(node.path, efsDeps.size);
    }

    // Initialize queue with nodes that have no .efs dependencies (in-degree 0)
    // Sort alphabetically for determinism
    const queue: string[] = [];
    for (const [path, deg] of inDegree) {
      if (deg === 0) queue.push(path);
    }
    queue.sort();

    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // For each node that depends on current, decrement their in-degree
      for (const [path, node] of efsNodes) {
        if (path === current) continue;
        let dependsOnCurrent = false;
        for (const edge of node.imports) {
          if (edge.resolvedPath === current) {
            dependsOnCurrent = true;
            break;
          }
        }
        if (dependsOnCurrent) {
          const newDeg = (inDegree.get(path) ?? 0) - 1;
          inDegree.set(path, newDeg);
          if (newDeg === 0) {
            // Insert in sorted position for determinism
            this.insertSorted(queue, path);
          }
        }
      }
    }

    if (result.length < efsNodes.size) {
      // Cycle detected — find the cycle path via DFS
      const resultSet = new Set(result);
      const remaining = new Set<string>();
      for (const path of efsNodes.keys()) {
        if (!resultSet.has(path)) {
          remaining.add(path);
        }
      }
      const cyclePath = this.findCyclePath(remaining, efsNodes);
      throw new Error(`Circular import detected: ${cyclePath}`);
    }

    return result;
  }

  /** @inheritDoc */
  getDirtyFiles(): readonly string[] {
    const dirty: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.dirty) {
        dirty.push(node.path);
      }
    }
    return dirty;
  }

  // ── Private helpers ──

  /** Insert a value into a sorted array while maintaining alphabetical order. */
  private insertSorted(arr: string[], value: string): void {
    let i = 0;
    while (i < arr.length && arr[i] < value) i++;
    arr.splice(i, 0, value);
  }

  /**
   * Find a human-readable cycle path among the remaining (unordered) nodes via DFS.
   * @returns A string like `"a.efs → b.efs → a.efs"` describing the cycle.
   */
  private findCyclePath(remaining: Set<string>, efsNodes: Map<string, MutableNode>): string {
    // DFS to find a cycle in the remaining nodes
    const visited = new Set<string>();
    const stack = new Set<string>();
    const parent = new Map<string, string>();

    for (const start of remaining) {
      const cycle = this.dfsForCycle(start, efsNodes, remaining, visited, stack, parent);
      if (cycle) return cycle;
    }

    // Fallback: list all remaining
    return [...remaining].join(' → ');
  }

  /**
   * Depth-first search from a single node looking for a back-edge (cycle).
   * @returns The formatted cycle path string, or `null` if no cycle found from this start.
   */
  private dfsForCycle(
    node: string,
    efsNodes: Map<string, MutableNode>,
    remaining: Set<string>,
    visited: Set<string>,
    stack: Set<string>,
    parent: Map<string, string>,
  ): string | null {
    if (stack.has(node)) {
      // Found cycle — reconstruct path
      const path: string[] = [node];
      let current = parent.get(node);
      while (current && current !== node) {
        path.push(current);
        current = parent.get(current);
      }
      path.push(node);
      path.reverse();
      return path.join(' → ');
    }

    if (visited.has(node)) return null;

    visited.add(node);
    stack.add(node);

    const moduleNode = efsNodes.get(node);
    if (moduleNode) {
      for (const edge of moduleNode.imports) {
        if (remaining.has(edge.resolvedPath)) {
          parent.set(edge.resolvedPath, node);
          const cycle = this.dfsForCycle(edge.resolvedPath, efsNodes, remaining, visited, stack, parent);
          if (cycle) return cycle;
        }
      }
    }

    stack.delete(node);
    return null;
  }
}

// ── Content Hashing (FNV-1a) ───────────────────────────────

/**
 * Compute a 32-bit FNV-1a hash of a string, returned as an 8-character hex string.
 *
 * Used for content hashing of source files to support future incremental compilation.
 * FNV-1a provides good distribution with minimal code and no external dependencies.
 */
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
  }
  // Convert to unsigned 32-bit hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}
