import { describe, it, expect } from 'vitest';
import { tokenize } from './lexer.js';
import type { Token, TokenKind, Trivia } from './tokens.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';

// ── Helpers ──────────────────────────────────────────────────────────

function lex(source: string): { tokens: Token[]; diagnostics: readonly Diagnostic[] } {
  const collector = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', collector);
  return { tokens, diagnostics: collector.getAll() };
}

/** Lex and return token kinds (excluding EOF). */
function kinds(source: string): TokenKind[] {
  return lex(source).tokens.slice(0, -1).map((t) => t.kind);
}

/** Lex and return token texts (excluding EOF). */
function texts(source: string): string[] {
  return lex(source).tokens.slice(0, -1).map((t) => t.text);
}

/** Lex and return the first non-EOF token. */
function first(source: string): Token {
  const { tokens } = lex(source);
  if (tokens.length < 2) throw new Error('Expected at least one token before EOF');
  return tokens[0];
}

/** Lex and return the EOF token. */
function eof(source: string): Token {
  const { tokens } = lex(source);
  return tokens[tokens.length - 1];
}

// ── Happy Path: Keywords and Identifiers ─────────────────────────────

describe('Keywords and Identifiers', () => {
  const allKeywords: TokenKind[] = [
    'let', 'mut', 'match', 'if', 'else', 'type',
    'import', 'export', 'from', 'for', 'while',
    'try', 'catch', 'throw', 'break', 'continue', 'return',
    'in', 'true', 'false', 'null', 'new',
  ];

  it.each(allKeywords)('should tokenize keyword %s', (kw) => {
    const tok = first(kw);
    expect(tok.kind).toBe(kw);
    expect(tok.text).toBe(kw);
  });

  it('should tokenize identifiers', () => {
    const identifiers = ['foo', 'myVar', '_private', 'camelCase', 'PascalCase', 'x1', '__double'];
    for (const id of identifiers) {
      const tok = first(id);
      expect(tok.kind).toBe('Identifier');
      expect(tok.text).toBe(id);
    }
  });

  it('should tokenize `rec` as identifier (not a keyword)', () => {
    const tok = first('rec');
    expect(tok.kind).toBe('Identifier');
    expect(tok.text).toBe('rec');
  });

  it('should not treat keyword-like identifiers as keywords', () => {
    const notKeywords = ['letter', 'matching', 'types', 'iffy', 'letting'];
    for (const id of notKeywords) {
      const tok = first(id);
      expect(tok.kind).toBe('Identifier');
      expect(tok.text).toBe(id);
    }
  });

  it('should handle underscore as an identifier', () => {
    const tok = first('_');
    expect(tok.kind).toBe('Identifier');
    expect(tok.text).toBe('_');
  });
});

// ── Happy Path: Number Literals ──────────────────────────────────────

describe('Number Literals', () => {
  it('should tokenize integers', () => {
    expect(first('0').kind).toBe('NumberLiteral');
    expect(first('0').text).toBe('0');
    expect(first('42').kind).toBe('NumberLiteral');
    expect(first('42').text).toBe('42');
    expect(first('100').kind).toBe('NumberLiteral');
    expect(first('100').text).toBe('100');
  });

  it('should tokenize decimal numbers', () => {
    expect(first('3.14').text).toBe('3.14');
    expect(first('0.5').text).toBe('0.5');
    expect(first('123.456').text).toBe('123.456');
  });

  it('should tokenize hex numbers', () => {
    const tok1 = first('0xFF');
    expect(tok1.kind).toBe('NumberLiteral');
    expect(tok1.text).toBe('0xFF');

    const tok2 = first('0XAB');
    expect(tok2.kind).toBe('NumberLiteral');
    expect(tok2.text).toBe('0XAB');

    const tok3 = first('0x0');
    expect(tok3.kind).toBe('NumberLiteral');
    expect(tok3.text).toBe('0x0');
  });

  it('should lex 123abc as NumberLiteral then Identifier', () => {
    expect(kinds('123abc')).toEqual(['NumberLiteral', 'Identifier']);
    expect(texts('123abc')).toEqual(['123', 'abc']);
  });

  it('should lex 0. at EOF as NumberLiteral then Dot', () => {
    expect(kinds('0.')).toEqual(['NumberLiteral', 'Dot']);
    expect(texts('0.')).toEqual(['0', '.']);
  });

  it('should lex 0.5 as a single decimal NumberLiteral', () => {
    expect(kinds('0.5')).toEqual(['NumberLiteral']);
    expect(texts('0.5')).toEqual(['0.5']);
  });

  it('should lex .5 as Dot then NumberLiteral', () => {
    expect(kinds('.5')).toEqual(['Dot', 'NumberLiteral']);
  });

  it('should lex .. as two Dots', () => {
    expect(kinds('..')).toEqual(['Dot', 'Dot']);
  });
});

