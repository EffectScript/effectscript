import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFileSystem, NodeFileSystem } from './filesystem.js';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';

describe('InMemoryFileSystem', () => {
  it('should write and read a file', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'let x = 42');
    expect(fs.readFile('/src/main.efs')).toBe('let x = 42');
  });

  it('should return undefined for a nonexistent file', () => {
    const fs = new InMemoryFileSystem();
    expect(fs.readFile('/nonexistent.efs')).toBeUndefined();
  });

  it('should report fileExists correctly', () => {
    const fs = new InMemoryFileSystem();
    expect(fs.fileExists('/src/main.efs')).toBe(false);
    fs.writeFile('/src/main.efs', 'let x = 1');
    expect(fs.fileExists('/src/main.efs')).toBe(true);
  });

  it('should overwrite an existing file', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'first');
    fs.writeFile('/src/main.efs', 'second');
    expect(fs.readFile('/src/main.efs')).toBe('second');
  });

  it('should update getModifiedTime after write', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'content');
    const time1 = fs.getModifiedTime('/src/main.efs');
    expect(typeof time1).toBe('number');
    expect(time1).toBeGreaterThan(0);
  });

  it('should return a later mtime after overwrite', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'v1');
    const time1 = fs.getModifiedTime('/src/main.efs');
    // Small delay to ensure different timestamp
    fs.writeFile('/src/main.efs', 'v2');
    const time2 = fs.getModifiedTime('/src/main.efs');
    expect(time2).toBeGreaterThanOrEqual(time1);
  });

  it('should return 0 for getModifiedTime on a nonexistent file', () => {
    const fs = new InMemoryFileSystem();
    expect(fs.getModifiedTime('/nonexistent')).toBe(0);
  });

  it('should list files with readDirectory', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/utils.efs', 'b');
    fs.writeFile('/src/lib/helper.efs', 'c');
    const files = fs.readDirectory('/src');
    expect(files).toContain('/src/main.efs');
    expect(files).toContain('/src/utils.efs');
    expect(files).toContain('/src/lib/helper.efs');
  });

  it('should filter readDirectory by extensions', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/readme.md', 'b');
    fs.writeFile('/src/config.json', 'c');
    const efsFiles = fs.readDirectory('/src', ['.efs']);
    expect(efsFiles).toContain('/src/main.efs');
    expect(efsFiles).not.toContain('/src/readme.md');
    expect(efsFiles).not.toContain('/src/config.json');
  });

  it('should filter readDirectory by multiple extensions', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/readme.md', 'b');
    fs.writeFile('/src/config.json', 'c');
    const files = fs.readDirectory('/src', ['.efs', '.json']);
    expect(files).toContain('/src/main.efs');
    expect(files).toContain('/src/config.json');
    expect(files).not.toContain('/src/readme.md');
  });

  it('should exclude paths matching exclude patterns in readDirectory', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/node_modules/pkg/index.js', 'b');
    fs.writeFile('/src/dist/out.js', 'c');
    const files = fs.readDirectory('/src', undefined, ['node_modules', 'dist']);
    expect(files).toContain('/src/main.efs');
    expect(files).not.toContain('/src/node_modules/pkg/index.js');
    expect(files).not.toContain('/src/dist/out.js');
  });

  it('should return empty array when no files match readDirectory', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/other/file.txt', 'content');
    const files = fs.readDirectory('/src');
    expect(files).toEqual([]);
  });

  it('should return empty array for readDirectory with no matching extensions', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'content');
    const files = fs.readDirectory('/src', ['.ts']);
    expect(files).toEqual([]);
  });

  it('should return the path unchanged for realpath', () => {
    const fs = new InMemoryFileSystem();
    expect(fs.realpath('/src/main.efs')).toBe('/src/main.efs');
    expect(fs.realpath('./relative/path')).toBe('./relative/path');
  });

  it('should handle writing empty content', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/empty.efs', '');
    expect(fs.readFile('/empty.efs')).toBe('');
    expect(fs.fileExists('/empty.efs')).toBe(true);
  });

  it('should exclude files matching glob pattern **/*.test.efs', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/main.test.efs', 'b');
    fs.writeFile('/src/lib/util.test.efs', 'c');
    fs.writeFile('/src/lib/util.efs', 'd');
    const files = fs.readDirectory('/src', ['.efs'], ['**/*.test.efs']);
    expect(files).toContain('/src/main.efs');
    expect(files).toContain('/src/lib/util.efs');
    expect(files).not.toContain('/src/main.test.efs');
    expect(files).not.toContain('/src/lib/util.test.efs');
  });

  it('should still support plain string excludes for backward compat', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/node_modules/pkg/index.js', 'b');
    const files = fs.readDirectory('/src', undefined, ['node_modules']);
    expect(files).toContain('/src/main.efs');
    expect(files).not.toContain('/src/node_modules/pkg/index.js');
  });

  it('should support multiple glob exclude patterns', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/main.efs', 'a');
    fs.writeFile('/src/main.test.efs', 'b');
    fs.writeFile('/src/node_modules/pkg.efs', 'c');
    const files = fs.readDirectory('/src', ['.efs'], ['**/*.test.efs', 'node_modules']);
    expect(files).toContain('/src/main.efs');
    expect(files).not.toContain('/src/main.test.efs');
    expect(files).not.toContain('/src/node_modules/pkg.efs');
  });

  it('should support glob with * wildcard', () => {
    const fs = new InMemoryFileSystem();
    fs.writeFile('/src/temp-abc.efs', 'a');
    fs.writeFile('/src/temp-xyz.efs', 'b');
    fs.writeFile('/src/main.efs', 'c');
    // Relative paths start with / (e.g., /temp-abc.efs)
    const files = fs.readDirectory('/src', ['.efs'], ['/**/temp-*']);
    expect(files).toContain('/src/main.efs');
    expect(files).not.toContain('/src/temp-abc.efs');
    expect(files).not.toContain('/src/temp-xyz.efs');
  });
});

