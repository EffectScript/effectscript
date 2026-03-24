/**
 * @module disk-cache
 *
 * Disk-backed declaration cache for persisting extracted TypeScript type
 * signatures across compiler invocations. Wraps {@link InMemoryDeclarationCache}
 * with a JSON-based disk tier using content hashing for invalidation.
 *
 * Cache layout on disk:
 * ```
 * <cacheDir>/
 *   manifest.json          — maps module paths → content hashes
 *   declarations/
 *     <hash>.json           — serialized ExportedTypeSignature
 * ```
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ExportedTypeSignature, ExportedExtension, FunctionType, Type } from '../checker/types.js';
import type { RecordType, ADTType } from '../checker/types.js';
import { InMemoryDeclarationCache } from './cache.js';
import type { DeclarationCache, CacheStats } from './cache.js';
import { fnv1aHash } from '../graph/module-graph.js';

// ── Manifest Types ──────────────────────────────────────────

/** Schema version for the on-disk manifest. Bumped when the format changes. */
const MANIFEST_VERSION = 1;

/** A single entry in the manifest, linking a module path to its content hash. */
interface ManifestEntry {
  readonly hash: string;
  readonly cachedAt: number;
}

/** On-disk manifest that tracks all cached declaration files and their content hashes. */
interface Manifest {
  readonly version: number;
  readonly entries: Record<string, ManifestEntry>;
}

// ── Serialization ───────────────────────────────────────────

/**
 * Serializes an ExportedTypeSignature to a JSON string.
 * Converts Map fields to plain objects for JSON compatibility.
 */
export function serializeSignature(sig: ExportedTypeSignature): string {
  const obj = {
    types: mapToRecord(sig.types, serializeType),
    values: mapToRecord(sig.values, serializeType),
    adtConstructors: mapToRecord(sig.adtConstructors, serializeType),
    extensions: mapToRecord(sig.extensions, (ext) => ({
      receiverType: serializeType(ext.receiverType),
      methodName: ext.methodName,
      fnType: serializeType(ext.fnType),
      emitName: ext.emitName,
    })),
  };
  return JSON.stringify(obj);
}

/**
 * Deserializes an ExportedTypeSignature from a JSON string.
 * Converts plain objects back to Maps where needed.
 */
export function deserializeSignature(json: string): ExportedTypeSignature {
  const obj = JSON.parse(json) as {
    types: Record<string, unknown>;
    values: Record<string, unknown>;
    adtConstructors: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
  return {
    types: recordToMap(obj.types, deserializeType),
    values: recordToMap(obj.values, deserializeType),
    adtConstructors: recordToMap(obj.adtConstructors, deserializeType) as ReadonlyMap<string, FunctionType>,
    extensions: obj.extensions
      ? recordToMap(obj.extensions, (raw) => {
          const e = raw as { receiverType: unknown; methodName: string; fnType: unknown; emitName: string };
          return {
            receiverType: deserializeType(e.receiverType),
            methodName: e.methodName,
            fnType: deserializeType(e.fnType) as FunctionType,
            emitName: e.emitName,
          } as ExportedExtension;
        })
      : new Map(),
  };
}

/** Converts a `Map<string, V>` to a plain object, applying `transform` to each value. */
function mapToRecord<V>(map: ReadonlyMap<string, V>, transform: (v: V) => unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of map) {
    result[key] = transform(value);
  }
  return result;
}

/** Converts a plain object to a `Map<string, V>`, applying `transform` to each value. */
function recordToMap<V>(record: Record<string, unknown>, transform: (v: unknown) => V): Map<string, V> {
  const map = new Map<string, V>();
  for (const [key, value] of Object.entries(record)) {
    map.set(key, transform(value));
  }
  return map;
}