// ── Happy Path: String Literals ──────────────────────────────────────

describe('String Literals', () => {
  it('should tokenize a simple string', () => {
    const tok = first('"hello"');
    expect(tok.kind).toBe('SimpleString');
    expect(tok.text).toBe('"hello"');
  });

  it('should tokenize an empty string', () => {
    const tok = first('""');
    expect(tok.kind).toBe('SimpleString');
    expect(tok.text).toBe('""');
  });

  it('should tokenize strings with escape sequences', () => {
    expect(first('"line\\nbreak"').kind).toBe('SimpleString');
    expect(first('"line\\nbreak"').text).toBe('"line\\nbreak"');

    expect(first('"tab\\there"').kind).toBe('SimpleString');
    expect(first('"null\\0char"').kind).toBe('SimpleString');
    expect(first('"quote\\"inside"').kind).toBe('SimpleString');
    expect(first('"backslash\\\\here"').kind).toBe('SimpleString');
    expect(first('"dollar\\$sign"').kind).toBe('SimpleString');
  });

  it('should tokenize a single interpolation', () => {
    const k = kinds('"hello ${name}"');
    expect(k).toEqual(['StringStart', 'Identifier', 'StringEnd']);

    const t = texts('"hello ${name}"');
    expect(t).toEqual(['"hello ${', 'name', '}"']);
  });

  it('should tokenize multiple interpolations', () => {
    const k = kinds('"${a} and ${b}"');
    expect(k).toEqual(['StringStart', 'Identifier', 'StringPart', 'Identifier', 'StringEnd']);
  });

  it('should tokenize expression in interpolation', () => {
    const k = kinds('"${x + 1}"');
    expect(k).toEqual(['StringStart', 'Identifier', 'Plus', 'NumberLiteral', 'StringEnd']);
  });

  it('should handle nested braces in interpolation', () => {
    const k = kinds('"${fn(() => { body })}"');
    expect(k).toEqual([
      'StringStart',
      'Identifier', 'LeftParen', 'LeftParen', 'RightParen', 'FatArrow',
      'LeftBrace', 'Identifier', 'RightBrace', 'RightParen',
      'StringEnd',
    ]);
  });

  it('should tokenize adjacent interpolations', () => {
    const k = kinds('"${a}${b}"');
    expect(k).toEqual(['StringStart', 'Identifier', 'StringPart', 'Identifier', 'StringEnd']);

    const t = texts('"${a}${b}"');
    expect(t[0]).toBe('"${');
    expect(t[2]).toBe('}${');
    expect(t[4]).toBe('}"');
  });

  it('should tokenize string with only interpolation', () => {
    const k = kinds('"${x}"');
    expect(k).toEqual(['StringStart', 'Identifier', 'StringEnd']);

    const t = texts('"${x}"');
    expect(t).toEqual(['"${', 'x', '}"']);
  });

  it('should handle escaped dollar preventing interpolation', () => {
    const tok = first('"price is \\$100"');
    expect(tok.kind).toBe('SimpleString');
    expect(tok.text).toBe('"price is \\$100"');
  });
});

// ── Happy Path: Operators ────────────────────────────────────────────

