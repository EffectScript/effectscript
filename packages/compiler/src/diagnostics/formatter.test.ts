import { describe, it, expect } from 'vitest';
import { formatDiagnostic, formatDiagnostics } from './formatter.js';
import type { Diagnostic } from './diagnostic.js';
import type { Span } from '../utils/span.js';

// ── Helpers ──────────────────────────────────────────────────

function span(file: string, line: number, colStart: number, colEnd: number): Span {
  return {
    file,
    start: { offset: 0, line, column: colStart },
    end: { offset: 0, line, column: colEnd },
  };
}

function diag(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  s: Span,
): Diagnostic {
  return { severity, code, message, span: s };
}

const NO_COLOR = { color: false, quiet: false };

// ── formatDiagnostic ─────────────────────────────────────────

describe('formatDiagnostic', () => {
  it('formats a single error with source context and underline', () => {
    const d = diag('error', 'E200', 'Type mismatch', span('src/main.efs', 5, 10, 17));
    const source = 'line1\nline2\nline3\nline4\nlet x: number = "hello"\nline6';
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => source,
    });
    expect(result).toContain('error[E200]');
    expect(result).toContain('Type mismatch');
    expect(result).toContain('--> src/main.efs:5:10');
    expect(result).toContain('let x: number = "hello"');
    expect(result).toContain('^^^^^^^');
  });

  it('formats a warning diagnostic', () => {
    const d = diag('warning', 'W200', 'Unused variable', span('src/main.efs', 8, 4, 5));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => 'a\nb\nc\nd\ne\nf\ng\nlet y = 42\ni',
    });
    expect(result).toContain('warning[W200]');
    expect(result).toContain('Unused variable');
    expect(result).toContain('--> src/main.efs:8:4');
    expect(result).toContain('let y = 42');
    expect(result).toContain('^');
  });

  it('formats info diagnostic', () => {
    const d = diag('info', 'I100', 'Note: something', span('src/lib.efs', 1, 0, 3));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => 'let x = 1',
    });
    expect(result).toContain('info[I100]');
    expect(result).toContain('Note: something');
  });

  it('formats diagnostic without source context when sourceLoader returns undefined', () => {
    const d = diag('error', 'E502', 'File not found', span('missing.efs', 1, 0, 0));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => undefined,
    });
    expect(result).toContain('error[E502]');
    expect(result).toContain('File not found');
    expect(result).toContain('--> missing.efs:1:0');
    // No source line
    expect(result).not.toContain(' | ');
  });

  it('formats diagnostic without source context when no sourceLoader provided', () => {
    const d = diag('error', 'E502', 'File not found', span('missing.efs', 1, 0, 0));
    const result = formatDiagnostic(d, NO_COLOR);
    expect(result).toContain('error[E502]');
    expect(result).toContain('--> missing.efs:1:0');
  });

  it('single character span produces single ^', () => {
    const d = diag('error', 'E200', 'Bad char', span('a.efs', 1, 3, 4));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => 'let x = 1',
    });
    expect(result).toContain('^');
    expect(result).not.toContain('^^');
  });

  it('zero-width span produces single ^', () => {
    const d = diag('error', 'E200', 'At point', span('a.efs', 1, 5, 5));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => 'let x = 1',
    });
    expect(result).toContain('^');
  });

  it('multi-character span produces correct underline width', () => {
    const d = diag('error', 'E200', 'Bad range', span('a.efs', 1, 4, 9));
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => 'let hello = 1',
    });
    expect(result).toContain('^^^^^');
  });

  it('includes related spans', () => {
    const d: Diagnostic = {
      severity: 'error',
      code: 'E210',
      message: 'Type conflict',
      span: span('a.efs', 5, 0, 5),
      relatedSpans: [
        { span: span('a.efs', 2, 0, 3), message: 'first defined here' },
      ],
    };
    const source = 'one\ntwo\nthree\nfour\nfive\nsix';
    const result = formatDiagnostic(d, {
      ...NO_COLOR,
      sourceLoader: () => source,
    });
    expect(result).toContain('error[E210]');
    expect(result).toContain('first defined here');
  });
});

