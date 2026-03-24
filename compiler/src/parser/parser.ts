/**
 * @module parser
 *
 * Recursive-descent parser for EffectScript.
 *
 * Converts a flat token stream (from the lexer) into an untyped AST.
 * The parser uses Pratt parsing for expressions (operator precedence climbing)
 * and straightforward recursive descent for declarations, statements, patterns,
 * and type annotations.
 *
 * Key design decisions:
 * - **Trivia preservation**: Leading/trailing trivia from tokens is attached
 *   to AST nodes via {@link withTrivia} for formatting tools.
 * - **Error recovery**: On syntax errors, the parser reports a diagnostic,
 *   emits an {@link ErrorNode}, and synchronizes to the next statement boundary.
 *   It never throws.
 * - **Arrow disambiguation**: `(x, y) => ...` vs. parenthesized expression
 *   is resolved by speculative lookahead via {@link Parser.isArrow}.
 * - **Generic disambiguation**: `foo<T>(x)` vs. `foo < T` is resolved by
 *   speculative parsing via {@link Parser.tryParseTypeArgs}.
 * - **`??` mixing**: The parser detects `??` mixed with `&&`/`||` without
 *   explicit parentheses and reports `E117` (matching JS SyntaxError behavior).
 *
 * Diagnostic codes emitted by the parser: `E100`–`E117`.
 */

import type { Span } from '../utils/span.js';
import { mergeSpans } from '../utils/span.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import { KEYWORDS } from '../lexer/tokens.js';
import type { Token, TokenKind } from '../lexer/tokens.js';
import type {
  Program, Declaration, Expression, Statement, Pattern, TypeNode,
  VariantDeclaration, TypeParameter, ImportSpecifier, ExportSpecifier,
  Identifier, BinaryOperator, CallExpr, MemberExpr,
  MatchArm, BlockExpr, FunctionParam,
  RecordField, TemplatePart,
  RecordPatternField, RecordTypeField, RecordType,
  ForRange,
  ErrorNode,
} from './ast.js';
import { OPERATOR_PRECEDENCE } from '../utils/operators.js';

/**
 * Parse an EffectScript token stream into an untyped AST.
 *
 * This is the public entry point for parsing. It creates a {@link Parser}
 * instance and drives it to produce a {@link Program} node.
 *
 * @param tokens      - The token array from the lexer (must end with `EOF`).
 * @param _filePath   - File path for diagnostics (currently unused; spans carry the path).
 * @param diagnostics - Collector that receives any parser errors.
 * @returns The root {@link Program} AST node.
 */
export function parse(
  tokens: readonly Token[],
  _filePath: string,
  diagnostics: DiagnosticCollector,
): Program {
  return new Parser(tokens, diagnostics).parseProgram();
}

// ── Operator Tables ──────────────────────────────────────────────────

/** Maps binary operators to their precedence levels (higher = tighter binding). */
const PRECEDENCE = OPERATOR_PRECEDENCE;

/** Maps token kinds to their corresponding binary operator strings. */
const TOKEN_TO_BINOP: Partial<Record<TokenKind, BinaryOperator>> = {
  Plus: '+', Minus: '-', Star: '*', Slash: '/', Percent: '%',
  EqualEqual: '==', BangEqual: '!=',
  Less: '<', Greater: '>', LessEqual: '<=', GreaterEqual: '>=',
  AmpAmp: '&&', PipePipe: '||',
  QuestionQuestion: '??',
};

// ── Trivia Transfer ─────────────────────────────────────────────────

/**
 * Attach leading/trailing trivia from the first/last tokens to an AST node.
 *
 * Uses runtime property assignment via Record cast to avoid
 * `exactOptionalPropertyTypes` issues with `prop: undefined`.
 *
 * @param obj   - The AST node object to annotate.
 * @param first - The first token spanning this node (provides leading trivia).
 * @param last  - The last token spanning this node (provides trailing trivia).
 * @returns The same `obj` with trivia properties set.
 */
function withTrivia<T>(obj: T, first: Token, last: Token): T {
  const rec = obj as Record<string, unknown>;
  if (first.leadingTrivia.length > 0) rec['leadingTrivia'] = first.leadingTrivia;
  if (last.trailingTrivia.length > 0) rec['trailingTrivia'] = last.trailingTrivia;
  return obj;
}