describe('Operators', () => {
  it('should tokenize single-character operators', () => {
    const ops: [string, TokenKind][] = [
      ['+', 'Plus'],
      ['-', 'Minus'],
      ['*', 'Star'],
      ['/', 'Slash'],
      ['%', 'Percent'],
      ['<', 'Less'],
      ['>', 'Greater'],
      ['!', 'Bang'],
      ['=', 'Equal'],
      ['|', 'Pipe'],
    ];
    for (const [src, expected] of ops) {
      const tok = first(src);
      expect(tok.kind).toBe(expected);
      expect(tok.text).toBe(src);
    }
  });

  it('should tokenize multi-character operators', () => {
    const ops: [string, TokenKind][] = [
      ['==', 'EqualEqual'],
      ['!=', 'BangEqual'],
      ['<=', 'LessEqual'],
      ['>=', 'GreaterEqual'],
      ['&&', 'AmpAmp'],
      ['||', 'PipePipe'],
      ['?.', 'QuestionDot'],
      ['??', 'QuestionQuestion'],
      ['=>', 'FatArrow'],
      ['|>', 'PipeGreater'],
    ];
    for (const [src, expected] of ops) {
      const tok = first(src);
      expect(tok.kind).toBe(expected);
      expect(tok.text).toBe(src);
    }
  });

  it('should disambiguate overlapping prefixes', () => {
    // !== should be BangEqual + Equal
    expect(kinds('!==')).toEqual(['BangEqual', 'Equal']);
    // ||> should be PipePipe + Greater
    expect(kinds('||>')).toEqual(['PipePipe', 'Greater']);
    // |> should be PipeGreater
    expect(kinds('|>')).toEqual(['PipeGreater']);
    // => should be FatArrow
    expect(kinds('=>')).toEqual(['FatArrow']);
  });
});

// ── Happy Path: Punctuation ──────────────────────────────────────────

describe('Punctuation', () => {
  it('should tokenize all punctuation tokens', () => {
    const pairs: [string, TokenKind][] = [
      ['(', 'LeftParen'],
      [')', 'RightParen'],
      ['{', 'LeftBrace'],
      ['}', 'RightBrace'],
      ['[', 'LeftBracket'],
      [']', 'RightBracket'],
      [':', 'Colon'],
      [',', 'Comma'],
      [';', 'Semicolon'],
      ['.', 'Dot'],
    ];
    for (const [src, expected] of pairs) {
      const tok = first(src);
      expect(tok.kind).toBe(expected);
      expect(tok.text).toBe(src);
    }
  });
});

// ── Happy Path: Trivia ───────────────────────────────────────────────

describe('Trivia', () => {
  it('should attach leading whitespace', () => {
    const tok = first('  let');
    expect(tok.kind).toBe('let');
    expect(tok.leadingTrivia).toHaveLength(1);
    expect(tok.leadingTrivia[0].kind).toBe('whitespace');
    expect(tok.leadingTrivia[0].text).toBe('  ');
  });

  it('should attach trailing whitespace (newline becomes leading of next token)', () => {
    const { tokens } = lex('let  \nx');
    const letToken = tokens[0];
    expect(letToken.kind).toBe('let');
    expect(letToken.trailingTrivia).toHaveLength(1);
    expect(letToken.trailingTrivia[0].kind).toBe('whitespace');
    expect(letToken.trailingTrivia[0].text).toBe('  ');

    // Newline becomes leading trivia of next token
    const xToken = tokens[1];
    expect(xToken.kind).toBe('Identifier');
    expect(xToken.leadingTrivia.length).toBeGreaterThanOrEqual(1);
    expect(xToken.leadingTrivia[0].kind).toBe('newline');
  });

  it('should handle line comment as trivia', () => {
    const tok = first('// comment\nlet');
    expect(tok.kind).toBe('let');
    expect(tok.leadingTrivia.length).toBe(2);
    expect(tok.leadingTrivia[0].kind).toBe('lineComment');
    expect(tok.leadingTrivia[0].text).toBe('// comment');
    expect(tok.leadingTrivia[1].kind).toBe('newline');
  });

  it('should handle block comment as trivia', () => {
    const tok = first('/* comment */let');
    expect(tok.kind).toBe('let');
    expect(tok.leadingTrivia).toHaveLength(1);
    expect(tok.leadingTrivia[0].kind).toBe('blockComment');
    expect(tok.leadingTrivia[0].text).toBe('/* comment */');
  });

  it('should handle inline trailing comment', () => {
    const { tokens } = lex('let // comment\nx');
    const letToken = tokens[0];
    expect(letToken.trailingTrivia.length).toBe(2);
    expect(letToken.trailingTrivia[0].kind).toBe('whitespace');
    expect(letToken.trailingTrivia[1].kind).toBe('lineComment');
  });

  it('should handle multiple leading trivia items', () => {
    const tok = first('\n  // comment\n  let');
    expect(tok.kind).toBe('let');
    // Should have: newline, whitespace, lineComment, newline, whitespace
    expect(tok.leadingTrivia).toHaveLength(5);
    expect(tok.leadingTrivia[0].kind).toBe('newline');
    expect(tok.leadingTrivia[1].kind).toBe('whitespace');
    expect(tok.leadingTrivia[2].kind).toBe('lineComment');
    expect(tok.leadingTrivia[3].kind).toBe('newline');
    expect(tok.leadingTrivia[4].kind).toBe('whitespace');
  });

  it('should attach EOF trivia at end of file', () => {
    const eofTok = eof('x  // trailing');
    expect(eofTok.kind).toBe('EOF');
    // The trailing whitespace and comment after 'x' should be trailing trivia of 'x',
    // but EOF still gets called
  });

  it('should treat BOM as whitespace trivia', () => {
    const tok = first('\uFEFFlet');
    expect(tok.kind).toBe('let');
    expect(tok.leadingTrivia.length).toBe(1);
    expect(tok.leadingTrivia[0].kind).toBe('whitespace');
  });
});