/** Convert a Type to a JSON-safe object, converting Map fields to plain objects. */
function serializeType(type: unknown): unknown {
  const t = type as Type;
  if (t.kind === 'record') {
    return { kind: 'record', fields: mapToRecord((t as RecordType).fields, serializeType) };
  }
  if (t.kind === 'adt') {
    const adt = t as ADTType;
    return {
      kind: 'adt',
      name: adt.name,
      typeArgs: adt.typeArgs.map(serializeType),
      variants: adt.variants.map(v => ({
        name: v.name,
        fields: mapToRecord(v.fields, serializeType),
      })),
    };
  }
  if (t.kind === 'function') {
    return {
      kind: 'function',
      params: t.params.map(p => ({ ...p, type: serializeType(p.type) })),
      returnType: serializeType(t.returnType),
      ...(t.typeParams ? { typeParams: t.typeParams } : {}),
    };
  }
  if (t.kind === 'nullable') return { kind: 'nullable', inner: serializeType(t.inner) };
  if (t.kind === 'array') return { kind: 'array', element: serializeType(t.element) };
  if (t.kind === 'promise') return { kind: 'promise', inner: serializeType(t.inner) };
  if (t.kind === 'tuple') return { kind: 'tuple', elements: t.elements.map(serializeType) };
  if (t.kind === 'union') return { kind: 'union', members: t.members.map(serializeType) };
  // Leaf types (primitive, any, null, error, generic, typevar) serialize as-is
  return t;
}

/** Convert a JSON-parsed object back to a Type, restoring Map fields. */
function deserializeType(obj: unknown): Type {
  const t = obj as Record<string, unknown>;
  const kind = t['kind'] as string;
  if (kind === 'record') {
    return { kind: 'record', fields: recordToMap(t['fields'] as Record<string, unknown>, deserializeType) } as RecordType;
  }
  if (kind === 'adt') {
    return {
      kind: 'adt',
      name: t['name'] as string,
      typeArgs: (t['typeArgs'] as unknown[]).map(deserializeType),
      variants: (t['variants'] as Array<{ name: string; fields: Record<string, unknown> }>).map(v => ({
        name: v.name,
        fields: recordToMap(v.fields, deserializeType),
      })),
    } as ADTType;
  }
  if (kind === 'function') {
    const params = (t['params'] as Array<Record<string, unknown>>).map(p => ({
      name: p['name'] as string,
      type: deserializeType(p['type']),
      optional: p['optional'] as boolean,
      hasDefault: p['hasDefault'] as boolean,
      ...(p['nullKind'] !== undefined ? { nullKind: p['nullKind'] } : {}),
    }));
    const result: Record<string, unknown> = {
      kind: 'function',
      params,
      returnType: deserializeType(t['returnType']),
    };
    if (t['typeParams']) result['typeParams'] = t['typeParams'];
    return result as unknown as Type;
  }
  if (kind === 'nullable') return { kind: 'nullable', inner: deserializeType(t['inner']) };
  if (kind === 'array') return { kind: 'array', element: deserializeType(t['element']) };
  if (kind === 'promise') return { kind: 'promise', inner: deserializeType(t['inner']) };
  if (kind === 'tuple') return { kind: 'tuple', elements: (t['elements'] as unknown[]).map(deserializeType) };
  if (kind === 'union') return { kind: 'union', members: (t['members'] as unknown[]).map(deserializeType) };
  // Leaf types
  return obj as Type;
}

// ── DiskBackedDeclarationCache ──────────────────────────────

/**
 * Two-tier declaration cache: in-memory + disk.
 * On get: checks memory → disk → returns null.
 * On set: writes to both memory and disk.
 * Uses FNV-1a content hashing of .d.ts files for invalidation.
 */
export class DiskBackedDeclarationCache implements DeclarationCache {
  private readonly inner: InMemoryDeclarationCache;
  private readonly cacheDir: string;
  private readonly declDir: string;
  private readonly manifestPath: string;
  private readonly disabled: boolean;
  private manifest: Manifest;

  /**
   * @param cacheDir  Root directory for on-disk cache files.
   * @param disabled  When `true`, the disk tier is skipped entirely (memory-only mode).
   */
  constructor(cacheDir: string, disabled = false) {
    this.inner = new InMemoryDeclarationCache();
    this.cacheDir = cacheDir;
    this.declDir = path.join(cacheDir, 'declarations');
    this.manifestPath = path.join(cacheDir, 'manifest.json');
    this.disabled = disabled;
    this.manifest = this.loadManifest();
  }