// ── NodeFileSystem ───────────────────────────────────────────

describe('NodeFileSystem', () => {
  let tmpDir: string;
  let nfs: NodeFileSystem;

  beforeEach(() => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'efs-test-'));
    nfs = new NodeFileSystem();
  });

  afterEach(() => {
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('returns content for existing file', () => {
      const filePath = nodePath.join(tmpDir, 'hello.efs');
      nodeFs.writeFileSync(filePath, 'let x = 1');
      expect(nfs.readFile(filePath)).toBe('let x = 1');
    });

    it('returns undefined for missing file', () => {
      expect(nfs.readFile(nodePath.join(tmpDir, 'missing.efs'))).toBeUndefined();
    });
  });

  describe('writeFile', () => {
    it('writes file content', () => {
      const filePath = nodePath.join(tmpDir, 'out.js');
      nfs.writeFile(filePath, 'console.log("hi")');
      expect(nodeFs.readFileSync(filePath, 'utf-8')).toBe('console.log("hi")');
    });

    it('creates parent directories', () => {
      const filePath = nodePath.join(tmpDir, 'a', 'b', 'c', 'deep.js');
      nfs.writeFile(filePath, 'deep');
      expect(nodeFs.readFileSync(filePath, 'utf-8')).toBe('deep');
    });
  });

  describe('fileExists', () => {
    it('returns true for existing file', () => {
      const filePath = nodePath.join(tmpDir, 'exists.efs');
      nodeFs.writeFileSync(filePath, '');
      expect(nfs.fileExists(filePath)).toBe(true);
    });

    it('returns false for missing file', () => {
      expect(nfs.fileExists(nodePath.join(tmpDir, 'nope.efs'))).toBe(false);
    });
  });

  describe('getModifiedTime', () => {
    it('returns positive mtime for existing file', () => {
      const filePath = nodePath.join(tmpDir, 'timed.efs');
      nodeFs.writeFileSync(filePath, 'content');
      expect(nfs.getModifiedTime(filePath)).toBeGreaterThan(0);
    });

    it('returns 0 for missing file', () => {
      expect(nfs.getModifiedTime(nodePath.join(tmpDir, 'missing.efs'))).toBe(0);
    });
  });

  describe('readDirectory', () => {
    it('finds .efs files with extension filter', () => {
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'a.efs'), '');
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'b.efs'), '');
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'c.ts'), '');
      const result = nfs.readDirectory(tmpDir, ['.efs']);
      expect(result).toHaveLength(2);
      expect(result.every(f => f.endsWith('.efs'))).toBe(true);
    });

    it('finds files recursively in subdirectories', () => {
      const subDir = nodePath.join(tmpDir, 'sub');
      nodeFs.mkdirSync(subDir);
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'a.efs'), '');
      nodeFs.writeFileSync(nodePath.join(subDir, 'b.efs'), '');
      const result = nfs.readDirectory(tmpDir, ['.efs']);
      expect(result).toHaveLength(2);
    });

    it('excludes paths matching exclude patterns', () => {
      const nmDir = nodePath.join(tmpDir, 'node_modules');
      nodeFs.mkdirSync(nmDir);
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'a.efs'), '');
      nodeFs.writeFileSync(nodePath.join(nmDir, 'b.efs'), '');
      const result = nfs.readDirectory(tmpDir, ['.efs'], ['node_modules']);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('a.efs');
    });

    it('returns all files when no extension filter', () => {
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'a.efs'), '');
      nodeFs.writeFileSync(nodePath.join(tmpDir, 'b.ts'), '');
      const result = nfs.readDirectory(tmpDir);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for missing directory', () => {
      const result = nfs.readDirectory(nodePath.join(tmpDir, 'nonexistent'));
      expect(result).toEqual([]);
    });
  });

  describe('realpath', () => {
    it('resolves a real path', () => {
      const filePath = nodePath.join(tmpDir, 'real.efs');
      nodeFs.writeFileSync(filePath, '');
      const resolved = nfs.realpath(filePath);
      expect(resolved).toBe(nodeFs.realpathSync(filePath));
    });
  });
});
