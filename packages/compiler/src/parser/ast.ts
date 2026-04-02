/**
 * @module ast
 *
 * Abstract Syntax Tree (AST) node definitions for EffectScript.
 *
 * This module defines every node type the parser can produce. The AST is
 * an untyped tree — type information is attached later by the checker
 * via the {@link ASTNodeBase.resolvedType} field.
 *
 * Node hierarchy:
 * - **Declarations**: `let`, `type`, `import`, `export`
 * - **Expressions**: literals, operators, calls, control flow, functions
 * - **Statements**: `for`, `while`, assignment, `throw`, `break`, `continue`, `return`
 * - **Patterns**: used in `match` arms — literal, variant, record, wildcard, binding, null
 * - **Type nodes**: inline type annotations — named, function, record, nullable, union, tuple
 * - **ErrorNode**: placeholder for malformed input (preserves parser recovery)
 *
 * All concrete node interfaces extend {@link ASTNodeBase} and are discriminated
 * by a string literal `kind` field. Helper unions ({@link ASTNode}, {@link Expression}, etc.)
 * group related nodes for type-safe visitor dispatch.
 *
 * Some sub-structures (e.g. {@link VariantField}, {@link RecordPatternField},
 * {@link RecordTypeField}, {@link TemplateStringPart}) do NOT extend `ASTNodeBase`
 * — the visitor walker reaches through them to their child AST nodes.
 */

import type { Span } from '../utils/span.js';
import type { Trivia } from '../lexer/tokens.js';
import type { Type } from '../checker/types.js';

// ── Base ─────────────────────────────────────────────────────────────

/**
 * Base interface for all AST nodes.
 *
 * Every node carries a discriminant `kind`, a source `span` for diagnostics
 * and source maps, and optional trivia for formatting preservation.
 */
export interface ASTNodeBase {
  /** Discriminant identifying the concrete node type (e.g. `'IfExpr'`, `'LetDeclaration'`). */
  readonly kind: string;
  /** Source location spanning from the first to last character of this node. */
  readonly span: Span;
  /** Whitespace/comments before this node (attached from the first token). */
  readonly leadingTrivia?: readonly Trivia[];
  /** Whitespace/comments after this node on the same line (attached from the last token). */
  readonly trailingTrivia?: readonly Trivia[];
  /**
   * Type assigned by the checker (Phase 5).
   *
   * Mutable so the checker can annotate nodes in-place without rebuilding the tree.
   * Present on expression and declaration nodes after type checking completes.
   */
  resolvedType?: Type;
}

// ── Union Types ──────────────────────────────────────────────────────

/** Union of all possible AST node types. */
export type ASTNode = Declaration | Expression | Statement | Pattern | TypeNode | ErrorNode;

/** Top-level and block-level declarations. */
export type Declaration =
  | LetDeclaration
  | TypeDeclaration
  | ImportDeclaration
  | ExportDeclaration
  | ExtensionFunctionDeclaration
  | InterfaceDeclaration;

/** All expression node types (produce a value). */
export type Expression =
  | NumberLiteral
  | BigIntLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | Identifier
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | NewExpr
  | MemberExpr
  | IfExpr
  | MatchExpr
  | BlockExpr
  | ArrowFunction
  | TryCatchExpr
  | ArrayExpr
  | RecordExpr
  | TemplateString
  | ThisExpr
  | AwaitExpr
  | NamedArgument
  | TupleExpr
  | IndexExpr;

/** Imperative statement node types (executed for side effects). */
export type Statement =
  | ForStatement
  | WhileStatement
  | AssignmentStatement
  | ThrowStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | ExpressionStatement;

/**
 * Pattern node types used in `match` arms and destructuring contexts.
 *
 * `Identifier` is included for let/for-loop tuple destructuring where elements
 * are raw identifiers rather than `BindingPattern` wrappers.
 */
export type Pattern =
  | LiteralPattern
  | VariantPattern
  | RecordPattern
  | WildcardPattern
  | BindingPattern
  | NullPattern
  | TuplePattern
  | Identifier;