  /**
   * Looks up a signature: memory first, then disk. On a disk hit the entry is
   * promoted to memory. Stale entries (hash mismatch) are automatically evicted.
   */
  get(modulePath: string): ExportedTypeSignature | null {
    // Check memory first
    const memResult = this.inner.get(modulePath);
    if (memResult) return memResult;

    if (this.disabled) return null;

    // Check disk
    const entry = this.manifest.entries[modulePath];
    if (!entry) return null;

    // Verify content hash
    const currentHash = this.hashFile(modulePath);
    if (currentHash === null || currentHash !== entry.hash) {
      // Hash mismatch or file deleted — invalidate stale entry
      delete this.manifest.entries[modulePath];
      this.saveManifest();
      return null;
    }

    // Load from disk
    const cacheFile = path.join(this.declDir, `${entry.hash}.json`);
    try {
      const json = fs.readFileSync(cacheFile, 'utf-8');
      const sig = deserializeSignature(json);
      // Promote to memory cache
      this.inner.set(modulePath, sig);
      return sig;
    } catch {
      // Corrupted file — treat as miss
      return null;
    }
  }

  /**
   * Stores a signature in both the memory and disk tiers. The on-disk file is
   * named by the FNV-1a hash of the source `.d.ts` content, and the manifest
   * is updated atomically. I/O errors are silently swallowed (memory still updated).
   */
  set(modulePath: string, signature: ExportedTypeSignature): void {
    this.inner.set(modulePath, signature);

    if (this.disabled) return;

    // Compute content hash
    const hash = this.hashFile(modulePath);
    if (hash === null) return; // Can't hash (file doesn't exist), skip disk write

    // Write cache file
    try {
      fs.mkdirSync(this.declDir, { recursive: true });
      const cacheFile = path.join(this.declDir, `${hash}.json`);
      fs.writeFileSync(cacheFile, serializeSignature(signature));

      // Update manifest
      this.manifest.entries[modulePath] = { hash, cachedAt: Date.now() };
      this.saveManifest();
    } catch {
      // Permission error or other I/O failure — silently fall back to memory only
    }
  }

  /** Delegates to the in-memory tier (constructors are not persisted to disk). */
  getConstructor(modulePath: string, name: string): FunctionType | null | undefined {
    return this.inner.getConstructor(modulePath, name);
  }

  /** Delegates to the in-memory tier (constructors are not persisted to disk). */
  setConstructor(modulePath: string, name: string, ctor: FunctionType | null): void {
    this.inner.setConstructor(modulePath, name, ctor);
  }

  /** Removes the entry from memory, deletes the on-disk cache file, and updates the manifest. */
  invalidate(modulePath: string): void {
    this.inner.invalidate(modulePath);

    if (this.disabled) return;

    const entry = this.manifest.entries[modulePath];
    if (entry) {
      // Remove cache file
      const cacheFile = path.join(this.declDir, `${entry.hash}.json`);
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      delete this.manifest.entries[modulePath];
      this.saveManifest();
    }
  }

  /** Clears all entries from both tiers, deletes the declarations directory and manifest file. */
  clear(): void {
    this.inner.clear();

    if (this.disabled) return;

    this.manifest = { version: MANIFEST_VERSION, entries: {} };
    try {
      // Remove declarations dir and manifest
      fs.rmSync(this.declDir, { recursive: true, force: true });
      fs.unlinkSync(this.manifestPath);
    } catch { /* ignore */ }
  }

  /** @inheritdoc */
  getStats(): CacheStats {
    return this.inner.getStats();
  }

  /** Reads and parses the manifest from disk, returning an empty manifest on any error or version mismatch. */
  private loadManifest(): Manifest {
    if (this.disabled) return { version: MANIFEST_VERSION, entries: {} };
    try {
      const raw = fs.readFileSync(this.manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as Manifest;
      if (parsed.version !== MANIFEST_VERSION) {
        // Version mismatch — discard
        return { version: MANIFEST_VERSION, entries: {} };
      }
      return { version: MANIFEST_VERSION, entries: { ...parsed.entries } };
    } catch {
      return { version: MANIFEST_VERSION, entries: {} };
    }
  }

  /** Writes the current manifest to disk as pretty-printed JSON. Errors are silently ignored. */
  private saveManifest(): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
    } catch { /* ignore */ }
  }

  /**
   * Reads a file and returns its FNV-1a content hash, or `null` if the file
   * cannot be read (e.g. deleted between compile runs).
   */
  private hashFile(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return fnv1aHash(content);
    } catch {
      return null;
    }
  }
}
