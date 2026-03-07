/**
 * @module js-emitter
 *
 * JavaScript emitter for EffectScript.
 *
 * Transforms a type-checked AST into JavaScript source code. The emitter uses
 * a recursive function-based pattern (not the AST walker) for precise control
 * over expression vs. statement position output.
 *
 * Key design decisions:
 * - **Expression position**: `if`/`else` → ternary, `match`/`block`/`try-catch` → IIFE.
 * - **Statement position**: bare `if`/`else`, bare blocks, bare `try`/`catch`.
 * - **Prelude mapping**: `print` → `console.log`, `Ok`/`Err` → factory functions,
 *   `attempt` → `__attempt` helper. Helpers are only emitted when used.
 * - **Operator rewriting**: `==` → `===`, `!=` → `!==`, `|>` → nested calls.
 * - **Import rewriting**: relative `.efs` paths → `.js` extension.
 * - **Null/undefined interop**: `null` arguments converted to `undefined` when the
 *   callee parameter has `nullKind === 'undefined'` or `'either'`.
 * - **ADT emission**: fieldless variants → frozen singletons, variants with fields → factory functions.
 * - **Type declarations**: record aliases are erased (no runtime output).
 */

import type {
  Program, LetDeclaration, TypeDeclaration, VariantDeclaration,
  ImportDeclaration, ExportDeclaration,
  NumberLiteral, StringLiteral, BooleanLiteral,
  Identifier, BinaryExpr, UnaryExpr, CallExpr, NewExpr,
  MemberExpr, IfExpr, MatchExpr, BlockExpr,
  ArrowFunction, TryCatchExpr,
  ArrayExpr, RecordExpr, TemplateString,
  ForStatement, WhileStatement, AssignmentStatement,
  ThrowStatement, ReturnStatement, ExpressionStatement,
  Expression, Declaration, Statement,
  Pattern,
} from '../parser/ast.js';
import { isDeclaration, isStatement } from '../parser/ast.js';
import type { ADTType, FunctionType, ParamType, Type } from '../checker/types.js';
import { resolveType } from '../checker/types.js';
import { EmitContext } from './emit-context.js';
import { getOperatorPrecedence } from '../utils/operators.js';
import { PRELUDE_NAMES } from '../prelude/prelude.js';
import { rewriteImportPath } from '../utils/constants.js';

// ── Operator Precedence ────────────────────────────────────

/** Look up the numeric precedence of an operator for parenthesization decisions. */
function getPrec(op: string): number {
  return getOperatorPrecedence(op);
}

// ── Prelude Detection ──────────────────────────────────────

/** Tracks which prelude symbols are used, so their JS helpers can be emitted. */
interface PreludeUsage {
  usesOk: boolean;
  usesErr: boolean;
  usesAttempt: boolean;
}

/** Check if an expression is the prelude `print` function by inspecting its resolved type. */
function isPreludePrint(node: Expression): boolean {
  if (node.kind !== 'Identifier' || (node as Identifier).name !== PRELUDE_NAMES.print) return false;
  const t = node.resolvedType;
  if (t === undefined) return false;
  const resolved = resolveType(t);
  if (resolved.kind !== 'function') return false;
  const ft = resolved as FunctionType;
  return ft.params.length === 1 && ft.params[0].type.kind === 'any' &&
    ft.returnType.kind === 'primitive' && ft.returnType.name === 'void';
}

/** Check if an expression is the prelude `Ok` constructor. */
function isPreludeOk(node: Expression): boolean {
  if (node.kind !== 'Identifier' || (node as Identifier).name !== PRELUDE_NAMES.Ok) return false;
  return isPreludeResultConstructor(node);
}

/** Check if an expression is the prelude `Err` constructor. */
function isPreludeErr(node: Expression): boolean {
  if (node.kind !== 'Identifier' || (node as Identifier).name !== PRELUDE_NAMES.Err) return false;
  return isPreludeResultConstructor(node);
}

/** Check if an expression is the prelude `attempt` function. */
function isPreludeAttempt(node: Expression): boolean {
  if (node.kind !== 'Identifier' || (node as Identifier).name !== PRELUDE_NAMES.attempt) return false;
  const t = node.resolvedType;
  if (t === undefined) return false;
  const resolved = resolveType(t);
  if (resolved.kind !== 'function') return false;
  const ft = resolved as FunctionType;
  return ft.returnType.kind === 'adt' && (ft.returnType as ADTType).name === PRELUDE_NAMES.Result;
}

/** Check if an expression resolves to a Result ADT constructor function. */
function isPreludeResultConstructor(node: Expression): boolean {
  const t = node.resolvedType;
  if (t === undefined) return false;
  const resolved = resolveType(t);
  if (resolved.kind !== 'function') return false;
  const ft = resolved as FunctionType;
  return ft.returnType.kind === 'adt' && (ft.returnType as ADTType).name === PRELUDE_NAMES.Result;
}

/**
 * Scan the entire AST for prelude symbol usage (Ok, Err, attempt).
 *
 * The result determines which runtime helper functions are emitted at the
 * top of the generated JS file.
 *
 * @param ast - The type-checked program AST.
 * @returns Which prelude helpers are used and need to be emitted.
 */
function scanPreludeUsage(ast: Program): PreludeUsage {
  const result: PreludeUsage = { usesOk: false, usesErr: false, usesAttempt: false };
  scanNode(ast, result);
  return result;
}

/**
 * Recursively scan an AST node tree for prelude symbol references.
 *
 * Walks all object properties and arrays looking for `CallExpr` nodes
 * whose callee is a prelude function (Ok, Err, attempt). Mutates the
 * `usage` flags in place.
 *
 * @param node - Any AST node (or sub-structure) to scan.
 * @param usage - Mutable prelude usage tracker, updated when symbols are found.
 */
function scanNode(node: unknown, usage: PreludeUsage): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  if (n['kind'] === 'CallExpr') {
    const callNode = node as CallExpr;
    if (isPreludePrint(callNode.callee)) { /* print doesn't need helper */ }
    if (isPreludeOk(callNode.callee)) usage.usesOk = true;
    if (isPreludeErr(callNode.callee)) usage.usesErr = true;
    if (isPreludeAttempt(callNode.callee)) usage.usesAttempt = true;
  }

  // Recurse into arrays and object properties
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        scanNode(item, usage);
      }
    } else if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['kind'] === 'string') {
      scanNode(value, usage);
    }
  }
}