// ── formatDiagnostics (multiple) ─────────────────────────────

describe('formatDiagnostics', () => {
  it('returns empty string for no diagnostics', () => {
    const result = formatDiagnostics([], NO_COLOR);
    expect(result).toBe('');
  });

  it('sorts diagnostics by file, then line, then column', () => {
    const d1 = diag('error', 'E200', 'err1', span('b.efs', 3, 0, 1));
    const d2 = diag('error', 'E201', 'err2', span('a.efs', 5, 0, 1));
    const d3 = diag('warning', 'W200', 'warn1', span('a.efs', 2, 0, 1));
    const result = formatDiagnostics([d1, d2, d3], NO_COLOR);
    const idx1 = result.indexOf('warn1');
    const idx2 = result.indexOf('err2');
    const idx3 = result.indexOf('err1');
    expect(idx1).toBeLessThan(idx2); // a.efs:2 before a.efs:5
    expect(idx2).toBeLessThan(idx3); // a.efs before b.efs
  });

  it('summary: single error', () => {
    const d = diag('error', 'E200', 'err', span('a.efs', 1, 0, 1));
    const result = formatDiagnostics([d], NO_COLOR);
    expect(result).toContain('Found 1 error.');
  });

  it('summary: multiple errors', () => {
    const d1 = diag('error', 'E200', 'err1', span('a.efs', 1, 0, 1));
    const d2 = diag('error', 'E201', 'err2', span('a.efs', 2, 0, 1));
    const result = formatDiagnostics([d1, d2], NO_COLOR);
    expect(result).toContain('Found 2 errors.');
  });

  it('summary: single warning', () => {
    const d = diag('warning', 'W200', 'warn', span('a.efs', 1, 0, 1));
    const result = formatDiagnostics([d], NO_COLOR);
    expect(result).toContain('Found 1 warning.');
  });

  it('summary: errors and warnings', () => {
    const d1 = diag('error', 'E200', 'err', span('a.efs', 1, 0, 1));
    const d2 = diag('warning', 'W200', 'warn', span('a.efs', 2, 0, 1));
    const result = formatDiagnostics([d1, d2], NO_COLOR);
    expect(result).toContain('Found 1 error and 1 warning.');
  });

  it('summary: multiple errors and warnings', () => {
    const d1 = diag('error', 'E200', 'e1', span('a.efs', 1, 0, 1));
    const d2 = diag('error', 'E201', 'e2', span('a.efs', 2, 0, 1));
    const d3 = diag('warning', 'W200', 'w1', span('a.efs', 3, 0, 1));
    const d4 = diag('warning', 'W201', 'w2', span('a.efs', 4, 0, 1));
    const result = formatDiagnostics([d1, d2, d3, d4], NO_COLOR);
    expect(result).toContain('Found 2 errors and 2 warnings.');
  });
});

// ── Color support ────────────────────────────────────────────

describe('color support', () => {
  it('includes ANSI codes when color enabled', () => {
    const d = diag('error', 'E200', 'err', span('a.efs', 1, 0, 1));
    const result = formatDiagnostic(d, { color: true, quiet: false });
    // Should contain ANSI escape code
    expect(result).toContain('\x1b[');
  });

  it('no ANSI codes when color disabled', () => {
    const d = diag('error', 'E200', 'err', span('a.efs', 1, 0, 1));
    const result = formatDiagnostic(d, NO_COLOR);
    expect(result).not.toContain('\x1b[');
  });
});

// ── Quiet mode ───────────────────────────────────────────────

