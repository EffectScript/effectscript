import { describe, it, expect } from 'vitest';
import { globMatch, globToRegex } from './glob.js';

describe('globMatch', () => {
  describe('* (single segment)', () => {
    it('matches filename without extension', () => {
      expect(globMatch('*.ts', 'foo.ts')).toBe(true);
    });

    it('does not cross directory separator', () => {
      expect(globMatch('*.ts', 'src/foo.ts')).toBe(false);
    });

    it('matches any characters in segment', () => {
      expect(globMatch('test-*', 'test-123')).toBe(true);
      expect(globMatch('test-*', 'test-')).toBe(true);
    });
  });

  describe('** (recursive)', () => {
    it('matches across directory separators', () => {
      expect(globMatch('**/*.test.efs', 'src/foo.test.efs')).toBe(true);
    });

    it('matches deeply nested paths', () => {
      expect(globMatch('**/*.test.efs', 'src/deep/nested/foo.test.efs')).toBe(true);
    });

    it('matches in root directory', () => {
      expect(globMatch('**/*.test.efs', 'foo.test.efs')).toBe(true);
    });

    it('matches everything with just **', () => {
      expect(globMatch('**', 'anything/at/all.txt')).toBe(true);
    });
  });

  describe('? (single character)', () => {
    it('matches a single character', () => {
      expect(globMatch('file?.ts', 'file1.ts')).toBe(true);
    });

    it('does not match multiple characters', () => {
      expect(globMatch('file?.ts', 'file12.ts')).toBe(false);
    });

    it('does not match directory separator', () => {
      expect(globMatch('file?ts', 'file/ts')).toBe(false);
    });
  });

  describe('exact match', () => {
    it('matches exact strings', () => {
      expect(globMatch('node_modules', 'node_modules')).toBe(true);
    });

    it('does not match partial strings', () => {
      expect(globMatch('node_modules', 'node_modules/foo')).toBe(false);
    });
  });

  describe('mixed patterns', () => {
    it('handles directory prefix with wildcard', () => {
      expect(globMatch('src/**/*.efs', 'src/main.efs')).toBe(true);
      expect(globMatch('src/**/*.efs', 'src/lib/util.efs')).toBe(true);
    });

    it('handles multiple wildcards', () => {
      expect(globMatch('**/test-*.efs', 'src/test-foo.efs')).toBe(true);
      expect(globMatch('**/test-*.efs', 'deep/nested/test-bar.efs')).toBe(true);
    });
  });

  describe('special regex characters', () => {
    it('escapes dots in pattern', () => {
      expect(globMatch('*.test.efs', 'xtest.efs')).toBe(false);
      expect(globMatch('*.test.efs', 'foo.test.efs')).toBe(true);
    });

    it('escapes brackets and parens', () => {
      expect(globMatch('file[1].ts', 'file[1].ts')).toBe(true);
      expect(globMatch('file(1).ts', 'file(1).ts')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('empty pattern matches empty string', () => {
      expect(globMatch('', '')).toBe(true);
    });

    it('empty pattern does not match non-empty string', () => {
      expect(globMatch('', 'foo')).toBe(false);
    });

    it('pattern without wildcards is exact match', () => {
      expect(globMatch('exact-match.ts', 'exact-match.ts')).toBe(true);
      expect(globMatch('exact-match.ts', 'not-exact.ts')).toBe(false);
    });
  });
});

describe('globToRegex', () => {
  it('returns a RegExp', () => {
    const regex = globToRegex('*.ts');
    expect(regex).toBeInstanceOf(RegExp);
  });
});
