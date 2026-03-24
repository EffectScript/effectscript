/**
 * @module lexer
 *
 * Lexical analysis (tokenization) for EffectScript source code.
 *
 * Converts a raw source string into a flat array of {@link Token} objects.
 * The lexer is single-pass, left-to-right, and produces one token per call
 * to {@link readContentToken}. It handles:
 *
 * - Identifiers and keywords (disambiguated via {@link KEYWORDS})
 * - Numeric literals (decimal and hexadecimal)
 * - String literals with escape sequences and `${...}` interpolation
 * - All operators and punctuation defined in {@link TokenKind}
 * - Trivia collection (whitespace, line comments, block comments)
 *
 * **Error recovery**: The lexer never throws. Malformed input produces
 * `Error` tokens and diagnostics are reported to the provided
 * {@link DiagnosticCollector}. The parser can then decide how to recover.
 *
 * **String interpolation model**: Interpolated strings are split into a
 * sequence of `StringStart`, regular expression tokens, `StringPart`
 * (for multi-interpolation), and `StringEnd` tokens. A brace-depth stack
 * (`interpolationStack`) tracks nesting so that `{` and `}` inside
 * interpolations are matched correctly.
 *
 * Diagnostic codes emitted by the lexer:
 * - `E001` — Unterminated string literal
 * - `E002` — Unterminated block comment
 * - `E003` — Unknown escape sequence
 * - `E004` — Unexpected character
 * - `E005` — Expected hex digits after `0x`
 * - `E008` — Unterminated string interpolation
 */

import type { Position, Span } from '../utils/span.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import type { Token, TokenKind, Trivia } from './tokens.js';
import { KEYWORDS } from './tokens.js';

/**
 * Tokenize an EffectScript source string into a token stream.
 *
 * This is the public entry point for lexical analysis. It creates a
 * {@link Lexer} instance internally and drives it to completion.
 *
 * @param source    - The raw EffectScript source text to tokenize.
 * @param filePath  - File path used in diagnostic messages and {@link Span} locations.
 * @param diagnostics - Collector that receives any lexer errors encountered.
 * @returns A complete token list, always terminated by an `EOF` token.
 */
export function tokenize(
  source: string,
  filePath: string,
  diagnostics: DiagnosticCollector,
): Token[] {
  const lexer = new Lexer(source, filePath, diagnostics);
  return lexer.tokenizeAll();
}

/**
 * Internal lexer state machine.
 *
 * Maintains a cursor (`pos`) over the source string and tracks line/column
 * for source mapping. The lexer alternates between collecting trivia
 * (whitespace, comments) and reading content tokens (keywords, literals,
 * operators). String interpolation nesting is tracked via `interpolationStack`.
 */
class Lexer {
  /** The complete source text being tokenized. */
  private readonly source: string;
  /** File path for span metadata. */
  private readonly filePath: string;
  /** Collector for lexer diagnostics (errors, warnings). */
  private readonly diagnostics: DiagnosticCollector;
  /** Current byte offset into `source`. */
  private pos: number = 0;
  /** Current 1-based line number. */
  private line: number = 1;
  /** Current 0-based column number (resets to 0 at each newline). */
  private column: number = 0;
  /** Accumulated output tokens. */
  private tokens: Token[] = [];
  /**
   * Stack of brace depths for string interpolation nesting.
   *
   * Each entry represents one level of `${...}` interpolation. The value
   * is the count of unmatched `{` braces within that interpolation level.
   * When a `}` is encountered at depth 0, the interpolation ends and
   * string lexing resumes.
   */
  private interpolationStack: number[] = [];

  constructor(source: string, filePath: string, diagnostics: DiagnosticCollector) {
    this.source = source;
    this.filePath = filePath;
    this.diagnostics = diagnostics;
  }

  /**
   * Drive the lexer to completion, producing all tokens from the source.
   *
   * Alternates between collecting leading trivia, reading a content token,
   * and collecting trailing trivia until the source is exhausted. Always
   * appends an `EOF` token at the end.
   *
   * @returns The complete token array including the final `EOF`.
   */
  tokenizeAll(): Token[] {
    while (this.pos < this.source.length) {
      const leadingTrivia = this.collectLeadingTrivia();

      if (this.pos >= this.source.length) {
        // Only trivia remains — attach to EOF
        this.emitEOF(leadingTrivia);
        return this.tokens;
      }

      const token = this.readContentToken();
      const trailingTrivia = this.collectTrailingTrivia();

      this.tokens.push({
        ...token,
        leadingTrivia,
        trailingTrivia,
      });
    }

    // Emit EOF
    this.emitEOF([]);
    return this.tokens;
  }

