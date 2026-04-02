import { describe, it, expect } from 'vitest';
import { DiagnosticCollectorImpl } from './collector.js';
import type { Diagnostic } from './diagnostic.js';
import type { Position, Span } from '../utils/span.js';

// Helpers
function pos(offset: number, line: number, column: number): Position {
  return { offset, line, column };
}

function span(file: string, start: Position, end: Position): Span {
  return { file, start, end };
}

function makeDiag(
  severity: 'error' | 'warning' | 'info',
  code: string,
  message: string,
  s: Span,
): Diagnostic {
  return { severity, code, message, span: s };
}

const testSpan1 = span('test.efs', pos(0, 1, 0), pos(5, 1, 5));
const testSpan2 = span('test.efs', pos(10, 2, 0), pos(15, 2, 5));
const testSpan3 = span('other.efs', pos(0, 1, 0), pos(3, 1, 3));

describe('DiagnosticCollectorImpl', () => {
  it('should report and retrieve a diagnostic', () => {
    const collector = new DiagnosticCollectorImpl();
    const diag = makeDiag('error', 'E001', 'Unexpected character', testSpan1);
    collector.report(diag);
    expect(collector.getAll()).toHaveLength(1);
    expect(collector.getAll()[0]).toEqual(diag);
  });

  it('should preserve insertion order for multiple diagnostics', () => {
    const collector = new DiagnosticCollectorImpl();
    const diag1 = makeDiag('error', 'E001', 'First error', testSpan1);
    const diag2 = makeDiag('warning', 'W001', 'A warning', testSpan2);
    const diag3 = makeDiag('error', 'E002', 'Second error', testSpan3);
    collector.report(diag1);
    collector.report(diag2);
    collector.report(diag3);
    const all = collector.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].code).toBe('E001');
    expect(all[1].code).toBe('W001');
    expect(all[2].code).toBe('E002');
  });

  it('should filter errors with getErrors()', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'Error 1', testSpan1));
    collector.report(makeDiag('warning', 'W001', 'Warning 1', testSpan2));
    collector.report(makeDiag('error', 'E002', 'Error 2', testSpan3));
    const errors = collector.getErrors();
    expect(errors).toHaveLength(2);
    expect(errors[0].code).toBe('E001');
    expect(errors[1].code).toBe('E002');
  });

  it('should filter warnings with getWarnings()', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'Error', testSpan1));
    collector.report(makeDiag('warning', 'W001', 'Warning 1', testSpan2));
    collector.report(makeDiag('warning', 'W002', 'Warning 2', testSpan3));
    const warnings = collector.getWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[0].code).toBe('W001');
    expect(warnings[1].code).toBe('W002');
  });

  it('should return hasErrors() false when only warnings exist', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('warning', 'W001', 'Warning', testSpan1));
    expect(collector.hasErrors()).toBe(false);
  });

  it('should return hasErrors() true when at least one error exists', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('warning', 'W001', 'Warning', testSpan1));
    collector.report(makeDiag('error', 'E001', 'Error', testSpan2));
    expect(collector.hasErrors()).toBe(true);
  });

  it('should deduplicate diagnostics with same code and same span', () => {
    const collector = new DiagnosticCollectorImpl();
    const diag1 = makeDiag('error', 'E001', 'Unexpected character', testSpan1);
    const diag2 = makeDiag('error', 'E001', 'Unexpected character', testSpan1);
    collector.report(diag1);
    collector.report(diag2);
    expect(collector.getAll()).toHaveLength(1);
  });

  it('should NOT deduplicate diagnostics with same code but different spans', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'Error at first location', testSpan1));
    collector.report(makeDiag('error', 'E001', 'Error at second location', testSpan2));
    expect(collector.getAll()).toHaveLength(2);
  });

  it('should NOT deduplicate diagnostics with different codes but same span', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'First error', testSpan1));
    collector.report(makeDiag('error', 'E002', 'Second error', testSpan1));
    expect(collector.getAll()).toHaveLength(2);
  });

  it('should clear all diagnostics', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'Error', testSpan1));
    collector.report(makeDiag('warning', 'W001', 'Warning', testSpan2));
    collector.clear();
    expect(collector.getAll()).toHaveLength(0);
    expect(collector.hasErrors()).toBe(false);
    expect(collector.getErrors()).toHaveLength(0);
    expect(collector.getWarnings()).toHaveLength(0);
  });

  it('should allow reporting after clear (fresh state)', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('error', 'E001', 'Error', testSpan1));
    collector.clear();
    collector.report(makeDiag('warning', 'W001', 'Warning', testSpan2));
    expect(collector.getAll()).toHaveLength(1);
    expect(collector.hasErrors()).toBe(false);
  });

  it('should handle info severity: appears in getAll but not getErrors or getWarnings', () => {
    const collector = new DiagnosticCollectorImpl();
    collector.report(makeDiag('info', 'I001', 'Information', testSpan1));
    expect(collector.getAll()).toHaveLength(1);
    expect(collector.getErrors()).toHaveLength(0);
    expect(collector.getWarnings()).toHaveLength(0);
    expect(collector.hasErrors()).toBe(false);
  });

  it('should return empty arrays when no diagnostics are reported', () => {
    const collector = new DiagnosticCollectorImpl();
    expect(collector.getAll()).toHaveLength(0);
    expect(collector.getErrors()).toHaveLength(0);
    expect(collector.getWarnings()).toHaveLength(0);
    expect(collector.hasErrors()).toBe(false);
  });

  it('should allow deduplicating after clear re-reports the same diagnostic', () => {
    const collector = new DiagnosticCollectorImpl();
    const diag = makeDiag('error', 'E001', 'Error', testSpan1);
    collector.report(diag);
    collector.clear();
    // After clear, the same diagnostic can be reported again
    collector.report(diag);
    expect(collector.getAll()).toHaveLength(1);
  });
});