// ── Happy Path: Source Positions ─────────────────────────────────────

describe('Source Positions', () => {
  it('should set correct offset, line, column on first token', () => {
    const tok = first('let');
    expect(tok.span.start.offset).toBe(0);
    expect(tok.span.start.line).toBe(1);
    expect(tok.span.start.column).toBe(0);
    expect(tok.span.end.offset).toBe(3);
    expect(tok.span.end.line).toBe(1);
    expect(tok.span.end.column).toBe(3);
  });

  it('should advance positions through multiple tokens', () => {
    const { tokens } = lex('let x');
    const letTok = tokens[0];
    expect(letTok.span.start.offset).toBe(0);
    expect(letTok.span.end.offset).toBe(3);

    const xTok = tokens[1];
    expect(xTok.span.start.offset).toBe(4);
    expect(xTok.span.end.offset).toBe(5);
  });

  it('should reset column after newlines', () => {
    const { tokens } = lex('x\ny');
    const yTok = tokens[1];
    expect(yTok.span.start.line).toBe(2);
    expect(yTok.span.start.column).toBe(0);
  });

  it('should handle multi-line source correctly', () => {
    const { tokens } = lex('let x = 42\nlet y = 10');
    // Second line: 'let' at line 2
    const letTok2 = tokens.find((t, i) => t.kind === 'let' && i > 0);
    expect(letTok2).toBeDefined();
    expect(letTok2!.span.start.line).toBe(2);
    expect(letTok2!.span.start.column).toBe(0);
  });

  it('should set correct file path on spans', () => {
    const collector = new DiagnosticCollectorImpl();
    const tokens = tokenize('x', 'myfile.efs', collector);
    expect(tokens[0].span.file).toBe('myfile.efs');
  });
});

// ── Happy Path: Complete Programs ────────────────────────────────────

describe('Complete Programs', () => {
  it('should tokenize "let x = 42"', () => {
    const k = kinds('let x = 42');
    expect(k).toEqual(['let', 'Identifier', 'Equal', 'NumberLiteral']);
  });

  it('should tokenize a function binding', () => {
    const k = kinds('let add = (x: number, y: number): number => x + y');
    expect(k).toEqual([
      'let', 'Identifier', 'Equal', 'LeftParen',
      'Identifier', 'Colon', 'Identifier', 'Comma',
      'Identifier', 'Colon', 'Identifier', 'RightParen',
      'Colon', 'Identifier', 'FatArrow',
      'Identifier', 'Plus', 'Identifier',
    ]);
  });

  it('should tokenize an import statement', () => {
    const k = kinds('import { foo } from "./bar"');
    expect(k).toEqual([
      'import', 'LeftBrace', 'Identifier', 'RightBrace',
      'from', 'SimpleString',
    ]);
  });

  it('should tokenize a match expression', () => {
    const k = kinds('match x { 1 => "one" _ => "other" }');
    expect(k).toEqual([
      'match', 'Identifier', 'LeftBrace',
      'NumberLiteral', 'FatArrow', 'SimpleString',
      'Identifier', 'FatArrow', 'SimpleString',
      'RightBrace',
    ]);
  });
});

