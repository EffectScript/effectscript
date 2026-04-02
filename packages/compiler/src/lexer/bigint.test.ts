import { describe, it, expect } from 'vitest';
import { tokenize } from './lexer.js';
import type { Token, TokenKind } from './tokens.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';

// ── Helpers ──────────────────────────────────────────────────────────

function lex(source: string): { tokens: Token[]; diagnostics: readonly Diagnostic[] } {
  const collector = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', collector);
  return { tokens, diagnostics: collector.getAll() };
}

function kinds(source: string): TokenKind[] {
  return lex(source).tokens.slice(0, -1).map((t) => t.kind);
}

function first(source: string): Token {
  const { tokens } = lex(source);
  if (tokens.length < 2) throw new Error('Expected at least one token before EOF');
  return tokens[0];
}

// ── BigInt Literal Tests ─────────────────────────────────────────────

describe('BigInt literal tokenization', () => {
  it('tokenizes 42n as BigIntLiteral', () => {
    const tok = first('42n');
    expect(tok.kind).toBe('BigIntLiteral');
    expect(tok.text).toBe('42n');
  });

  it('tokenizes 0n as BigIntLiteral', () => {
    const tok = first('0n');
    expect(tok.kind).toBe('BigIntLiteral');
    expect(tok.text).toBe('0n');
  });

  it('tokenizes large bigint beyond MAX_SAFE_INTEGER', () => {
    const tok = first('9007199254740993n');
    expect(tok.kind).toBe('BigIntLiteral');
    expect(tok.text).toBe('9007199254740993n');
  });

  it('tokenizes hex bigint 0xFFn', () => {
    const tok = first('0xFFn');
    expect(tok.kind).toBe('BigIntLiteral');
    expect(tok.text).toBe('0xFFn');
  });

  it('tokenizes hex bigint with uppercase X (0XABn)', () => {
    const tok = first('0XABn');
    expect(tok.kind).toBe('BigIntLiteral');
    expect(tok.text).toBe('0XABn');
  });

  it('reports E006 for decimal bigint 3.14n', () => {
    const { diagnostics } = lex('3.14n');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.code === 'E006')).toBe(true);
  });

  it('tokenizes 42 as NumberLiteral (regression)', () => {
    const tok = first('42');
    expect(tok.kind).toBe('NumberLiteral');
    expect(tok.text).toBe('42');
  });

  it('tokenizes 42n + 10n as BigIntLiteral Plus BigIntLiteral', () => {
    const k = kinds('42n + 10n');
    expect(k).toEqual(['BigIntLiteral', 'Plus', 'BigIntLiteral']);
  });
});