/** Inline type annotation node types. */
export type TypeNode =
  | NamedType
  | FunctionType
  | RecordType
  | NullableType
  | UnionType
  | TupleType
  | LiteralTypeNode
  | IntersectionType;

// ── Program (Root) ───────────────────────────────────────────────────

/** Root node of an EffectScript source file. Contains a sequence of top-level declarations and statements. */
export interface Program extends ASTNodeBase {
  readonly kind: 'Program';
  /** Ordered list of top-level declarations and statements. */
  readonly body: readonly (Declaration | Statement)[];
}

// ── Declarations ─────────────────────────────────────────────────────

/**
 * Variable binding: `let x = expr` or `var x: Type = expr`.
 *
 * Immutable when declared with `let`; `mutable` is `true` when declared with `var`.
 */
export interface LetDeclaration extends ASTNodeBase {
  readonly kind: 'LetDeclaration';
  /** The binding name (synthetic `"_tuple"` when `tuplePattern` is present). */
  readonly name: Identifier;
  /** Tuple destructuring target, e.g. `let (a, b) = ...`. When present, `name` is a synthetic placeholder. */
  readonly tuplePattern?: TuplePattern;
  /** Whether the binding was declared with `var` (allows reassignment). */
  readonly mutable: boolean;
  /** Optional explicit type annotation after the colon. */
  readonly typeAnnotation?: TypeNode;
  /** The right-hand side expression. */
  readonly initializer: Expression;
  /** `true` if this declaration appears inside an `export` wrapper. */
  readonly exported: boolean;
}

/**
 * ADT or named record type declaration: `type Color = Red | Green | Blue`
 * or `type User = { name: string }`.
 *
 * An ADT has one or more `variants`; a named record has `recordType` set
 * and an empty `variants` array.
 */
export interface TypeDeclaration extends ASTNodeBase {
  readonly kind: 'TypeDeclaration';
  /** The type name (must be capitalized by convention). */
  readonly name: Identifier;
  /** Generic type parameters, e.g. `<T, E>`. */
  readonly typeParams?: readonly TypeParameter[];
  /** ADT variant arms separated by `|`. Empty for named record types and type aliases. */
  readonly variants: readonly VariantDeclaration[];
  /** Present when the type is a named record alias (`type Foo = { ... }`). */
  readonly recordType?: RecordType;
  /** Present when the type is a non-record type alias (e.g. `type Method = "GET" | "POST"`). */
  readonly typeAlias?: TypeNode;
  /** `true` if this declaration appears inside an `export` wrapper. */
  readonly exported: boolean;
}

/** A single variant arm within an ADT: `Ok(value: T)` or `None`. */
export interface VariantDeclaration extends ASTNodeBase {
  readonly kind: 'VariantDeclaration';
  /** Variant tag name. */
  readonly name: Identifier;
  /** Named fields carried by this variant (empty for fieldless variants). */
  readonly fields: readonly VariantField[];
}

/**
 * A named field within a variant declaration.
 *
 * Does NOT extend `ASTNodeBase` — the visitor reaches through to child nodes.
 */
export interface VariantField {
  /** Field name identifier. */
  readonly name: Identifier;
  /** Field type annotation. */
  readonly type: TypeNode;
}

/** A generic type parameter, e.g. `T` in `type Result<T, E>` or `T: Constraint` with an upper bound. */
export interface TypeParameter extends ASTNodeBase {
  readonly kind: 'TypeParameter';
  /** The parameter name. */
  readonly name: Identifier;
  /** Optional constraint (upper bound), e.g. `{ name: string }` in `<T: { name: string }>`. */
  readonly constraint?: TypeNode;
}

/**
 * Import declaration: `import { a, b } from "mod"` or `import D from "mod"`
 * or `import D, { a } from "mod"`.
 */
export interface ImportDeclaration extends ASTNodeBase {
  readonly kind: 'ImportDeclaration';
  /** Named import specifiers (`{ a, b }`). */
  readonly specifiers: readonly ImportSpecifier[];
  /** The module path string literal. */
  readonly source: StringLiteral;
  /** Default import identifier, if present. */
  readonly defaultImport?: Identifier;
}