// ── Import Path Rewriting ──────────────────────────────────


// ── Main Entry Point ───────────────────────────────────────

/**
 * Emit JavaScript from a typed AST.
 *
 * Scans for prelude usage, emits helper functions at the top of the file,
 * then emits each top-level declaration/statement.
 *
 * @param ast - The type-checked AST.
 * @returns The generated JavaScript source code.
 */
export function emitJS(ast: Program): string {
  const ctx = new EmitContext();
  const prelude = scanPreludeUsage(ast);

  // Emit prelude helpers at top of file
  emitPreludeHelpers(ctx, prelude);

  for (const item of ast.body) {
    emitTopLevel(ctx, item, prelude);
  }

  return ctx.getOutput();
}

/**
 * Emit JavaScript from a typed AST, returning both the source and the {@link EmitContext}.
 *
 * The EmitContext contains source map mappings which can be fed to
 * {@link generateSourceMap} to produce a `.js.map` file.
 *
 * @param ast - The type-checked AST.
 * @returns The generated JS source and the EmitContext with source mappings.
 */
export function emitJSWithContext(ast: Program): { source: string; context: EmitContext } {
  const ctx = new EmitContext();
  const prelude = scanPreludeUsage(ast);

  emitPreludeHelpers(ctx, prelude);

  for (const item of ast.body) {
    emitTopLevel(ctx, item, prelude);
  }

  return { source: ctx.getOutput(), context: ctx };
}

// ── Prelude Helpers ────────────────────────────────────────

/**
 * Emit JS runtime helpers for prelude symbols at the top of the file.
 *
 * Only emits helpers that are actually used:
 * - `Ok(value)` → `{ _tag: "Ok", value }`
 * - `Err(error)` → `{ _tag: "Err", error }`
 * - `__attempt(f)` → try/catch wrapper returning Ok/Err
 *
 * @param ctx - The emit context to write to.
 * @param prelude - Which prelude symbols are used in the AST.
 */
function emitPreludeHelpers(ctx: EmitContext, prelude: PreludeUsage): void {
  if (prelude.usesOk) {
    ctx.writeLine('const Ok = (value) => ({ _tag: "Ok", value });');
  }
  if (prelude.usesErr) {
    ctx.writeLine('const Err = (error) => ({ _tag: "Err", error });');
  }
  if (prelude.usesAttempt) {
    ctx.writeLine('const __attempt = (f) => { try { return { _tag: "Ok", value: f() }; } catch (e) { return { _tag: "Err", error: e }; } };');
  }
}

// ── Top-Level Items ────────────────────────────────────────

/**
 * Dispatch a top-level declaration or statement to its appropriate emitter.
 *
 * Handles let/type/import/export declarations, for/while/assignment/throw/break/continue/return
 * statements, and expression statements. ErrorNodes emit a placeholder comment.
 *
 * @param ctx - The emit context to write to.
 * @param node - The top-level AST node (declaration or statement).
 * @param prelude - Which prelude symbols are used (for expression emission).
 */
function emitTopLevel(ctx: EmitContext, node: Declaration | Statement, prelude: PreludeUsage): void {
  switch (node.kind) {
    case 'LetDeclaration':
      emitLetDeclaration(ctx, node, prelude, node.exported ? 'export' : '');
      break;
    case 'TypeDeclaration':
      emitTypeDeclaration(ctx, node, node.exported ? 'export' : '');
      break;
    case 'ImportDeclaration':
      emitImportDeclaration(ctx, node);
      break;
    case 'ExportDeclaration':
      emitExportDeclaration(ctx, node, prelude);
      break;
    case 'ForStatement':
      emitForStatement(ctx, node, prelude);
      break;
    case 'WhileStatement':
      emitWhileStatement(ctx, node, prelude);
      break;
    case 'AssignmentStatement':
      emitAssignmentStatement(ctx, node, prelude);
      break;
    case 'ThrowStatement':
      emitThrowStatement(ctx, node, prelude);
      break;
    case 'BreakStatement':
      ctx.writeLine('break;');
      break;
    case 'ContinueStatement':
      ctx.writeLine('continue;');
      break;
    case 'ReturnStatement':
      emitReturnStatement(ctx, node as ReturnStatement, prelude);
      break;
    case 'ExpressionStatement':
      emitExpressionStatement(ctx, node, prelude);
      break;
    default: {
      // ErrorNode or unknown
      const n = node as { kind: string };
      if (n.kind === 'ErrorNode') {
        ctx.writeLine('/* error: unparseable region */');
      }
      break;
    }
  }
}

/**
 * Emit a `return` statement with an optional value expression.
 *
 * Emits `return expr;` if a value is present, or bare `return;` otherwise.
 */
function emitReturnStatement(ctx: EmitContext, node: ReturnStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  if (node.value) {
    ctx.write('return ');
    emitExpr(ctx, node.value, prelude);
    ctx.writeLine(';');
  } else {
    ctx.writeLine('return;');
  }
}

// ── Declarations ───────────────────────────────────────────

/**
 * Emit a `let` declaration as `const`/`let` with initializer.
 *
 * Arrow functions with block bodies get special handling to avoid wrapping
 * the body in an IIFE.
 */
function emitLetDeclaration(ctx: EmitContext, node: LetDeclaration, prelude: PreludeUsage, exportPrefix: string): void {
  const keyword = node.mutable ? 'let' : 'const';
  const prefix = exportPrefix ? exportPrefix + ' ' : '';

  // Special case: arrow function with block body
  if (node.initializer.kind === 'ArrowFunction') {
    const fn = node.initializer as ArrowFunction;
    if (fn.body.kind === 'BlockExpr') {
      ctx.addMapping(node.span);
      ctx.write(`${prefix}${keyword} ${node.name.name} = (`);
      emitParams(ctx, fn.params, prelude);
      ctx.write(') => ');
      emitBlockBody(ctx, fn.body as BlockExpr, prelude);
      ctx.newLine();
      return;
    }
  }

  ctx.addMapping(node.span);
  ctx.write(`${prefix}${keyword} ${node.name.name} = `);
  emitExpr(ctx, node.initializer, prelude);
  ctx.writeLine(';');
}