  /**
   * Append the sentinel `EOF` token and report any unterminated interpolation.
   *
   * @param leadingTrivia - Any trailing trivia from the source to attach to the EOF token.
   */
  private emitEOF(leadingTrivia: Trivia[]): void {
    // Report unterminated interpolation if we're still inside one
    if (this.interpolationStack.length > 0) {
      const pos = this.currentPosition();
      const span = this.makeSpan(pos, pos);
      this.reportDiagnostic(D.E008, 'Unterminated string interpolation', span);
      this.interpolationStack.length = 0;
    }

    const pos = this.currentPosition();
    this.tokens.push({
      kind: 'EOF',
      text: '',
      span: { file: this.filePath, start: pos, end: pos },
      leadingTrivia,
      trailingTrivia: [],
    });
  }

  // ── Position Tracking ─────────────────────────────────────────────

  /** Snapshot the current cursor as a {@link Position} (offset, line, column). */
  private currentPosition(): Position {
    return { offset: this.pos, line: this.line, column: this.column };
  }

  /** Return the character at the current position, or `''` at EOF. */
  private peek(): string {
    return this.pos < this.source.length ? this.source[this.pos] : '';
  }

  /**
   * Return the character at a relative offset from the current position.
   *
   * @param offset - Number of characters ahead to look (e.g. 1 for next char).
   * @returns The character at `pos + offset`, or `''` if out of bounds.
   */
  private peekAt(offset: number): string {
    const idx = this.pos + offset;
    return idx < this.source.length ? this.source[idx] : '';
  }

  /** Create a {@link Span} from two positions within the current file. */
  private makeSpan(start: Position, end: Position): Span {
    return { file: this.filePath, start, end };
  }

  // ── Trivia Collection ─────────────────────────────────────────────