/** A single named import: `imported` is the original name, `local` is the alias (if renamed). */
export interface ImportSpecifier extends ASTNodeBase {
  readonly kind: 'ImportSpecifier';
  /** The name as it appears in the exporting module. */
  readonly imported: Identifier;
  /** Local alias, if `import { foo as bar }` syntax is used. */
  readonly local?: Identifier;
}

/**
 * Export declaration.
 *
 * Three forms:
 * - Inline: `export let x = ...` or `export type T = ...` (has `declaration`)
 * - Named: `export { a, b }` (has `specifiers`)
 * - Re-export: `export { a } from "mod"` (has `specifiers` + `source`)
 */
export interface ExportDeclaration extends ASTNodeBase {
  readonly kind: 'ExportDeclaration';
  /** The inlined declaration being exported. */
  readonly declaration?: LetDeclaration | TypeDeclaration | ExtensionFunctionDeclaration | InterfaceDeclaration;
  /** Named export specifiers. */
  readonly specifiers?: readonly ExportSpecifier[];
  /** Re-export source module path. */
  readonly source?: StringLiteral;
}

/**
 * Extension function declaration: `fun ReceiverType.method(params): ReturnType => body`.
 *
 * Adds a method to an existing type without modifying it. `this` refers to
 * the receiver instance inside the body.
 */
export interface ExtensionFunctionDeclaration extends ASTNodeBase {
  readonly kind: 'ExtensionFunctionDeclaration';
  /** The type being extended (e.g., `string`, `Array<T>`, `User`). */
  readonly receiverType: TypeNode;
  /** The method name. */
  readonly name: Identifier;
  /** Generic type parameters on the extension (e.g., `<T>` in `fun <T> Array<T>.first()`). */
  readonly typeParams?: readonly TypeParameter[];
  /** Method parameters (excluding the implicit receiver). */
  readonly params: readonly FunctionParam[];
  /** Return type annotation (required for extension functions). */
  readonly returnType: TypeNode;
  /** The method body expression. */
  readonly body: Expression;
  /** Whether this extension is exported. */
  readonly exported: boolean;
  /** Whether this extension function is async (returns Promise<T>). */
  readonly async?: boolean;
  /** Resolved receiver type, set by the checker. */
  resolvedReceiverType?: import('../checker/types.js').Type;
}

/**
 * Interface declaration: `interface Foo<T> extends Bar<T> { ... }`.
 *
 * Interfaces define structural type contracts with method signatures and
 * property requirements. They are erased at runtime — only `.d.ts` output.
 */
export interface InterfaceDeclaration extends ASTNodeBase {
  readonly kind: 'InterfaceDeclaration';
  /** Interface name. */
  readonly name: Identifier;
  /** Generic type parameters (e.g. <T, U>). */
  readonly typeParams?: readonly TypeParameter[];
  /** Extended interfaces. */
  readonly extends?: readonly TypeNode[];
  /** Method declarations (name + signature, no body). */
  readonly methods: readonly InterfaceMethodDeclaration[];
  /** Property declarations. */
  readonly properties: readonly InterfacePropertyDeclaration[];
  /** `true` if this declaration appears inside an `export` wrapper. */
  readonly exported: boolean;
}

/**
 * A method signature within an interface (no body).
 *
 * Does NOT extend `ASTNodeBase` — the visitor walker reaches through to child AST nodes.
 */
export interface InterfaceMethodDeclaration {
  readonly name: Identifier;
  readonly typeParams?: readonly TypeParameter[];
  readonly params: readonly FunctionParam[];
  /** Optional in the AST for error recovery. The checker treats missing returnType as void. */
  readonly returnType?: TypeNode;
  readonly span: Span;
}

/**
 * A property requirement within an interface.
 *
 * Does NOT extend `ASTNodeBase` — the visitor walker reaches through to child AST nodes.
 */
export interface InterfacePropertyDeclaration {
  readonly name: Identifier;
  readonly typeAnnotation: TypeNode;
  /** `true` for `var` (mutable), `false` for `let` (readonly). */
  readonly mutable: boolean;
  readonly span: Span;
}