/**
 * Emit a type declaration. Record aliases are erased; ADT variants emit
 * constructors (frozen singletons or factory functions).
 */
function emitTypeDeclaration(ctx: EmitContext, node: TypeDeclaration, exportPrefix: string): void {
  // Named record type aliases are erased — no runtime code
  if (node.recordType !== undefined) return;

  const prefix = exportPrefix ? exportPrefix + ' ' : '';
  for (const v of node.variants) {
    emitVariantConstructor(ctx, v, prefix);
  }
}

/**
 * Emit a single ADT variant constructor.
 *
 * Fieldless variants produce `Object.freeze({ _tag: "Name" })`.
 * Variants with fields produce `(field1, field2) => ({ _tag: "Name", field1, field2 })`.
 */
function emitVariantConstructor(ctx: EmitContext, v: VariantDeclaration, exportPrefix: string): void {
  ctx.addMapping(v.span);
  if (v.fields.length === 0) {
    // Fieldless → frozen singleton
    ctx.writeLine(`${exportPrefix}const ${v.name.name} = Object.freeze({ _tag: "${v.name.name}" });`);
  } else {
    // With fields → factory function
    const paramNames = v.fields.map(f => f.name.name);
    const fieldEntries = paramNames.join(', ');
    ctx.writeLine(`${exportPrefix}const ${v.name.name} = (${paramNames.join(', ')}) => ({ _tag: "${v.name.name}", ${fieldEntries} });`);
  }
}

/**
 * Emit an import declaration, rewriting the source path for JS output.
 *
 * Handles three forms: default-only, default + named, and named-only imports.
 * Relative `.efs` paths are rewritten to `.js` via {@link rewriteImportPath}.
 */
function emitImportDeclaration(ctx: EmitContext, node: ImportDeclaration): void {
  ctx.addMapping(node.span);
  const source = rewriteImportPath(node.source.value);

  if (node.defaultImport !== undefined && node.specifiers.length === 0) {
    // Default import only
    ctx.writeLine(`import ${node.defaultImport.name} from "${source}";`);
    return;
  }

  if (node.defaultImport !== undefined) {
    // Default + named
    const specs = node.specifiers.map(s =>
      s.local !== undefined ? `${s.imported.name} as ${s.local.name}` : s.imported.name
    ).join(', ');
    ctx.writeLine(`import ${node.defaultImport.name}, { ${specs} } from "${source}";`);
    return;
  }

  // Named imports only
  const specs = node.specifiers.map(s =>
    s.local !== undefined ? `${s.imported.name} as ${s.local.name}` : s.imported.name
  ).join(', ');
  ctx.writeLine(`import { ${specs} } from "${source}";`);
}

/**
 * Emit an export declaration.
 *
 * Handles three forms: declaration exports (`export let`/`export type`),
 * named re-exports (`export { a, b }`), and re-exports from a module
 * (`export { a } from "mod"`).
 */
function emitExportDeclaration(ctx: EmitContext, node: ExportDeclaration, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);

  if (node.declaration !== undefined) {
    if (node.declaration.kind === 'LetDeclaration') {
      emitLetDeclaration(ctx, node.declaration, prelude, 'export');
    } else if (node.declaration.kind === 'TypeDeclaration') {
      emitTypeDeclaration(ctx, node.declaration, 'export');
    }
    return;
  }

  if (node.specifiers !== undefined) {
    const specs = node.specifiers.map(s =>
      s.exported !== undefined ? `${s.local.name} as ${s.exported.name}` : s.local.name
    ).join(', ');
    if (node.source !== undefined) {
      const source = rewriteImportPath(node.source.value);
      ctx.writeLine(`export { ${specs} } from "${source}";`);
    } else {
      ctx.writeLine(`export { ${specs} };`);
    }
  }
}

// ── Statements ─────────────────────────────────────────────

/** Emit a `for (const x of iterable)` loop. */
function emitForStatement(ctx: EmitContext, node: ForStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  ctx.write(`for (const ${node.variable.name} of `);
  emitExpr(ctx, node.iterable, prelude);
  ctx.write(') ');
  emitBlockStatements(ctx, node.body, prelude);
  ctx.newLine();
}

/** Emit a `while` loop. */
function emitWhileStatement(ctx: EmitContext, node: WhileStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  ctx.write('while (');
  emitExpr(ctx, node.condition, prelude);
  ctx.write(') ');
  emitBlockStatements(ctx, node.body, prelude);
  ctx.newLine();
}

/** Emit an assignment statement (`target = value;`). */
function emitAssignmentStatement(ctx: EmitContext, node: AssignmentStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  emitExpr(ctx, node.target, prelude);
  ctx.write(' = ');
  emitExpr(ctx, node.value, prelude);
  ctx.writeLine(';');
}

/** Emit a `throw` statement. */
function emitThrowStatement(ctx: EmitContext, node: ThrowStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  ctx.write('throw ');
  emitExpr(ctx, node.value, prelude);
  ctx.writeLine(';');
}

/** Emit an expression statement (delegates to {@link emitStmtExpr} for position-aware emission). */
function emitExpressionStatement(ctx: EmitContext, node: ExpressionStatement, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);
  emitStmtExpr(ctx, node.expression, prelude);
}

// ── Expression Emission ────────────────────────────────────

/**
 * Emit an expression in statement position (value is discarded).
 *
 * For compound expressions (if, match, block, try-catch), uses statement form
 * (bare if/else, bare blocks) instead of IIFE wrappers. Other expressions
 * are emitted normally followed by a semicolon.
 */
function emitStmtExpr(ctx: EmitContext, node: Expression, prelude: PreludeUsage): void {
  switch (node.kind) {
    case 'IfExpr':
      emitIfStatement(ctx, node as IfExpr, prelude);
      break;
    case 'MatchExpr':
      emitMatchStatement(ctx, node as MatchExpr, prelude);
      break;
    case 'BlockExpr':
      emitBlockStatement(ctx, node as BlockExpr, prelude);
      break;
    case 'TryCatchExpr':
      emitTryCatchStatement(ctx, node as TryCatchExpr, prelude);
      break;
    default:
      emitExpr(ctx, node, prelude);
      ctx.writeLine(';');
      break;
  }
}