  /**
   * Collect all leading trivia before the next content token.
   *
   * Leading trivia includes whitespace, newlines, line comments (`//`),
   * and block comments. Collection stops at the first non-trivia character.
   *
   * @returns Array of trivia nodes in source order.
   */
  private collectLeadingTrivia(): Trivia[] {
    const trivia: Trivia[] = [];
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\uFEFF') {
        trivia.push(this.readWhitespace());
      } else if (ch === '\n' || ch === '\r') {
        trivia.push(this.readNewline());
      } else if (ch === '/' && this.peekAt(1) === '/') {
        trivia.push(this.readLineComment());
      } else if (ch === '/' && this.peekAt(1) === '*') {
        const result = this.readBlockComment();
        if (result === null) {
          // Unterminated block comment — already reported diagnostic and emitted Error token
          return trivia;
        }
        trivia.push(result);
      } else {
        break;
      }
    }
    return trivia;
  }

  /**
   * Collect trailing trivia on the same line after a content token.
   *
   * Only horizontal whitespace (`' '`, `'\t'`) and same-line comments
   * are collected. A newline or non-trivia character stops collection
   * (the newline becomes leading trivia for the next token).
   *
   * @returns Array of trivia nodes in source order.
   */
  private collectTrailingTrivia(): Trivia[] {
    const trivia: Trivia[] = [];
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t') {
        trivia.push(this.readWhitespace());
      } else if (ch === '/' && this.peekAt(1) === '/') {
        trivia.push(this.readLineComment());
      } else if (ch === '/' && this.peekAt(1) === '*') {
        // Block comment on same line as trailing trivia
        const result = this.readBlockComment();
        if (result === null) {
          return trivia;
        }
        trivia.push(result);
      } else {
        // Newline or non-trivia ends trailing trivia collection
        break;
      }
    }
    return trivia;
  }

  /** Consume a run of horizontal whitespace (spaces, tabs, BOM). */
  private readWhitespace(): Trivia {
    const start = this.currentPosition();
    let text = '';
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\uFEFF') {
        text += ch;
        this.pos++;
        this.column++;
      } else {
        break;
      }
    }
    return { kind: 'whitespace', text, span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Consume a newline sequence (`\n`, `\r`, or `\r\n`) and update line tracking. */
  private readNewline(): Trivia {
    const start = this.currentPosition();
    let text = '';
    const ch = this.peek();
    if (ch === '\r') {
      text += '\r';
      this.pos++;
      if (this.pos < this.source.length && this.source[this.pos] === '\n') {
        text += '\n';
        this.pos++;
      }
    } else {
      text += '\n';
      this.pos++;
    }
    this.line++;
    this.column = 0;
    return { kind: 'newline', text, span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Consume a line comment (`// ...`) up to (but not including) the next newline. */
  private readLineComment(): Trivia {
    const start = this.currentPosition();
    let text = '';
    // Consume // and everything until newline or EOF
    while (this.pos < this.source.length && this.source[this.pos] !== '\n' && this.source[this.pos] !== '\r') {
      text += this.source[this.pos];
      this.pos++;
      this.column++;
    }
    return { kind: 'lineComment', text, span: this.makeSpan(start, this.currentPosition()) };
  }

  /**
   * Consume a block comment (`/* ... *​/`).
   *
   * Handles newlines within the comment body for correct line tracking.
   * If the comment is unterminated (EOF reached before `*​/`), reports
   * diagnostic `E002` and emits an `Error` token.
   *
   * @returns The trivia node, or `null` if the comment was unterminated.
   */
  private readBlockComment(): Trivia | null {
    const start = this.currentPosition();
    let text = '/*';
    this.pos += 2;
    this.column += 2;

    while (this.pos < this.source.length) {
      if (this.source[this.pos] === '*' && this.peekAt(1) === '/') {
        text += '*/';
        this.pos += 2;
        this.column += 2;
        return { kind: 'blockComment', text, span: this.makeSpan(start, this.currentPosition()) };
      }
      const ch = this.source[this.pos];
      text += ch;
      if (ch === '\n') {
        this.pos++;
        this.line++;
        this.column = 0;
      } else if (ch === '\r') {
        this.pos++;
        if (this.pos < this.source.length && this.source[this.pos] === '\n') {
          text += '\n';
          this.pos++;
        }
        this.line++;
        this.column = 0;
      } else {
        this.pos++;
        this.column++;
      }
    }

    // Unterminated block comment
    const span = this.makeSpan(start, this.currentPosition());
    this.reportDiagnostic(D.E002, 'Unterminated block comment', span);
    this.tokens.push({
      kind: 'Error',
      text,
      span,
      leadingTrivia: [],
      trailingTrivia: [],
    });
    return null;
  }

  // ── Content Token Reading ─────────────────────────────────────────

  /**
   * Read the next content (non-trivia) token from the source.
   *
   * Dispatches to specialized readers based on the current character:
   * identifiers/keywords, numbers, strings, or operator/punctuation.
   *
   * @returns A token without trivia (trivia is attached by the caller).
   */
  private readContentToken(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const ch = this.peek();

    if (isIdentStart(ch)) return this.readIdentifierOrKeyword();
    if (isDigit(ch)) return this.readNumber();
    if (ch === '"') return this.readString();

    // Operators and punctuation
    switch (ch) {
      case '+': return this.singleToken('Plus', '+');
      case '-': return this.singleToken('Minus', '-');
      case '*': return this.singleToken('Star', '*');
      case '%': return this.singleToken('Percent', '%');
      case '/': return this.singleToken('Slash', '/');
      case '=': return this.readEqual();
      case '!': return this.readBang();
      case '<': return this.readLess();
      case '>': return this.readGreater();
      case '&': return this.readAmpersand();
      case '|': return this.readPipe();
      case '?': return this.readQuestion();
      case '(': return this.singleToken('LeftParen', '(');
      case ')': return this.singleToken('RightParen', ')');
      case '{': return this.readLeftBrace();
      case '}': return this.readRightBraceOrStringResume();
      case '[': return this.singleToken('LeftBracket', '[');
      case ']': return this.singleToken('RightBracket', ']');
      case ':': return this.singleToken('Colon', ':');
      case ',': return this.singleToken('Comma', ',');
      case ';': return this.singleToken('Semicolon', ';');
      case '.': return this.readDot();
      default:
        return this.readUnknownChar();
    }
  }

  /**
   * Consume a single character and produce a token of the given kind.
   *
   * @param kind - The token kind to assign.
   * @param text - The expected single-character text.
   * @returns The constructed token.
   */
  private singleToken(kind: TokenKind, text: string): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    return { kind, text, span: this.makeSpan(start, this.currentPosition()) };
  }

  // ── Identifier and Keyword ────────────────────────────────────────

  /**
   * Read an identifier or keyword token.
   *
   * Consumes characters matching `[a-zA-Z_][a-zA-Z0-9_]*`, then checks
   * the result against {@link KEYWORDS} to determine if it's a reserved word.
   */
  private readIdentifierOrKeyword(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    let text = '';
    while (this.pos < this.source.length && isIdentContinue(this.source[this.pos])) {
      text += this.source[this.pos];
      this.pos++;
      this.column++;
    }
    const kind: TokenKind = KEYWORDS.has(text) ? text as TokenKind : 'Identifier';
    return { kind, text, span: this.makeSpan(start, this.currentPosition()) };
  }

  // ── Number Literals ───────────────────────────────────────────────

  /**
   * Read a numeric literal (decimal or hexadecimal).
   *
   * Supports:
   * - Decimal integers: `42`
   * - Decimal floats: `3.14` (requires a digit after the dot)
   * - Hex integers: `0xFF`, `0XAB`
   *
   * Reports `E005` if `0x` is not followed by hex digits.
   */
  private readNumber(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    let text = '';

    // Check for hex
    if (this.peek() === '0' && (this.peekAt(1) === 'x' || this.peekAt(1) === 'X')) {
      text += this.source[this.pos]; // '0'
      this.pos++;
      this.column++;
      text += this.source[this.pos]; // 'x' or 'X'
      this.pos++;
      this.column++;

      if (this.pos >= this.source.length || !isHexDigit(this.source[this.pos])) {
        // E005: Expected hex digits
        const span = this.makeSpan(start, this.currentPosition());
        this.reportDiagnostic(D.E005, "Expected hex digits after '0x'", span);
        return { kind: 'Error', text, span };
      }

      while (this.pos < this.source.length && isHexDigit(this.source[this.pos])) {
        text += this.source[this.pos];
        this.pos++;
        this.column++;
      }
      return { kind: 'NumberLiteral', text, span: this.makeSpan(start, this.currentPosition()) };
    }

    // Integer part
    while (this.pos < this.source.length && isDigit(this.source[this.pos])) {
      text += this.source[this.pos];
      this.pos++;
      this.column++;
    }

    // Decimal part: only if '.' followed by a digit
    if (this.peek() === '.' && this.pos + 1 < this.source.length && isDigit(this.source[this.pos + 1])) {
      text += '.';
      this.pos++;
      this.column++;
      while (this.pos < this.source.length && isDigit(this.source[this.pos])) {
        text += this.source[this.pos];
        this.pos++;
        this.column++;
      }
    }

    return { kind: 'NumberLiteral', text, span: this.makeSpan(start, this.currentPosition()) };
  }

  // ── String Literals ───────────────────────────────────────────────

  /**
   * Begin reading a string literal from its opening `"` quote.
   *
   * Delegates to {@link readStringContent} which handles the shared logic
   * for both initial strings and post-interpolation continuations.
   */
  private readString(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    let text = '"';
    this.pos++; // consume opening "
    this.column++;

    return this.readStringContent(start, text, true);
  }

  /**
   * Read string content until a closing quote, interpolation start, or error.
   *
   * This is the shared workhorse for string lexing. It handles:
   * - Closing `"` → produces `SimpleString` (if `isStart`) or `StringEnd`
   * - `${` → produces `StringStart` (if `isStart`) or `StringPart`, pushes interpolation
   * - Escape sequences via {@link readEscape}
   * - Unterminated strings (newline or EOF) → `Error` token + diagnostic
   *
   * @param start   - Position where this string segment began.
   * @param text    - Accumulated text so far (includes the opening `"` or `}`).
   * @param isStart - `true` when this is the first segment (from the opening `"`),
   *                  `false` when resuming after an interpolation close `}`.
   */
  private readStringContent(
    start: Position,
    text: string,
    isStart: boolean,
  ): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];

      if (ch === '"') {
        // Closing quote
        text += '"';
        this.pos++;
        this.column++;
        const kind: TokenKind = isStart ? 'SimpleString' : 'StringEnd';
        return { kind, text, span: this.makeSpan(start, this.currentPosition()) };
      }

      if (ch === '\\') {
        // Escape sequence
        const escapeResult = this.readEscape();
        if (escapeResult.error) {
          // Unknown escape — emit an Error token for the entire string so far
          text += escapeResult.text;
          // Continue reading to find the end of string
          continue;
        }
        text += escapeResult.text;
        continue;
      }

      if (ch === '$' && this.peekAt(1) === '{') {
        // Interpolation start
        text += '${';
        this.pos += 2;
        this.column += 2;
        this.interpolationStack.push(0);

        const kind: TokenKind = isStart ? 'StringStart' : 'StringPart';
        return { kind, text, span: this.makeSpan(start, this.currentPosition()) };
      }

      if (ch === '\n' || ch === '\r') {
        // Unterminated string (newline inside string)
        const span = this.makeSpan(start, this.currentPosition());
        this.reportDiagnostic(D.E001, 'Unterminated string literal', span);
        return { kind: 'Error', text, span };
      }

      text += ch;
      this.pos++;
      this.column++;
    }

    // EOF inside string
    const span = this.makeSpan(start, this.currentPosition());
    if (this.interpolationStack.length > 0) {
      this.reportDiagnostic(D.E008, 'Unterminated string interpolation', span);
    } else {
      this.reportDiagnostic(D.E001, 'Unterminated string literal', span);
    }
    return { kind: 'Error', text, span };
  }

  /**
   * Read a backslash escape sequence within a string literal.
   *
   * Recognized escapes: `\\`, `\"`, `\n`, `\t`, `\r`, `\0`, `\$`.
   * Unknown escapes report `E003` and set `error: true` in the result.
   *
   * @returns An object with the consumed `text` (including the backslash)
   *          and an `error` flag indicating if the escape was unrecognized.
   */
  private readEscape(): { text: string; error: boolean } {
    // We're positioned at the backslash
    let text = '\\';
    this.pos++;
    this.column++;

    if (this.pos >= this.source.length) {
      return { text, error: false };
    }

    const ch = this.source[this.pos];
    switch (ch) {
      case '\\': case '"': case 'n': case 't': case 'r': case '0': case '$':
        text += ch;
        this.pos++;
        this.column++;
        return { text, error: false };
      default: {
        // Unknown escape
        const escStart: Position = { offset: this.pos - 1, line: this.line, column: this.column - 1 };
        text += ch;
        this.pos++;
        this.column++;
        const span = this.makeSpan(escStart, this.currentPosition());
        this.reportDiagnostic(D.E003, `Unknown escape sequence '\\${ch}'`, span);
        return { text, error: true };
      }
    }
  }

  /**
   * Resume string lexing after a `}` closes a `${...}` interpolation.
   *
   * Pops the interpolation stack and continues reading string content.
   * The resulting token will be `StringPart` (if another `${` follows)
   * or `StringEnd` (if the closing `"` follows).
   */
  private resumeStringAfterInterpolation(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    let text = '}';
    this.pos++; // consume }
    this.column++;
    this.interpolationStack.pop();

    return this.readStringContent(start, text, false);
  }

  // ── Operator Reading ──────────────────────────────────────────────

  /** Read `=`, `==`, or `=>` (assignment, equality, fat arrow). */
  private readEqual(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '=') {
      this.pos++;
      this.column++;
      return { kind: 'EqualEqual', text: '==', span: this.makeSpan(start, this.currentPosition()) };
    }
    if (this.peek() === '>') {
      this.pos++;
      this.column++;
      return { kind: 'FatArrow', text: '=>', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Equal', text: '=', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `!` or `!=` (logical not, inequality). */
  private readBang(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '=') {
      this.pos++;
      this.column++;
      return { kind: 'BangEqual', text: '!=', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Bang', text: '!', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `<` or `<=` (less-than, less-or-equal). */
  private readLess(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '=') {
      this.pos++;
      this.column++;
      return { kind: 'LessEqual', text: '<=', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Less', text: '<', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `>` or `>=` (greater-than, greater-or-equal). */
  private readGreater(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '=') {
      this.pos++;
      this.column++;
      return { kind: 'GreaterEqual', text: '>=', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Greater', text: '>', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `&` (intersection type operator) or `&&` (logical and). */
  private readAmpersand(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '&') {
      this.pos++;
      this.column++;
      return { kind: 'AmpAmp', text: '&&', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Amp', text: '&', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `|` or `||` (union/ADT separator, logical or). */
  private readPipe(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '|') {
      this.pos++;
      this.column++;
      return { kind: 'PipePipe', text: '||', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Pipe', text: '|', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `?`, `?.`, or `??` (nullable type, optional chaining, null coalescing). */
  private readQuestion(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    this.pos++;
    this.column++;
    if (this.peek() === '.') {
      this.pos++;
      this.column++;
      return { kind: 'QuestionDot', text: '?.', span: this.makeSpan(start, this.currentPosition()) };
    }
    if (this.peek() === '?') {
      this.pos++;
      this.column++;
      return { kind: 'QuestionQuestion', text: '??', span: this.makeSpan(start, this.currentPosition()) };
    }
    return { kind: 'Question', text: '?', span: this.makeSpan(start, this.currentPosition()) };
  }

  /** Read `.`, `..`, or `..<` (member access, inclusive range, exclusive range). */
  private readDot(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    if (this.peekAt(1) === '.') {
      const start = this.currentPosition();
      this.pos += 2;
      this.column += 2;
      if (this.peek() === '<') {
        this.pos++;
        this.column++;
        return { kind: 'DotDotLess', text: '..<', span: this.makeSpan(start, this.currentPosition()) };
      }
      return { kind: 'DotDot', text: '..', span: this.makeSpan(start, this.currentPosition()) };
    }
    return this.singleToken('Dot', '.');
  }

  // ── Brace Handling ────────────────────────────────────────────────

  /**
   * Read a `{` token, incrementing interpolation brace depth if inside a string.
   *
   * When inside a `${...}` interpolation, nested braces (e.g. object literals)
   * must be tracked so the lexer knows which `}` closes the interpolation
   * vs. which closes a nested construct.
   */
  private readLeftBrace(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    // If inside interpolation, increment brace depth
    if (this.interpolationStack.length > 0) {
      this.interpolationStack[this.interpolationStack.length - 1]++;
    }
    return this.singleToken('LeftBrace', '{');
  }

  /**
   * Read a `}` token, or resume string lexing if this closes an interpolation.
   *
   * If inside an interpolation and brace depth is 0, this `}` ends the
   * interpolation and string content resumes. Otherwise, it's a normal
   * `RightBrace` token (with interpolation depth decremented if applicable).
   */
  private readRightBraceOrStringResume(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    if (this.interpolationStack.length > 0) {
      const depth = this.interpolationStack[this.interpolationStack.length - 1];
      if (depth === 0) {
        // This } closes the interpolation — resume string lexing
        return this.resumeStringAfterInterpolation();
      }
      // Decrement brace depth
      this.interpolationStack[this.interpolationStack.length - 1]--;
    }
    return this.singleToken('RightBrace', '}');
  }

  // ── Unknown Character ─────────────────────────────────────────────

  /** Consume a single unrecognized character and report `E004`. */
  private readUnknownChar(): Omit<Token, 'leadingTrivia' | 'trailingTrivia'> {
    const start = this.currentPosition();
    const ch = this.source[this.pos];
    this.pos++;
    this.column++;
    const span = this.makeSpan(start, this.currentPosition());
    this.reportDiagnostic(D.E004, `Unexpected character '${ch}'`, span);
    return { kind: 'Error', text: ch, span };
  }

  // ── Diagnostics ───────────────────────────────────────────────────

  /**
   * Report an error diagnostic to the collector.
   *
   * @param code    - Diagnostic code (e.g. `'E001'`).
   * @param message - Human-readable error description.
   * @param span    - Source location of the error.
   */
  private reportDiagnostic(code: string, message: string, span: Span): void {
    this.diagnostics.report({
      severity: 'error',
      code,
      message,
      span,
    });
  }
}

// ── Character Classification ────────────────────────────────────────

/** Check if `ch` can start an identifier: `[a-zA-Z_]`. */
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

/** Check if `ch` can continue an identifier: `[a-zA-Z0-9_]`. */
function isIdentContinue(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Check if `ch` is an ASCII decimal digit: `[0-9]`. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Check if `ch` is an ASCII hexadecimal digit: `[0-9a-fA-F]`. */
function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