describe('quiet mode', () => {
  it('suppresses warnings in quiet mode', () => {
    const d1 = diag('error', 'E200', 'error msg', span('a.efs', 1, 0, 1));
    const d2 = diag('warning', 'W200', 'warning msg', span('a.efs', 2, 0, 1));
    const result = formatDiagnostics([d1, d2], { color: false, quiet: true });
    expect(result).toContain('error msg');
    expect(result).not.toContain('warning msg');
  });

  it('summary counts only errors in quiet mode', () => {
    const d1 = diag('error', 'E200', 'e1', span('a.efs', 1, 0, 1));
    const d2 = diag('warning', 'W200', 'w1', span('a.efs', 2, 0, 1));
    const result = formatDiagnostics([d1, d2], { color: false, quiet: true });
    expect(result).toContain('Found 1 error.');
    expect(result).not.toContain('warning');
  });

  it('returns empty string when only warnings in quiet mode', () => {
    const d = diag('warning', 'W200', 'warn', span('a.efs', 1, 0, 1));
    const result = formatDiagnostics([d], { color: false, quiet: true });
    expect(result).toBe('');
  });
});

// ── Suggested fixes ──────────────────────────────────────────

describe('suggested fixes', () => {
  it('renders fix description when present', () => {
    const d: Diagnostic = {
      severity: 'error',
      code: 'E202',
      message: "Cannot assign to immutable binding 'x'",
      span: span('a.efs', 2, 0, 5),
      fix: {
        description: "Declare 'x' as mutable with 'var'",
        edits: [],
      },
    };
    const result = formatDiagnostic(d, NO_COLOR);
    expect(result).toContain('fix:');
    expect(result).toContain("Declare 'x' as mutable with 'var'");
  });

  it('renders normally when no fix is present', () => {
    const d = diag('error', 'E200', 'Type mismatch', span('a.efs', 1, 0, 5));
    const result = formatDiagnostic(d, NO_COLOR);
    expect(result).not.toContain('fix:');
  });

  it('renders fix together with related spans', () => {
    const d: Diagnostic = {
      severity: 'error',
      code: 'E202',
      message: "Cannot assign to 'x'",
      span: span('a.efs', 3, 0, 5),
      relatedSpans: [{
        span: span('a.efs', 1, 0, 5),
        message: "'x' declared here",
      }],
      fix: {
        description: "Use 'var' for mutable binding",
        edits: [],
      },
    };
    const result = formatDiagnostic(d, NO_COLOR);
    expect(result).toContain("'x' declared here");
    expect(result).toContain('fix:');
    expect(result).toContain("Use 'var' for mutable binding");
    // Fix should come after related spans
    const relatedIdx = result.indexOf("'x' declared here");
    const fixIdx = result.indexOf('fix:');
    expect(fixIdx).toBeGreaterThan(relatedIdx);
  });
});

// ── Source line caching ─────────────────────────────────────

describe('source line caching in formatDiagnostics', () => {
  it('sourceLoader called once per file for multiple diagnostics', () => {
    let callCount = 0;
    const d1 = diag('error', 'E200', 'err1', span('a.efs', 1, 0, 1));
    const d2 = diag('error', 'E201', 'err2', span('a.efs', 2, 0, 1));
    const d3 = diag('warning', 'W200', 'warn1', span('a.efs', 3, 0, 1));
    formatDiagnostics([d1, d2, d3], {
      color: false,
      quiet: false,
      sourceLoader: (_file) => {
        callCount++;
        return 'line1\nline2\nline3';
      },
    });
    expect(callCount).toBe(1);
  });

  it('sourceLoader called once per unique file', () => {
    const calls: string[] = [];
    const d1 = diag('error', 'E200', 'err1', span('a.efs', 1, 0, 1));
    const d2 = diag('error', 'E201', 'err2', span('a.efs', 2, 0, 1));
    const d3 = diag('error', 'E202', 'err3', span('b.efs', 1, 0, 1));
    formatDiagnostics([d1, d2, d3], {
      color: false,
      quiet: false,
      sourceLoader: (file) => {
        calls.push(file);
        return 'line1\nline2';
      },
    });
    expect(calls.length).toBe(2);
    expect(calls).toContain('a.efs');
    expect(calls).toContain('b.efs');
  });
});