/**
 * Emit an expression in expression position (value is needed).
 *
 * Dispatches to kind-specific emitters for all expression types. Compound
 * expressions (if, match, block, try-catch) are wrapped in IIFEs to produce
 * a value. See {@link emitStmtExpr} for the statement-position counterpart.
 */
function emitExpr(ctx: EmitContext, node: Expression, prelude: PreludeUsage): void {
  switch (node.kind) {
    case 'NumberLiteral':
      ctx.write(String((node as NumberLiteral).value));
      break;
    case 'StringLiteral':
      emitStringLiteral(ctx, node as StringLiteral);
      break;
    case 'BooleanLiteral':
      ctx.write(String((node as BooleanLiteral).value));
      break;
    case 'NullLiteral':
      ctx.write('null');
      break;
    case 'Identifier':
      ctx.write((node as Identifier).name);
      break;
    case 'BinaryExpr':
      emitBinaryExpr(ctx, node as BinaryExpr, prelude);
      break;
    case 'UnaryExpr':
      emitUnaryExpr(ctx, node as UnaryExpr, prelude);
      break;
    case 'CallExpr':
      emitCallExpr(ctx, node as CallExpr, prelude);
      break;
    case 'NewExpr':
      emitNewExpr(ctx, node as NewExpr, prelude);
      break;
    case 'MemberExpr':
      emitMemberExpr(ctx, node as MemberExpr, prelude);
      break;
    case 'IfExpr':
      emitIfExpr(ctx, node as IfExpr, prelude);
      break;
    case 'MatchExpr':
      emitMatchExpr(ctx, node as MatchExpr, prelude);
      break;
    case 'BlockExpr':
      emitBlockExpr(ctx, node as BlockExpr, prelude);
      break;
    case 'ArrowFunction':
      emitArrowFunction(ctx, node as ArrowFunction, prelude);
      break;
    case 'TryCatchExpr':
      emitTryCatchExpr(ctx, node as TryCatchExpr, prelude);
      break;
    case 'ArrayExpr':
      emitArrayExpr(ctx, node as ArrayExpr, prelude);
      break;
    case 'RecordExpr':
      emitRecordExpr(ctx, node as RecordExpr, prelude);
      break;
    case 'TemplateString':
      emitTemplateString(ctx, node as TemplateString, prelude);
      break;
    default:
      break;
  }
}

/** Emit a string literal with backslash, quote, newline, carriage return, and tab characters escaped. */
function emitStringLiteral(ctx: EmitContext, node: StringLiteral): void {
  const escaped = node.value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  ctx.write(`"${escaped}"`);
}

/**
 * Emit a binary expression with operator rewriting and precedence-based parenthesization.
 *
 * Rewrites `|>` to nested calls, `==` to `===`, and `!=` to `!==`.
 */
function emitBinaryExpr(ctx: EmitContext, node: BinaryExpr, prelude: PreludeUsage): void {
  // Pipe operator: x |> f → f(x)
  if (node.operator === '|>') {
    emitExpr(ctx, node.right, prelude);
    ctx.write('(');
    emitExpr(ctx, node.left, prelude);
    ctx.write(')');
    return;
  }

  const jsOp = node.operator === '==' ? '===' : node.operator === '!=' ? '!==' : node.operator;

  // Left operand: needs parens if lower precedence
  if (needsParens(node, node.left, 'left')) {
    ctx.write('(');
    emitExpr(ctx, node.left, prelude);
    ctx.write(')');
  } else {
    emitExpr(ctx, node.left, prelude);
  }

  ctx.write(` ${jsOp} `);

  // Right operand: needs parens if lower or equal precedence (for left-associative)
  if (needsParens(node, node.right, 'right')) {
    ctx.write('(');
    emitExpr(ctx, node.right, prelude);
    ctx.write(')');
  } else {
    emitExpr(ctx, node.right, prelude);
  }
}

/**
 * Determine if a child expression needs parentheses inside a parent binary expression.
 *
 * Uses operator precedence: wraps if the child has lower precedence than the parent,
 * or same precedence on the right side (for left-associative operators).
 */
function needsParens(parent: BinaryExpr, child: Expression, side: 'left' | 'right'): boolean {
  if (child.kind !== 'BinaryExpr') return false;
  const childBin = child as BinaryExpr;
  // Pipe has its own emission, no parens needed
  if (childBin.operator === '|>') return false;
  const parentPrec = getPrec(parent.operator);
  const childPrec = getPrec(childBin.operator);
  if (childPrec < parentPrec) return true;
  // For right side, also wrap if same precedence (left-associative)
  if (side === 'right' && childPrec === parentPrec) return true;
  return false;
}

/** Emit a unary expression (prefix operator + operand). */
function emitUnaryExpr(ctx: EmitContext, node: UnaryExpr, prelude: PreludeUsage): void {
  ctx.write(node.operator);
  emitExpr(ctx, node.operand, prelude);
}

/**
 * Emit a call expression with prelude rewriting and null/undefined interop.
 *
 * `print(x)` → `console.log(x)`, `attempt(f)` → `__attempt(f)`.
 * For other calls, `null` arguments may be converted to `undefined` based on
 * the callee parameter's {@link NullKind}.
 */
function emitCallExpr(ctx: EmitContext, node: CallExpr, prelude: PreludeUsage): void {
  ctx.addMapping(node.span);

  // Prelude print → console.log
  if (isPreludePrint(node.callee)) {
    ctx.write('console.log(');
    emitArgs(ctx, node.args, prelude);
    ctx.write(')');
    return;
  }

  // Prelude attempt → __attempt
  if (isPreludeAttempt(node.callee)) {
    ctx.write('__attempt(');
    emitArgs(ctx, node.args, prelude);
    ctx.write(')');
    return;
  }

  // Get callee's resolved FunctionType for null→undefined interop
  const calleeParams = getCalleeParams(node.callee);

  emitExpr(ctx, node.callee, prelude);
  ctx.write('(');
  emitArgsWithNullKind(ctx, node.args, prelude, calleeParams);
  ctx.write(')');
}

/**
 * Extract parameter types from a callee expression's resolved type.
 *
 * Used to determine {@link ParamType.nullKind} for null→undefined interop
 * when emitting call arguments.
 *
 * @param callee - The function being called.
 * @returns The function's parameter types, or `undefined` if the callee isn't a resolved function.
 */