/** A single named export: `local` is the internal name, `exported` is the alias. */
export interface ExportSpecifier extends ASTNodeBase {
  readonly kind: 'ExportSpecifier';
  /** Internal name being exported. */
  readonly local: Identifier;
  /** External alias, if different from `local`. */
  readonly exported?: Identifier;
}

// ── Expressions ──────────────────────────────────────────────────────

/** Numeric literal: `42`, `3.14`, `0xFF`. */
export interface NumberLiteral extends ASTNodeBase {
  readonly kind: 'NumberLiteral';
  /** The parsed numeric value. */
  readonly value: number;
}

/** BigInt literal: `42n`, `0xFFn`. Stored as a raw string to preserve precision. */
export interface BigIntLiteral extends ASTNodeBase {
  readonly kind: 'BigIntLiteral';
  /** The raw text of the bigint literal without the 'n' suffix. */
  readonly raw: string;
}

/** Simple string literal (no interpolation): `"hello"`. */
export interface StringLiteral extends ASTNodeBase {
  readonly kind: 'StringLiteral';
  /** The string value with escape sequences resolved. */
  readonly value: string;
}

/** Boolean literal: `true` or `false`. */
export interface BooleanLiteral extends ASTNodeBase {
  readonly kind: 'BooleanLiteral';
  readonly value: boolean;
}

/** The `null` literal. */
export interface NullLiteral extends ASTNodeBase {
  readonly kind: 'NullLiteral';
}

/** A name reference: variable, function, type constructor, etc. */
export interface Identifier extends ASTNodeBase {
  readonly kind: 'Identifier';
  /** The identifier text. */
  readonly name: string;
}

/** Binary operator expression: `left op right`. */
export interface BinaryExpr extends ASTNodeBase {
  readonly kind: 'BinaryExpr';
  /** The infix operator. */
  readonly operator: BinaryOperator;
  /** Left-hand operand. */
  readonly left: Expression;
  /** Right-hand operand. */
  readonly right: Expression;
}

/** All binary operators supported by the language. */
export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '>' | '<=' | '>='
  | '&&' | '||'
  | '??';

/** Unary prefix expression: `!x` or `-x`. */
export interface UnaryExpr extends ASTNodeBase {
  readonly kind: 'UnaryExpr';
  /** The prefix operator. */
  readonly operator: UnaryOperator;
  /** The operand expression. */
  readonly operand: Expression;
}

/** Unary operators: logical not and arithmetic negation. */
export type UnaryOperator = '!' | '-';

/** Function call: `callee(args)` or `callee<T>(args)`. */
export interface CallExpr extends ASTNodeBase {
  readonly kind: 'CallExpr';
  /** The expression being called. */
  readonly callee: Expression;
  /** Explicit type arguments for generic calls, e.g. `foo<string>(x)`. */
  readonly typeArgs?: readonly TypeNode[];
  /** Positional argument expressions (may include NamedArgument nodes). */
  readonly args: readonly Expression[];
  /**
   * Parameter-ordered argument expressions, set by the checker when named arguments are present.
   * `undefined` entries represent skipped defaulted parameters.
   * The emitter reads this to reorder arguments to positional JS output.
   */
  resolvedArgs?: readonly (Expression | undefined)[];
}

/** Constructor call: `new Foo(args)` or `new Foo<T>(args)`. */
export interface NewExpr extends ASTNodeBase {
  readonly kind: 'NewExpr';
  /** The constructor expression. */
  readonly callee: Expression;
  /** Explicit type arguments. */
  readonly typeArgs?: readonly TypeNode[];
  /** Positional argument expressions (may include NamedArgument nodes). */
  readonly args: readonly Expression[];
  /**
   * Parameter-ordered argument expressions, set by the checker when named arguments are present.
   * `undefined` entries represent skipped defaulted parameters.
   */
  resolvedArgs?: readonly (Expression | undefined)[];
}

/** Member access: `obj.prop` or optional chaining `obj?.prop`. */
export interface MemberExpr extends ASTNodeBase {
  readonly kind: 'MemberExpr';
  /** The object being accessed. */
  readonly object: Expression;
  /** The property name. */
  readonly property: Identifier;
  /** `true` if this uses `?.` (optional chaining). */
  readonly optional: boolean;
  /** Set by the checker when this member access resolves to an extension function call. */
  extensionEmitName?: string;
}

