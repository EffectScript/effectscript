import { describe, it, expect } from 'vitest';
import { encodeVLQ, generateSourceMap } from './source-map.js';
import type { SourceMapping } from './emit-context.js';

describe('VLQ encoding', () => {
  it('encodes 0', () => {
    expect(encodeVLQ(0)).toBe('A');
  });

  it('encodes small positive values', () => {
    expect(encodeVLQ(1)).toBe('C');
    expect(encodeVLQ(2)).toBe('E');
    expect(encodeVLQ(3)).toBe('G');
  });

  it('encodes small negative values', () => {
    expect(encodeVLQ(-1)).toBe('D');
    expect(encodeVLQ(-2)).toBe('F');
  });

  it('encodes larger values requiring continuation bits', () => {
    // 16 => VLQ value 32 => 100000 binary
    // split into 5-bit groups with continuation: 00000 1 00010
    // This should produce 'gB' (known VLQ result)
    expect(encodeVLQ(16)).toBe('gB');
  });

  it('encodes negative larger values', () => {
    expect(encodeVLQ(-16)).toBe('hB');
  });
});

describe('generateSourceMap', () => {
  it('produces valid Source Map v3 JSON with single mapping', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0, sourceFile: 'test.efs' },
    ];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    expect(parsed['version']).toBe(3);
    expect(parsed['file']).toBe('test.js');
    expect(parsed['sources']).toEqual(['test.efs']);
    expect(typeof parsed['mappings']).toBe('string');
  });

  it('includes sourceContent when provided', () => {
    const mappings: SourceMapping[] = [];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js', 'let x = 42');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    expect(parsed['sourcesContent']).toEqual(['let x = 42']);
  });

  it('omits sourcesContent when not provided', () => {
    const mappings: SourceMapping[] = [];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    expect(parsed['sourcesContent']).toBeUndefined();
  });

  it('produces empty mappings string for no mappings', () => {
    const mappings: SourceMapping[] = [];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    expect(parsed['mappings']).toBe('');
  });

  it('produces multiple mapping segments', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0, sourceFile: 'test.efs' },
      { generatedLine: 1, generatedColumn: 6, sourceLine: 1, sourceColumn: 4, sourceFile: 'test.efs' },
      { generatedLine: 2, generatedColumn: 0, sourceLine: 2, sourceColumn: 0, sourceFile: 'test.efs' },
    ];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    // Line 1 has 2 segments separated by comma; line 2 starts after semicolon
    const mappingStr = parsed['mappings'] as string;
    expect(mappingStr).toContain(','); // multiple segments on same line
    expect(mappingStr).toContain(';'); // line separator
  });

  it('handles multiple generated lines with gaps', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0, sourceFile: 'test.efs' },
      { generatedLine: 3, generatedColumn: 0, sourceLine: 3, sourceColumn: 0, sourceFile: 'test.efs' },
    ];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    const parsed = JSON.parse(result) as Record<string, unknown>;

    // Line gap: line 1 has mapping, line 2 is empty (;), line 3 has mapping
    const mappingStr = parsed['mappings'] as string;
    const lines = mappingStr.split(';');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[1]).toBe(''); // empty line 2
  });

  it('produces well-formed JSON', () => {
    const mappings: SourceMapping[] = [
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0, sourceFile: 'test.efs' },
    ];
    const result = generateSourceMap(mappings, 'test.efs', 'test.js');
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