function getCalleeParams(callee: Expression): readonly ParamType[] | undefined {
  const resolved = (callee as unknown as { resolvedType?: Type }).resolvedType;
  if (resolved === undefined) return undefined;
  const actual = resolveType(resolved);
  if (actual.kind === 'function') return (actual as FunctionType).params;
  return undefined;
}

/**
 * Emit call arguments with null/undefined interop.
 *
 * When a `null` literal argument corresponds to a parameter with
 * `nullKind === 'undefined'` or `'either'`, it is emitted as `undefined`
 * instead of `null` for TypeScript interop compatibility.
 *
 * @param ctx - The emit context.
 * @param args - The argument expressions.
 * @param prelude - Prelude usage flags.
 * @param params - The callee's parameter types (for nullKind lookup), if available.
 */
function emitArgsWithNullKind(
  ctx: EmitContext,
  args: readonly Expression[],
  prelude: PreludeUsage,
  params: readonly ParamType[] | undefined,
): void {
  for (let i = 0; i < args.length; i++) {
    if (i > 0) ctx.write(', ');
    const arg = args[i];
    // Check if this null arg should be emitted as undefined
    if (arg.kind === 'NullLiteral' && params !== undefined && i < params.length) {
      const nullKind = params[i].nullKind;
      if (nullKind === 'undefined' || nullKind === 'either') {
        ctx.write('undefined');
        continue;
      }
    }
    emitExpr(ctx, arg, prelude);
  }
}

/** Emit a `new` expression. */
function emitNewExpr(ctx: EmitContext, node: NewExpr, prelude: PreludeUsage): void {
  ctx.write('new ');
  emitExpr(ctx, node.callee, prelude);
  ctx.write('(');
  emitArgs(ctx, node.args, prelude);
  ctx.write(')');
}

/** Emit a member access expression, using `?.` for optional chaining. */
function emitMemberExpr(ctx: EmitContext, node: MemberExpr, prelude: PreludeUsage): void {
  emitExpr(ctx, node.object, prelude);
  ctx.write(node.optional ? '?.' : '.');
  ctx.write(node.property.name);
}

/** Emit a comma-separated list of argument expressions. */
function emitArgs(ctx: EmitContext, args: readonly Expression[], prelude: PreludeUsage): void {
  for (let i = 0; i < args.length; i++) {
    if (i > 0) ctx.write(', ');
    emitExpr(ctx, args[i], prelude);
  }
}

/** Emit a comma-separated list of function parameter names with optional default values. */
function emitParams(ctx: EmitContext, params: readonly ArrowFunction['params'][number][], prelude: PreludeUsage): void {
  for (let i = 0; i < params.length; i++) {
    if (i > 0) ctx.write(', ');
    ctx.write(params[i].name.name);
    if (params[i].defaultValue !== undefined) {
      ctx.write(' = ');
      emitExpr(ctx, params[i].defaultValue!, prelude);
    }
  }
}

// ── If Expression ──────────────────────────────────────────

/**
 * Emit if/else in expression position.
 *
 * Uses ternary when both branches are simple expressions, IIFE when there is
 * no else branch, or ternary with IIFE branches for complex block bodies.
 */
function emitIfExpr(ctx: EmitContext, node: IfExpr, prelude: PreludeUsage): void {
  if (node.alternate === undefined) {
    // No else in expression position — just emit condition check as IIFE
    emitIfIIFE(ctx, node, prelude);
    return;
  }

  // If both branches are simple expressions (not blocks), use ternary
  if (isSimpleExpr(node.consequent) && isSimpleExpr(node.alternate)) {
    emitExpr(ctx, node.condition, prelude);
    ctx.write(' ? ');
    emitExpr(ctx, node.consequent, prelude);
    ctx.write(' : ');
    emitExpr(ctx, node.alternate, prelude);
    return;
  }

  // Complex branches: use ternary with IIFE for block branches
  emitExpr(ctx, node.condition, prelude);
  ctx.write(' ? ');
  emitBranchExpr(ctx, node.consequent, prelude);
  ctx.write(' : ');
  emitBranchExpr(ctx, node.alternate, prelude);
}

/** Emit a branch — IIFE if it's a block, direct expression otherwise. */
function emitBranchExpr(ctx: EmitContext, node: Expression, prelude: PreludeUsage): void {
  if (node.kind === 'BlockExpr') {
    emitBlockExpr(ctx, node as BlockExpr, prelude);
  } else {
    emitExpr(ctx, node, prelude);
  }
}

/** Emit an if/else as an IIFE for expression position when ternary is not suitable (e.g. no else branch). */
function emitIfIIFE(ctx: EmitContext, node: IfExpr, prelude: PreludeUsage): void {
  ctx.write('(() => {');
  ctx.newLine();
  ctx.indent();
  ctx.writeIndented('if (');
  emitExpr(ctx, node.condition, prelude);
  ctx.write(') ');
  emitBlockReturn(ctx, node.consequent, prelude);
  if (node.alternate !== undefined) {
    ctx.write(' else ');
    emitBlockReturn(ctx, node.alternate, prelude);
  }
  ctx.newLine();
  ctx.dedent();
  ctx.write('})()');
}

/**
 * Emit if/else in statement position as a bare `if` / `else if` / `else` chain.
 *
 * Handles else-if chains by recursively calling itself for nested `IfExpr` alternates.
 */
function emitIfStatement(ctx: EmitContext, node: IfExpr, prelude: PreludeUsage): void {
  ctx.write('if (');
  emitExpr(ctx, node.condition, prelude);
  ctx.write(') ');

  if (node.consequent.kind === 'BlockExpr') {
    emitBlockStatements(ctx, node.consequent as BlockExpr, prelude);
  } else {
    ctx.write('{');
    ctx.newLine();
    ctx.indent();
    emitStmtBody(ctx, node.consequent, prelude);
    ctx.dedent();
    ctx.writeIndented('}');
  }

  if (node.alternate !== undefined) {
    ctx.write(' else ');
    if (node.alternate.kind === 'IfExpr') {
      // else if chain
      emitIfStatement(ctx, node.alternate as IfExpr, prelude);
      return;
    }
    if (node.alternate.kind === 'BlockExpr') {
      emitBlockStatements(ctx, node.alternate as BlockExpr, prelude);
    } else {
      ctx.write('{');
      ctx.newLine();
      ctx.indent();
      emitStmtBody(ctx, node.alternate, prelude);
      ctx.dedent();
      ctx.writeIndented('}');
    }
  }
  ctx.newLine();
}