/**
 * Conditional expression: `if (cond) consequent else alternate`.
 *
 * In EffectScript, `if` is an expression — both branches produce values.
 * The `alternate` is optional (no `else` branch yields `null`).
 */
export interface IfExpr extends ASTNodeBase {
  readonly kind: 'IfExpr';
  /** The boolean condition (must be parenthesized in source). */
  readonly condition: Expression;
  /** The "then" branch expression. */
  readonly consequent: Expression;
  /** The "else" branch expression, if present. */
  readonly alternate?: Expression;
}

/** Pattern matching expression: `match subject { arms }`. */
export interface MatchExpr extends ASTNodeBase {
  readonly kind: 'MatchExpr';
  /** The value being matched against. */
  readonly subject: Expression;
  /** One or more match arms with patterns and bodies. */
  readonly arms: readonly MatchArm[];
}

/** A single arm in a `match` expression: `pattern [if guard] => body`. */
export interface MatchArm extends ASTNodeBase {
  readonly kind: 'MatchArm';
  /** The pattern to match against the subject. */
  readonly pattern: Pattern;
  /** Optional guard condition that must also be true. */
  readonly guard?: Expression;
  /** The body expression evaluated when this arm matches. */
  readonly body: Expression;
}

/**
 * Block expression: `{ statements; tail_expr }`.
 *
 * The last item in `body` may be an expression (the block's value).
 * Blocks can contain declarations, statements, and expressions.
 */
export interface BlockExpr extends ASTNodeBase {
  readonly kind: 'BlockExpr';
  /** Declarations, statements, and expressions within the block. */
  readonly body: readonly (Declaration | Statement | Expression)[];
}

/** Arrow function: `(params) => body` or `<T>(params): ReturnType => body`. */
export interface ArrowFunction extends ASTNodeBase {
  readonly kind: 'ArrowFunction';
  /** Whether the function is declared with the `async` keyword. */
  readonly async?: boolean;
  /** Generic type parameters for the function. */
  readonly typeParams?: readonly TypeParameter[];
  /** Function parameters with optional types and defaults. */
  readonly params: readonly FunctionParam[];
  /** Explicit return type annotation. */
  readonly returnType?: TypeNode;
  /** The function body expression. */
  readonly body: Expression;
}

/** A parameter in an arrow function definition. */
export interface FunctionParam extends ASTNodeBase {
  readonly kind: 'FunctionParam';
  /** Parameter name. */
  readonly name: Identifier;
  /** Optional type annotation. */
  readonly type?: TypeNode;
  /** Optional default value expression. */
  readonly defaultValue?: Expression;
  /** Whether the parameter is declared with `var` (allows content mutation). */
  readonly mutable: boolean;
}

/** Try/catch expression: `try { ... } catch (e) { ... }`. */
export interface TryCatchExpr extends ASTNodeBase {
  readonly kind: 'TryCatchExpr';
  /** The try block. */
  readonly tryBody: BlockExpr;
  /** The catch parameter identifier. */
  readonly catchParam: Identifier;
  /** The catch handler block. */
  readonly catchBody: BlockExpr;
}

/** Array literal: `[a, b, c]`. */
export interface ArrayExpr extends ASTNodeBase {
  readonly kind: 'ArrayExpr';
  /** Element expressions in order. */
  readonly elements: readonly Expression[];
}

/** Record (object) literal: `{ name: value }` or shorthand `{ name }`. */
export interface RecordExpr extends ASTNodeBase {
  readonly kind: 'RecordExpr';
  /** Key-value field pairs. */
  readonly fields: readonly RecordField[];
}

/** A single field in a record literal: `name: value`. */
export interface RecordField extends ASTNodeBase {
  readonly kind: 'RecordField';
  /** Field name identifier. */
  readonly name: Identifier;
  /** Field value expression (same as `name` for shorthand `{ x }`). */
  readonly value: Expression;
}

/**
 * Template string with interpolations: `"hello ${name}, you are ${age}"`.
 *
 * Composed of alternating string parts and expression parts.
 */
