import type { Span } from '../utils/span.js';

/** Placeholder span for diagnostics originating from the interop layer. */
export const interopSpan: Span = {
  file: '<interop>',
  start: { offset: 0, line: 0, column: 0 },
  end: { offset: 0, line: 0, column: 0 },
};