// ── Match Expression ───────────────────────────────────────

/** Emit match in expression position as an IIFE wrapping an if/else chain with `return` values. */
function emitMatchExpr(ctx: EmitContext, node: MatchExpr, prelude: PreludeUsage): void {
  ctx.write('(() => {');
  ctx.newLine();
  ctx.indent();
  emitMatchChain(ctx, node, prelude, true);
  ctx.dedent();
  ctx.write('})()');
}

/** Emit match in statement position as a bare if/else chain (no IIFE, no return). */
function emitMatchStatement(ctx: EmitContext, node: MatchExpr, prelude: PreludeUsage): void {
  emitMatchChain(ctx, node, prelude, false);
}

/**
 * Emit the if/else chain for a match expression's arms.
 *
 * Each arm becomes an `if` condition + body. Catch-all arms become the `else` block.
 * In expression position (`isExpr`), arm bodies emit `return`. A trailing `throw`
 * is only added when the match is not exhaustive (checked via the `isExhaustive` flag
 * set by the type checker).
 */
function emitMatchChain(ctx: EmitContext, node: MatchExpr, prelude: PreludeUsage, isExpr: boolean): void {
  const subject = node.subject;
  const adtType = getADTType(subject);

  for (let i = 0; i < node.arms.length; i++) {
    const arm = node.arms[i];
    const isFirst = i === 0;
    const isCatchAll = isCatchAllPattern(arm.pattern) && arm.guard === undefined;

    if (isCatchAll && !isFirst) {
      // Else block for catch-all
      ctx.write(' else {');
      ctx.newLine();
      ctx.indent();
      emitPatternBindings(ctx, arm.pattern, subject, prelude, adtType);
      if (isExpr) {
        ctx.writeIndented('return ');
        emitExpr(ctx, arm.body, prelude);
        ctx.writeLine(';');
      } else {
        emitStmtBody(ctx, arm.body, prelude);
      }
      ctx.dedent();
      ctx.writeIndented('}');
    } else {
      if (!isFirst) ctx.write(' else ');
      ctx.writeIndented('if (');
      emitPatternCondition(ctx, arm.pattern, subject, prelude, adtType);
      if (arm.guard !== undefined) {
        if (!isCatchAllPattern(arm.pattern)) ctx.write(' && ');
        emitExpr(ctx, arm.guard, prelude);
      }
      ctx.write(') {');
      ctx.newLine();
      ctx.indent();
      emitPatternBindings(ctx, arm.pattern, subject, prelude, adtType);
      if (isExpr) {
        ctx.writeIndented('return ');
        emitExpr(ctx, arm.body, prelude);
        ctx.writeLine(';');
      } else {
        emitStmtBody(ctx, arm.body, prelude);
      }
      ctx.dedent();
      ctx.writeIndented('}');
    }
  }

  // Add final else with throw only when match is not exhaustive.
  // Exhaustiveness is set by the checker on the node as `isExhaustive`.
  const isExhaustive = (node as unknown as Record<string, unknown>)['isExhaustive'] === true;
  if (isExpr && !isExhaustive) {
    ctx.write(' else {');
    ctx.newLine();
    ctx.indent();
    ctx.writeLineIndented('throw new Error("Non-exhaustive match");');
    ctx.dedent();
    ctx.writeIndented('}');
  }
  ctx.newLine();
}

/**
 * Extract the ADT type from a match subject's resolved type.
 *
 * @param subject - The match expression's subject.
 * @returns The ADT type if the subject resolves to one, otherwise `undefined`.
 */
function getADTType(subject: Expression): ADTType | undefined {
  if (subject.resolvedType === undefined) return undefined;
  const resolved = resolveType(subject.resolvedType);
  if (resolved.kind === 'adt') return resolved as ADTType;
  return undefined;
}

/** Check if a pattern is a catch-all (wildcard or binding — NOT record patterns). */
function isCatchAllPattern(pattern: Pattern): boolean {
  // RecordPattern is NOT a catch-all — it only matches values with the specific fields.
  return pattern.kind === 'WildcardPattern' || pattern.kind === 'BindingPattern';
}

/**
 * Emit the JavaScript condition for a match pattern.
 *
 * Variant patterns check `_tag`; literal patterns use `===`; null patterns
 * check `=== null`; catch-alls emit `true`.
 */
function emitPatternCondition(ctx: EmitContext, pattern: Pattern, subject: Expression, prelude: PreludeUsage, adtType?: ADTType): void {
  switch (pattern.kind) {
    case 'VariantPattern': {
      emitExpr(ctx, subject, prelude);
      ctx.write(`._tag === "${pattern.name.name}"`);
      // Nested literal patterns add additional conditions
      if (pattern.fields !== undefined && adtType !== undefined) {
        const variant = adtType.variants.find(v => v.name === pattern.name.name);
        if (variant !== undefined) {
          const fieldNames = Array.from(variant.fields.keys());
          for (let i = 0; i < pattern.fields.length; i++) {
            const field = pattern.fields[i];
            if (field.kind === 'LiteralPattern') {
              ctx.write(' && ');
              emitExpr(ctx, subject, prelude);
              ctx.write(`.${fieldNames[i]} === `);
              emitExpr(ctx, field.literal, prelude);
            }
          }
        }
      }
      break;
    }
    case 'LiteralPattern':
      emitExpr(ctx, subject, prelude);
      ctx.write(' === ');
      emitExpr(ctx, pattern.literal, prelude);
      break;
    case 'NullPattern':
      emitExpr(ctx, subject, prelude);
      ctx.write(' === null');
      break;
    case 'BindingPattern':
    case 'WildcardPattern':
      // Always matches — emit true as condition
      ctx.write('true');
      break;
    case 'RecordPattern':
      // Always matches structurally
      ctx.write('true');
      break;
  }
}

/**
 * Emit `const` bindings for the variables introduced by a match pattern.
 *
 * Variant patterns bind positionally from the variant's field names.
 * Binding patterns bind the entire subject. Record patterns destructure fields.
 */
