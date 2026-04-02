/**
 * @module filesystem
 *
 * File system abstraction layer for the EffectScript compiler. Provides a
 * {@link FileSystem} interface with two implementations:
 * - {@link InMemoryFileSystem} for testing and sandboxed compilation
 * - {@link NodeFileSystem} for real disk I/O via Node.js `fs`
 */

import { globMatch } from './utils/glob.js';

/**
 * Check if a relative path matches an exclude pattern.
 * Patterns containing glob wildcards (`*`, `?`, `**`) use full glob matching.
 * Plain strings use substring matching for backward compatibility.
 * @param pattern - The exclude pattern to test against.
 * @param relativePath - The path relative to the project root.
 * @returns `true` if the path should be excluded.
 */
function matchesExclude(pattern: string, relativePath: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) {
    return globMatch(pattern, relativePath);
  }
  return relativePath.includes(pattern);
}

/**
 * Abstract file system interface used throughout the compiler.
 * Decouples compilation from the real file system, enabling in-memory testing
 * and potential future virtual file system support.
 */
export interface FileSystem {
  /** Read a file's text content. Returns `undefined` if the file doesn't exist. */
  readFile(path: string): string | undefined;
  /** Write text content to a file, creating parent directories as needed. */
  writeFile(path: string, content: string): void;
  /** Check whether a file exists at the given path. */
  fileExists(path: string): boolean;
  /** Return the file's last-modified time in milliseconds since epoch. Returns `0` if unavailable. */
  getModifiedTime(path: string): number;
  /**
   * Recursively list files under a directory.
   * @param path - Root directory to search.
   * @param extensions - If provided, only include files ending with one of these extensions.
   * @param excludes - If provided, skip files whose relative path matches any pattern.
   * @returns Absolute paths of matching files.
   */
  readDirectory(
    path: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
  ): readonly string[];
  /** Resolve symlinks and return the canonical path. */
  realpath(path: string): string;
}

/** Internal storage record for a single file in {@link InMemoryFileSystem}. */
interface FileEntry {
  content: string;
  mtime: number;
}

/**
 * In-memory file system backed by a `Map`. Useful for testing and sandboxed
 * compilation where no real disk I/O is desired. File paths are matched by
 * exact string equality (prefix-based for directory listing).
 */
export class InMemoryFileSystem implements FileSystem {
  private files = new Map<string, FileEntry>();

  /** @inheritDoc */
  readFile(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  /** @inheritDoc */
  writeFile(path: string, content: string): void {
    this.files.set(path, { content, mtime: Date.now() });
  }

  /** @inheritDoc */
  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  /** @inheritDoc */
  getModifiedTime(path: string): number {
    return this.files.get(path)?.mtime ?? 0;
  }

  /** @inheritDoc */
  readDirectory(
    path: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
  ): readonly string[] {
    const results: string[] = [];
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(path)) {
        continue;
      }

      if (extensions && extensions.length > 0) {
        if (!extensions.some((ext) => filePath.endsWith(ext))) {
          continue;
        }
      }

      if (excludes && excludes.length > 0) {
        const relativePath = filePath.slice(path.length);
        if (excludes.some((pattern) => matchesExclude(pattern, relativePath))) {
          continue;
        }
      }

      results.push(filePath);
    }
    return results;
  }

  /** @inheritDoc In-memory paths have no symlinks, so this returns the path as-is. */
  realpath(path: string): string {
    return path;
  }
}

// ── Node.js File System ────────────────────────────────────

import * as fs from 'fs';
import * as nodePath from 'path';

/**
 * File system implementation backed by Node.js `fs` module for real disk I/O.
 * Used in production compilation. Automatically creates parent directories on write
 * and silently returns fallback values when files are missing or unreadable.
 */
export class NodeFileSystem implements FileSystem {
  /** @inheritDoc */
  readFile(path: string): string | undefined {
    try {
      return fs.readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** @inheritDoc Creates parent directories recursively if they don't exist. */
  writeFile(path: string, content: string): void {
    const dir = nodePath.dirname(path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, content, 'utf-8');
  }

  /** @inheritDoc */
  fileExists(path: string): boolean {
    return fs.existsSync(path);
  }

  /** @inheritDoc */
  getModifiedTime(path: string): number {
    try {
      return fs.statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** @inheritDoc */
  readDirectory(
    path: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
  ): readonly string[] {
    const results: string[] = [];
    try {
      this.walkDir(path, path, extensions, excludes, results);
    } catch {
      // Directory doesn't exist or isn't readable
    }
    return results;
  }

  /** @inheritDoc */
  realpath(path: string): string {
    return fs.realpathSync(path);
  }

  /**
   * Recursively walk a directory, collecting file paths that match the extension
   * and exclude filters. Skips excluded directories entirely (no descent).
   */
  private walkDir(
    rootDir: string,
    currentDir: string,
    extensions: readonly string[] | undefined,
    excludes: readonly string[] | undefined,
    results: string[],
  ): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(currentDir, entry.name);
      const relativePath = fullPath.slice(rootDir.length);

      if (excludes && excludes.length > 0) {
        if (excludes.some(pattern => matchesExclude(pattern, relativePath))) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        this.walkDir(rootDir, fullPath, extensions, excludes, results);
      } else if (entry.isFile()) {
        if (extensions && extensions.length > 0) {
          if (!extensions.some(ext => fullPath.endsWith(ext))) {
            continue;
          }
        }
        results.push(fullPath);
      }
    }
  }
}