export interface TemplateString extends ASTNodeBase {
  readonly kind: 'TemplateString';
  /** Ordered sequence of string literal segments and interpolated expressions. */
  readonly parts: readonly TemplatePart[];
}

/** Either a literal string segment or an interpolated expression within a template string. */
export type TemplatePart = TemplateStringPart | TemplateExprPart;

/**
 * A literal text segment within a template string.
 *
 * Does NOT extend `ASTNodeBase` — has no children for the visitor to traverse.
 */
export interface TemplateStringPart {
  readonly kind: 'TemplateStringPart';
  /** The text content with escape sequences resolved. */
  readonly value: string;
  /** Source location of this segment. */
  readonly span: Span;
}

/**
 * An interpolated expression within a template string: `${expr}`.
 *
 * Does NOT extend `ASTNodeBase` — the visitor reaches through to the inner expression.
 */
export interface TemplateExprPart {
  readonly kind: 'TemplateExprPart';
  /** The interpolated expression. */
  readonly expression: Expression;
  /** Source location of this interpolation (including `${}` delimiters). */
  readonly span: Span;
}

/** The `this` keyword expression — refers to the receiver inside an extension function. */
export interface ThisExpr extends ASTNodeBase {
  readonly kind: 'ThisExpr';
}

/** Await expression: `await expr`. Unwraps a `Promise<T>` to `T` inside an async function. */
export interface AwaitExpr extends ASTNodeBase {
  readonly kind: 'AwaitExpr';
  readonly argument: Expression;
}

/** Tuple expression: `(1, "hello")`. Always has 2 or more elements. */
export interface TupleExpr extends ASTNodeBase {
  readonly kind: 'TupleExpr';
  readonly elements: readonly Expression[];
}

/** Bracket-based property access: `obj[expr]` or optional `obj?.["key"]`. */
export interface IndexExpr extends ASTNodeBase {
  readonly kind: 'IndexExpr';
  readonly object: Expression;
  readonly index: Expression;
  readonly optional: boolean;
}

/**
 * Named argument in a call expression: `name: value`.
 *
 * Only valid inside the argument list of a `CallExpr` or `NewExpr`.
 * The checker resolves named arguments to parameter positions and
 * annotates the call node with `resolvedArgs` for the emitter.
 */
export interface NamedArgument extends ASTNodeBase {
  readonly kind: 'NamedArgument';
  /** The parameter name being targeted. */
  readonly name: Identifier;
  /** The argument value expression. */
  readonly value: Expression;
}

// ── Patterns ─────────────────────────────────────────────────────────

/** Matches a specific literal value: number, string, or boolean. */
export interface LiteralPattern extends ASTNodeBase {
  readonly kind: 'LiteralPattern';
  /** The literal value to match against. */
  readonly literal: NumberLiteral | StringLiteral | BooleanLiteral;
}

/** Matches an ADT variant, optionally destructuring its fields: `Ok(value)` or `None`. */
export interface VariantPattern extends ASTNodeBase {
  readonly kind: 'VariantPattern';
  /** The variant tag name (capitalized). */
  readonly name: Identifier;
  /** Positional sub-patterns for the variant's fields. */
  readonly fields?: readonly Pattern[];
}

/** Matches a record shape by field names: `{ name, age: a }`. */
export interface RecordPattern extends ASTNodeBase {
  readonly kind: 'RecordPattern';
  /** Fields to match, each with a name and optional nested pattern. */
  readonly fields: readonly RecordPatternField[];
}

/**
 * A single field in a record pattern.
 *
 * Does NOT extend `ASTNodeBase` — the visitor reaches through to child nodes.
 */
export interface RecordPatternField {
  /** The field name to match. */
  readonly name: Identifier;
  /** Optional nested pattern for the field value. */
  readonly pattern?: Pattern;
}

/** Wildcard pattern `_` — matches anything, binds nothing. */
export interface WildcardPattern extends ASTNodeBase {
  readonly kind: 'WildcardPattern';
}

/** Binding pattern — matches anything and binds the value to a name: `x`. */
export interface BindingPattern extends ASTNodeBase {
  readonly kind: 'BindingPattern';
  /** The name to bind the matched value to. */
  readonly name: Identifier;
}

