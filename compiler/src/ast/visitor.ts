/**
 * @module visitor
 *
 * AST visitor and tree walker for EffectScript.
 *
 * Provides a generic depth-first traversal mechanism via {@link walkAST}.
 * Consumers implement the {@link ASTVisitor} interface (all methods optional)
 * and the walker calls the appropriate enter/leave methods for each node.
 *
 * **Dispatch strategy** (per-kind > category fallback):
 * 1. If a per-kind method exists (e.g. `enterIfExpr`), call it.
 * 2. Else if a category method exists (e.g. `enterExpression`), call it.
 * 3. Else do nothing for that enter/leave hook.
 *
 * This two-tier dispatch lets visitors handle specific nodes precisely
 * while still catching entire categories with a single method.
 *
 * **Child traversal**: The {@link getChildren} function knows the shape of
 * every AST node and returns its children in source order. Nodes like
 * `VariantField`, `RecordPatternField`, and `TemplateStringPart` that
 * don't extend `ASTNodeBase` are "reached through" — their child AST
 * nodes are returned directly.
 *
 * **Stopping**: A visitor can call `context.stop()` at any point to
 * immediately halt the entire traversal.
 */

import type {
  ASTNodeBase, Program,
  Declaration, LetDeclaration, TypeDeclaration, ImportDeclaration, ExportDeclaration,
  Expression, NumberLiteral, StringLiteral, BooleanLiteral, NullLiteral, Identifier,
  BinaryExpr, UnaryExpr, CallExpr, NewExpr, MemberExpr, IfExpr, MatchExpr,
  BlockExpr, ArrowFunction, TryCatchExpr, ArrayExpr, RecordExpr, TemplateString,
  Statement, ForStatement, WhileStatement, AssignmentStatement, ThrowStatement,
  BreakStatement, ContinueStatement, ReturnStatement, ExpressionStatement,
  Pattern, LiteralPattern, VariantPattern, RecordPattern, WildcardPattern,
  BindingPattern, NullPattern,
  TypeNode, NamedType, FunctionType, RecordType, NullableType, UnionType, TupleType,
  ErrorNode, MatchArm, VariantDeclaration, TypeParameter, FunctionParam,
  ImportSpecifier, ExportSpecifier, RecordField,
} from '../parser/ast.js';

/**
 * Context passed to visitor methods during AST traversal.
 *
 * Provides information about the current node's position in the tree
 * and a mechanism to abort traversal early.
 */
export interface VisitorContext {
  /** The parent AST node, or `undefined` at the root. */
  readonly parent: ASTNodeBase | undefined;
  /** Current depth in the tree (root = 0). */
  readonly depth: number;
  /** Call to halt traversal immediately. No further nodes will be visited. */
  stop(): void;
}

/**
 * Visitor interface for traversing AST nodes.
 *
 * For each node, walkAST calls the most specific matching method:
 * 1. Per-kind method (e.g., enterIfExpr) — if defined, called
 * 2. Category method (e.g., enterExpression) — if defined and no per-kind match
 * 3. Neither — walkAST traverses children automatically
 *
 * All methods are optional. Enter methods are called before children,
 * leave methods are called after children.
 */
export interface ASTVisitor {
  // ── Category-level methods ─────────────────────────────────
  enterDeclaration?(node: Declaration, context: VisitorContext): void;
  leaveDeclaration?(node: Declaration, context: VisitorContext): void;
  enterExpression?(node: Expression, context: VisitorContext): void;
  leaveExpression?(node: Expression, context: VisitorContext): void;
  enterStatement?(node: Statement, context: VisitorContext): void;
  leaveStatement?(node: Statement, context: VisitorContext): void;
  enterPattern?(node: Pattern, context: VisitorContext): void;
  leavePattern?(node: Pattern, context: VisitorContext): void;
  enterType?(node: TypeNode, context: VisitorContext): void;
  leaveType?(node: TypeNode, context: VisitorContext): void;