// ── Edge Case Tests ──────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('should return just EOF for empty source', () => {
    const { tokens, diagnostics } = lex('');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('EOF');
    expect(tokens[0].leadingTrivia).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('should return EOF with trivia for whitespace-only source', () => {
    const { tokens } = lex('   \n  \n');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('EOF');
    expect(tokens[0].leadingTrivia.length).toBeGreaterThan(0);
  });

  it('should disambiguate adjacent operators: !==', () => {
    expect(kinds('!==')).toEqual(['BangEqual', 'Equal']);
  });

  it('should disambiguate adjacent operators: ||>', () => {
    expect(kinds('||>')).toEqual(['PipePipe', 'Greater']);
  });

  it('should disambiguate adjacent operators: |>', () => {
    expect(kinds('|>')).toEqual(['PipeGreater']);
  });

  it('should lex number followed by identifier: 123abc', () => {
    expect(kinds('123abc')).toEqual(['NumberLiteral', 'Identifier']);
  });

  it('should handle dot disambiguation: 0.5 vs obj.field vs ..', () => {
    expect(kinds('0.5')).toEqual(['NumberLiteral']);
    expect(kinds('obj.field')).toEqual(['Identifier', 'Dot', 'Identifier']);
    expect(kinds('..')).toEqual(['Dot', 'Dot']);
  });

  it('should handle } closing interpolation vs closing block', () => {
    // In interpolation: } resumes string
    const k1 = kinds('"${x}"');
    expect(k1).toEqual(['StringStart', 'Identifier', 'StringEnd']);

    // In blocks: } is RightBrace
    const k2 = kinds('{ x }');
    expect(k2).toEqual(['LeftBrace', 'Identifier', 'RightBrace']);
  });

  it('should handle non-ASCII characters in strings', () => {
    const tok = first('"héllo"');
    expect(tok.kind).toBe('SimpleString');
    expect(tok.text).toBe('"héllo"');
  });

  it('should handle \\r\\n line endings', () => {
    const { tokens } = lex('x\r\ny');
    const yTok = tokens[1];
    expect(yTok.span.start.line).toBe(2);
    expect(yTok.span.start.column).toBe(0);
  });

  it('should handle \\r line endings', () => {
    const { tokens } = lex('x\ry');
    const yTok = tokens[1];
    expect(yTok.span.start.line).toBe(2);
    expect(yTok.span.start.column).toBe(0);
  });
});

// ── Error/Rejection Tests ────────────────────────────────────────────

describe('Error Handling', () => {
  it('should report E001 for unterminated string', () => {
    const { tokens, diagnostics } = lex('"hello');
    expect(tokens.some((t) => t.kind === 'Error')).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('E001');
    expect(diagnostics[0].severity).toBe('error');
  });

  it('should report E001 for string terminated by newline', () => {
    const { diagnostics } = lex('"hello\nworld');
    expect(diagnostics.some((d) => d.code === 'E001')).toBe(true);
  });

  it('should report E002 for unterminated block comment', () => {
    const { tokens, diagnostics } = lex('/* oops');
    expect(tokens.some((t) => t.kind === 'Error')).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('E002');
  });

  it('should report E003 for unknown escape sequence', () => {
    const { diagnostics } = lex('"bad\\q"');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('E003');
    expect(diagnostics[0].message).toContain('q');
  });

  it('should report E004 for unexpected characters', () => {
    for (const ch of ['@', '#', '`']) {
      const { tokens, diagnostics } = lex(ch);
      expect(tokens.some((t) => t.kind === 'Error')).toBe(true);
      expect(diagnostics.some((d) => d.code === 'E004')).toBe(true);
    }
  });

  it('should report E005 for empty hex literal', () => {
    const { tokens, diagnostics } = lex('0x');
    expect(tokens.some((t) => t.kind === 'Error')).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('E005');
  });

  it('should report E006 for single &', () => {
    const { tokens, diagnostics } = lex('&');
    expect(tokens.some((t) => t.kind === 'Error')).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('E006');
    expect(diagnostics[0].message).toContain('&&');
  });

  it('should lex single ? as Question token', () => {
    const tok = first('?');
    expect(tok.kind).toBe('Question');
    expect(tok.text).toBe('?');
  });

  it('should report E008 for unterminated interpolation at EOF', () => {
    const { diagnostics } = lex('"${');
    expect(diagnostics.some((d) => d.code === 'E008')).toBe(true);
  });

  it('should report multiple errors in one file', () => {
    const { diagnostics } = lex('@ # `');
    expect(diagnostics.length).toBe(3);
    diagnostics.forEach((d) => expect(d.code).toBe('E004'));
  });

  it('should continue lexing after errors', () => {
    const { tokens } = lex('@ let');
    const letToken = tokens.find((t) => t.kind === 'let');
    expect(letToken).toBeDefined();
  });
});

