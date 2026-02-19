/**
 * @module formatter
 *
 * Rust/Elm-style diagnostic formatter that renders compiler diagnostics
 * with source context, colored underlines, related locations, and
 * suggested fixes.
 */

import type { Diagnostic } from './diagnostic.js';

// ── Types ──────────────────────────────────────────────────

/** Options controlling how diagnostics are rendered to text. */
export interface FormatterOptions {
  /** Enable ANSI color codes in output. */
  readonly color: boolean;
  /** When true, only errors are shown (warnings suppressed). */
  readonly quiet: boolean;
  /**
   * Callback to load source text for a file path.
   * Returns `undefined` if the source is unavailable.
   */
  readonly sourceLoader?: (file: string) => string | undefined;
}

// ── ANSI helpers ───────────────────────────────────────────

/**
 * Wrap `text` in an ANSI escape sequence.
 * @param code - ANSI color/style code (e.g. `"31"` for red).
 * @param text - The text to colorize.
 * @param enabled - When `false`, returns `text` unchanged.
 */
function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Red ANSI text (used for errors). */
function red(text: string, c: boolean): string { return ansi('31', text, c); }
/** Yellow ANSI text (used for warnings). */
function yellow(text: string, c: boolean): string { return ansi('33', text, c); }
/** Cyan ANSI text (used for info diagnostics). */
function cyan(text: string, c: boolean): string { return ansi('36', text, c); }
/** Bold ANSI text. */
function bold(text: string, c: boolean): string { return ansi('1', text, c); }

// ── Single diagnostic formatter ────────────────────────────

/**
 * Format a single diagnostic as a multi-line string with source context.
 * @param diagnostic - The diagnostic to render.
 * @param options - Formatting options (color, source loader, etc.).
 * @returns A formatted string ready for terminal output.
 */
export function formatDiagnostic(
  diagnostic: Diagnostic,
  options: FormatterOptions,
): string {
  const source = options.sourceLoader?.(diagnostic.span.file);
  const sourceLines = source?.split('\n');
  return formatDiagnosticWithLines(diagnostic, options, sourceLines);
}

/**
 * Internal formatting helper that accepts pre-split source lines.
 * Used by both {@link formatDiagnostic} and {@link formatDiagnostics}
 * to avoid redundant string splitting when formatting multiple diagnostics
 * from the same file.
 */
function formatDiagnosticWithLines(
  diagnostic: Diagnostic,
  options: FormatterOptions,
  sourceLines: string[] | undefined,
): string {
  const c = options.color;
  const { severity, code, message, span } = diagnostic;

  const severityStr =
    severity === 'error' ? red('error', c) :
    severity === 'warning' ? yellow('warning', c) :
    cyan('info', c);

  const lines: string[] = [];

  // Header: error[E200]: message
  lines.push(`${severityStr}${bold(`[${code}]`, c)}: ${message}`);

  // Location: --> file:line:column
  lines.push(`  ${bold('-->', c)} ${span.file}:${span.start.line}:${span.start.column}`);

  // Source context
  if (sourceLines !== undefined) {
    const lineIdx = span.start.line - 1; // 1-based → 0-based
    if (lineIdx >= 0 && lineIdx < sourceLines.length) {
      const sourceLine = sourceLines[lineIdx];
      const lineNum = String(span.start.line);
      const gutter = ' '.repeat(lineNum.length + 1);

      lines.push(`${gutter}|`);
      lines.push(` ${lineNum} | ${sourceLine}`);

      // Underline
      const colStart = span.start.column;
      const colEnd = span.start.line === span.end.line
        ? span.end.column
        : sourceLine.length;
      const underlineWidth = Math.max(1, colEnd - colStart);
      const padding = ' '.repeat(colStart);
      const underline = '^'.repeat(underlineWidth);

      const coloredUnderline =
        severity === 'error' ? red(underline, c) :
        severity === 'warning' ? yellow(underline, c) :
        cyan(underline, c);

      lines.push(`${gutter}| ${padding}${coloredUnderline}`);
    }
  }

  // Related spans
  if (diagnostic.relatedSpans) {
    for (const related of diagnostic.relatedSpans) {
      lines.push('');
      lines.push(`  ${bold('=', c)} ${related.message}`);
      lines.push(`    ${bold('-->', c)} ${related.span.file}:${related.span.start.line}:${related.span.start.column}`);
    }
  }

  // Suggested fix
  if (diagnostic.fix) {
    lines.push('');
    lines.push(`  ${bold('fix:', c)} ${diagnostic.fix.description}`);
  }

  return lines.join('\n');
}

// ── Multiple diagnostics formatter ─────────────────────────

/**
 * Format an array of diagnostics, sorted by location, with a trailing summary line.
 *
 * Caches source line splits per file to avoid redundant splitting.
 * In quiet mode, only errors are included.
 *
 * @param diagnostics - The diagnostics to render.
 * @param options - Formatting options (color, quiet, source loader).
 * @returns A formatted string, or empty string if there is nothing to show.
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: FormatterOptions,
): string {
  if (diagnostics.length === 0) return '';

  // Filter in quiet mode
  const filtered = options.quiet
    ? diagnostics.filter(d => d.severity === 'error')
    : diagnostics;

  if (filtered.length === 0) return '';

  // Sort by file, then line, then column
  const sorted = [...filtered].sort((a, b) => {
    const fileCmp = a.span.file.localeCompare(b.span.file);
    if (fileCmp !== 0) return fileCmp;
    const lineCmp = a.span.start.line - b.span.start.line;
    if (lineCmp !== 0) return lineCmp;
    return a.span.start.column - b.span.start.column;
  });

  // Cache source line splits per file to avoid redundant splitting
  const sourceLineCache = new Map<string, string[] | undefined>();
  function getSourceLines(file: string): string[] | undefined {
    if (sourceLineCache.has(file)) return sourceLineCache.get(file);
    const source = options.sourceLoader?.(file);
    const lines = source?.split('\n');
    sourceLineCache.set(file, lines);
    return lines;
  }

  const parts: string[] = [];
  for (const d of sorted) {
    parts.push(formatDiagnosticWithLines(d, options, getSourceLines(d.span.file)));
  }

  // Summary
  const errorCount = sorted.filter(d => d.severity === 'error').length;
  const warningCount = sorted.filter(d => d.severity === 'warning').length;

  const summary = buildSummary(errorCount, warningCount, options);
  if (summary) {
    parts.push('');
    parts.push(summary);
  }

  return parts.join('\n');
}

/**
 * Build a summary line like "Found 2 errors and 1 warning."
 * Returns an empty string when both counts are zero.
 */
function buildSummary(errors: number, warnings: number, options: FormatterOptions): string {
  const c = options.color;

  if (errors === 0 && warnings === 0) return '';

  const errorStr = errors > 0
    ? `${errors} ${errors === 1 ? 'error' : 'errors'}`
    : '';
  const warningStr = warnings > 0
    ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
    : '';

  if (errorStr && warningStr) {
    return bold(`Found ${errorStr} and ${warningStr}.`, c);
  }
  if (errorStr) {
    return bold(`Found ${errorStr}.`, c);
  }
  return bold(`Found ${warningStr}.`, c);
}