function emitPatternBindings(ctx: EmitContext, pattern: Pattern, subject: Expression, prelude: PreludeUsage, adtType?: ADTType): void {
  switch (pattern.kind) {
    case 'VariantPattern': {
      if (pattern.fields === undefined || adtType === undefined) break;
      const variant = adtType.variants.find(v => v.name === pattern.name.name);
      if (variant === undefined) break;
      // Binding is positional: pattern.fields[i] binds to the i-th variant field.
      // Field names come from the variant definition's stable insertion-order Map.
      const fieldNames = Array.from(variant.fields.keys());
      for (let i = 0; i < pattern.fields.length; i++) {
        const field = pattern.fields[i];
        if (field.kind === 'BindingPattern') {
          ctx.writeIndented(`const ${field.name.name} = `);
          emitExpr(ctx, subject, prelude);
          ctx.writeLine(`.${fieldNames[i]};`);
        }
        // Nested literal patterns don't produce bindings
      }
      break;
    }
    case 'BindingPattern':
      ctx.writeIndented(`const ${pattern.name.name} = `);
      emitExpr(ctx, subject, prelude);
      ctx.writeLine(';');
      break;
    case 'RecordPattern':
      for (const field of pattern.fields) {
        ctx.writeIndented(`const ${field.name.name} = `);
        emitExpr(ctx, subject, prelude);
        ctx.writeLine(`.${field.name.name};`);
      }
      break;
    default:
      break;
  }
}

// ── Block Expression ───────────────────────────────────────

/**
 * Emit a block in expression position as an IIFE.
 *
 * Empty blocks emit `(() => {})()`. Non-empty blocks emit the body with
 * the last expression wrapped in `return`.
 */
function emitBlockExpr(ctx: EmitContext, node: BlockExpr, prelude: PreludeUsage): void {
  if (node.body.length === 0) {
    ctx.write('(() => {})()');
    return;
  }

  ctx.write('(() => {');
  ctx.newLine();
  ctx.indent();
  emitBlockBodyWithReturn(ctx, node.body, prelude);
  ctx.dedent();
  ctx.write('})()');
}

/** Emit a block in statement position as a bare `{ }` block (no IIFE, no return). */
function emitBlockStatement(ctx: EmitContext, node: BlockExpr, prelude: PreludeUsage): void {
  ctx.write('{');
  ctx.newLine();
  ctx.indent();
  for (const item of node.body) {
    emitBlockItem(ctx, item, prelude, false);
  }
  ctx.dedent();
  ctx.writeLine('}');
}

/** Emit a block body as statements without return (used by for/while/if bodies). */
function emitBlockStatements(ctx: EmitContext, node: BlockExpr, prelude: PreludeUsage): void {
  ctx.write('{');
  ctx.newLine();
  ctx.indent();
  for (const item of node.body) {
    emitBlockItem(ctx, item, prelude, false);
  }
  ctx.dedent();
  ctx.writeIndented('}');
}

/**
 * Emit block body items where the last expression gets a `return` prefix.
 *
 * Used inside IIFEs and arrow function bodies to produce a value from the block.
 * Declarations and statements are emitted normally; only the final expression
 * in the list receives `return`.
 */
function emitBlockBodyWithReturn(ctx: EmitContext, items: readonly (Declaration | Statement | Expression)[], prelude: PreludeUsage): void {
  for (let i = 0; i < items.length; i++) {
    const isLast = i === items.length - 1;
    emitBlockItem(ctx, items[i], prelude, isLast);
  }
}

/**
 * Emit a block body with `{ }` braces and return semantics for arrow functions.
 *
 * The last expression in the block gets a `return` prefix. Used for arrow
 * function block bodies at both top-level and indented positions.
 */
function emitBlockBody(ctx: EmitContext, node: BlockExpr, prelude: PreludeUsage): void {
  ctx.write('{');
  ctx.newLine();
  ctx.indent();
  emitBlockBodyWithReturn(ctx, node.body, prelude);
  ctx.dedent();
  ctx.writeIndented('}');
}

/**
 * Emit a single `{ return expr; }` block wrapping an expression or block body.
 *
 * If the node is a `BlockExpr`, its items are emitted with return semantics.
 * Otherwise, the expression is wrapped directly in `{ return expr; }`.
 * Used by if/else IIFE branches.
 */
function emitBlockReturn(ctx: EmitContext, node: Expression, prelude: PreludeUsage): void {
  if (node.kind === 'BlockExpr') {
    const block = node as BlockExpr;
    ctx.write('{');
    ctx.newLine();
    ctx.indent();
    emitBlockBodyWithReturn(ctx, block.body, prelude);
    ctx.dedent();
    ctx.writeIndented('}');
  } else {
    ctx.write('{');
    ctx.newLine();
    ctx.indent();
    ctx.writeIndented('return ');
    emitExpr(ctx, node, prelude);
    ctx.writeLine(';');
    ctx.dedent();
    ctx.writeIndented('}');
  }
}

/**
 * Emit a single item within a block (declaration, statement, or expression).
 *
 * If `isLastAndReturn` is true and the item is an expression, wraps it with `return`.
 */
function emitBlockItem(ctx: EmitContext, item: Declaration | Statement | Expression, prelude: PreludeUsage, isLastAndReturn: boolean): void {
  // Declarations and statements
  if (isDeclaration(item)) {
    emitBlockDecl(ctx, item, prelude);
    return;
  }
  if (isStatement(item)) {
    emitBlockStmt(ctx, item, prelude);
    return;
  }

  // Expression: if last and in return context, add return
  if (isLastAndReturn) {
    ctx.writeIndented('return ');
    emitExpr(ctx, item as Expression, prelude);
    ctx.writeLine(';');
  } else {
    ctx.writeIndented('');
    emitStmtExpr(ctx, item as Expression, prelude);
  }
}

/** Emit a declaration inside a block (indented). Handles `let` and `type` declarations. */
function emitBlockDecl(ctx: EmitContext, node: Declaration, prelude: PreludeUsage): void {
  switch (node.kind) {
    case 'LetDeclaration':
      emitLetDeclarationIndented(ctx, node, prelude);
      break;
    case 'TypeDeclaration':
      emitTypeDeclaration(ctx, node, '');
      break;
    default:
      break;
  }
}

/**
 * Emit a let declaration with indentation (for use inside blocks).
 *
 * Like {@link emitLetDeclaration}, but writes with block-level indentation.
 * Arrow functions with block bodies get special handling to avoid IIFE wrapping.
 */
