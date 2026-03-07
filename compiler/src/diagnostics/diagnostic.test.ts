import { describe, it, expect } from 'vitest';
import type {
  DiagnosticSeverity,
  Diagnostic,
  RelatedSpan,
  SuggestedFix,
  TextEdit,
} from './diagnostic.js';
import type { Position, Span } from '../utils/span.js';

// Helpers
function pos(offset: number, line: number, column: number): Position {
  return { offset, line, column };
}

function span(file: string, start: Position, end: Position): Span {
  return { file, start, end };
}

describe('Diagnostic', () => {
  const testSpan = span('test.efs', pos(0, 1, 0), pos(5, 1, 5));

  it('should create an error diagnostic with all required fields', () => {
    const diag: Diagnostic = {
      severity: 'error',
      code: 'E001',
      message: 'Unexpected character',
      span: testSpan,
    };
    expect(diag.severity).toBe('error');
    expect(diag.code).toBe('E001');
    expect(diag.message).toBe('Unexpected character');
    expect(diag.span).toEqual(testSpan);
  });

  it('should create a warning diagnostic', () => {
    const diag: Diagnostic = {
      severity: 'warning',
      code: 'W001',
      message: 'Unused variable',
      span: testSpan,
    };
    expect(diag.severity).toBe('warning');
  });

  it('should create an info diagnostic', () => {
    const diag: Diagnostic = {
      severity: 'info',
      code: 'I001',
      message: 'Type inferred as number',
      span: testSpan,
    };
    expect(diag.severity).toBe('info');
  });

  it('should allow omitting optional relatedSpans and fix', () => {
    const diag: Diagnostic = {
      severity: 'error',
      code: 'E100',
      message: 'Unexpected token',
      span: testSpan,
    };
    expect(diag.relatedSpans).toBeUndefined();
    expect(diag.fix).toBeUndefined();
  });

  it('should include related spans', () => {
    const relatedSpan: RelatedSpan = {
      span: span('test.efs', pos(20, 3, 0), pos(25, 3, 5)),
      message: 'First defined here',
    };
    const diag: Diagnostic = {
      severity: 'error',
      code: 'E200',
      message: 'Duplicate definition',
      span: testSpan,
      relatedSpans: [relatedSpan],
    };
    expect(diag.relatedSpans).toHaveLength(1);
    expect(diag.relatedSpans![0].message).toBe('First defined here');
  });

  it('should include a suggested fix with text edits', () => {
    const edit: TextEdit = {
      span: testSpan,
      replacement: 'let mut',
    };
    const fix: SuggestedFix = {
      description: 'Add mut keyword',
      edits: [edit],
    };
    const diag: Diagnostic = {
      severity: 'error',
      code: 'E300',
      message: 'Cannot reassign immutable binding',
      span: testSpan,
      fix,
    };
    expect(diag.fix).toBeDefined();
    expect(diag.fix!.description).toBe('Add mut keyword');
    expect(diag.fix!.edits).toHaveLength(1);
    expect(diag.fix!.edits[0].replacement).toBe('let mut');
  });
});

describe('DiagnosticSeverity', () => {
  it('should only allow error, warning, and info', () => {
    const severities: DiagnosticSeverity[] = ['error', 'warning', 'info'];
    expect(severities).toHaveLength(3);
  });
});
