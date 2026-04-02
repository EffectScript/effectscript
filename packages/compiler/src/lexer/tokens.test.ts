import { describe, it, expect } from 'vitest';
import type { Trivia, TriviaKind, Token, TokenKind } from './tokens.js';
import type { Position, Span } from '../utils/span.js';

// Helpers
function pos(offset: number, line: number, column: number): Position {
  return { offset, line, column };
}

function span(file: string, start: Position, end: Position): Span {
  return { file, start, end };
}

function makeTrivia(kind: TriviaKind, text: string, s: Span): Trivia {
  return { kind, text, span: s };
}

function makeToken(
  kind: TokenKind,
  text: string,
  s: Span,
  leadingTrivia: readonly Trivia[] = [],
  trailingTrivia: readonly Trivia[] = [],
): Token {
  return { kind, text, span: s, leadingTrivia, trailingTrivia };
}

describe('Trivia', () => {
  it('should create whitespace trivia', () => {
    const t = makeTrivia('whitespace', '  ', span('f.efs', pos(0, 1, 0), pos(2, 1, 2)));
    expect(t.kind).toBe('whitespace');
    expect(t.text).toBe('  ');
  });

  it('should create newline trivia', () => {
    const t = makeTrivia('newline', '\n', span('f.efs', pos(5, 1, 5), pos(6, 2, 0)));
    expect(t.kind).toBe('newline');
    expect(t.text).toBe('\n');
  });

  it('should create line comment trivia', () => {
    const t = makeTrivia('lineComment', '// hello', span('f.efs', pos(0, 1, 0), pos(8, 1, 8)));
    expect(t.kind).toBe('lineComment');
    expect(t.text).toBe('// hello');
  });

  it('should create block comment trivia', () => {
    const t = makeTrivia('blockComment', '/* hi */', span('f.efs', pos(0, 1, 0), pos(8, 1, 8)));
    expect(t.kind).toBe('blockComment');
    expect(t.text).toBe('/* hi */');
  });
});

describe('Token', () => {
  it('should create a keyword token', () => {
    const s = span('f.efs', pos(0, 1, 0), pos(3, 1, 3));
    const tok = makeToken('let', 'let', s);
    expect(tok.kind).toBe('let');
    expect(tok.text).toBe('let');
    expect(tok.span).toEqual(s);
  });

  it('should create an identifier token', () => {
    const s = span('f.efs', pos(4, 1, 4), pos(7, 1, 7));
    const tok = makeToken('Identifier', 'foo', s);
    expect(tok.kind).toBe('Identifier');
    expect(tok.text).toBe('foo');
  });

  it('should create a number literal token', () => {
    const s = span('f.efs', pos(0, 1, 0), pos(2, 1, 2));
    const tok = makeToken('NumberLiteral', '42', s);
    expect(tok.kind).toBe('NumberLiteral');
    expect(tok.text).toBe('42');
  });

  it('should create operator tokens', () => {
    const s = span('f.efs', pos(0, 1, 0), pos(2, 1, 2));
    const tok = makeToken('EqualEqual', '==', s);
    expect(tok.kind).toBe('EqualEqual');
    expect(tok.text).toBe('==');
  });

  it('should create an EOF token', () => {
    const s = span('f.efs', pos(100, 5, 0), pos(100, 5, 0));
    const tok = makeToken('EOF', '', s);
    expect(tok.kind).toBe('EOF');
    expect(tok.text).toBe('');
  });

  it('should create an Error token with raw text', () => {
    const s = span('f.efs', pos(10, 1, 10), pos(11, 1, 11));
    const tok = makeToken('Error', '@', s);
    expect(tok.kind).toBe('Error');
    expect(tok.text).toBe('@');
  });

  it('should have empty trivia arrays by default', () => {
    const s = span('f.efs', pos(0, 1, 0), pos(3, 1, 3));
    const tok = makeToken('let', 'let', s);
    expect(tok.leadingTrivia).toEqual([]);
    expect(tok.trailingTrivia).toEqual([]);
  });

  it('should carry leading and trailing trivia', () => {
    const wsTrivia = makeTrivia('whitespace', '  ', span('f.efs', pos(0, 1, 0), pos(2, 1, 2)));
    const nlTrivia = makeTrivia('newline', '\n', span('f.efs', pos(5, 1, 5), pos(6, 2, 0)));
    const s = span('f.efs', pos(2, 1, 2), pos(5, 1, 5));
    const tok = makeToken('let', 'let', s, [wsTrivia], [nlTrivia]);
    expect(tok.leadingTrivia).toHaveLength(1);
    expect(tok.leadingTrivia[0].kind).toBe('whitespace');
    expect(tok.trailingTrivia).toHaveLength(1);
    expect(tok.trailingTrivia[0].kind).toBe('newline');
  });

  it('should support string interpolation tokens', () => {
    const s1 = span('f.efs', pos(0, 1, 0), pos(8, 1, 8));
    const start = makeToken('StringStart', '"hello ${', s1);
    expect(start.kind).toBe('StringStart');

    const s2 = span('f.efs', pos(13, 1, 13), pos(15, 1, 15));
    const part = makeToken('StringPart', '} world ${', s2);
    expect(part.kind).toBe('StringPart');

    const s3 = span('f.efs', pos(20, 1, 20), pos(22, 1, 22));
    const end = makeToken('StringEnd', '}"', s3);
    expect(end.kind).toBe('StringEnd');
  });
});

describe('TokenKind exhaustiveness', () => {
  it('should include all expected keyword kinds', () => {
    const keywords: TokenKind[] = [
      'let', 'var', 'match', 'if', 'else', 'type',
      'import', 'export', 'from', 'for', 'while',
      'try', 'catch', 'throw', 'break', 'continue', 'return',
      'in', 'true', 'false', 'null', 'new',
      'fun', 'this', 'async', 'await',
    ];
    // If any of these aren't valid TokenKind values, TypeScript will error at compile time.
    // At runtime, just verify the array was constructed.
    expect(keywords).toHaveLength(26);
  });

  it('should include all expected operator kinds', () => {
    const operators: TokenKind[] = [
      'Plus', 'Minus', 'Star', 'Slash', 'Percent',
      'EqualEqual', 'BangEqual',
      'Less', 'Greater', 'LessEqual', 'GreaterEqual',
      'AmpAmp', 'PipePipe', 'Bang',
      'QuestionDot', 'QuestionQuestion',
      'FatArrow', 'Equal',
      'Pipe',
    ];
    expect(operators).toHaveLength(19);
  });

  it('should include all expected punctuation kinds', () => {
    const punctuation: TokenKind[] = [
      'LeftParen', 'RightParen',
      'LeftBrace', 'RightBrace',
      'LeftBracket', 'RightBracket',
      'Colon', 'Comma', 'Semicolon', 'Dot',
    ];
    expect(punctuation).toHaveLength(10);
  });

  it('should include special token kinds', () => {
    const special: TokenKind[] = ['EOF', 'Error'];
    expect(special).toHaveLength(2);
  });
});