  // ── Per-kind: Declarations ─────────────────────────────────
  enterLetDeclaration?(node: LetDeclaration, context: VisitorContext): void;
  leaveLetDeclaration?(node: LetDeclaration, context: VisitorContext): void;
  enterTypeDeclaration?(node: TypeDeclaration, context: VisitorContext): void;
  leaveTypeDeclaration?(node: TypeDeclaration, context: VisitorContext): void;
  enterImportDeclaration?(node: ImportDeclaration, context: VisitorContext): void;
  leaveImportDeclaration?(node: ImportDeclaration, context: VisitorContext): void;
  enterExportDeclaration?(node: ExportDeclaration, context: VisitorContext): void;
  leaveExportDeclaration?(node: ExportDeclaration, context: VisitorContext): void;

  // ── Per-kind: Expressions ──────────────────────────────────
  enterNumberLiteral?(node: NumberLiteral, context: VisitorContext): void;
  leaveNumberLiteral?(node: NumberLiteral, context: VisitorContext): void;
  enterStringLiteral?(node: StringLiteral, context: VisitorContext): void;
  leaveStringLiteral?(node: StringLiteral, context: VisitorContext): void;
  enterBooleanLiteral?(node: BooleanLiteral, context: VisitorContext): void;
  leaveBooleanLiteral?(node: BooleanLiteral, context: VisitorContext): void;
  enterNullLiteral?(node: NullLiteral, context: VisitorContext): void;
  leaveNullLiteral?(node: NullLiteral, context: VisitorContext): void;
  enterIdentifier?(node: Identifier, context: VisitorContext): void;
  leaveIdentifier?(node: Identifier, context: VisitorContext): void;
  enterBinaryExpr?(node: BinaryExpr, context: VisitorContext): void;
  leaveBinaryExpr?(node: BinaryExpr, context: VisitorContext): void;
  enterUnaryExpr?(node: UnaryExpr, context: VisitorContext): void;
  leaveUnaryExpr?(node: UnaryExpr, context: VisitorContext): void;
  enterCallExpr?(node: CallExpr, context: VisitorContext): void;
  leaveCallExpr?(node: CallExpr, context: VisitorContext): void;
  enterNewExpr?(node: NewExpr, context: VisitorContext): void;
  leaveNewExpr?(node: NewExpr, context: VisitorContext): void;
  enterMemberExpr?(node: MemberExpr, context: VisitorContext): void;
  leaveMemberExpr?(node: MemberExpr, context: VisitorContext): void;
  enterIfExpr?(node: IfExpr, context: VisitorContext): void;
  leaveIfExpr?(node: IfExpr, context: VisitorContext): void;
  enterMatchExpr?(node: MatchExpr, context: VisitorContext): void;
  leaveMatchExpr?(node: MatchExpr, context: VisitorContext): void;
  enterBlockExpr?(node: BlockExpr, context: VisitorContext): void;
  leaveBlockExpr?(node: BlockExpr, context: VisitorContext): void;
  enterArrowFunction?(node: ArrowFunction, context: VisitorContext): void;
  leaveArrowFunction?(node: ArrowFunction, context: VisitorContext): void;
  enterTryCatchExpr?(node: TryCatchExpr, context: VisitorContext): void;
  leaveTryCatchExpr?(node: TryCatchExpr, context: VisitorContext): void;
  enterArrayExpr?(node: ArrayExpr, context: VisitorContext): void;
  leaveArrayExpr?(node: ArrayExpr, context: VisitorContext): void;
  enterRecordExpr?(node: RecordExpr, context: VisitorContext): void;
  leaveRecordExpr?(node: RecordExpr, context: VisitorContext): void;
  enterTemplateString?(node: TemplateString, context: VisitorContext): void;
  leaveTemplateString?(node: TemplateString, context: VisitorContext): void;