function emitLetDeclarationIndented(ctx: EmitContext, node: LetDeclaration, prelude: PreludeUsage): void {
  const keyword = node.mutable ? 'let' : 'const';

  if (node.initializer.kind === 'ArrowFunction') {
    const fn = node.initializer as ArrowFunction;
    if (fn.body.kind === 'BlockExpr') {
      ctx.writeIndented(`${keyword} ${node.name.name} = (`);
      emitParams(ctx, fn.params, prelude);
      ctx.write(') => ');
      emitBlockBody(ctx, fn.body as BlockExpr, prelude);
      ctx.newLine();
      return;
    }
  }

  ctx.writeIndented(`${keyword} ${node.name.name} = `);
  emitExpr(ctx, node.initializer, prelude);
  ctx.writeLine(';');
}

/**
 * Emit a statement inside a block (indented).
 *
 * Dispatches to statement-specific emitters for expression statements,
 * for/while loops, assignments, throw, break, continue, and return.
 */
function emitBlockStmt(ctx: EmitContext, node: Statement, prelude: PreludeUsage): void {
  switch (node.kind) {
    case 'ExpressionStatement':
      ctx.writeIndented('');
      emitStmtExpr(ctx, (node as ExpressionStatement).expression, prelude);
      break;
    case 'ForStatement':
      ctx.writeIndented('');
      emitForStatement(ctx, node as ForStatement, prelude);
      break;
    case 'WhileStatement':
      ctx.writeIndented('');
      emitWhileStatement(ctx, node as WhileStatement, prelude);
      break;
    case 'AssignmentStatement':
      ctx.writeIndented('');
      emitAssignmentStatement(ctx, node as AssignmentStatement, prelude);
      break;
    case 'ThrowStatement':
      ctx.writeIndented('');
      emitThrowStatement(ctx, node as ThrowStatement, prelude);
      break;
    case 'BreakStatement':
      ctx.writeLineIndented('break;');
      break;
    case 'ContinueStatement':
      ctx.writeLineIndented('continue;');
      break;
    case 'ReturnStatement':
      ctx.writeIndented('');
      emitReturnStatement(ctx, node as ReturnStatement, prelude);
      break;
    default:
      break;
  }
}

/** Emit a single expression as an indented statement with trailing semicolon (value discarded). */
function emitStmtBody(ctx: EmitContext, node: Expression, prelude: PreludeUsage): void {
  ctx.writeIndented('');
  emitExpr(ctx, node, prelude);
  ctx.writeLine(';');
}

// ── Try/Catch ──────────────────────────────────────────────

/** Emit try/catch in expression position as an IIFE with `return` in both try and catch bodies. */
function emitTryCatchExpr(ctx: EmitContext, node: TryCatchExpr, prelude: PreludeUsage): void {
  ctx.write('(() => {');
  ctx.newLine();
  ctx.indent();
  ctx.writeLineIndented('try {');
  ctx.indent();
  emitBlockBodyWithReturn(ctx, node.tryBody.body, prelude);
  ctx.dedent();
  ctx.writeLineIndented(`} catch (${node.catchParam.name}) {`);
  ctx.indent();
  emitBlockBodyWithReturn(ctx, node.catchBody.body, prelude);
  ctx.dedent();
  ctx.writeLineIndented('}');
  ctx.dedent();
  ctx.write('})()');
}

/** Emit try/catch in statement position as a bare `try { } catch (e) { }` block. */
function emitTryCatchStatement(ctx: EmitContext, node: TryCatchExpr, prelude: PreludeUsage): void {
  ctx.write('try ');
  emitBlockStatements(ctx, node.tryBody, prelude);
  ctx.write(` catch (${node.catchParam.name}) `);
  emitBlockStatements(ctx, node.catchBody, prelude);
  ctx.newLine();
}

// ── Arrow Function ─────────────────────────────────────────

/**
 * Emit an arrow function expression.
 *
 * Block bodies are emitted with `{ }` braces and return semantics via
 * {@link emitBlockBody}. Simple expression bodies are emitted directly after `=>`.
 */
function emitArrowFunction(ctx: EmitContext, node: ArrowFunction, prelude: PreludeUsage): void {
  ctx.write('(');
  emitParams(ctx, node.params, prelude);
  ctx.write(') => ');

  if (node.body.kind === 'BlockExpr') {
    emitBlockBody(ctx, node.body as BlockExpr, prelude);
  } else {
    emitExpr(ctx, node.body, prelude);
  }
}

// ── Array / Record / Template ──────────────────────────────

/** Emit an array literal `[a, b, c]`. */
function emitArrayExpr(ctx: EmitContext, node: ArrayExpr, prelude: PreludeUsage): void {
  ctx.write('[');
  for (let i = 0; i < node.elements.length; i++) {
    if (i > 0) ctx.write(', ');
    emitExpr(ctx, node.elements[i], prelude);
  }
  ctx.write(']');
}

/** Emit a record literal `({ key: value })`. Wrapped in parens to avoid block ambiguity. */
function emitRecordExpr(ctx: EmitContext, node: RecordExpr, prelude: PreludeUsage): void {
  // Wrap in parens to avoid ambiguity with block statement
  ctx.write('({ ');
  for (let i = 0; i < node.fields.length; i++) {
    if (i > 0) ctx.write(', ');
    const field = node.fields[i];
    ctx.write(`${field.name.name}: `);
    emitExpr(ctx, field.value, prelude);
  }
  ctx.write(' })');
}

/**
 * Emit a template string using JS backtick syntax.
 *
 * String parts are emitted as-is; expression parts are wrapped in `${...}`.
 */
function emitTemplateString(ctx: EmitContext, node: TemplateString, prelude: PreludeUsage): void {
  ctx.write('`');
  for (const part of node.parts) {
    if (part.kind === 'TemplateStringPart') {
      ctx.write(part.value);
    } else {
      ctx.write('${');
      emitExpr(ctx, part.expression, prelude);
      ctx.write('}');
    }
  }
  ctx.write('`');
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Check if an expression is simple enough for inline ternary emission.
 *
 * Block expressions are not simple (they require IIFE wrapping), but all
 * other expression kinds can be emitted inline in a ternary.
 */
function isSimpleExpr(node: Expression): boolean {
  // Not a block expression and not an if expression with block branches
  return node.kind !== 'BlockExpr';
}

