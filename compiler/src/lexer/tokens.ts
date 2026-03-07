/**
 * @module tokens
 *
 * Token definitions for the EffectScript lexer.
 *
 * Defines the complete vocabulary of the language: keywords, operators,
 * punctuation, literals, and special tokens. Also defines the trivia model
 * used to preserve whitespace and comments for formatting tools.
 *
 * Token kinds use string literal unions rather than numeric enums for
 * readability in tests and diagnostics. Keywords are their own literal
 * text (e.g. `'let'`, `'if'`), while operators and punctuation use
 * descriptive names (e.g. `'EqualEqual'` for `==`).
 */

import type { Span } from '../utils/span.js';

/**
 * Classification of non-semantic content (whitespace, comments) attached
 * to tokens. Trivia is preserved so that formatting and documentation
 * tools can reconstruct the original source layout.
 */
export type TriviaKind = 'whitespace' | 'newline' | 'lineComment' | 'blockComment';

/**
 * A piece of non-semantic content (whitespace or comment) attached to a token.
 *
 * Leading trivia appears before the token's meaningful text; trailing trivia
 * appears after it on the same line.
 */
export interface Trivia {
  /** What category of trivia this represents. */
  readonly kind: TriviaKind;
  /** The exact source text of the trivia (e.g. `"  "`, `"// comment"`). */
  readonly text: string;
  /** Source location of the trivia. */
  readonly span: Span;
}

/**
 * Discriminant for every token the lexer can produce.
 *
 * Categories:
 * - **Keywords**: language-reserved words (`let`, `if`, `match`, etc.)
 * - **Identifiers and literals**: user-defined names, numbers, strings
 * - **Operators**: arithmetic, comparison, logical, null-coalescing, pipe
 * - **Punctuation**: braces, brackets, parens, delimiters
 * - **Special**: `EOF` (end of input) and `Error` (malformed input)
 *
 * String interpolation uses a three-token model:
 * - `StringStart` — `"text ${` (opening quote through first interpolation)
 * - `StringPart` — `}text ${` (between interpolations)
 * - `StringEnd` — `}text"` (last interpolation through closing quote)
 * - `SimpleString` — `"text"` (no interpolation at all)
 */
export type TokenKind =
  // Keywords
  | 'let' | 'mut' | 'match' | 'if' | 'else' | 'type'
  | 'import' | 'export' | 'from' | 'for' | 'while'
  | 'try' | 'catch' | 'throw' | 'break' | 'continue' | 'return'
  | 'in' | 'true' | 'false' | 'null' | 'new'
  // Identifiers and literals
  | 'Identifier'
  | 'NumberLiteral'
  | 'SimpleString'
  | 'StringStart' | 'StringPart' | 'StringEnd'
  // Operators
  | 'Plus' | 'Minus' | 'Star' | 'Slash' | 'Percent'
  | 'EqualEqual' | 'BangEqual'
  | 'Less' | 'Greater' | 'LessEqual' | 'GreaterEqual'
  | 'AmpAmp' | 'PipePipe' | 'Bang'
  | 'QuestionDot' | 'QuestionQuestion' | 'Question'
  | 'FatArrow' | 'Equal'
  | 'Pipe' | 'PipeGreater'
  // Punctuation
  | 'LeftParen' | 'RightParen'
  | 'LeftBrace' | 'RightBrace'
  | 'LeftBracket' | 'RightBracket'
  | 'Colon' | 'Comma' | 'Semicolon' | 'Dot'
  // Special
  | 'EOF'
  | 'Error';

/**
 * A single lexical token produced by the lexer.
 *
 * Every token carries its kind, original source text, source location,
 * and any attached trivia. The trivia model ensures that every character
 * in the source is accounted for by exactly one token or trivia node.
 */
export interface Token {
  /** The syntactic category of this token. */
  readonly kind: TokenKind;
  /** The exact source text that produced this token. */
  readonly text: string;
  /** Source location spanning from the first to last character of the token text. */
  readonly span: Span;
  /** Whitespace and comments appearing before this token. */
  readonly leadingTrivia: readonly Trivia[];
  /** Whitespace and comments appearing after this token on the same line. */
  readonly trailingTrivia: readonly Trivia[];
}

/** Set of all keyword token kinds for quick lookup during identifier/keyword disambiguation. */
export const KEYWORDS: ReadonlySet<string> = new Set<TokenKind>([
  'let', 'mut', 'match', 'if', 'else', 'type',
  'import', 'export', 'from', 'for', 'while',
  'try', 'catch', 'throw', 'break', 'continue', 'return',
  'in', 'true', 'false', 'null', 'new',
]);