  // ── Per-kind: Statements ───────────────────────────────────
  enterForStatement?(node: ForStatement, context: VisitorContext): void;
  leaveForStatement?(node: ForStatement, context: VisitorContext): void;
  enterWhileStatement?(node: WhileStatement, context: VisitorContext): void;
  leaveWhileStatement?(node: WhileStatement, context: VisitorContext): void;
  enterAssignmentStatement?(node: AssignmentStatement, context: VisitorContext): void;
  leaveAssignmentStatement?(node: AssignmentStatement, context: VisitorContext): void;
  enterThrowStatement?(node: ThrowStatement, context: VisitorContext): void;
  leaveThrowStatement?(node: ThrowStatement, context: VisitorContext): void;
  enterBreakStatement?(node: BreakStatement, context: VisitorContext): void;
  leaveBreakStatement?(node: BreakStatement, context: VisitorContext): void;
  enterContinueStatement?(node: ContinueStatement, context: VisitorContext): void;
  leaveContinueStatement?(node: ContinueStatement, context: VisitorContext): void;
  enterReturnStatement?(node: ReturnStatement, context: VisitorContext): void;
  leaveReturnStatement?(node: ReturnStatement, context: VisitorContext): void;
  enterExpressionStatement?(node: ExpressionStatement, context: VisitorContext): void;
  leaveExpressionStatement?(node: ExpressionStatement, context: VisitorContext): void;

  // ── Per-kind: Patterns ─────────────────────────────────────
  enterLiteralPattern?(node: LiteralPattern, context: VisitorContext): void;
  leaveLiteralPattern?(node: LiteralPattern, context: VisitorContext): void;
  enterVariantPattern?(node: VariantPattern, context: VisitorContext): void;
  leaveVariantPattern?(node: VariantPattern, context: VisitorContext): void;
  enterRecordPattern?(node: RecordPattern, context: VisitorContext): void;
  leaveRecordPattern?(node: RecordPattern, context: VisitorContext): void;
  enterWildcardPattern?(node: WildcardPattern, context: VisitorContext): void;
  leaveWildcardPattern?(node: WildcardPattern, context: VisitorContext): void;
  enterBindingPattern?(node: BindingPattern, context: VisitorContext): void;
  leaveBindingPattern?(node: BindingPattern, context: VisitorContext): void;
  enterNullPattern?(node: NullPattern, context: VisitorContext): void;
  leaveNullPattern?(node: NullPattern, context: VisitorContext): void;

  // ── Per-kind: Type Nodes ───────────────────────────────────
  enterNamedType?(node: NamedType, context: VisitorContext): void;
  leaveNamedType?(node: NamedType, context: VisitorContext): void;
  enterFunctionType?(node: FunctionType, context: VisitorContext): void;
  leaveFunctionType?(node: FunctionType, context: VisitorContext): void;
  enterRecordType?(node: RecordType, context: VisitorContext): void;
  leaveRecordType?(node: RecordType, context: VisitorContext): void;
  enterNullableType?(node: NullableType, context: VisitorContext): void;
  leaveNullableType?(node: NullableType, context: VisitorContext): void;
  enterUnionType?(node: UnionType, context: VisitorContext): void;
  leaveUnionType?(node: UnionType, context: VisitorContext): void;
  enterTupleType?(node: TupleType, context: VisitorContext): void;
  leaveTupleType?(node: TupleType, context: VisitorContext): void;

