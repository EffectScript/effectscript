import { describe, it, expect } from 'vitest';
import {
  type Position,
  type Span,
  mergeSpans,
  pointSpan,
  containsPosition,
  spansOverlap,
  formatSpan,
} from './span.js';

// Helper to create a Position
function pos(offset: number, line: number, column: number): Position {
  return { offset, line, column };
}

// Helper to create a Span
function span(file: string, start: Position, end: Position): Span {
  return { file, start, end };
}

describe('Position', () => {
  it('should store offset, line, and column', () => {
    const p = pos(10, 2, 5);
    expect(p.offset).toBe(10);
    expect(p.line).toBe(2);
    expect(p.column).toBe(5);
  });
});

describe('Span', () => {
  it('should store file, start, and end positions', () => {
    const s = span('test.efs', pos(0, 1, 0), pos(5, 1, 5));
    expect(s.file).toBe('test.efs');
    expect(s.start.offset).toBe(0);
    expect(s.end.offset).toBe(5);
  });

  it('should represent an empty file', () => {
    const s = span('empty.efs', pos(0, 1, 0), pos(0, 1, 0));
    expect(s.start).toEqual(s.end);
  });
});

describe('mergeSpans', () => {
  it('should merge two adjacent spans', () => {
    const a = span('file.efs', pos(0, 1, 0), pos(3, 1, 3));
    const b = span('file.efs', pos(3, 1, 3), pos(6, 1, 6));
    const merged = mergeSpans(a, b);
    expect(merged.file).toBe('file.efs');
    expect(merged.start).toEqual(pos(0, 1, 0));
    expect(merged.end).toEqual(pos(6, 1, 6));
  });

  it('should merge two non-adjacent spans (with gap)', () => {
    const a = span('file.efs', pos(0, 1, 0), pos(3, 1, 3));
    const b = span('file.efs', pos(10, 2, 0), pos(15, 2, 5));
    const merged = mergeSpans(a, b);
    expect(merged.start).toEqual(pos(0, 1, 0));
    expect(merged.end).toEqual(pos(15, 2, 5));
  });

  it('should throw when merging spans from different files', () => {
    const a = span('a.efs', pos(0, 1, 0), pos(3, 1, 3));
    const b = span('b.efs', pos(0, 1, 0), pos(3, 1, 3));
    expect(() => mergeSpans(a, b)).toThrow();
  });
});

describe('pointSpan', () => {
  it('should create a zero-width span where start equals end', () => {
    const p = pos(5, 1, 5);
    const s = pointSpan('file.efs', p);
    expect(s.file).toBe('file.efs');
    expect(s.start).toEqual(p);
    expect(s.end).toEqual(p);
  });
});

describe('containsPosition', () => {
  const s = span('file.efs', pos(5, 1, 5), pos(10, 1, 10));

  it('should return true for a position inside the span', () => {
    expect(containsPosition(s, pos(7, 1, 7))).toBe(true);
  });

  it('should return true for a position at the start (inclusive)', () => {
    expect(containsPosition(s, pos(5, 1, 5))).toBe(true);
  });

  it('should return false for a position at the end (exclusive)', () => {
    expect(containsPosition(s, pos(10, 1, 10))).toBe(false);
  });

  it('should return false for a position before the span', () => {
    expect(containsPosition(s, pos(2, 1, 2))).toBe(false);
  });

  it('should return false for a position after the span', () => {
    expect(containsPosition(s, pos(15, 1, 15))).toBe(false);
  });
});

describe('spansOverlap', () => {
  it('should return true for overlapping spans', () => {
    const a = span('file.efs', pos(0, 1, 0), pos(5, 1, 5));
    const b = span('file.efs', pos(3, 1, 3), pos(8, 1, 8));
    expect(spansOverlap(a, b)).toBe(true);
  });

  it('should return false for adjacent non-overlapping spans', () => {
    const a = span('file.efs', pos(0, 1, 0), pos(5, 1, 5));
    const b = span('file.efs', pos(5, 1, 5), pos(10, 1, 10));
    expect(spansOverlap(a, b)).toBe(false);
  });

  it('should return true when one span contains the other', () => {
    const outer = span('file.efs', pos(0, 1, 0), pos(10, 1, 10));
    const inner = span('file.efs', pos(3, 1, 3), pos(7, 1, 7));
    expect(spansOverlap(outer, inner)).toBe(true);
    expect(spansOverlap(inner, outer)).toBe(true);
  });

  it('should return false for completely separate spans', () => {
    const a = span('file.efs', pos(0, 1, 0), pos(3, 1, 3));
    const b = span('file.efs', pos(5, 1, 5), pos(8, 1, 8));
    expect(spansOverlap(a, b)).toBe(false);
  });
});

describe('formatSpan', () => {
  it('should format as "file:line:column"', () => {
    const s = span('file.efs', pos(0, 1, 0), pos(5, 1, 5));
    expect(formatSpan(s)).toBe('file.efs:1:0');
  });

  it('should use the start position for multi-line spans', () => {
    const s = span('app.efs', pos(10, 3, 2), pos(50, 5, 0));
    expect(formatSpan(s)).toBe('app.efs:3:2');
  });
});