/** Check if a name starts with an uppercase letter (used to distinguish variant patterns from bindings). */
function isCapitalized(name: string): boolean {
  return name.length > 0 && name[0] >= 'A' && name[0] <= 'Z';
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Recursive-descent parser with Pratt expression parsing.
 *
 * Maintains a cursor (`pos`) over the token array. The parser never mutates
 * the token stream — it only advances the position. Speculative parsing
 * (for arrow functions and generic type arguments) saves and restores `pos`.
 */
class Parser {
  /** The complete token array from the lexer. */
  private readonly tokens: readonly Token[];
  /** Current position in the token array. */
  private pos: number = 0;
  /** Collector for parser diagnostics. */
  private readonly diagnostics: DiagnosticCollector;

  constructor(tokens: readonly Token[], diagnostics: DiagnosticCollector) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  // ── Token primitives ───────────────────────────────────────────────
  // These low-level methods provide the token-stream interface used by
  // all parsing methods. They handle bounds checking and EOF safety.

  /** Return the current token (or the last token if past the end). */
  private cur(): Token { return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]; }
  /** Lookahead `n` tokens from current position (default 0 = current). */
  private peek(n: number = 0): Token { return this.tokens[this.pos + n] ?? this.tokens[this.tokens.length - 1]; }
  /** Return the most recently consumed token. */
  private prev(): Token { return this.pos > 0 ? this.tokens[this.pos - 1] : this.cur(); }
  /** Consume and return the current token, advancing the cursor (no-op at EOF). */
  private advance(): Token { const t = this.cur(); if (t.kind !== 'EOF') this.pos++; return t; }
  /** Check if the current token is of the given kind without consuming it. */
  private check(k: TokenKind): boolean { return this.cur().kind === k; }
  /** If the current token matches `k`, consume it and return `true`; otherwise return `false`. */
  private match(k: TokenKind): boolean { if (this.check(k)) { this.advance(); return true; } return false; }
  /** Check if we've reached the end of the token stream. */
  private atEnd(): boolean { return this.cur().kind === 'EOF'; }

  /**
   * Consume and return a token of the expected kind, or report `E100` and
   * return a synthetic token if the current token doesn't match.
   */
  private expect(k: TokenKind): Token {
    if (this.check(k)) return this.advance();
    const t = this.cur();
    this.error(D.E100, `Expected '${k}', found '${t.kind}'`, t.span);
    return { kind: k, text: '', span: t.span, leadingTrivia: [], trailingTrivia: [] };
  }

  /** Check if there is a newline in the current token's leading trivia (for ASI). */
  private hasNewline(): boolean { return this.cur().leadingTrivia.some(t => t.kind === 'newline'); }
  /** Check if we're at a statement boundary (semicolon, `}`, EOF, or newline). */
  private atStmtEnd(): boolean { return this.check('Semicolon') || this.check('RightBrace') || this.atEnd() || this.hasNewline(); }
  /** Consume an optional semicolon (automatic semicolon insertion). */
  private eatSemicolon(): void { this.match('Semicolon'); }
  /** Report a parser error diagnostic. */
  private error(code: string, msg: string, span: Span): void { this.diagnostics.report({ severity: 'error', code, message: msg, span }); }

  /** Create an {@link Identifier} AST node from a token. */
  private id(tok: Token): Identifier { return { kind: 'Identifier', name: tok.text, span: tok.span }; }

  /**
   * Consume an identifier or reserved keyword token and return it.
   * Used in positions where keywords are valid names (member access, property names).
   */
  private expectIdentifierName(): Token {
    const t = this.cur();
    if (t.kind === 'Identifier' || KEYWORDS.has(t.kind)) return this.advance();
    this.error(D.E100, `Expected identifier or keyword, found '${t.kind}'`, t.span);
    return { kind: 'Identifier', text: '', span: t.span, leadingTrivia: [], trailingTrivia: [] };
  }

  /**
   * Error recovery: skip tokens until a likely statement boundary.
   *
   * Stops at semicolons, closing braces, and declaration keywords
   * so that the parser can resume normal parsing.
   */
  private synchronize(): void {
    while (!this.atEnd()) {
      const k = this.cur().kind;
      if (k === 'Semicolon' || k === 'RightBrace' || k === 'let' || k === 'type' || k === 'import' || k === 'export' || k === 'fun') return;
      this.advance();
    }
  }

  /**
   * Create an {@link ErrorNode} spanning from `startPos` to the current position.
   *
   * Concatenates the text of all skipped tokens for diagnostic display.
   *
   * @param startPos - Token index where the error region began.
   */
  private errorNode(startPos: number): ErrorNode {
    let text = '';
    for (let i = startPos; i < this.pos; i++) text += this.tokens[i].text;
    if (text === '') text = this.cur().text;
    const st = this.tokens[startPos] ?? this.cur();
    return withTrivia<ErrorNode>(
      { kind: 'ErrorNode', text, span: mergeSpans(st.span, this.prev().span) },
      st, this.prev(),
    );
  }

  // ── Program ────────────────────────────────────────────────────────

  /** Parse the entire token stream into a {@link Program} root node. */
  parseProgram(): Program {
    const start = this.cur();
    const body: (Declaration | Statement)[] = [];
    while (!this.atEnd()) {
      const item = this.topLevel();
      if (item !== null) body.push(item);
    }
    const eof = this.cur();
    const span = body.length > 0 ? mergeSpans(body[0].span, body[body.length - 1].span) : eof.span;
    return withTrivia<Program>({ kind: 'Program', body, span }, start, eof);
  }

  /** Parse a single top-level item (declaration or statement). Returns `null` on parse failure. */
  private topLevel(): (Declaration | Statement) | null {
    switch (this.cur().kind) {
      case 'let': return this.letDecl(false);
      case 'type': return this.typeDecl(false);
      case 'import': return this.importDecl();
      case 'export': return this.exportDecl();
      case 'fun': return this.extensionFunDecl(false);
      case 'async':
        if (this.peek(1).kind === 'fun') {
          this.advance(); // consume 'async'
          return this.extensionFunDecl(false, true);
        }
        return this.exprOrAssign();
      case 'for': return this.forStmt();
      case 'while': return this.whileStmt();
      case 'throw': return this.throwStmt();
      case 'break': {
        const t = this.advance(); this.eatSemicolon();
        return withTrivia<Statement>({ kind: 'BreakStatement', span: t.span }, t, t);
      }
      case 'continue': {
        const t = this.advance(); this.eatSemicolon();
        return withTrivia<Statement>({ kind: 'ContinueStatement', span: t.span }, t, t);
      }
      case 'return': return this.returnStmt();
      default: return this.exprOrAssign();
    }
  }

  // ── Declarations ───────────────────────────────────────────────────

  /**
   * Parse a `let` declaration: `let [mut] name [: Type] = expr`.
   *
   * @param exported - `true` if this declaration is wrapped by `export`.
   * @returns A {@link LetDeclaration} on success, or an {@link ExpressionStatement}
   *          wrapping an {@link ErrorNode} on parse failure.
   */
  private letDecl(exported: boolean): Declaration | Statement {
    const letTok = this.advance();
    const mutable = this.match('mut');

    if (!this.check('Identifier')) {
      this.error(D.E100, `Expected identifier after 'let${mutable ? ' mut' : ''}', found '${this.cur().kind}'`, this.cur().span);
      const sp = this.pos - (mutable ? 2 : 1);
      this.synchronize(); this.eatSemicolon();
      const en = this.errorNode(sp);
      return withTrivia<Statement>(
        { kind: 'ExpressionStatement', expression: en as unknown as Expression, span: en.span },
        letTok, this.prev(),
      );
    }

    const name = this.id(this.advance());
    let typeAnnotation: TypeNode | undefined;
    if (this.match('Colon')) typeAnnotation = this.parseType();
    this.expect('Equal');

    if (this.atEnd() || this.atStmtEnd()) {
      this.error(D.E101, 'Expected expression', this.cur().span);
      const en: ErrorNode = { kind: 'ErrorNode', text: '', span: this.cur().span };
      return withTrivia<Statement>(
        { kind: 'ExpressionStatement', expression: en as unknown as Expression, span: mergeSpans(letTok.span, this.prev().span) },
        letTok, this.prev(),
      );
    }

    const init = this.expr();
    const last = this.prev();
    this.eatSemicolon();

    const result: Record<string, unknown> = {
      kind: 'LetDeclaration',
      name,
      mutable,
      initializer: init,
      exported,
      span: mergeSpans(letTok.span, last.span),
    };
    if (typeAnnotation !== undefined) result['typeAnnotation'] = typeAnnotation;
    return withTrivia(result as unknown as Declaration, letTok, last);
  }

  /**
   * Parse a `type` declaration: `type Name[<T>] = Variant1 | Variant2` or `type Name = { ... }`.
   *
   * @param exported - `true` if this declaration is wrapped by `export`.
   */
  private typeDecl(exported: boolean): Declaration {
    const typeTok = this.advance();
    const name = this.id(this.expect('Identifier'));
    let typeParams: TypeParameter[] | undefined;
    if (this.check('Less')) typeParams = this.parseTypeParams();
    this.expect('Equal');

    let variants: VariantDeclaration[] = [];
    let recordType: RecordType | undefined;
    let typeAlias: TypeNode | undefined;

    if (this.check('LeftBrace')) {
      recordType = this.recordTy() as RecordType;
    } else if (this.check('SimpleString') || this.check('NumberLiteral') || this.check('true') || this.check('false')) {
      // Literal type alias: type HttpMethod = "GET" | "POST"
      typeAlias = this.parseType();
    } else {
      variants = this.parseVariants();
    }

    const last = this.prev();
    this.eatSemicolon();

    const result: Record<string, unknown> = {
      kind: 'TypeDeclaration',
      name,
      variants,
      exported,
      span: mergeSpans(typeTok.span, last.span),
    };
    if (typeParams !== undefined) result['typeParams'] = typeParams;
    if (recordType !== undefined) result['recordType'] = recordType;
    if (typeAlias !== undefined) result['typeAlias'] = typeAlias;
    return withTrivia(result as unknown as Declaration, typeTok, last);
  }

  /** Parse a `<T, U: Constraint, ...>` type parameter list. Assumes `<` is the current token. */
  private parseTypeParams(): TypeParameter[] {
    this.advance(); // <
    const params: TypeParameter[] = [];
    while (!this.check('Greater') && !this.atEnd()) {
      const t = this.expect('Identifier');
      const name = this.id(t);
      let constraint: TypeNode | undefined;
      if (this.match('Colon')) {
        constraint = this.parseType();
      }
      const endSpan = constraint ? constraint.span : t.span;
      const tp: Record<string, unknown> = { kind: 'TypeParameter', name, span: mergeSpans(t.span, endSpan) };
      if (constraint !== undefined) tp['constraint'] = constraint;
      params.push(tp as unknown as TypeParameter);
      if (!this.match('Comma')) break;
    }
    this.expect('Greater');
    return params;
  }

  /** Parse one or more ADT variants separated by `|`. */
  private parseVariants(): VariantDeclaration[] {
    const vs: VariantDeclaration[] = [this.parseVariant()];
    while (this.match('Pipe')) vs.push(this.parseVariant());
    return vs;
  }

  /** Parse a single ADT variant: `Name` or `Name(field: Type, ...)`. */
  private parseVariant(): VariantDeclaration {
    const nt = this.expect('Identifier');
    const name = this.id(nt);
    const fields: Array<{ name: Identifier; type: TypeNode }> = [];
    if (this.match('LeftParen')) {
      while (!this.check('RightParen') && !this.atEnd()) {
        const fn = this.id(this.expect('Identifier'));
        this.expect('Colon');
        fields.push({ name: fn, type: this.parseType() });
        if (!this.match('Comma')) break;
      }
      this.expect('RightParen');
    }
    return { kind: 'VariantDeclaration', name, fields, span: mergeSpans(nt.span, this.prev().span) };
  }

  /** Parse an `import` declaration: `import [default,] { named } from "path"`. */
  private importDecl(): Declaration {
    const imp = this.advance();
    let defaultImport: Identifier | undefined;
    const specifiers: ImportSpecifier[] = [];

    if (this.check('Identifier')) {
      defaultImport = this.id(this.advance());
      // After default import, check for `, { ... }` to combine default + named
      if (this.match('Comma')) {
        if (this.check('LeftBrace')) {
          this.parseNamedSpecifiers(specifiers);
        } else {
          this.error(D.E116, "Expected '{' after ',' in import", this.cur().span);
        }
      }
    } else if (this.check('LeftBrace')) {
      this.parseNamedSpecifiers(specifiers);
    } else {
      this.error(D.E116, "Expected '{' for import specifiers", this.cur().span);
    }

    this.expect('from');

    if (!this.check('SimpleString')) {
      this.error(D.E115, "Expected module path after 'from'", this.cur().span);
      const result: Record<string, unknown> = {
        kind: 'ImportDeclaration',
        specifiers,
        source: { kind: 'StringLiteral' as const, value: '', span: this.cur().span },
        span: mergeSpans(imp.span, this.prev().span),
      };
      if (defaultImport !== undefined) result['defaultImport'] = defaultImport;
      return result as unknown as Declaration;
    }

    const src = this.advance();
    this.eatSemicolon();
    const result: Record<string, unknown> = {
      kind: 'ImportDeclaration',
      specifiers,
      source: { kind: 'StringLiteral' as const, value: this.interp(src.text), span: src.span },
      span: mergeSpans(imp.span, src.span),
    };
    if (defaultImport !== undefined) result['defaultImport'] = defaultImport;
    return withTrivia(result as unknown as Declaration, imp, src);
  }

  /** Parse `{ a, b, c }` named import specifiers into the provided array. Assumes `{` is current. */
  private parseNamedSpecifiers(specifiers: ImportSpecifier[]): void {
    this.advance(); // consume LeftBrace
    while (!this.check('RightBrace') && !this.atEnd()) {
      const t = this.expect('Identifier');
      specifiers.push({ kind: 'ImportSpecifier', imported: this.id(t), span: t.span });
      if (!this.match('Comma')) break;
    }
    this.expect('RightBrace');
  }

  /** Parse an `export` declaration: `export let/type ...`, `export { ... }`, or `export { ... } from "mod"`. */
  private exportDecl(): Declaration {
    const exp = this.advance();

    if (this.check('let')) {
      const decl = this.letDecl(true);
      if (decl.kind === 'LetDeclaration') {
        const result: Record<string, unknown> = {
          kind: 'ExportDeclaration',
          declaration: decl,
          span: mergeSpans(exp.span, decl.span),
        };
        return withTrivia(result as unknown as Declaration, exp, this.prev());
      }
      return { kind: 'ExportDeclaration', span: mergeSpans(exp.span, decl.span) } as Declaration;
    }

    if (this.check('type')) {
      const decl = this.typeDecl(true);
      const result: Record<string, unknown> = {
        kind: 'ExportDeclaration',
        declaration: decl,
        span: mergeSpans(exp.span, decl.span),
      };
      return withTrivia(result as unknown as Declaration, exp, this.prev());
    }

    if (this.check('fun') || (this.check('async') && this.peek(1).kind === 'fun')) {
      const isAsync = this.check('async');
      if (isAsync) this.advance(); // consume 'async'
      const decl = this.extensionFunDecl(true, isAsync);
      if (decl.kind === 'ExtensionFunctionDeclaration') {
        const result: Record<string, unknown> = {
          kind: 'ExportDeclaration',
          declaration: decl,
          span: mergeSpans(exp.span, decl.span),
        };
        return withTrivia(result as unknown as Declaration, exp, this.prev());
      }
      return { kind: 'ExportDeclaration', span: mergeSpans(exp.span, decl.span) } as Declaration;
    }

    if (this.check('LeftBrace')) {
      this.advance();
      const specifiers: ExportSpecifier[] = [];
      while (!this.check('RightBrace') && !this.atEnd()) {
        const t = this.expect('Identifier');
        specifiers.push({ kind: 'ExportSpecifier', local: this.id(t), span: t.span });
        if (!this.match('Comma')) break;
      }
      this.expect('RightBrace');

      if (this.match('from')) {
        const src = this.expect('SimpleString');
        this.eatSemicolon();
        const result: Record<string, unknown> = {
          kind: 'ExportDeclaration',
          specifiers,
          source: { kind: 'StringLiteral' as const, value: this.interp(src.text), span: src.span },
          span: mergeSpans(exp.span, src.span),
        };
        return withTrivia(result as unknown as Declaration, exp, this.prev());
      }

      this.eatSemicolon();
      const result: Record<string, unknown> = {
        kind: 'ExportDeclaration',
        specifiers,
        span: mergeSpans(exp.span, this.prev().span),
      };
      return withTrivia(result as unknown as Declaration, exp, this.prev());
    }

    this.error(D.E104, `Unexpected token '${this.cur().kind}' after 'export'`, this.cur().span);
    return { kind: 'ExportDeclaration', span: exp.span } as Declaration;
  }

  // ── Statements ─────────────────────────────────────────────────────

  /**
   * Parse an extension function declaration: `[async] fun [<TypeParams>] ReceiverType.methodName(params): ReturnType => body`.
   *
   * @param exported - `true` if this declaration is wrapped by `export`.
   * @param isAsync - `true` if preceded by `async` keyword.
   */
  private extensionFunDecl(exported: boolean, isAsync = false): Declaration | Statement {
    const funTok = this.advance(); // consume 'fun'

    // Optional type parameters: fun <T> ...
    let typeParams: TypeParameter[] | undefined;
    if (this.check('Less')) {
      typeParams = this.parseTypeParams();
    }

    // Receiver type: a named type, possibly with type args
    if (!this.check('Identifier')) {
      this.error(D.E102, `Expected receiver type after 'fun'`, this.cur().span);
      this.synchronize();
      const en = this.errorNode(this.pos - 1);
      return withTrivia<Statement>(
        { kind: 'ExpressionStatement', expression: en as unknown as Expression, span: en.span },
        funTok, this.prev(),
      );
    }

    const receiverType = this.parseType();

    // Dot separator
    if (!this.match('Dot')) {
      this.error(D.E102, `Expected '.' after receiver type in extension function`, this.cur().span);
      this.synchronize();
      const en = this.errorNode(this.pos - 1);
      return withTrivia<Statement>(
        { kind: 'ExpressionStatement', expression: en as unknown as Expression, span: en.span },
        funTok, this.prev(),
      );
    }

    // Method name
    const nameToken = this.expect('Identifier');
    const name = this.id(nameToken);

    // Parameters
    this.expect('LeftParen');
    const params = this.parseFnParams();
    this.expect('RightParen');

    // Return type annotation (required — report E222 if missing)
    if (!this.match('Colon')) {
      this.error(D.E222, `Extension function requires a return type annotation`, this.cur().span);
      // Try to parse the rest anyway for recovery
      if (this.match('FatArrow')) {
        const body = this.expr();
        const result: Record<string, unknown> = {
          kind: 'ExtensionFunctionDeclaration',
          receiverType, name, params, body, exported,
          returnType: { kind: 'NamedType', name: { kind: 'Identifier', name: 'void', span: this.prev().span }, span: this.prev().span },
          span: mergeSpans(funTok.span, this.prev().span),
        };
        if (typeParams !== undefined) result['typeParams'] = typeParams;
        if (isAsync) result['async'] = true;
        return withTrivia(result as unknown as Declaration, funTok, this.prev());
      }
      this.synchronize();
      const en = this.errorNode(this.pos - 1);
      return withTrivia<Statement>(
        { kind: 'ExpressionStatement', expression: en as unknown as Expression, span: en.span },
        funTok, this.prev(),
      );
    }

    const returnType = this.parseType();

    // Fat arrow
    if (!this.match('FatArrow')) {
      this.error(D.E106, "Expected '=>' after extension function return type", this.cur().span);
    }

    const body = this.expr();

    const result: Record<string, unknown> = {
      kind: 'ExtensionFunctionDeclaration',
      receiverType, name, params, returnType, body, exported,
      span: mergeSpans(funTok.span, this.prev().span),
    };
    if (typeParams !== undefined) result['typeParams'] = typeParams;
    if (isAsync) result['async'] = true;
    return withTrivia(result as unknown as Declaration, funTok, this.prev());
  }

  /**
   * Parse a for loop: simple, range, or destructuring.
   *
   * Forms:
   * - `for (x in iterable) { ... }` — simple array iteration
   * - `for (i in 0..10) { ... }` — inclusive range
   * - `for (i in 0..<10) { ... }` — exclusive range
   * - `for ({ name, age } in users) { ... }` — record destructuring
   * - `for ((a, b) in pairs) { ... }` — tuple destructuring
   */
  private forStmt(): Statement {
    const f = this.advance(); // consume 'for'
    this.expect('LeftParen');

    // Parse loop variable: identifier, record pattern { ... }, or tuple pattern ( ... )
    const variable = this.parseForVariable();

    if (!this.match('in')) this.error(D.E114, "Expected 'in' in for loop", this.cur().span);

    // Parse the iterable / range start expression
    const startExpr = this.expr();

    // Check for range operator: .. or ..<
    let range: ForRange | undefined;
    if (this.check('DotDot') || this.check('DotDotLess')) {
      const rangeOp = this.advance();
      const exclusive = rangeOp.kind === 'DotDotLess';
      const endExpr = this.expr();
      range = {
        start: startExpr,
        end: endExpr,
        exclusive,
        span: mergeSpans(startExpr.span, endExpr.span),
      };
    }

    this.expect('RightParen');
    const body = this.blockExpr();
    this.eatSemicolon();

    const result: Record<string, unknown> = {
      kind: 'ForStatement',
      variable,
      iterable: startExpr,
      body,
      span: mergeSpans(f.span, this.prev().span),
    };
    if (range !== undefined) result['range'] = range;
    return withTrivia<Statement>(result as unknown as Statement, f, this.prev());
  }

  /**
   * Parse the loop variable in a for statement.
   *
   * Returns an Identifier, RecordPattern, or TuplePattern depending on
   * the leading token: `{` → record, `(` → tuple, otherwise identifier.
   */
  private parseForVariable(): Identifier | import('./ast.js').RecordPattern | import('./ast.js').TuplePattern {
    // Record destructuring: { name, age }
    if (this.check('LeftBrace')) {
      return this.recordPat() as import('./ast.js').RecordPattern;
    }

    // Tuple destructuring: (a, b) — must have at least 2 elements
    if (this.check('LeftParen')) {
      return this.parseForTuplePattern();
    }

    // Simple identifier
    return this.id(this.expect('Identifier'));
  }

  /**
   * Parse a tuple pattern for for-loop variable position: `(a, b)` or `(_, item)`.
   *
   * Requires at least 2 elements (with at least one comma) to disambiguate
   * from a parenthesized identifier. A single-element `(a)` is a parse error.
   */
  private parseForTuplePattern(): import('./ast.js').TuplePattern {
    const lp = this.advance(); // consume '('
    const elements: (Identifier | import('./ast.js').WildcardPattern)[] = [];

    while (!this.check('RightParen') && !this.atEnd()) {
      if (this.check('Identifier') && this.cur().text === '_') {
        elements.push({ kind: 'WildcardPattern', span: this.advance().span });
      } else {
        elements.push(this.id(this.expect('Identifier')));
      }
      if (!this.match('Comma')) break;
    }

    this.expect('RightParen');

    if (elements.length < 2) {
      this.error(D.E103, 'Tuple pattern requires at least 2 elements', mergeSpans(lp.span, this.prev().span));
    }

    return {
      kind: 'TuplePattern',
      elements,
      span: mergeSpans(lp.span, this.prev().span),
    };
  }

  /** Parse a `while (condition) { ... }` loop statement. */
  private whileStmt(): Statement {
    const w = this.advance();
    this.expect('LeftParen');
    const condition = this.expr();
    this.expect('RightParen');
    const body = this.blockExpr();
    this.eatSemicolon();
    return withTrivia<Statement>(
      { kind: 'WhileStatement', condition, body, span: mergeSpans(w.span, this.prev().span) },
      w, this.prev(),
    );
  }

  /** Parse a `throw expr` statement. */
  private throwStmt(): Statement {
    const t = this.advance();
    const value = this.expr();
    this.eatSemicolon();
    return withTrivia<Statement>(
      { kind: 'ThrowStatement', value, span: mergeSpans(t.span, this.prev().span) },
      t, this.prev(),
    );
  }

  /** Parse a `return` or `return expr` statement. */
  private returnStmt(): Statement {
    const t = this.advance();
    // Parse optional return value: if next is `;`, `}`, or EOF, it's a bare return
    if (this.check('Semicolon') || this.check('RightBrace') || this.atEnd()) {
      this.eatSemicolon();
      return withTrivia<Statement>(
        { kind: 'ReturnStatement', span: t.span },
        t, this.prev(),
      );
    }
    const value = this.expr();
    this.eatSemicolon();
    const result: Record<string, unknown> = {
      kind: 'ReturnStatement',
      span: mergeSpans(t.span, this.prev().span),
    };
    if (value !== undefined) result['value'] = value;
    return withTrivia(result as unknown as Statement, t, this.prev());
  }

  /** Parse an expression; if followed by `=`, treat as an assignment statement. */
  private exprOrAssign(): Statement {
    const expression = this.expr();
    if (this.check('Equal')) {
      this.advance();
      const value = this.expr();
      this.eatSemicolon();
      return withTrivia<Statement>(
        { kind: 'AssignmentStatement', target: expression, value, span: mergeSpans(expression.span, this.prev().span) },
        this.tokens[0], this.prev(),
      );
    }
    this.eatSemicolon();
    return withTrivia<Statement>(
      { kind: 'ExpressionStatement', expression, span: expression.span },
      this.tokens[0], this.prev(),
    );
  }

  // ── Expressions (Pratt) ────────────────────────────────────────────

  /**
   * Parse an expression using Pratt (precedence-climbing) parsing.
   *
   * Handles binary operators, call expressions, member access, optional
   * chaining, and generic type argument calls. The `minPrec` parameter
   * controls how tightly operators must bind before being consumed.
   *
   * @param minPrec - Minimum operator precedence to consume (default 0 = all operators).
   */
  private expr(minPrec: number = 0): Expression {
    let left: Expression;
    if (this.check('Less') && this.isGenericArrow()) {
      left = this.genericArrowFn();
    } else {
      left = this.primary();
    }
    while (true) {
      // Try generic call: foo<T>(x) — must check before LeftParen
      if (this.check('Less') && !this.hasNewline()) {
        const typeArgs = this.tryParseTypeArgs();
        if (typeArgs !== null) { left = this.callExprWithTypeArgs(left, typeArgs); continue; }
      }
      if (this.check('LeftParen') && !this.hasNewline()) { left = this.callExpr(left); continue; }
      if (this.check('Dot')) { left = this.memberExpr(left, false); continue; }
      if (this.check('QuestionDot')) { left = this.memberExpr(left, true); continue; }
      const op = TOKEN_TO_BINOP[this.cur().kind];
      if (op === undefined) break;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      const opSpan = this.advance().span;
      const right = this.expr(prec + 1);
      // Detect ?? mixed with && or || without parens (matches JS SyntaxError)
      const isUnparenBinOp = (node: Expression, ...ops: string[]): boolean =>
        node.kind === 'BinaryExpr' && ops.includes(node.operator) && !('parenthesized' in node);
      if (op === '&&' || op === '||') {
        if (isUnparenBinOp(left, '??') || isUnparenBinOp(right, '??')) {
          this.error(D.E117, "Cannot mix '??' with '&&' or '||' — use explicit parentheses", opSpan);
        }
      }
      if (op === '??') {
        if (isUnparenBinOp(left, '&&', '||') || isUnparenBinOp(right, '&&', '||')) {
          this.error(D.E117, "Cannot mix '??' with '&&' or '||' — use explicit parentheses", opSpan);
        }
      }
      left = { kind: 'BinaryExpr', operator: op, left, right, span: mergeSpans(left.span, right.span) };
    }
    return left;
  }

  /** Parse a primary (atomic) expression: literals, identifiers, `if`, `match`, `new`, unary, etc. */
  private primary(): Expression {
    const t = this.cur();
    switch (t.kind) {
      case 'NumberLiteral': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'NumberLiteral', value: Number(tok.text), span: tok.span },
          tok, tok,
        );
      }
      case 'SimpleString': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'StringLiteral', value: this.interp(tok.text), span: tok.span },
          tok, tok,
        );
      }
      case 'StringStart': return this.templateStr();
      case 'true': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'BooleanLiteral', value: true, span: tok.span },
          tok, tok,
        );
      }
      case 'false': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'BooleanLiteral', value: false, span: tok.span },
          tok, tok,
        );
      }
      case 'null': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'NullLiteral', span: tok.span },
          tok, tok,
        );
      }
      case 'Identifier': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'Identifier', name: tok.text, span: tok.span },
          tok, tok,
        );
      }
      case 'this': {
        const tok = this.advance();
        return withTrivia<Expression>(
          { kind: 'ThisExpr', span: tok.span },
          tok, tok,
        );
      }
      case 'if': return this.ifExpr();
      case 'match': return this.matchExpr();
      case 'try': return this.tryCatch();
      case 'new': return this.newExpr();
      case 'LeftBrace': return this.braceExpr();
      case 'LeftParen': return this.parenExpr();
      case 'LeftBracket': return this.arrayExpr();
      case 'Bang': {
        const tok = this.advance();
        const o = this.expr(9);
        return withTrivia<Expression>(
          { kind: 'UnaryExpr', operator: '!', operand: o, span: mergeSpans(tok.span, o.span) },
          tok, this.prev(),
        );
      }
      case 'Minus': {
        const tok = this.advance();
        const o = this.expr(9);
        return withTrivia<Expression>(
          { kind: 'UnaryExpr', operator: '-', operand: o, span: mergeSpans(tok.span, o.span) },
          tok, this.prev(),
        );
      }
      case 'async': return this.asyncArrowFn();
      case 'await': {
        const tok = this.advance();
        // Parse at unary precedence (same as ! and -) so that
        // `await a + b` parses as `(await a) + b` and
        // `await a.b()` parses as `await (a.b())`
        const arg = this.expr(9);
        return withTrivia<Expression>(
          { kind: 'AwaitExpr', argument: arg, span: mergeSpans(tok.span, arg.span) },
          tok, this.prev(),
        );
      }
      default: {
        this.error(D.E101, 'Expected expression', t.span);
        const sp = this.pos; this.advance();
        return this.errorNode(sp) as unknown as Expression;
      }
    }
  }

  /** Parse a template string with interpolations: `"text ${expr} more"`. */
  private templateStr(): Expression {
    const start = this.advance();
    const parts: TemplatePart[] = [];
    const sc = start.text.slice(1, -2);
    if (sc.length > 0) parts.push({ kind: 'TemplateStringPart', value: this.interpEsc(sc), span: start.span });
    parts.push({ kind: 'TemplateExprPart', expression: this.expr(), span: this.prev().span });

    while (this.check('StringPart')) {
      const pt = this.advance();
      const ptxt = pt.text.slice(1, -2);
      if (ptxt.length > 0) parts.push({ kind: 'TemplateStringPart', value: this.interpEsc(ptxt), span: pt.span });
      parts.push({ kind: 'TemplateExprPart', expression: this.expr(), span: this.prev().span });
    }

    const end = this.check('StringEnd') ? this.advance() : this.cur();
    if (end.kind === 'StringEnd') {
      const et = end.text.slice(1, -1);
      if (et.length > 0) parts.push({ kind: 'TemplateStringPart', value: this.interpEsc(et), span: end.span });
    }

    return withTrivia<Expression>(
      { kind: 'TemplateString', parts, span: mergeSpans(start.span, end.span) },
      start, end,
    );
  }

  /**
   * Parse a comma-separated argument list, detecting `name: value` as {@link NamedArgument}.
   *
   * Must be called after the opening `(` has been consumed. Does not consume `)`.
   */
  private parseCallArgs(): Expression[] {
    const args: Expression[] = [];
    while (!this.check('RightParen') && !this.atEnd()) {
      // Check for named argument: Identifier followed by Colon (not inside braces)
      if (this.check('Identifier') && this.peek(1).kind === 'Colon') {
        const nameTok = this.advance(); // consume Identifier
        this.advance();                 // consume Colon
        const value = this.expr();      // parse the value expression
        const name: Identifier = { kind: 'Identifier', name: nameTok.text, span: nameTok.span };
        args.push({ kind: 'NamedArgument', name, value, span: mergeSpans(nameTok.span, value.span) } as Expression);
      } else {
        args.push(this.expr());
      }
      if (!this.match('Comma')) break;
    }
    return args;
  }

  /** Parse a function call's argument list: `callee(arg1, arg2, ...)`. Assumes `(` is current. */
  private callExpr(callee: Expression): CallExpr {
    this.advance();
    const args = this.parseCallArgs();
    if (!this.match('RightParen')) this.error(D.E109, "Expected ')' to close '('", this.cur().span);
    return { kind: 'CallExpr', callee, args, span: mergeSpans(callee.span, this.prev().span) };
  }

  /** Speculatively parse `<TypeArg, ...>(` for generic calls.
   *  Returns null and restores position if this is not a generic call
   *  (e.g., `i < 10` should be parsed as a comparison). */
  private tryParseTypeArgs(): TypeNode[] | null {
    const saved = this.pos;
    const savedDiagCount = this.diagnostics.getAll().length;
    try {
      this.advance(); // skip '<'
      // Quick bail: if next token can't start a type, this isn't a generic call
      if (!this.isTypeStart()) { this.pos = saved; return null; }
      const typeArgs: TypeNode[] = [];
      while (!this.check('Greater') && !this.atEnd()) {
        typeArgs.push(this.parseType());
        if (!this.match('Comma')) break;
      }
      if (!this.check('Greater')) { this.pos = saved; this.rollbackDiagnostics(savedDiagCount); return null; }
      this.advance(); // skip '>'
      if (!this.check('LeftParen')) { this.pos = saved; this.rollbackDiagnostics(savedDiagCount); return null; }
      return typeArgs;
    } catch {
      this.pos = saved;
      this.rollbackDiagnostics(savedDiagCount);
      return null;
    }
  }

  /** Check if the current token can start a type annotation. */
  private isTypeStart(): boolean {
    return this.check('Identifier') || this.check('LeftParen') || this.check('LeftBrace');
  }

  /** Discard diagnostics emitted during failed speculative parsing. */
  private rollbackDiagnostics(savedCount: number): void {
    this.diagnostics.rollback(savedCount);
  }

  /** Parse a generic function call `callee<T>(args)` after type args have been parsed. Assumes `(` is current. */
  private callExprWithTypeArgs(callee: Expression, typeArgs: TypeNode[]): CallExpr {
    this.advance(); // skip '('
    const args = this.parseCallArgs();
    if (!this.match('RightParen')) this.error(D.E109, "Expected ')' to close '('", this.cur().span);
    const result: Record<string, unknown> = {
      kind: 'CallExpr', callee, typeArgs, args,
      span: mergeSpans(callee.span, this.prev().span),
    };
    return result as unknown as CallExpr;
  }

  /**
   * Parse a member access: `object.property` or `object?.property`.
   *
   * @param object   - The left-hand expression.
   * @param optional - `true` for optional chaining (`?.`).
   */
  private memberExpr(object: Expression, optional: boolean): MemberExpr {
    this.advance();
    const pt = this.expectIdentifierName();
    return { kind: 'MemberExpr', object, property: this.id(pt), optional, span: mergeSpans(object.span, pt.span) };
  }

  /** Parse an `if (cond) consequent [else alternate]` expression. */
  private ifExpr(): Expression {
    const ifTok = this.advance();
    this.expect('LeftParen');
    const condition = this.expr();
    this.expect('RightParen');
    const consequent = this.expr();
    if (this.match('else')) {
      const alternate = this.expr();
      const result: Record<string, unknown> = {
        kind: 'IfExpr',
        condition,
        consequent,
        alternate,
        span: mergeSpans(ifTok.span, this.prev().span),
      };
      return withTrivia(result as unknown as Expression, ifTok, this.prev());
    }
    return withTrivia<Expression>(
      { kind: 'IfExpr', condition, consequent, span: mergeSpans(ifTok.span, this.prev().span) },
      ifTok, this.prev(),
    );
  }

  /** Parse a `match subject { pattern => body, ... }` expression. */
  private matchExpr(): Expression {
    const mt = this.advance();
    const subject = this.expr(999);
    if (!this.match('LeftBrace')) this.error(D.E108, "Expected '{' after match subject", this.cur().span);
    const arms: MatchArm[] = [];
    while (!this.check('RightBrace') && !this.atEnd()) { arms.push(this.matchArm()); this.match('Comma'); }
    if (!this.match('RightBrace')) this.error(D.E110, "Expected '}'", this.cur().span);
    return withTrivia<Expression>(
      { kind: 'MatchExpr', subject, arms, span: mergeSpans(mt.span, this.prev().span) },
      mt, this.prev(),
    );
  }

  /** Parse a single match arm: `pattern [if guard] => body`. */
  private matchArm(): MatchArm {
    const pattern = this.parsePattern();
    if (this.match('if')) {
      const guard = this.expr();
      if (!this.match('FatArrow')) this.error(D.E105, "Expected '=>' in match arm", this.cur().span);
      const body = this.expr();
      return { kind: 'MatchArm', pattern, guard, body, span: mergeSpans(pattern.span, body.span) };
    }
    if (!this.match('FatArrow')) this.error(D.E105, "Expected '=>' in match arm", this.cur().span);
    const body = this.expr();
    return { kind: 'MatchArm', pattern, body, span: mergeSpans(pattern.span, body.span) };
  }

  /** Parse a block expression `{ decl; stmt; expr }`. The last expression is the block's value. */
  private blockExpr(): BlockExpr {
    const lb = this.expect('LeftBrace');
    const body: (Declaration | Statement | Expression)[] = [];
    while (!this.check('RightBrace') && !this.atEnd()) {
      switch (this.cur().kind) {
        case 'let': body.push(this.letDecl(false)); break;
        case 'type': body.push(this.typeDecl(false)); break;
        case 'for': body.push(this.forStmt()); break;
        case 'while': body.push(this.whileStmt()); break;
        case 'throw': body.push(this.throwStmt()); break;
        case 'break': {
          const t = this.advance(); this.eatSemicolon();
          body.push(withTrivia<Statement>({ kind: 'BreakStatement', span: t.span }, t, t));
          break;
        }
        case 'continue': {
          const t = this.advance(); this.eatSemicolon();
          body.push(withTrivia<Statement>({ kind: 'ContinueStatement', span: t.span }, t, t));
          break;
        }
        case 'return': body.push(this.returnStmt()); break;
        default: {
          const e = this.expr();
          if (this.check('Equal')) {
            this.advance();
            const v = this.expr();
            body.push({ kind: 'AssignmentStatement', target: e, value: v, span: mergeSpans(e.span, v.span) } as Statement);
          } else {
            body.push(e);
          }
          this.eatSemicolon();
        }
      }
    }
    if (!this.match('RightBrace')) this.error(D.E110, "Expected '}' to close '{'", this.cur().span);
    return withTrivia<BlockExpr>(
      { kind: 'BlockExpr', body, span: mergeSpans(lb.span, this.prev().span) },
      lb, this.prev(),
    );
  }

  /** Parse a `try { ... } catch (e) { ... }` expression. */
  private tryCatch(): Expression {
    const tt = this.advance();
    const tryBody = this.blockExpr();
    if (!this.match('catch')) {
      this.error(D.E112, "Expected 'catch' after try block", this.cur().span);
      return {
        kind: 'TryCatchExpr',
        tryBody,
        catchParam: this.id({ kind: 'Identifier', text: '_error', span: this.cur().span, leadingTrivia: [], trailingTrivia: [] }),
        catchBody: { kind: 'BlockExpr', body: [], span: this.cur().span },
        span: mergeSpans(tt.span, tryBody.span),
      } as Expression;
    }
    if (!this.match('LeftParen')) this.error(D.E113, "Expected '(' after 'catch'", this.cur().span);
    const catchParam = this.id(this.expect('Identifier'));
    this.expect('RightParen');
    const catchBody = this.blockExpr();
    return withTrivia<Expression>(
      { kind: 'TryCatchExpr', tryBody, catchParam, catchBody, span: mergeSpans(tt.span, this.prev().span) },
      tt, this.prev(),
    );
  }

  /** Parse a `new Foo[<T>](args)` constructor call expression. */
  private newExpr(): Expression {
    const nt = this.advance();
    const callee = this.primary();
    let typeArgs: TypeNode[] | undefined;
    if (this.check('Less')) {
      const parsed = this.tryParseTypeArgs();
      if (parsed !== null) typeArgs = parsed;
    }
    let args: Expression[] = [];
    if (this.match('LeftParen')) {
      args = this.parseCallArgs();
      this.expect('RightParen');
    }
    const result: Record<string, unknown> = {
      kind: 'NewExpr', callee, args,
      span: mergeSpans(nt.span, this.prev().span),
    };
    if (typeArgs !== undefined) result['typeArgs'] = typeArgs;
    return withTrivia(result as unknown as Expression, nt, this.prev());
  }

  /** Parse an array literal: `[elem1, elem2, ...]`. */
  private arrayExpr(): Expression {
    const lb = this.advance();
    const elements: Expression[] = [];
    while (!this.check('RightBracket') && !this.atEnd()) { elements.push(this.expr()); if (!this.match('Comma')) break; }
    if (!this.match('RightBracket')) this.error(D.E111, "Expected ']' to close '['", this.cur().span);
    return withTrivia<Expression>(
      { kind: 'ArrayExpr', elements, span: mergeSpans(lb.span, this.prev().span) },
      lb, this.prev(),
    );
  }

  // ── Disambiguation ─────────────────────────────────────────────────

  /**
   * Disambiguate `{` — is it a record literal or a block expression?
   *
   * Heuristic: `{ }` → record, `{ ident: ... }` → record, `{ ident, ... }` → record.
   * Everything else is a block expression.
   */
  private braceExpr(): Expression {
    const n = this.peek(1);
    if (n.kind === 'RightBrace') return this.recordExpr();
    if (n.kind === 'Identifier' || KEYWORDS.has(n.kind)) {
      const after = this.peek(2).kind;
      // { ident: ... } → explicit record field
      // { ident, ... } → shorthand record field (only for identifiers, not keywords)
      if (after === 'Colon' || (after === 'Comma' && n.kind === 'Identifier')) return this.recordExpr();
    }
    return this.blockExpr();
  }

  /** Parse a record literal: `{ name: value }` or shorthand `{ name }`. */
  private recordExpr(): Expression {
    const lb = this.advance();
    const fields: RecordField[] = [];
    while (!this.check('RightBrace') && !this.atEnd()) {
      const nt = this.expectIdentifierName();
      if (this.match('Colon')) {
        // Explicit: { name: expr }
        const v = this.expr();
        fields.push({ kind: 'RecordField', name: this.id(nt), value: v, span: mergeSpans(nt.span, v.span) });
      } else {
        // Shorthand: { name } → { name: name }
        const ident: Identifier = { kind: 'Identifier', name: nt.text, span: nt.span };
        fields.push({ kind: 'RecordField', name: this.id(nt), value: ident, span: nt.span });
      }
      if (!this.match('Comma')) break;
    }
    if (!this.match('RightBrace')) this.error(D.E110, "Expected '}' to close '{'", this.cur().span);
    return withTrivia<Expression>(
      { kind: 'RecordExpr', fields, span: mergeSpans(lb.span, this.prev().span) },
      lb, this.prev(),
    );
  }

  /**
   * Disambiguate `(` — is it an arrow function or a parenthesized expression?
   *
   * Uses {@link isArrow} for speculative lookahead. If it's an arrow, delegates
   * to {@link arrowFn}. Otherwise parses a grouped expression and marks it as
   * `parenthesized` (for `??`/`&&`-`||` mixing checks).
   */
  private parenExpr(): Expression {
    if (this.isArrow()) return this.arrowFn();
    this.advance();
    const e = this.expr();
    if (!this.match('RightParen')) this.error(D.E109, "Expected ')' to close '('", this.cur().span);
    // Mark expression as parenthesized so ?? / &&-|| mixing check can skip it
    (e as unknown as Record<string, unknown>)['parenthesized'] = true;
    return e;
  }

  /**
   * Speculative lookahead: is the current `<` the start of a generic arrow function `<T>(x) => ...`?
   *
   * Saves and restores the parser position. Returns `true` if the token sequence
   * matches `<Ident, ...>(` followed by an arrow function pattern.
   */
  private isGenericArrow(): boolean {
    const saved = this.pos;
    try {
      this.advance(); // skip '<'
      while (!this.check('Greater') && !this.atEnd()) {
        if (!this.check('Identifier')) return false;
        this.advance();
        // Skip optional constraint after ':'
        if (this.check('Colon')) {
          this.advance(); // skip ':'
          // Skip the constraint type by tracking nesting depth
          let depth = 0;
          while (!this.atEnd()) {
            if ((this.check('Comma') || this.check('Greater')) && depth === 0) break;
            if (this.check('LeftBrace') || this.check('LeftParen') || this.check('Less')) depth++;
            else if (this.check('RightBrace') || this.check('RightParen') || this.check('Greater')) depth--;
            this.advance();
          }
        }
        if (!this.match('Comma')) break;
      }
      if (!this.check('Greater')) return false;
      this.advance(); // skip '>'
      if (!this.check('LeftParen')) return false;
      return this.isArrow();
    } finally { this.pos = saved; }
  }

  /** Parse a generic arrow function: `<T>(params) => body`. Assumes `<` is current. */
  private genericArrowFn(): Expression {
    const lt = this.cur();
    const typeParams = this.parseTypeParams();
    return this.arrowFnWithTypeParams(lt, typeParams);
  }

  /**
   * Parse arrow function parameters and body after type params have been parsed.
   *
   * @param firstToken - The `<` token (for span calculation).
   * @param typeParams - Already-parsed generic type parameters.
   */
  private arrowFnWithTypeParams(firstToken: Token, typeParams: TypeParameter[]): Expression {
    this.advance(); // skip '('
    const params = this.parseFnParams();
    this.expect('RightParen');

    let returnType: TypeNode | undefined;
    if (this.match('Colon')) returnType = this.parseType();

    if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
    const body = this.expr();

    const result: Record<string, unknown> = {
      kind: 'ArrowFunction',
      typeParams,
      params,
      body,
      span: mergeSpans(firstToken.span, this.prev().span),
    };
    if (returnType !== undefined) result['returnType'] = returnType;
    return withTrivia(result as unknown as Expression, firstToken, this.prev());
  }

  /**
   * Speculative lookahead: is the current `(` the start of an arrow function `(params) => ...`?
   *
   * Saves and restores the parser position. Checks that the parenthesized
   * content looks like parameter declarations followed by an optional return
   * type and then `=>`.
   */
  private isArrow(): boolean {
    const saved = this.pos;
    try {
      this.advance();
      if (this.check('RightParen')) {
        this.advance();
        if (this.check('Colon')) { this.advance(); this.skipTy(); }
        return this.check('FatArrow');
      }
      while (!this.check('RightParen') && !this.atEnd()) {
        // Skip optional `mut` keyword before parameter name
        if (this.check('mut')) this.advance();
        if (!this.check('Identifier')) return false;
        this.advance();
        if (this.check('Colon')) { this.advance(); this.skipTy(); }
        if (this.check('Equal')) { this.advance(); this.skipEx(); }
        if (!this.match('Comma')) break;
      }
      if (!this.check('RightParen')) return false;
      this.advance();
      if (this.check('Colon')) { this.advance(); this.skipTy(); }
      return this.check('FatArrow');
    } finally { this.pos = saved; }
  }

  /** Skip over a type annotation during speculative lookahead (doesn't build AST nodes). */
  private skipTy(): void {
    if (this.check('LeftParen')) {
      this.advance(); let d = 1;
      while (d > 0 && !this.atEnd()) { if (this.check('LeftParen')) d++; if (this.check('RightParen')) d--; this.advance(); }
      if (this.check('FatArrow')) { this.advance(); this.skipTy(); }
      return;
    }
    if (this.check('LeftBrace')) {
      this.advance(); let d = 1;
      while (d > 0 && !this.atEnd()) { if (this.check('LeftBrace')) d++; if (this.check('RightBrace')) d--; this.advance(); }
      return;
    }
    // Literal types in type position: "GET", 42, true, false
    if (this.check('SimpleString') || this.check('NumberLiteral') || this.check('true') || this.check('false')) {
      this.advance();
    } else if (this.check('Identifier')) {
      this.advance();
      if (this.check('Less')) {
        this.advance(); let d = 1;
        while (d > 0 && !this.atEnd()) { if (this.check('Less')) d++; if (this.check('Greater')) d--; this.advance(); }
      }
    }
    if (this.check('Question')) this.advance();
    if (this.check('Amp')) { this.advance(); this.skipTy(); }
    if (this.check('Pipe')) { this.advance(); this.skipTy(); }
  }

  /** Skip over a default-value expression during speculative lookahead (balanced parens). */
  private skipEx(): void {
    let d = 0;
    while (!this.atEnd()) {
      if (this.check('LeftParen')) d++;
      else if (this.check('RightParen')) { if (d === 0) return; d--; }
      else if (this.check('Comma') && d === 0) return;
      this.advance();
    }
  }

  /** Parse a non-generic arrow function: `(params) [: ReturnType] => body`. Assumes `(` is current. */
  private arrowFn(): Expression {
    const lp = this.advance();
    const params = this.parseFnParams();
    this.expect('RightParen');

    if (this.match('Colon')) {
      const returnType = this.parseType();
      if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
      const body = this.expr();
      const result: Record<string, unknown> = {
        kind: 'ArrowFunction',
        params,
        returnType,
        body,
        span: mergeSpans(lp.span, this.prev().span),
      };
      return withTrivia(result as unknown as Expression, lp, this.prev());
    }

    if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
    const body = this.expr();
    return withTrivia<Expression>(
      { kind: 'ArrowFunction', params, body, span: mergeSpans(lp.span, this.prev().span) },
      lp, this.prev(),
    );
  }

  /**
   * Parse an async arrow function: `async (params) => body` or `async <T>(params) => body`.
   *
   * Assumes the current token is `async`. The token after `async` must be `(` or `<`
   * (since `async` is a reserved keyword, no ambiguity with identifiers).
   */
  private asyncArrowFn(): Expression {
    const asyncTok = this.advance(); // consume 'async'
    if (this.check('Less') && this.isGenericArrow()) {
      // async <T>(params) => body
      const typeParams = this.parseTypeParams();
      return this.arrowFnWithTypeParamsAsync(asyncTok, typeParams);
    }
    if (this.check('LeftParen')) {
      // async (params) => body
      return this.arrowFnAsync(asyncTok);
    }
    this.error(D.E101, "Expected '(' or '<' after 'async'", this.cur().span);
    const sp = this.pos; this.advance();
    return this.errorNode(sp) as unknown as Expression;
  }

  /** Parse an async arrow function with type params already consumed. */
  private arrowFnWithTypeParamsAsync(asyncTok: Token, typeParams: TypeParameter[]): Expression {
    this.advance(); // skip '('
    const params = this.parseFnParams();
    this.expect('RightParen');

    let returnType: TypeNode | undefined;
    if (this.match('Colon')) returnType = this.parseType();

    if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
    const body = this.expr();

    const result: Record<string, unknown> = {
      kind: 'ArrowFunction',
      async: true,
      typeParams,
      params,
      body,
      span: mergeSpans(asyncTok.span, this.prev().span),
    };
    if (returnType !== undefined) result['returnType'] = returnType;
    return withTrivia(result as unknown as Expression, asyncTok, this.prev());
  }

  /** Parse an async non-generic arrow function: `async (params) [: ReturnType] => body`. */
  private arrowFnAsync(asyncTok: Token): Expression {
    this.advance(); // skip '('
    const params = this.parseFnParams();
    this.expect('RightParen');

    if (this.match('Colon')) {
      const returnType = this.parseType();
      if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
      const body = this.expr();
      const result: Record<string, unknown> = {
        kind: 'ArrowFunction',
        async: true,
        params,
        returnType,
        body,
        span: mergeSpans(asyncTok.span, this.prev().span),
      };
      return withTrivia(result as unknown as Expression, asyncTok, this.prev());
    }

    if (!this.match('FatArrow')) this.error(D.E106, "Expected '=>' after arrow function parameters", this.cur().span);
    const body = this.expr();
    const result: Record<string, unknown> = {
      kind: 'ArrowFunction',
      async: true,
      params,
      body,
      span: mergeSpans(asyncTok.span, this.prev().span),
    };
    return withTrivia(result as unknown as Expression, asyncTok, this.prev());
  }

  /** Parse function parameter list (used by async and regular arrows). */
  private parseFnParams(): FunctionParam[] {
    const params: FunctionParam[] = [];
    while (!this.check('RightParen') && !this.atEnd()) {
      const isMut = this.match('mut');
      const startTok = isMut ? this.prev() : this.cur();
      const nt = this.expect('Identifier');
      const nm = this.id(nt);
      if (this.match('Colon')) {
        const ty = this.parseType();
        if (this.match('Equal')) {
          const dv = this.expr();
          params.push({ kind: 'FunctionParam', name: nm, type: ty, defaultValue: dv, mutable: isMut, span: mergeSpans(startTok.span, dv.span) });
        } else {
          params.push({ kind: 'FunctionParam', name: nm, type: ty, mutable: isMut, span: mergeSpans(startTok.span, ty.span) });
        }
      } else if (this.match('Equal')) {
        const dv = this.expr();
        params.push({ kind: 'FunctionParam', name: nm, defaultValue: dv, mutable: isMut, span: mergeSpans(startTok.span, dv.span) });
      } else {
        params.push({ kind: 'FunctionParam', name: nm, mutable: isMut, span: mergeSpans(startTok.span, nt.span) });
      }
      if (!this.match('Comma')) break;
    }
    return params;
  }

  // ── Patterns ───────────────────────────────────────────────────────

  /**
   * Parse a pattern for use in `match` arms.
   *
   * Dispatches based on the current token:
   * - `null` → NullPattern
   * - Number/string/boolean → LiteralPattern
   * - `_` → WildcardPattern
   * - Capitalized identifier → VariantPattern (optionally with sub-patterns)
   * - Lowercase identifier → BindingPattern
   * - `{` → RecordPattern
   */
  private parsePattern(): Pattern {
    const t = this.cur();
    if (t.kind === 'null') return { kind: 'NullPattern', span: this.advance().span };
    if (t.kind === 'NumberLiteral') { const tk = this.advance(); return { kind: 'LiteralPattern', literal: { kind: 'NumberLiteral', value: Number(tk.text), span: tk.span }, span: tk.span }; }
    if (t.kind === 'SimpleString') { const tk = this.advance(); return { kind: 'LiteralPattern', literal: { kind: 'StringLiteral', value: this.interp(tk.text), span: tk.span }, span: tk.span }; }
    if (t.kind === 'true' || t.kind === 'false') { const tk = this.advance(); return { kind: 'LiteralPattern', literal: { kind: 'BooleanLiteral', value: tk.kind === 'true', span: tk.span }, span: tk.span }; }
    if (t.kind === 'Identifier' && t.text === '_') return { kind: 'WildcardPattern', span: this.advance().span };

    if (t.kind === 'Identifier' && isCapitalized(t.text)) {
      const nt = this.advance();
      if (this.match('LeftParen')) {
        const fields: Pattern[] = [];
        while (!this.check('RightParen') && !this.atEnd()) { fields.push(this.parsePattern()); if (!this.match('Comma')) break; }
        this.expect('RightParen');
        return { kind: 'VariantPattern', name: this.id(nt), fields, span: mergeSpans(nt.span, this.prev().span) };
      }
      return { kind: 'VariantPattern', name: this.id(nt), span: nt.span };
    }

    if (t.kind === 'Identifier') { const tk = this.advance(); return { kind: 'BindingPattern', name: this.id(tk), span: tk.span }; }
    if (t.kind === 'LeftBrace') return this.recordPat();

    this.error(D.E103, 'Expected pattern', t.span);
    const sp = this.pos; this.advance();
    return { kind: 'WildcardPattern', span: this.errorNode(sp).span };
  }

  /** Parse a record pattern: `{ name, age: a }`. Assumes `{` is current. */
  private recordPat(): Pattern {
    const lb = this.advance();
    const fields: RecordPatternField[] = [];
    while (!this.check('RightBrace') && !this.atEnd()) {
      const nt = this.expectIdentifierName();
      if (this.match('Colon')) {
        fields.push({ name: this.id(nt), pattern: this.parsePattern() });
      } else {
        fields.push({ name: this.id(nt) });
      }
      if (!this.match('Comma')) break;
    }
    this.expect('RightBrace');
    return { kind: 'RecordPattern', fields, span: mergeSpans(lb.span, this.prev().span) };
  }

  // ── Types ──────────────────────────────────────────────────────────

  /**
   * Parse a type annotation, handling nullable (`?`), intersection (`&`), and union (`|`).
   *
   * Grammar: `intersectionType ('|' intersectionType)*`
   * intersectionType: `primaryType '?'? ('&' primaryType '?'?)*`
   */
  private parseType(): TypeNode {
    let ty = this.parseIntersectionType();
    if (this.check('Pipe')) {
      const ms: TypeNode[] = [ty];
      while (this.match('Pipe')) {
        ms.push(this.parseIntersectionType());
      }
      return { kind: 'UnionType', members: ms, span: mergeSpans(ms[0].span, ms[ms.length - 1].span) };
    }
    return ty;
  }

  /**
   * Parse an intersection type: `primaryType '?'? ('&' primaryType '?'?)*`.
   * Intersection binds tighter than union but looser than nullable.
   */
  private parseIntersectionType(): TypeNode {
    let ty = this.primaryTy();
    if (this.match('Question')) ty = { kind: 'NullableType', inner: ty, span: mergeSpans(ty.span, this.prev().span) };
    if (this.check('Amp')) {
      const members: TypeNode[] = [ty];
      while (this.match('Amp')) {
        let m = this.primaryTy();
        if (this.match('Question')) m = { kind: 'NullableType', inner: m, span: mergeSpans(m.span, this.prev().span) };
        members.push(m);
      }
      return { kind: 'IntersectionType', members, span: mergeSpans(members[0].span, members[members.length - 1].span) };
    }
    return ty;
  }

  /** Parse a primary type: named type with optional generic args, parenthesized type, record type, or literal type. */
  private primaryTy(): TypeNode {
    if (this.check('LeftParen')) return this.parenTy();
    if (this.check('LeftBrace')) return this.recordTy();

    // String literal type: "GET"
    if (this.check('SimpleString')) {
      const tok = this.advance();
      const value = this.interp(tok.text);
      const literal = { kind: 'StringLiteral' as const, value, span: tok.span };
      return { kind: 'LiteralTypeNode', literal, span: tok.span };
    }

    // Number literal type: 42
    if (this.check('NumberLiteral')) {
      const tok = this.advance();
      const literal = { kind: 'NumberLiteral' as const, value: Number(tok.text), span: tok.span };
      return { kind: 'LiteralTypeNode', literal, span: tok.span };
    }

    // Boolean literal type: true / false
    if (this.check('true') || this.check('false')) {
      const tok = this.advance();
      const literal = { kind: 'BooleanLiteral' as const, value: tok.kind === 'true', span: tok.span };
      return { kind: 'LiteralTypeNode', literal, span: tok.span };
    }

    if (this.check('Identifier')) {
      const nt = this.advance();
      if (this.check('Less')) {
        this.advance();
        const ta: TypeNode[] = [];
        while (!this.check('Greater') && !this.atEnd()) { ta.push(this.parseType()); if (!this.match('Comma')) break; }
        this.expect('Greater');
        return { kind: 'NamedType', name: this.id(nt), typeArgs: ta, span: mergeSpans(nt.span, this.prev().span) };
      }
      return { kind: 'NamedType', name: this.id(nt), span: nt.span };
    }
    this.error(D.E102, 'Expected type annotation', this.cur().span);
    return { kind: 'NamedType', name: { kind: 'Identifier', name: 'unknown', span: this.cur().span }, span: this.cur().span };
  }

  /** Parse `(types) => returnType` (function type) or `(types)` (tuple type). */
  private parenTy(): TypeNode {
    const lp = this.advance();
    const ts: TypeNode[] = [];
    while (!this.check('RightParen') && !this.atEnd()) { ts.push(this.parseType()); if (!this.match('Comma')) break; }
    this.expect('RightParen');
    if (this.match('FatArrow')) { const rt = this.parseType(); return { kind: 'FunctionType', params: ts, returnType: rt, span: mergeSpans(lp.span, rt.span) }; }
    return { kind: 'TupleType', elements: ts, span: mergeSpans(lp.span, this.prev().span) };
  }

  /** Parse a record type annotation: `{ name: string, age?: number }`. */
  private recordTy(): TypeNode {
    const lb = this.advance();
    const fields: RecordTypeField[] = [];
    while (!this.check('RightBrace') && !this.atEnd()) {
      const nt = this.expect('Identifier');
      const optional = this.match('Question');
      this.expect('Colon');
      fields.push({ name: this.id(nt), type: this.parseType(), optional });
      if (!this.match('Comma')) break;
    }
    this.expect('RightBrace');
    return { kind: 'RecordType', fields, span: mergeSpans(lb.span, this.prev().span) };
  }

  // ── String helpers ─────────────────────────────────────────────────

  /** Strip surrounding quotes from a raw string token and resolve escape sequences. */
  private interp(raw: string): string { return this.interpEsc(raw.slice(1, -1)); }

  /**
   * Resolve escape sequences in a string body (after quote removal).
   *
   * Handles: `\\`, `\"`, `\n`, `\t`, `\r`, `\0`, `\$`.
   * Unknown escapes pass through the backslash literally.
   */
  private interpEsc(text: string): string {
    let r = '', i = 0;
    while (i < text.length) {
      if (text[i] === '\\' && i + 1 < text.length) {
        switch (text[i + 1]) {
          case 'n': r += '\n'; i += 2; continue;
          case 't': r += '\t'; i += 2; continue;
          case 'r': r += '\r'; i += 2; continue;
          case '\\': r += '\\'; i += 2; continue;
          case '"': r += '"'; i += 2; continue;
          case '0': r += '\0'; i += 2; continue;
          case '$': r += '$'; i += 2; continue;
          default: r += text[i]; i++; continue;
        }
      }
      r += text[i]; i++;
    }
    return r;
  }
}