  // ── Per-kind: Other ────────────────────────────────────────
  enterErrorNode?(node: ErrorNode, context: VisitorContext): void;
  leaveErrorNode?(node: ErrorNode, context: VisitorContext): void;
  enterMatchArm?(node: MatchArm, context: VisitorContext): void;
  leaveMatchArm?(node: MatchArm, context: VisitorContext): void;
  enterVariantDeclaration?(node: VariantDeclaration, context: VisitorContext): void;
  leaveVariantDeclaration?(node: VariantDeclaration, context: VisitorContext): void;
  enterTypeParameter?(node: TypeParameter, context: VisitorContext): void;
  leaveTypeParameter?(node: TypeParameter, context: VisitorContext): void;
  enterFunctionParam?(node: FunctionParam, context: VisitorContext): void;
  leaveFunctionParam?(node: FunctionParam, context: VisitorContext): void;
  enterProgram?(node: Program, context: VisitorContext): void;
  leaveProgram?(node: Program, context: VisitorContext): void;
  enterImportSpecifier?(node: ImportSpecifier, context: VisitorContext): void;
  leaveImportSpecifier?(node: ImportSpecifier, context: VisitorContext): void;
  enterExportSpecifier?(node: ExportSpecifier, context: VisitorContext): void;
  leaveExportSpecifier?(node: ExportSpecifier, context: VisitorContext): void;
  enterRecordField?(node: RecordField, context: VisitorContext): void;
  leaveRecordField?(node: RecordField, context: VisitorContext): void;
}

// ── Category Classification ──────────────────────────────────────────

/**
 * High-level syntactic category for AST node kinds.
 *
 * Used to select the correct category-level visitor method when no
 * per-kind method is defined. `'Other'` means per-kind only (no fallback).
 */
type NodeCategory = 'Declaration' | 'Expression' | 'Statement' | 'Pattern' | 'TypeNode' | 'Other';

/** Maps every node `kind` string to its syntactic category for visitor dispatch. */
const NODE_CATEGORY: Record<string, NodeCategory> = {
  // Declarations
  LetDeclaration: 'Declaration',
  TypeDeclaration: 'Declaration',
  ImportDeclaration: 'Declaration',
  ExportDeclaration: 'Declaration',
  // Expressions
  NumberLiteral: 'Expression',
  StringLiteral: 'Expression',
  BooleanLiteral: 'Expression',
  NullLiteral: 'Expression',
  Identifier: 'Expression',
  BinaryExpr: 'Expression',
  UnaryExpr: 'Expression',
  CallExpr: 'Expression',
  NewExpr: 'Expression',
  MemberExpr: 'Expression',
  IfExpr: 'Expression',
  MatchExpr: 'Expression',
  BlockExpr: 'Expression',
  ArrowFunction: 'Expression',
  TryCatchExpr: 'Expression',
  ArrayExpr: 'Expression',
  RecordExpr: 'Expression',
  TemplateString: 'Expression',
  // Statements
  ForStatement: 'Statement',
  WhileStatement: 'Statement',
  AssignmentStatement: 'Statement',
  ThrowStatement: 'Statement',
  BreakStatement: 'Statement',
  ContinueStatement: 'Statement',
  ReturnStatement: 'Statement',
  ExpressionStatement: 'Statement',
  // Patterns
  LiteralPattern: 'Pattern',
  VariantPattern: 'Pattern',
  RecordPattern: 'Pattern',
  WildcardPattern: 'Pattern',
  BindingPattern: 'Pattern',
  NullPattern: 'Pattern',
  // Type Nodes
  NamedType: 'TypeNode',
  FunctionType: 'TypeNode',
  RecordType: 'TypeNode',
  NullableType: 'TypeNode',
  UnionType: 'TypeNode',
  TupleType: 'TypeNode',
  // Other (per-kind only, no category fallback)
  Program: 'Other',
  ErrorNode: 'Other',
  MatchArm: 'Other',
  VariantDeclaration: 'Other',
  TypeParameter: 'Other',
  FunctionParam: 'Other',
  ImportSpecifier: 'Other',
  ExportSpecifier: 'Other',
  RecordField: 'Other',
};

/** Maps categories to their `enter*` method names on the visitor. */
const CATEGORY_ENTER: Record<string, string> = {
  Declaration: 'enterDeclaration',
  Expression: 'enterExpression',
  Statement: 'enterStatement',
  Pattern: 'enterPattern',
  TypeNode: 'enterType',
};

