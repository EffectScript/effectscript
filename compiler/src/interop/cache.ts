/**
 * @module cache
 *
 * In-memory declaration cache for storing extracted TypeScript type signatures.
 * Caches {@link ExportedTypeSignature} values by module path and constructor
 * signatures by `module::name` composite keys. Tracks hit/miss statistics for
 * diagnostics and performance monitoring.
 */
import type { ExportedTypeSignature, FunctionType } from '../checker/types.js';

// ── Interfaces ──────────────────────────────────────────────

/** Cumulative cache hit/miss counters. */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
}

/**
 * Caches extracted TypeScript declaration signatures to avoid redundant
 * re-extraction of the same module across multiple import sites.
 */
export interface DeclarationCache {
  /** Returns the cached signature for `modulePath`, or `null` on a miss. */
  get(modulePath: string): ExportedTypeSignature | null;

  /** Stores a signature for `modulePath`, replacing any existing entry. */
  set(modulePath: string, signature: ExportedTypeSignature): void;

  /**
   * Returns a cached constructor signature for a named export.
   * @returns The constructor type, `null` if explicitly cached as absent,
   *          or `undefined` if not yet cached.
   */
  getConstructor(modulePath: string, name: string): FunctionType | null | undefined;

  /** Caches a constructor signature (or `null` to mark absence). */
  setConstructor(modulePath: string, name: string, ctor: FunctionType | null): void;

  /** Removes the cached signature and all associated constructors for `modulePath`. */
  invalidate(modulePath: string): void;

  /** Clears all cached entries and resets hit/miss counters. */
  clear(): void;

  /** Returns cumulative hit/miss statistics. */
  getStats(): CacheStats;
}

// ── Implementation ──────────────────────────────────────────

/**
 * Simple in-memory implementation of {@link DeclarationCache}.
 *
 * Stores signatures in a `Map<string, ExportedTypeSignature>` keyed by
 * absolute module path. Constructor signatures use a composite
 * `"modulePath::exportName"` key. All data is lost when the process exits;
 * use {@link DiskBackedDeclarationCache} for persistence across invocations.
 */
export class InMemoryDeclarationCache implements DeclarationCache {
  private readonly signatures = new Map<string, ExportedTypeSignature>();
  private readonly constructors = new Map<string, FunctionType | null>();
  private hits = 0;
  private misses = 0;

  /** @inheritdoc */
  get(modulePath: string): ExportedTypeSignature | null {
    const sig = this.signatures.get(modulePath);
    if (sig !== undefined) {
      this.hits++;
      return sig;
    }
    this.misses++;
    return null;
  }

  /** @inheritdoc */
  set(modulePath: string, signature: ExportedTypeSignature): void {
    this.signatures.set(modulePath, signature);
  }

  /**
   * Looks up a constructor by the composite key `"modulePath::name"`.
   * @returns The cached constructor, `null` if cached as absent, or
   *          `undefined` if not yet cached (caller should extract and cache).
   */
  getConstructor(modulePath: string, name: string): FunctionType | null | undefined {
    const key = `${modulePath}::${name}`;
    if (!this.constructors.has(key)) {
      return undefined;
    }
    return this.constructors.get(key) as FunctionType | null;
  }

  /** @inheritdoc */
  setConstructor(modulePath: string, name: string, ctor: FunctionType | null): void {
    const key = `${modulePath}::${name}`;
    this.constructors.set(key, ctor);
  }

  /**
   * Removes the module signature and all constructor entries whose key
   * starts with `"modulePath::"`.
   */
  invalidate(modulePath: string): void {
    this.signatures.delete(modulePath);
    // Also remove constructors for this module
    const prefix = `${modulePath}::`;
    for (const key of this.constructors.keys()) {
      if (key.startsWith(prefix)) {
        this.constructors.delete(key);
      }
    }
  }

  /** @inheritdoc */
  clear(): void {
    this.signatures.clear();
    this.constructors.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** @inheritdoc */
  getStats(): CacheStats {
    return { hits: this.hits, misses: this.misses };
  }
}