/** Matches the `null` literal specifically. */
export interface NullPattern extends ASTNodeBase {
  readonly kind: 'NullPattern';
}

/** Tuple destructuring pattern: `(a, b)` or `(_, item)`. Used in for-loop, let, and match contexts. */
export interface TuplePattern extends ASTNodeBase {
  readonly kind: 'TuplePattern';
  /** At least 2 elements. In for-loop/let contexts: Identifier | WildcardPattern only. In match: any Pattern. */
  readonly elements: readonly Pattern[];
}

// ── Type Nodes ───────────────────────────────────────────────────────

/** Named type reference, optionally with type arguments: `string`, `Array<number>`, `Result<T, E>`. */
export interface NamedType extends ASTNodeBase {
  readonly kind: 'NamedType';
  /** The type name. */
  readonly name: Identifier;
  /** Generic type arguments, e.g. `<number, string>`. */
  readonly typeArgs?: readonly TypeNode[];
}

/** Function type annotation: `(string, number) => boolean`. */
export interface FunctionType extends ASTNodeBase {
  readonly kind: 'FunctionType';
  /** Parameter types (positional). */
  readonly params: readonly TypeNode[];
  /** The return type. */
  readonly returnType: TypeNode;
}

/** Record (object) type annotation: `{ name: string, age?: number }`. */
export interface RecordType extends ASTNodeBase {
  readonly kind: 'RecordType';
  /** Field definitions with names, types, and optionality. */
  readonly fields: readonly RecordTypeField[];
  /** Index signature, e.g. `[string]: number`. Present only for dictionary-style types. */
  readonly indexSignature?: IndexSignatureField;
}

/**
 * An index signature field within a record type: `[string]: T` or `[number]: T`.
 *
 * Does NOT extend `ASTNodeBase` — the visitor reaches through to the `valueType` child.
 */
export interface IndexSignatureField {
  readonly keyType: 'string' | 'number';
  readonly valueType: TypeNode;
  readonly span: Span;
}

/**
 * A single field in a record type annotation.
 *
 * Does NOT extend `ASTNodeBase` — the visitor reaches through to child nodes.
 */
export interface RecordTypeField {
  /** Field name identifier. */
  readonly name: Identifier;
  /** Field type annotation. */
  readonly type: TypeNode;
  /** Whether this field is optional (`name?:`). */
  readonly optional: boolean;
  /** Whether this field is declared with `var` (mutable). False for bare fields. */
  readonly mutable: boolean;
}

/** Nullable type: `T?` (shorthand for `T | null`). */
export interface NullableType extends ASTNodeBase {
  readonly kind: 'NullableType';
  /** The non-null inner type. */
  readonly inner: TypeNode;
}

/** Union type: `A | B | C`. */
export interface UnionType extends ASTNodeBase {
  readonly kind: 'UnionType';
  /** The member types of the union. */
  readonly members: readonly TypeNode[];
}

/** Tuple type: `(string, number)` (when not followed by `=>`). */
export interface TupleType extends ASTNodeBase {
  readonly kind: 'TupleType';
  /** Element types in order. */
  readonly elements: readonly TypeNode[];
}

/** Literal type node: a string, number, or boolean literal used as a type (e.g. `"GET"`, `42`, `true`). */
export interface LiteralTypeNode extends ASTNodeBase {
  readonly kind: 'LiteralTypeNode';
  /** The literal expression this type represents. */
  readonly literal: StringLiteral | NumberLiteral | BooleanLiteral;
}

/** Intersection type: `A & B`. All member types must be satisfied. */
export interface IntersectionType extends ASTNodeBase {
  readonly kind: 'IntersectionType';
  readonly members: readonly TypeNode[];
}

// ── Statements ───────────────────────────────────────────────────────

/** Range bound for `for (i in start..end)` / `for (i in start..<end)` loops. */
export interface ForRange {
  readonly start: Expression;
  readonly end: Expression;
  /** `true` for `..<` (exclusive), `false` for `..` (inclusive). */
  readonly exclusive: boolean;
  readonly span: Span;
}