/** Maps categories to their `leave*` method names on the visitor. */
const CATEGORY_LEAVE: Record<string, string> = {
  Declaration: 'leaveDeclaration',
  Expression: 'leaveExpression',
  Statement: 'leaveStatement',
  Pattern: 'leavePattern',
  TypeNode: 'leaveType',
};

// ── Child Traversal ──────────────────────────────────────────────────

/** Set of node kinds that have already triggered an "unknown kind" warning (avoids log spam). */
const warnedKinds = new Set<string>();

/**
 * Return the direct child AST nodes of the given node, in source order.
 *
 * This function encodes knowledge of every AST node shape. For composite
 * structures that don't extend `ASTNodeBase` (e.g. `VariantField`,
 * `RecordPatternField`, `RecordTypeField`), it reaches through to their
 * child AST nodes directly.
 *
 * Unknown node kinds trigger a one-time console warning and return an empty array.
 *
 * @param node - The parent node whose children to enumerate.
 * @returns Children in source order (left-to-right, top-to-bottom).
 */
function getChildren(node: ASTNodeBase): readonly ASTNodeBase[] {
  const children: ASTNodeBase[] = [];
  const kind = node.kind;

  switch (kind) {
    // ── Program ──
    case 'Program': {
      const n = node as Program;
      for (const item of n.body) children.push(item);
      break;
    }
    // ── Declarations ──
    case 'LetDeclaration': {
      const n = node as LetDeclaration;
      children.push(n.name);
      if (n.typeAnnotation) children.push(n.typeAnnotation);
      children.push(n.initializer);
      break;
    }
    case 'TypeDeclaration': {
      const n = node as TypeDeclaration;
      children.push(n.name);
      if (n.typeParams) {
        for (const tp of n.typeParams) children.push(tp);
      }
      if (n.recordType) {
        children.push(n.recordType);
      }
      for (const v of n.variants) children.push(v);
      break;
    }
    case 'VariantDeclaration': {
      const n = node as VariantDeclaration;
      children.push(n.name);
      // VariantField doesn't extend ASTNodeBase — reach through to child AST nodes
      for (const field of n.fields) {
        children.push(field.name);
        children.push(field.type);
      }
      break;
    }
    case 'ImportDeclaration': {
      const n = node as ImportDeclaration;
      if (n.defaultImport) children.push(n.defaultImport);
      for (const spec of n.specifiers) children.push(spec);
      children.push(n.source);
      break;
    }
    case 'ImportSpecifier': {
      const n = node as ImportSpecifier;
      children.push(n.imported);
      if (n.local) children.push(n.local);
      break;
    }
    case 'ExportDeclaration': {
      const n = node as ExportDeclaration;
      if (n.declaration) children.push(n.declaration);
      if (n.specifiers) {
        for (const spec of n.specifiers) children.push(spec);
      }
      if (n.source) children.push(n.source);
      break;
    }
    case 'ExportSpecifier': {
      const n = node as ExportSpecifier;
      children.push(n.local);
      if (n.exported) children.push(n.exported);
      break;
    }
    // ── Expressions ──
    case 'BinaryExpr': {
      const n = node as BinaryExpr;
      children.push(n.left);
      children.push(n.right);
      break;
    }
    case 'UnaryExpr': {
      const n = node as UnaryExpr;
      children.push(n.operand);
      break;
    }
    case 'CallExpr': {
      const n = node as CallExpr;
      children.push(n.callee);
      if (n.typeArgs) {
        for (const ta of n.typeArgs) children.push(ta);
      }
      for (const arg of n.args) children.push(arg);
      break;
    }
    case 'NewExpr': {
      const n = node as NewExpr;
      children.push(n.callee);
      if (n.typeArgs) {
        for (const ta of n.typeArgs) children.push(ta);
      }
      for (const arg of n.args) children.push(arg);
      break;
    }
    case 'MemberExpr': {
      const n = node as MemberExpr;
      children.push(n.object);
      children.push(n.property);
      break;
    }
    case 'IfExpr': {
      const n = node as IfExpr;
      children.push(n.condition);
      children.push(n.consequent);
      if (n.alternate) children.push(n.alternate);
      break;
    }
    case 'MatchExpr': {
      const n = node as MatchExpr;
      children.push(n.subject);
      for (const arm of n.arms) children.push(arm);
      break;
    }
    case 'MatchArm': {
      const n = node as MatchArm;
      children.push(n.pattern);
      if (n.guard) children.push(n.guard);
      children.push(n.body);
      break;
    }
    case 'BlockExpr': {
      const n = node as BlockExpr;
      for (const item of n.body) children.push(item);
      break;
    }
    case 'ArrowFunction': {
      const n = node as ArrowFunction;
      if (n.typeParams) {
        for (const tp of n.typeParams) children.push(tp);
      }
      for (const p of n.params) children.push(p);
      if (n.returnType) children.push(n.returnType);
      children.push(n.body);
      break;
    }
    case 'FunctionParam': {
      const n = node as FunctionParam;
      children.push(n.name);
      if (n.type) children.push(n.type);
      if (n.defaultValue) children.push(n.defaultValue);
      break;
    }
    case 'TryCatchExpr': {
      const n = node as TryCatchExpr;
      children.push(n.tryBody);
      children.push(n.catchParam);
      children.push(n.catchBody);
      break;
    }
    case 'ArrayExpr': {
      const n = node as ArrayExpr;
      for (const el of n.elements) children.push(el);
      break;
    }
    case 'RecordExpr': {
      const n = node as RecordExpr;
      for (const field of n.fields) children.push(field);
      break;
    }
    case 'RecordField': {
      const n = node as RecordField;
      children.push(n.name);
      children.push(n.value);
      break;
    }
    case 'TemplateString': {
      const n = node as TemplateString;
      for (const part of n.parts) {
        if (part.kind === 'TemplateExprPart') {
          children.push(part.expression);
        }
        // TemplateStringPart has no AST children
      }
      break;
    }
    // ── Statements ──
    case 'ForStatement': {
      const n = node as ForStatement;
      children.push(n.variable);
      children.push(n.iterable);
      children.push(n.body);
      break;
    }
    case 'WhileStatement': {
      const n = node as WhileStatement;
      children.push(n.condition);
      children.push(n.body);
      break;
    }
    case 'AssignmentStatement': {
      const n = node as AssignmentStatement;
      children.push(n.target);
      children.push(n.value);
      break;
    }
    case 'ThrowStatement': {
      const n = node as ThrowStatement;
      children.push(n.value);
      break;
    }
    case 'ReturnStatement': {
      const n = node as ReturnStatement;
      if (n.value) children.push(n.value);
      break;
    }
    case 'ExpressionStatement': {
      const n = node as ExpressionStatement;
      children.push(n.expression);
      break;
    }
    // ── Patterns ──
    case 'LiteralPattern': {
      const n = node as LiteralPattern;
      children.push(n.literal);
      break;
    }
    case 'VariantPattern': {
      const n = node as VariantPattern;
      children.push(n.name);
      if (n.fields) {
        for (const f of n.fields) children.push(f);
      }
      break;
    }
    case 'RecordPattern': {
      const n = node as RecordPattern;
      // RecordPatternField doesn't extend ASTNodeBase — reach through
      for (const field of n.fields) {
        children.push(field.name);
        if (field.pattern) children.push(field.pattern);
      }
      break;
    }
    case 'BindingPattern': {
      const n = node as BindingPattern;
      children.push(n.name);
      break;
    }
    // ── Type Nodes ──
    case 'NamedType': {
      const n = node as NamedType;
      children.push(n.name);
      if (n.typeArgs) {
        for (const ta of n.typeArgs) children.push(ta);
      }
      break;
    }
    case 'FunctionType': {
      const n = node as FunctionType;
      for (const p of n.params) children.push(p);
      children.push(n.returnType);
      break;
    }
    case 'RecordType': {
      const n = node as RecordType;
      // RecordTypeField doesn't extend ASTNodeBase — reach through
      for (const field of n.fields) {
        children.push(field.name);
        children.push(field.type);
      }
      break;
    }
    case 'NullableType': {
      const n = node as NullableType;
      children.push(n.inner);
      break;
    }
    case 'UnionType': {
      const n = node as UnionType;
      for (const m of n.members) children.push(m);
      break;
    }
    case 'TupleType': {
      const n = node as TupleType;
      for (const el of n.elements) children.push(el);
      break;
    }
    case 'TypeParameter': {
      const n = node as TypeParameter;
      children.push(n.name);
      break;
    }
    // ── Leaf nodes (no children) ──
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'Identifier':
    case 'WildcardPattern':
    case 'NullPattern':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ErrorNode':
      break;
    default: {
      if (!warnedKinds.has(kind)) {
        warnedKinds.add(kind);
        console.error(`walkAST: unknown node kind "${kind}" — skipping child traversal`);
      }
      break;
    }
  }

  return children;
}