// ── Diagnostic Quality Tests ─────────────────────────────────────────

describe('Diagnostic Quality', () => {
  it('should have correct spans on error diagnostics', () => {
    const { diagnostics } = lex('@');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].span.start.offset).toBe(0);
    expect(diagnostics[0].span.end.offset).toBe(1);
  });

  it('should include the character in E004 messages', () => {
    const { diagnostics } = lex('@');
    expect(diagnostics[0].message).toContain('@');
  });

  it('should have diagnostic codes in E001-E099 range', () => {
    // Test several error types
    const sources = ['"unterminated', '/* open', '"\\q"', '@', '0x', '&'];
    for (const src of sources) {
      const { diagnostics } = lex(src);
      for (const d of diagnostics) {
        const num = parseInt(d.code.slice(1), 10);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(99);
      }
    }
  });
});

// ── Integration Tests ────────────────────────────────────────────────

describe('Integration', () => {
  it('should tokenize a realistic multi-line program', () => {
    const source = `let x = 42
let name = "world"
let greeting = "hello \${name}!"
if x == 42 {
  greeting
} else {
  "unknown"
}`;
    const { tokens, diagnostics } = lex(source);
    expect(diagnostics).toHaveLength(0);
    // Should end with EOF
    expect(tokens[tokens.length - 1].kind).toBe('EOF');
    // Should contain expected token kinds
    const k = tokens.map((t) => t.kind);
    expect(k).toContain('let');
    expect(k).toContain('Identifier');
    expect(k).toContain('NumberLiteral');
    expect(k).toContain('SimpleString');
    expect(k).toContain('StringStart');
    expect(k).toContain('StringEnd');
    expect(k).toContain('if');
    expect(k).toContain('else');
  });

  it('should round-trip: concatenating all text and trivia reproduces original source', () => {
    const source = 'let x = 42  // answer\nlet y = x + 1\n';
    const { tokens } = lex(source);

    let reconstructed = '';
    for (const tok of tokens) {
      for (const t of tok.leadingTrivia) {
        reconstructed += t.text;
      }
      reconstructed += tok.text;
      for (const t of tok.trailingTrivia) {
        reconstructed += t.text;
      }
    }
    expect(reconstructed).toBe(source);
  });

  it('should round-trip a program with block comments', () => {
    const source = '/* header */\nlet /* inline */ x = 42';
    const { tokens } = lex(source);

    let reconstructed = '';
    for (const tok of tokens) {
      for (const t of tok.leadingTrivia) {
        reconstructed += t.text;
      }
      reconstructed += tok.text;
      for (const t of tok.trailingTrivia) {
        reconstructed += t.text;
      }
    }
    expect(reconstructed).toBe(source);
  });

  it('should round-trip a string interpolation', () => {
    const source = '"hello ${name}!"';
    const { tokens } = lex(source);

    let reconstructed = '';
    for (const tok of tokens) {
      for (const t of tok.leadingTrivia) {
        reconstructed += t.text;
      }
      reconstructed += tok.text;
      for (const t of tok.trailingTrivia) {
        reconstructed += t.text;
      }
    }
    expect(reconstructed).toBe(source);
  });
});

// ── Comment Edge Cases ───────────────────────────────────────────────

describe('Comment Edge Cases', () => {
  it('should handle line comment at EOF with no trailing newline', () => {
    const { tokens, diagnostics } = lex('x // comment');
    expect(diagnostics).toHaveLength(0);
    const xTok = tokens[0];
    expect(xTok.trailingTrivia.some((t) => t.kind === 'lineComment')).toBe(true);
  });

  it('should not nest block comments (first */ closes)', () => {
    // /* nested /* */ */ — the first */ closes the block comment
    // Then the remaining " */" is Star + Slash tokens
    const k = kinds('/* nested /* */ */');
    expect(k).toContain('Star');
    expect(k).toContain('Slash');
  });
});

// ── Question Token Tests ─────────────────────────────────────────────

describe('Question Token', () => {
  it('should lex ?. as QuestionDot', () => {
    expect(first('?.').kind).toBe('QuestionDot');
  });

  it('should lex ?? as QuestionQuestion', () => {
    expect(first('??').kind).toBe('QuestionQuestion');
  });

  it('should lex bare ? as Question', () => {
    expect(first('?').kind).toBe('Question');
    expect(first('?').text).toBe('?');
  });
});
