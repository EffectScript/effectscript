/**
 * @module utils/span
 *
 * Source location primitives used throughout the compiler. Defines
 * {@link Position} (a point in a file) and {@link Span} (a range between
 * two positions), plus helpers for merging, comparing, and formatting spans.
 */

/** A position within a source file. */
export interface Position {
  readonly offset: number;  // 0-based byte offset from start of file
  readonly line: number;    // 1-based line number
  readonly column: number;  // 0-based column (matches LSP, TypeScript internals)
}

/** A range within a source file. */
export interface Span {
  readonly file: string;    // file path
  readonly start: Position;
  readonly end: Position;
}

/** Create a span that covers two spans (from start of first to end of second). */
export function mergeSpans(a: Span, b: Span): Span {
  if (a.file !== b.file) {
    throw new Error(
      `Cannot merge spans from different files: "${a.file}" and "${b.file}"`
    );
  }
  return {
    file: a.file,
    start: a.start,
    end: b.end,
  };
}

/** Create a zero-width span at a position (for insertion points). */
export function pointSpan(file: string, pos: Position): Span {
  return { file, start: pos, end: pos };
}

/** Check if a position falls within a span (start inclusive, end exclusive). */
export function containsPosition(span: Span, pos: Position): boolean {
  return pos.offset >= span.start.offset && pos.offset < span.end.offset;
}

/** Check if two spans overlap. */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.start.offset < b.end.offset && b.start.offset < a.end.offset;
}

/** Format a span for display: "file:line:column". */
export function formatSpan(span: Span): string {
  return `${span.file}:${span.start.line}:${span.start.column}`;
}