// ── walkAST ──────────────────────────────────────────────────────────

/**
 * Walk an AST depth-first, dispatching to visitor methods.
 *
 * For each node:
 * 1. Call the most specific enter method (per-kind > category)
 * 2. Recursively visit children via {@link getChildren}
 * 3. Call the most specific leave method (per-kind > category)
 *
 * Unknown node kinds are handled gracefully: a warning is logged
 * once and traversal continues past the node.
 *
 * @param root    - The {@link Program} root node to traverse.
 * @param visitor - An object implementing any subset of {@link ASTVisitor} methods.
 */
export function walkAST(root: Program, visitor: ASTVisitor): void {
  let stopped = false;

  function visit(node: ASTNodeBase, parent: ASTNodeBase | undefined, depth: number): void {
    if (stopped) return;

    const context: VisitorContext = {
      parent,
      depth,
      stop() { stopped = true; },
    };

    // ── Enter dispatch ──
    const kind = node.kind;
    const enterPerKind = `enter${kind}`;
    const visitorRecord = visitor as Record<string, unknown>;

    if (typeof visitorRecord[enterPerKind] === 'function') {
      (visitorRecord[enterPerKind] as (node: ASTNodeBase, context: VisitorContext) => void)(node, context);
    } else {
      const category = NODE_CATEGORY[kind];
      if (category !== undefined && category !== 'Other') {
        const enterCategory = CATEGORY_ENTER[category];
        if (enterCategory !== undefined && typeof visitorRecord[enterCategory] === 'function') {
          (visitorRecord[enterCategory] as (node: ASTNodeBase, context: VisitorContext) => void)(node, context);
        }
      }
    }

    if (stopped) return;

    // ── Visit children ──
    const children = getChildren(node);
    for (const child of children) {
      if (stopped) return;
      visit(child, node, depth + 1);
    }

    if (stopped) return;

    // ── Leave dispatch ──
    const leavePerKind = `leave${kind}`;

    if (typeof visitorRecord[leavePerKind] === 'function') {
      (visitorRecord[leavePerKind] as (node: ASTNodeBase, context: VisitorContext) => void)(node, context);
    } else {
      const category = NODE_CATEGORY[kind];
      if (category !== undefined && category !== 'Other') {
        const leaveCategory = CATEGORY_LEAVE[category];
        if (leaveCategory !== undefined && typeof visitorRecord[leaveCategory] === 'function') {
          (visitorRecord[leaveCategory] as (node: ASTNodeBase, context: VisitorContext) => void)(node, context);
        }
      }
    }
  }

  visit(root, undefined, 0);
}