/**
 * For-in loop with optional range syntax and pattern destructuring.
 *
 * `for (x in iterable)`, `for (i in 0..<10)`, `for ({ name } in users)`,
 * `for ((a, b) in pairs)`.
 */
export interface ForStatement extends ASTNodeBase {
  readonly kind: 'ForStatement';
  /** Loop variable: simple identifier, record destructuring, or tuple destructuring. */
  readonly variable: Identifier | RecordPattern | TuplePattern;
  /** The expression being iterated over (also holds the start expr for ranges). */
  readonly iterable: Expression;
  /** Present for range iteration (`..` or `..<`); mutually exclusive with iterable for semantics. */
  readonly range?: ForRange;
  /** The loop body block. */
  readonly body: BlockExpr;
}

/** While loop: `while (condition) { ... }`. */
export interface WhileStatement extends ASTNodeBase {
  readonly kind: 'WhileStatement';
  /** The boolean loop condition. */
  readonly condition: Expression;
  /** The loop body block. */
  readonly body: BlockExpr;
}

/** Assignment statement: `target = value`. Only valid for mutable bindings. */
export interface AssignmentStatement extends ASTNodeBase {
  readonly kind: 'AssignmentStatement';
  /** The left-hand side (identifier or member expression). */
  readonly target: Expression;
  /** The right-hand side value being assigned. */
  readonly value: Expression;
}

/** Throw statement: `throw expr`. */
export interface ThrowStatement extends ASTNodeBase {
  readonly kind: 'ThrowStatement';
  /** The value being thrown (typically an error). */
  readonly value: Expression;
}

/** Break statement: `break` — exits the nearest enclosing loop. */
export interface BreakStatement extends ASTNodeBase {
  readonly kind: 'BreakStatement';
}

/** Continue statement: `continue` — skips to next iteration of the nearest loop. */
export interface ContinueStatement extends ASTNodeBase {
  readonly kind: 'ContinueStatement';
}

/** Return statement: `return` or `return expr`. */
export interface ReturnStatement extends ASTNodeBase {
  readonly kind: 'ReturnStatement';
  /** The returned value, or absent for bare `return`. */
  readonly value?: Expression;
}

/** Wraps an expression used as a statement (e.g. a function call for side effects). */
export interface ExpressionStatement extends ASTNodeBase {
  readonly kind: 'ExpressionStatement';
  /** The expression being executed for its side effects. */
  readonly expression: Expression;
}

// ── Error Node ───────────────────────────────────────────────────────

/**
 * Placeholder node for malformed input.
 *
 * Created during parser error recovery to preserve the token span so
 * that downstream phases can report accurate locations.
 */
export interface ErrorNode extends ASTNodeBase {
  readonly kind: 'ErrorNode';
  /** Concatenated text of the skipped tokens. */
  readonly text: string;
}

// ── AST Node Predicates ──────────────────────────────────────────────

/**
 * Type predicate: returns `true` if the node is any {@link Declaration} variant.
 *
 * Used by the checker, emitter, and visitor to distinguish declarations
 * from statements and expressions without exhaustive `kind` checks.
 */
export function isDeclaration(node: { kind: string }): node is Declaration {
  return node.kind === 'LetDeclaration' || node.kind === 'TypeDeclaration' ||
    node.kind === 'ImportDeclaration' || node.kind === 'ExportDeclaration' ||
    node.kind === 'ExtensionFunctionDeclaration' ||
    node.kind === 'InterfaceDeclaration';
}

/**
 * Type predicate: returns `true` if the node is any {@link Statement} variant.
 *
 * Used by the checker, emitter, and visitor to distinguish statements
 * from declarations and expressions without exhaustive `kind` checks.
 */
export function isStatement(node: { kind: string }): node is Statement {
  return node.kind === 'ForStatement' || node.kind === 'WhileStatement' ||
    node.kind === 'AssignmentStatement' || node.kind === 'ThrowStatement' ||
    node.kind === 'BreakStatement' || node.kind === 'ContinueStatement' ||
    node.kind === 'ReturnStatement' || node.kind === 'ExpressionStatement';
}
