/**
 * @module checker
 *
 * Main type checker for EffectScript.
 *
 * The checker operates in two passes over the top-level AST:
 * 1. **Registration pass**: hoists type declarations (ADTs, record aliases)
 *    and forward-declares `let` bindings that have explicit type annotations.
 * 2. **Checking pass**: processes each declaration/statement in order,
 *    inferring expression types and verifying assignability.
 *
 * Key capabilities:
 * - Expression type inference (literals, identifiers, calls, member access, etc.)
 * - Null narrowing in `if`/`else` branches via null-comparison conditions.
 * - Generic function instantiation with type argument inference.
 * - Match exhaustiveness checking (delegates to {@link checkExhaustiveness}).
 * - Built-in method typing for `string`, `number`, `boolean`, and `Array`.
 * - Import/export resolution and cross-module type propagation.
 *
 * Diagnostic codes: E200–E218 (errors), W200–W203 (warnings).
 */

import type { Span } from '../utils/span.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type { PreludeDeclarations } from '../prelude/prelude.js';
import { registerPrelude, PRELUDE_NAMES } from '../prelude/prelude.js';
import type {
  Program, Declaration, Expression, Statement, Pattern, TypeNode,
  LetDeclaration, TypeDeclaration, ImportDeclaration, ExportDeclaration,
  Identifier,
  BinaryExpr, UnaryExpr, CallExpr, MemberExpr,
  IfExpr, MatchExpr, BlockExpr, ArrowFunction, TryCatchExpr,
  ArrayExpr, RecordExpr, TemplateString,
  ForStatement, WhileStatement, AssignmentStatement, ThrowStatement,
  ReturnStatement, ExpressionStatement,
  NamedType,
  NullableType as NullableTypeNode,
  FunctionType as FunctionTypeNode,
  RecordType as RecordTypeNode,
  UnionType as UnionTypeNode,
  TupleType as TupleTypeNode,
  VariantPattern, BindingPattern,
  RecordPattern,
  NewExpr,
} from '../parser/ast.js';
import { isStatement } from '../parser/ast.js';
import type {
  Type,
  FunctionType,
  ADTType,
  ADTVariant,
  RecordType,
  ArrayType,
  ParamType,
  ExportedTypeSignature,
} from './types.js';
import {
  resolveType,
  isAssignableTo,
  typesEqual,
  typeToString,
  makeNullable,
  freshTypeVar,
  simplifyUnion,
  resetTypeVarCounter,
  NUM, STR, BOOL, VOID, NEVER, ANY, NULL_TYPE, ERROR_TYPE,
} from './types.js';
import { ScopeManager } from './scope.js';
import { checkExhaustiveness } from './exhaustiveness.js';

// ── Public API ──────────────────────────────────────────────

/** Input to the type checker: the AST, imported module signatures, prelude, and diagnostic collector. */
export interface CheckerInput {
  /** The parsed AST to type-check. */
  readonly ast: Program;
  /** Import map: module specifier → exported type signature (for cross-module lookups). */
  readonly imports: ReadonlyMap<string, ExportedTypeSignature>;
  /** The prelude declarations (Result, Ok, Err, attempt, print). */
  readonly prelude: PreludeDeclarations;
  /** Collector to receive diagnostics (errors and warnings) produced during checking. */
  readonly diagnostics: DiagnosticCollector;
}

/** Output of the type checker: the annotated AST and the module's exported signature. */
export interface CheckerOutput {
  /** The AST with `resolvedType` fields set on expressions and declarations. */
  readonly typedAST: Program;
  /** The module's exported type signature for consumption by downstream importers. */
  readonly exports: ExportedTypeSignature;
}

/**
 * Type-check a program and annotate the AST with resolved types.
 *
 * Resets the type variable counter for deterministic IDs, then runs
 * the two-pass type checker.
 *
 * @param input - The checker input (AST, imports, prelude, diagnostics).
 * @returns The annotated AST and the module's exported type signature.
 */
export function check(input: CheckerInput): CheckerOutput {
  resetTypeVarCounter();
  const checker = new TypeChecker(input);
  return checker.run();
}

// ── TypeChecker ─────────────────────────────────────────────

/**
 * The core type checker implementation.
 *
 * Operates in two passes:
 * 1. **Registration** — hoists type declarations and forward-declared let bindings.
 * 2. **Checking** — infers expression types, validates statements, and collects exports.
 *
 * The checker mutates the AST in place by setting `resolvedType` on nodes
 * (via {@link setResolvedType}) rather than building a parallel typed tree.
 */
class TypeChecker {
  /** Lexical scope manager (linked-list scope chain). */
  private readonly scope: ScopeManager;
  /** Collector for all diagnostics emitted during checking. */
  private readonly diagnostics: DiagnosticCollector;
  /** Import map: module specifier → exported type signature. */
  private readonly imports: ReadonlyMap<string, ExportedTypeSignature>;
  /** The AST being checked. */
  private readonly ast: Program;
  /** Accumulated exported value bindings (populated during checking). */
  private readonly exportedValues = new Map<string, Type>();
  /** Accumulated exported type bindings (populated during checking). */
  private readonly exportedTypes = new Map<string, Type>();
  /** Accumulated exported ADT variant constructors (populated during checking). */
  private readonly exportedAdtConstructors = new Map<string, FunctionType>();

  constructor(input: CheckerInput) {
    this.ast = input.ast;
    this.diagnostics = input.diagnostics;
    this.imports = input.imports;
    this.scope = new ScopeManager();
    registerPrelude(input.prelude, this.scope);
  }

  /**
   * Run the two-pass type checker and return the annotated AST + exports.
   *
   * Pass 1 registers type declarations and forward-declared let bindings.
   * Pass 2 checks each top-level item in source order.
   */
  run(): CheckerOutput {
    // Pass 1: Register type declarations (hoisted)
    for (const item of this.ast.body) {
      if (item.kind === 'TypeDeclaration') {
        this.registerTypeDeclaration(item as TypeDeclaration);
      } else if (item.kind === 'ExportDeclaration') {
        const exp = item as ExportDeclaration;
        if (exp.declaration && exp.declaration.kind === 'TypeDeclaration') {
          this.registerTypeDeclaration(exp.declaration);
        }
      }
    }

    // Pass 1b: Register let bindings with type annotations (for forward references)
    for (const item of this.ast.body) {
      const decl =
        item.kind === 'LetDeclaration'
          ? item as LetDeclaration
          : (item.kind === 'ExportDeclaration' &&
             (item as ExportDeclaration).declaration?.kind === 'LetDeclaration')
            ? (item as ExportDeclaration).declaration as LetDeclaration
            : undefined;
      if (!decl) continue;

      if (decl.typeAnnotation) {
        const declaredType = this.resolveTypeNode(decl.typeAnnotation);
        this.declareBinding(decl.name.name, declaredType, decl.mutable, decl.span);
      } else if (decl.initializer?.kind === 'ArrowFunction') {
        // Forward-declare arrow functions with inline type info (enables recursion)
        const arrow = decl.initializer as ArrowFunction;
        if (arrow.params.every(p => p.type !== undefined) && arrow.returnType) {
          const generics = arrow.typeParams?.map(tp => ({
            kind: 'generic' as const,
            name: tp.name.name,
          })) ?? [];
          const paramTypes = arrow.params.map(p => {
            const pType = generics.length > 0
              ? this.resolveTypeNodeWithGenerics(p.type!, generics)
              : this.resolveTypeNode(p.type!);
            return {
              name: p.name.name,
              type: pType,
              optional: false,
              hasDefault: p.defaultValue !== undefined,
            } satisfies ParamType;
          });
          const returnType = generics.length > 0
            ? this.resolveTypeNodeWithGenerics(arrow.returnType, generics)
            : this.resolveTypeNode(arrow.returnType);
          const fnType: FunctionType = { kind: 'function', params: paramTypes, returnType };
          if (generics.length > 0) {
            const result: Record<string, unknown> = { ...fnType };
            result['typeParams'] = generics.map(g => ({ name: g.name }));
            this.declareBinding(decl.name.name, result as unknown as FunctionType, decl.mutable, decl.span);
          } else {
            this.declareBinding(decl.name.name, fnType, decl.mutable, decl.span);
          }
        }
      }
    }

    // Pass 2: Check each item in order
    for (const item of this.ast.body) {
      this.checkTopLevel(item);
    }

    return {
      typedAST: this.ast,
      exports: {
        types: this.exportedTypes,
        values: this.exportedValues,
        adtConstructors: this.exportedAdtConstructors,
      },
    };
  }

  // ── Top-level dispatch ──────────────────────────────────

  /** Dispatch a top-level declaration or statement to the appropriate handler. */
  private checkTopLevel(item: Declaration | Statement): void {
    switch (item.kind) {
      case 'LetDeclaration':
        this.checkLetDeclaration(item as LetDeclaration);
        break;
      case 'TypeDeclaration':
        // Already registered in Pass 1, just set resolvedType
        this.setResolvedType(item, this.scope.resolveType((item as TypeDeclaration).name.name) ?? VOID);
        break;
      case 'ImportDeclaration':
        this.checkImportDeclaration(item as ImportDeclaration);
        break;
      case 'ExportDeclaration':
        this.checkExportDeclaration(item as ExportDeclaration);
        break;
      case 'ForStatement':
        this.checkForStatement(item as ForStatement);
        break;
      case 'WhileStatement':
        this.checkWhileStatement(item as WhileStatement);
        break;
      case 'AssignmentStatement':
        this.checkAssignmentStatement(item as AssignmentStatement);
        break;
      case 'ThrowStatement':
        this.checkThrowStatement(item as ThrowStatement);
        break;
      case 'ReturnStatement':
        this.checkReturnStatement(item as ReturnStatement);
        break;
      case 'ExpressionStatement':
        this.inferExpression((item as ExpressionStatement).expression);
        break;
      default:
        break;
    }
  }

  // ── Declaration checking ────────────────────────────────

  /**
   * Check a `let` declaration: infer the initializer type, verify against
   * the type annotation (if present), and declare the binding in the current scope.
   * Reports W203 if the declaration shadows a prelude binding.
   */
  private checkLetDeclaration(decl: LetDeclaration): void {
    // Warn if shadowing a prelude binding
    const name = decl.name.name;
    if (name === PRELUDE_NAMES.print || name === PRELUDE_NAMES.Ok ||
        name === PRELUDE_NAMES.Err || name === PRELUDE_NAMES.attempt) {
      this.diagnostics.report({
        severity: 'warning',
        code: D.W203,
        message: `Declaration '${decl.name.name}' shadows a prelude binding`,
        span: decl.name.span,
        fix: {
          description: `Rename '${decl.name.name}' to avoid shadowing the prelude binding`,
          edits: [],
        },
      });
    }

    const inferredType = this.inferExpression(decl.initializer);

    if (decl.typeAnnotation) {
      const declaredType = this.resolveTypeNode(decl.typeAnnotation);

      // Check assignability
      if (inferredType.kind !== 'error' && !isAssignableTo(inferredType, declaredType)) {
        const diag: Record<string, unknown> = {
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(inferredType)}' is not assignable to type '${typeToString(declaredType)}'`,
          span: decl.initializer.span,
        };
        if (decl.typeAnnotation !== undefined) {
          diag['relatedSpans'] = [{ span: decl.typeAnnotation.span, message: 'expected type declared here' }];
        }
        this.diagnostics.report(diag as unknown as Diagnostic);
      }

      // If already registered in Pass 1b (same current scope), don't re-declare
      if (!this.scope.isInCurrentScope(decl.name.name)) {
        this.declareBinding(decl.name.name, declaredType, decl.mutable, decl.span);
      }
      this.setResolvedType(decl, declaredType);
    } else {
      // Infer type from initializer
      if (!this.scope.isInCurrentScope(decl.name.name)) {
        this.declareBinding(decl.name.name, inferredType, decl.mutable, decl.span);
      } else if (decl.initializer?.kind === 'ArrowFunction' &&
                 (decl.initializer as ArrowFunction).params.every(p => p.type !== undefined) &&
                 (decl.initializer as ArrowFunction).returnType) {
        // Forward-declared in Pass 1b — don't re-declare (skip like typeAnnotation path)
      } else {
        const existing = this.scope.resolve(decl.name.name);
        const dup: Record<string, unknown> = {
          severity: 'error',
          code: D.E213,
          message: `Duplicate declaration: '${decl.name.name}' is already declared in this scope`,
          span: decl.name.span,
        };
        if (existing !== undefined) {
          dup['relatedSpans'] = [{ span: existing.declared, message: `'${decl.name.name}' first declared here` }];
        }
        this.diagnostics.report(dup as unknown as Diagnostic);
      }
      this.setResolvedType(decl, inferredType);
    }
  }

  /**
   * Register a type declaration (ADT or named record alias) in the type scope.
   *
   * For ADTs, also registers variant constructors as value bindings. Fieldless
   * variants are bound as ADT values; variants with fields become constructor functions.
   */
  private registerTypeDeclaration(decl: TypeDeclaration): void {
    const typeParams = decl.typeParams?.map(tp => ({
      kind: 'generic' as const,
      name: tp.name.name,
    })) ?? [];

    // Named record type alias: type Foo = { ... }
    if (decl.recordType !== undefined) {
      const fields = new Map<string, Type>();
      for (const f of decl.recordType.fields) {
        fields.set(f.name.name, this.resolveTypeNodeWithGenerics(f.type, typeParams));
      }
      const recordType: RecordType = { kind: 'record', fields };
      this.scope.declareType(decl.name.name, recordType);
      this.setResolvedType(decl, recordType);
      return;
    }

    const variants: ADTVariant[] = decl.variants.map(v => {
      const fields = new Map<string, Type>();
      for (const f of v.fields) {
        // Push type params into scope for resolving variant field types
        fields.set(f.name.name, this.resolveTypeNodeWithGenerics(f.type, typeParams));
      }
      return { name: v.name.name, fields };
    });

    const adtType: ADTType = {
      kind: 'adt',
      name: decl.name.name,
      typeArgs: typeParams,
      variants,
    };

    this.scope.declareType(decl.name.name, adtType);

    // Register variant constructors in scope
    for (const variant of variants) {
      if (variant.fields.size === 0) {
        // Unit variant — it IS the ADT value
        this.declareBinding(variant.name, adtType, false, decl.span);
      } else {
        // Variant with fields → constructor function
        const params: ParamType[] = Array.from(variant.fields.entries()).map(([name, type]) => ({
          name,
          type,
          optional: false,
          hasDefault: false,
        }));
        const ctorBase: Record<string, unknown> = {
          kind: 'function',
          params,
          returnType: adtType,
        };
        if (typeParams.length > 0) ctorBase['typeParams'] = typeParams.map(g => ({ name: g.name }));
        const ctorType = ctorBase as unknown as FunctionType;
        this.declareBinding(variant.name, ctorType, false, decl.span);
      }
    }
  }

  /**
   * Check an import declaration: resolve each imported name against the module's
   * exported signature and declare local bindings. Reports E211 for missing modules
   * or missing exports.
   */
  private checkImportDeclaration(decl: ImportDeclaration): void {
    const source = decl.source.value;
    const sig = this.imports.get(source);

    // Handle default import: import Foo from "module"
    if (decl.defaultImport) {
      const localName = decl.defaultImport.name;
      if (sig) {
        const defaultType = sig.values.get('default');
        if (defaultType) {
          this.declareBinding(localName, defaultType, false, decl.defaultImport.span);
        } else {
          this.diagnostics.report({
            severity: 'error',
            code: D.E211,
            message: `Module '${source}' has no default export`,
            span: decl.defaultImport.span,
          });
          this.declareBinding(localName, ERROR_TYPE, false, decl.defaultImport.span);
        }
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E211,
          message: `Cannot find module '${source}'`,
          span: decl.source.span,
        });
        this.declareBinding(localName, ERROR_TYPE, false, decl.defaultImport.span);
      }
    }

    for (const spec of decl.specifiers) {
      const importedName = spec.imported.name;
      const localName = spec.local?.name ?? importedName;

      if (sig) {
        const importedType = sig.values.get(importedName) ?? sig.types.get(importedName);
        if (importedType) {
          this.declareBinding(localName, importedType, false, spec.span);
        } else {
          this.diagnostics.report({
            severity: 'error',
            code: D.E211,
            message: `Module '${source}' has no exported member '${importedName}'`,
            span: spec.span,
          });
          this.declareBinding(localName, ERROR_TYPE, false, spec.span);
        }
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E211,
          message: `Cannot find module '${source}'`,
          span: decl.source.span,
        });
        this.declareBinding(localName, ERROR_TYPE, false, spec.span);
      }
    }
  }

  /**
   * Check an export declaration: process the inner declaration (if any),
   * register the exported names in the module's export maps, and handle
   * re-exports from other modules.
   */
  private checkExportDeclaration(decl: ExportDeclaration): void {
    if (decl.declaration) {
      if (decl.declaration.kind === 'LetDeclaration') {
        this.checkLetDeclaration(decl.declaration);
        const name = decl.declaration.name.name;
        const binding = this.scope.resolve(name);
        if (binding) {
          this.exportedValues.set(name, binding.type);
        }
      } else if (decl.declaration.kind === 'TypeDeclaration') {
        // Already registered in Pass 1
        const name = decl.declaration.name.name;
        const type = this.scope.resolveType(name);
        if (type) {
          this.exportedTypes.set(name, type);

          // Also export variant constructors when an ADT type is exported
          if (type.kind === 'adt') {
            for (const variant of type.variants) {
              const binding = this.scope.resolve(variant.name);
              if (binding) {
                this.exportedValues.set(variant.name, binding.type);
                if (binding.type.kind === 'function') {
                  this.exportedAdtConstructors.set(variant.name, binding.type);
                }
              }
            }
          }
        }
        this.setResolvedType(decl.declaration, type ?? VOID);
      }
    }

    if (decl.specifiers) {
      if (decl.source) {
        // Re-export: export { foo } from "./other"
        const sig = this.imports.get(decl.source.value);
        for (const spec of decl.specifiers) {
          const importedName = spec.local.name;
          const exportedName = spec.exported?.name ?? importedName;
          if (sig) {
            const importedType = sig.values.get(importedName) ?? sig.types.get(importedName);
            if (importedType) {
              this.exportedValues.set(exportedName, importedType);
            } else {
              this.diagnostics.report({
                severity: 'error',
                code: D.E211,
                message: `Module '${decl.source.value}' has no exported member '${importedName}'`,
                span: spec.span,
              });
            }
          } else {
            this.diagnostics.report({
              severity: 'error',
              code: D.E211,
              message: `Cannot find module '${decl.source.value}'`,
              span: decl.source.span,
            });
          }
        }
      } else {
        // Local re-export: export { foo }
        for (const spec of decl.specifiers) {
          const localName = spec.local.name;
          const exportedName = spec.exported?.name ?? localName;
          const binding = this.scope.resolve(localName);
          if (binding) {
            this.exportedValues.set(exportedName, binding.type);
          }
        }
      }
    }
  }

  // ── Expression inference ────────────────────────────────

  /**
   * Infer the type of an expression and set its `resolvedType` on the AST node.
   *
   * Dispatches to a specialized handler for each expression kind. The inferred
   * type is always set on the node via {@link setResolvedType} before returning.
   *
   * @param node - The expression AST node to type-check.
   * @returns The inferred type of the expression.
   */
  private inferExpression(node: Expression): Type {
    let type: Type;

    switch (node.kind) {
      case 'NumberLiteral':
        type = NUM;
        break;
      case 'StringLiteral':
        type = STR;
        break;
      case 'BooleanLiteral':
        type = BOOL;
        break;
      case 'NullLiteral':
        type = NULL_TYPE;
        break;
      case 'Identifier':
        type = this.inferIdentifier(node as Identifier);
        break;
      case 'BinaryExpr':
        type = this.inferBinaryExpr(node as BinaryExpr);
        break;
      case 'UnaryExpr':
        type = this.inferUnaryExpr(node as UnaryExpr);
        break;
      case 'CallExpr':
        type = this.inferCallExpr(node as CallExpr);
        break;
      case 'NewExpr':
        type = this.inferNewExpr(node as NewExpr);
        break;
      case 'MemberExpr':
        type = this.inferMemberExpr(node as MemberExpr);
        break;
      case 'IfExpr':
        type = this.inferIfExpr(node as IfExpr);
        break;
      case 'MatchExpr':
        type = this.inferMatchExpr(node as MatchExpr);
        break;
      case 'BlockExpr':
        type = this.inferBlockExpr(node as BlockExpr);
        break;
      case 'ArrowFunction':
        type = this.inferArrowFunction(node as ArrowFunction);
        break;
      case 'TryCatchExpr':
        type = this.inferTryCatchExpr(node as TryCatchExpr);
        break;
      case 'ArrayExpr':
        type = this.inferArrayExpr(node as ArrayExpr);
        break;
      case 'RecordExpr':
        type = this.inferRecordExpr(node as RecordExpr);
        break;
      case 'TemplateString':
        type = this.inferTemplateString(node as TemplateString);
        break;
      default:
        // ErrorNode or unknown
        type = ERROR_TYPE;
        break;
    }

    this.setResolvedType(node, type);
    return type;
  }

  /** Resolve an identifier against the scope chain. Reports E201 if not found. */
  private inferIdentifier(node: Identifier): Type {
    const binding = this.scope.resolve(node.name);
    if (binding) {
      this.scope.markReferenced(node.name);
      return binding.type;
    }
    this.diagnostics.report({
      severity: 'error',
      code: D.E201,
      message: `Cannot find name '${node.name}'`,
      span: node.span,
    });
    return ERROR_TYPE;
  }

  /**
   * Infer the type of a binary expression.
   *
   * Handles null coalescing (`??`), pipe (`|>`), arithmetic (`+`, `-`, `*`, `/`, `%`),
   * comparison (`==`, `!=`, `<`, `>`, `<=`, `>=`), and logical (`&&`, `||`) operators.
   * Reports E216 for type mismatches.
   */
  private inferBinaryExpr(node: BinaryExpr): Type {
    const leftType = resolveType(this.inferExpression(node.left));
    const rightType = resolveType(this.inferExpression(node.right));

    // Error propagation
    if (leftType.kind === 'error' || rightType.kind === 'error') return ERROR_TYPE;

    const op = node.operator;

    // Null coalescing
    if (op === '??') {
      if (leftType.kind === 'nullable') {
        return leftType.inner;
      }
      return leftType;
    }

    // Pipe operator
    if (op === '|>') {
      // x |> f  is  f(x)
      if (rightType.kind === 'function' && rightType.params.length >= 1) {
        return rightType.returnType;
      }
      this.diagnostics.report({
        severity: 'error',
        code: D.E208,
        message: `Right-hand side of '|>' must be a function`,
        span: node.right.span,
      });
      return ERROR_TYPE;
    }

    // Arithmetic operators
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
      if (op === '+') {
        // + accepts number+number or string+string
        if (leftType.kind === 'primitive' && leftType.name === 'number' &&
            rightType.kind === 'primitive' && rightType.name === 'number') {
          return NUM;
        }
        if (leftType.kind === 'primitive' && leftType.name === 'string' &&
            rightType.kind === 'primitive' && rightType.name === 'string') {
          return STR;
        }
        this.diagnostics.report({
          severity: 'error',
          code: D.E216,
          message: `Operator '+' cannot be applied to types '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
          span: node.span,
        });
        return ERROR_TYPE;
      }
      // Other arithmetic: both must be number
      if (leftType.kind === 'primitive' && leftType.name === 'number' &&
          rightType.kind === 'primitive' && rightType.name === 'number') {
        return NUM;
      }
      this.diagnostics.report({
        severity: 'error',
        code: D.E216,
        message: `Operator '${op}' cannot be applied to types '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
        span: node.span,
      });
      return ERROR_TYPE;
    }

    // Comparison operators
    if (op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      return BOOL;
    }

    // Logical operators
    if (op === '&&' || op === '||') {
      // Allow Any operands for JS interop patterns (e.g. `x || defaultValue`)
      if (leftType.kind === 'any' || rightType.kind === 'any') {
        return leftType.kind === 'any' ? rightType : leftType;
      }
      if (leftType.kind === 'primitive' && leftType.name === 'boolean' &&
          rightType.kind === 'primitive' && rightType.name === 'boolean') {
        return BOOL;
      }
      this.diagnostics.report({
        severity: 'error',
        code: D.E216,
        message: `Operator '${op}' requires boolean operands, got '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
        span: node.span,
      });
      return ERROR_TYPE;
    }

    return ERROR_TYPE;
  }

  /** Infer the type of a unary expression (`-` for numbers, `!` for booleans). */
  private inferUnaryExpr(node: UnaryExpr): Type {
    const operandType = resolveType(this.inferExpression(node.operand));
    if (operandType.kind === 'error') return ERROR_TYPE;

    if (node.operator === '-') {
      if (operandType.kind === 'primitive' && operandType.name === 'number') {
        return NUM;
      }
      this.diagnostics.report({
        severity: 'error',
        code: D.E216,
        message: `Operator '-' cannot be applied to type '${typeToString(operandType)}'`,
        span: node.span,
      });
      return ERROR_TYPE;
    }

    if (node.operator === '!') {
      if (operandType.kind === 'primitive' && operandType.name === 'boolean') {
        return BOOL;
      }
      this.diagnostics.report({
        severity: 'error',
        code: D.E216,
        message: `Operator '!' cannot be applied to type '${typeToString(operandType)}'`,
        span: node.span,
      });
      return ERROR_TYPE;
    }

    return ERROR_TYPE;
  }

  /** Infer the type of a function call expression. Delegates to {@link inferCallLike}. */
  private inferCallExpr(node: CallExpr): Type {
    return this.inferCallLike(node);
  }

  /** Infer the type of a `new` expression. Delegates to {@link inferCallLike}. */
  private inferNewExpr(node: NewExpr): Type {
    return this.inferCallLike(node);
  }

  /**
   * Shared implementation for call and new expressions.
   *
   * Resolves the callee type, instantiates generics if needed, checks argument
   * count and types, and returns the function's return type. Reports E208 for
   * non-callable types and E207 for argument count mismatches.
   */
  private inferCallLike(node: { callee: Expression; typeArgs?: readonly import('../parser/ast.js').TypeNode[]; args: readonly Expression[]; span: Span }): Type {
    const calleeType = resolveType(this.inferExpression(node.callee));
    if (calleeType.kind === 'error') return ERROR_TYPE;

    if (calleeType.kind !== 'function') {
      const diagnostic: Record<string, unknown> = {
        severity: 'error',
        code: D.E208,
        message: `Type '${typeToString(calleeType)}' is not callable`,
        span: node.callee.span,
      };
      // Add related location if callee is an identifier we can look up
      if (node.callee.kind === 'Identifier') {
        const binding = this.scope.resolve((node.callee as Identifier).name);
        if (binding) {
          diagnostic['relatedSpans'] = [{
            span: binding.declared,
            message: `'${(node.callee as Identifier).name}' declared here`,
          }];
        }
      }
      this.diagnostics.report(diagnostic as unknown as import('../diagnostics/diagnostic.js').Diagnostic);
      return ERROR_TYPE;
    }

    const fn = calleeType;

    // Instantiate generic function if needed
    const instantiated = this.instantiateCall(fn, node);

    // Check argument count
    const requiredParams = instantiated.params.filter(p => !p.optional && !p.hasDefault).length;
    if (node.args.length < requiredParams || node.args.length > instantiated.params.length) {
      const diagnostic: Record<string, unknown> = {
        severity: 'error',
        code: D.E207,
        message: `Expected ${requiredParams}${requiredParams !== instantiated.params.length ? '-' + instantiated.params.length : ''} arguments, but got ${node.args.length}`,
        span: node.span,
      };
      if (node.callee.kind === 'Identifier') {
        const binding = this.scope.resolve((node.callee as Identifier).name);
        if (binding) {
          diagnostic['relatedSpans'] = [{
            span: binding.declared,
            message: `'${(node.callee as Identifier).name}' declared here`,
          }];
        }
      }
      this.diagnostics.report(diagnostic as unknown as import('../diagnostics/diagnostic.js').Diagnostic);
      return ERROR_TYPE;
    }

    // Check argument types
    for (let i = 0; i < node.args.length; i++) {
      const argType = resolveType(this.inferExpression(node.args[i]));
      if (argType.kind !== 'error' && i < instantiated.params.length) {
        const paramType = resolveType(instantiated.params[i].type);
        if (!isAssignableTo(argType, paramType)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Argument of type '${typeToString(argType)}' is not assignable to parameter of type '${typeToString(paramType)}'`,
            span: node.args[i].span,
          });
        }
      }
    }

    return resolveType(instantiated.returnType);
  }

  /**
   * Infer the type of a member access expression (`obj.field` or `obj?.field`).
   *
   * Handles optional chaining on nullable types (returns nullable result),
   * reports E215 for non-optional access on nullable types, and delegates
   * to {@link lookupField} for the actual field resolution.
   */
  private inferMemberExpr(node: MemberExpr): Type {
    const objType = resolveType(this.inferExpression(node.object));
    if (objType.kind === 'error') return ERROR_TYPE;

    const fieldName = node.property.name;

    // Optional chaining on nullable
    if (node.optional && objType.kind === 'nullable') {
      const innerType = objType.inner;
      const fieldType = this.lookupField(innerType, fieldName, node.property.span);
      if (fieldType.kind === 'error') return ERROR_TYPE;
      return makeNullable(fieldType);
    }

    // Non-optional access on nullable → error
    if (objType.kind === 'nullable' && !node.optional) {
      const diagnostic: Record<string, unknown> = {
        severity: 'error',
        code: D.E215,
        message: `Cannot access property '${fieldName}' on nullable type '${typeToString(objType)}'. Use '?.' for optional access`,
        span: node.property.span,
      };
      if (node.object.kind === 'Identifier') {
        const binding = this.scope.resolve((node.object as Identifier).name);
        if (binding) {
          diagnostic['relatedSpans'] = [{
            span: binding.declared,
            message: `'${(node.object as Identifier).name}' declared as nullable here`,
          }];
        }
      }
      this.diagnostics.report(diagnostic as unknown as import('../diagnostics/diagnostic.js').Diagnostic);
      return ERROR_TYPE;
    }

    return this.lookupField(objType, fieldName, node.property.span);
  }

  /**
   * Look up a field or method on a type.
   *
   * Supports record fields, array properties/methods (length, push, pop, map, etc.),
   * and built-in string/number/boolean methods. Reports E209 if the field does not exist.
   *
   * @param objType   - The resolved type of the object being accessed.
   * @param fieldName - The field or method name.
   * @param span      - Source span for error reporting.
   * @returns The type of the field, or ERROR_TYPE if not found.
   */
  private lookupField(objType: Type, fieldName: string, span: Span): Type {
    const resolved = resolveType(objType);

    if (resolved.kind === 'record') {
      const fieldType = resolved.fields.get(fieldName);
      if (fieldType) return fieldType;
      this.diagnostics.report({
        severity: 'error',
        code: D.E209,
        message: `Property '${fieldName}' does not exist on type '${typeToString(resolved)}'`,
        span,
      });
      return ERROR_TYPE;
    }

    if (resolved.kind === 'array') {
      const elemType = resolved.element;
      if (fieldName === 'length') return NUM;

      switch (fieldName) {
        case 'push':
        case 'unshift':
          return {
            kind: 'function',
            params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
            returnType: VOID,
          } as FunctionType;
        case 'pop':
        case 'shift':
          return {
            kind: 'function',
            params: [],
            returnType: makeNullable(elemType),
          } as FunctionType;
        case 'map': {
          // Generic: <U>(fn: (T) => U) => Array<U>
          // The type parameter U is inferred from the callback's return type.
          const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
          const callbackType: FunctionType = {
            kind: 'function',
            params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
            returnType: uParam,
          };
          const mappedArray: import('./types.js').ArrayType = { kind: 'array', element: uParam };
          return {
            kind: 'function',
            typeParams: [{ name: 'U' }],
            params: [{ name: 'fn', type: callbackType, optional: false, hasDefault: false }],
            returnType: mappedArray,
          } as FunctionType;
        }
        case 'filter':
          return {
            kind: 'function',
            params: [{ name: 'fn', type: {
              kind: 'function',
              params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
              returnType: BOOL,
            } as FunctionType, optional: false, hasDefault: false }],
            returnType: resolved,
          } as FunctionType;
        case 'forEach':
          return {
            kind: 'function',
            params: [{ name: 'fn', type: {
              kind: 'function',
              params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
              returnType: VOID,
            } as FunctionType, optional: false, hasDefault: false }],
            returnType: VOID,
          } as FunctionType;
        case 'includes':
          return {
            kind: 'function',
            params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
            returnType: BOOL,
          } as FunctionType;
        case 'at':
          return {
            kind: 'function',
            params: [{ name: 'index', type: NUM, optional: false, hasDefault: false }],
            returnType: makeNullable(elemType),
          } as FunctionType;
      }
    }

    // Built-in string methods and properties
    if (resolved.kind === 'primitive' && resolved.name === 'string') {
      const strMethod = this.lookupStringField(fieldName);
      if (strMethod) return strMethod;
      this.diagnostics.report({
        severity: 'error',
        code: D.E209,
        message: `Property '${fieldName}' does not exist on type 'string'`,
        span,
      });
      return ERROR_TYPE;
    }

    // Built-in number methods
    if (resolved.kind === 'primitive' && resolved.name === 'number') {
      const numMethod = this.lookupNumberField(fieldName);
      if (numMethod) return numMethod;
      this.diagnostics.report({
        severity: 'error',
        code: D.E209,
        message: `Property '${fieldName}' does not exist on type 'number'`,
        span,
      });
      return ERROR_TYPE;
    }

    // Built-in boolean methods
    if (resolved.kind === 'primitive' && resolved.name === 'boolean') {
      const boolMethod = this.lookupBooleanField(fieldName);
      if (boolMethod) return boolMethod;
      this.diagnostics.report({
        severity: 'error',
        code: D.E209,
        message: `Property '${fieldName}' does not exist on type 'boolean'`,
        span,
      });
      return ERROR_TYPE;
    }

    if (resolved.kind === 'any' || resolved.kind === 'error') return ANY;

    this.diagnostics.report({
      severity: 'error',
      code: D.E209,
      message: `Property '${fieldName}' does not exist on type '${typeToString(resolved)}'`,
      span,
    });
    return ERROR_TYPE;
  }

  /** Returns the type for a built-in string property or method, or undefined if unknown. */
  private lookupStringField(fieldName: string): Type | undefined {
    if (fieldName === 'length') return NUM;

    switch (fieldName) {
      // No-arg methods returning string
      case 'trim':
      case 'trimStart':
      case 'trimEnd':
      case 'toUpperCase':
      case 'toLowerCase':
        return { kind: 'function', params: [], returnType: STR } as FunctionType;

      // (string) => boolean
      case 'includes':
      case 'startsWith':
      case 'endsWith':
        return {
          kind: 'function',
          params: [{ name: 'search', type: STR, optional: false, hasDefault: false }],
          returnType: BOOL,
        } as FunctionType;

      // (string) => number
      case 'indexOf':
      case 'lastIndexOf':
        return {
          kind: 'function',
          params: [{ name: 'search', type: STR, optional: false, hasDefault: false }],
          returnType: NUM,
        } as FunctionType;

      // (number, number?) => string
      case 'slice':
      case 'substring':
        return {
          kind: 'function',
          params: [
            { name: 'start', type: NUM, optional: false, hasDefault: false },
            { name: 'end', type: NUM, optional: true, hasDefault: false },
          ],
          returnType: STR,
        } as FunctionType;

      // (number) => string
      case 'charAt':
        return {
          kind: 'function',
          params: [{ name: 'index', type: NUM, optional: false, hasDefault: false }],
          returnType: STR,
        } as FunctionType;

      // (string) => Array<string>
      case 'split':
        return {
          kind: 'function',
          params: [{ name: 'separator', type: STR, optional: false, hasDefault: false }],
          returnType: { kind: 'array', element: STR } as ArrayType,
        } as FunctionType;

      // (string, string) => string
      case 'replace':
        return {
          kind: 'function',
          params: [
            { name: 'search', type: STR, optional: false, hasDefault: false },
            { name: 'replacement', type: STR, optional: false, hasDefault: false },
          ],
          returnType: STR,
        } as FunctionType;

      // (number) => string
      case 'repeat':
        return {
          kind: 'function',
          params: [{ name: 'count', type: NUM, optional: false, hasDefault: false }],
          returnType: STR,
        } as FunctionType;

      // (number, string?) => string
      case 'padStart':
      case 'padEnd':
        return {
          kind: 'function',
          params: [
            { name: 'targetLength', type: NUM, optional: false, hasDefault: false },
            { name: 'fillString', type: STR, optional: true, hasDefault: false },
          ],
          returnType: STR,
        } as FunctionType;

      // (string) => string
      case 'concat':
        return {
          kind: 'function',
          params: [{ name: 'str', type: STR, optional: false, hasDefault: false }],
          returnType: STR,
        } as FunctionType;
    }

    return undefined;
  }

  /** Returns the type for a built-in number method, or undefined if unknown. */
  private lookupNumberField(fieldName: string): Type | undefined {
    switch (fieldName) {
      case 'toString':
        return { kind: 'function', params: [], returnType: STR } as FunctionType;
      case 'toFixed':
        return {
          kind: 'function',
          params: [{ name: 'digits', type: NUM, optional: true, hasDefault: false }],
          returnType: STR,
        } as FunctionType;
      case 'valueOf':
        return { kind: 'function', params: [], returnType: NUM } as FunctionType;
    }
    return undefined;
  }

  /** Returns the type for a built-in boolean method, or undefined if unknown. */
  private lookupBooleanField(fieldName: string): Type | undefined {
    switch (fieldName) {
      case 'toString':
        return { kind: 'function', params: [], returnType: STR } as FunctionType;
      case 'valueOf':
        return { kind: 'function', params: [], returnType: BOOL } as FunctionType;
    }
    return undefined;
  }

  /**
   * Infer the type of an `if`/`else` expression.
   *
   * Applies null narrowing in each branch via {@link applyNarrowing}. If both
   * branches are present, returns their common type or a union. If no `else`,
   * returns `void`.
   */
  private inferIfExpr(node: IfExpr): Type {
    const condType = resolveType(this.inferExpression(node.condition));
    if (condType.kind !== 'error' && condType.kind !== 'any') {
      if (!(condType.kind === 'primitive' && condType.name === 'boolean')) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(condType)}' is not assignable to type 'boolean'`,
          span: node.condition.span,
        });
      }
    }

    // Apply null narrowing in branches
    this.scope.pushScope();
    this.applyNarrowing(node.condition, 'then');
    const consequentType = this.inferExpression(node.consequent);
    this.scope.popScope();

    if (node.alternate) {
      this.scope.pushScope();
      this.applyNarrowing(node.condition, 'else');
      const alternateType = this.inferExpression(node.alternate);
      this.scope.popScope();

      // Find common type or union
      if (typesEqual(consequentType, alternateType)) return consequentType;
      return simplifyUnion([consequentType, alternateType]);
    }

    return VOID;
  }

  /**
   * Infer the type of a `match` expression.
   *
   * Checks each arm's pattern against the subject type, validates guards,
   * performs exhaustiveness checking, and returns the union of arm body types.
   * Sets `isExhaustive` on the AST node for use by the emitter.
   */
  private inferMatchExpr(node: MatchExpr): Type {
    const subjectType = resolveType(this.inferExpression(node.subject));
    const armTypes: Type[] = [];

    for (const matchArm of node.arms) {
      this.scope.pushScope();

      // Check pattern and introduce bindings
      this.checkPattern(matchArm.pattern, subjectType);

      // Check guard
      if (matchArm.guard) {
        const guardType = resolveType(this.inferExpression(matchArm.guard));
        if (guardType.kind !== 'error' && !(guardType.kind === 'primitive' && guardType.name === 'boolean')) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Type '${typeToString(guardType)}' is not assignable to type 'boolean'`,
            span: matchArm.guard.span,
          });
        }
      }

      const bodyType = this.inferExpression(matchArm.body);
      armTypes.push(bodyType);
      this.scope.popScope();
    }

    // Exhaustiveness check
    const exhaustivenessArms = node.arms.map(a => {
      const arm: Record<string, unknown> = { pattern: a.pattern };
      if (a.guard !== undefined) arm['guard'] = a.guard;
      return arm as unknown as { pattern: Pattern; guard?: Expression };
    });
    const result = checkExhaustiveness(subjectType, exhaustivenessArms, node.span);
    if (!result.exhaustive) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E203,
        message: `Non-exhaustive match expression. Missing patterns: ${result.missingPatterns.join(', ')}`,
        span: node.span,
        fix: {
          description: `Add missing match arms: ${result.missingPatterns.join(', ')}`,
          edits: [],
        },
      });
    }
    // Store exhaustiveness for the emitter (avoids redundant throw on exhaustive matches)
    (node as unknown as Record<string, unknown>)['isExhaustive'] = result.exhaustive;

    if (armTypes.length === 0) return VOID;
    if (armTypes.length === 1) return armTypes[0];

    // Find common type
    const allSame = armTypes.every(t => typesEqual(t, armTypes[0]));
    if (allSame) return armTypes[0];

    return simplifyUnion(armTypes);
  }

  /**
   * Infer the type of a block expression.
   *
   * Opens a new scope, processes each item, and returns the type of the last
   * expression (or `void` if the block is empty or ends with a statement).
   */
  private inferBlockExpr(node: BlockExpr): Type {
    if (node.body.length === 0) return VOID;

    this.scope.pushScope();
    let lastType: Type = VOID;

    for (let i = 0; i < node.body.length; i++) {
      const item = node.body[i];
      if (item.kind === 'LetDeclaration') {
        this.checkLetDeclaration(item as LetDeclaration);
        lastType = VOID;
      } else if (item.kind === 'ReturnStatement') {
        this.checkStatement(item);
        const ret = item as ReturnStatement;
        if (ret.value) {
          const resolved = (ret.value as unknown as Record<string, unknown>)['resolvedType'] as Type | undefined;
          lastType = resolved ?? VOID;
        } else {
          lastType = VOID;
        }
      } else if (isStatement(item)) {
        this.checkStatement(item);
        lastType = VOID;
      } else {
        // Expression — if last, it's the block's type
        lastType = this.inferExpression(item as Expression);
      }
    }

    this.scope.popScope();
    return lastType;
  }

  /**
   * Infer the type of an arrow function.
   *
   * Resolves parameter types (reports E205 if missing), opens a scope for the body,
   * infers the body type, and checks it against the return type annotation (if any).
   * Returns a {@link FunctionType} with optional generic type parameters.
   */
  private inferArrowFunction(node: ArrowFunction): Type {
    // Extract type parameters FIRST so they're available during param/return type resolution
    const generics = node.typeParams?.map(tp => ({
      kind: 'generic' as const,
      name: tp.name.name,
    })) ?? [];
    const typeParams = generics.length > 0
      ? generics.map(g => ({ name: g.name }))
      : undefined;

    const params: ParamType[] = [];

    // Check parameter types (using generics-aware resolution when type params present)
    for (const p of node.params) {
      if (p.type) {
        const pType = generics.length > 0
          ? this.resolveTypeNodeWithGenerics(p.type, generics)
          : this.resolveTypeNode(p.type);
        params.push({ name: p.name.name, type: pType, optional: false, hasDefault: p.defaultValue !== undefined });
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E205,
          message: `Parameter '${p.name.name}' requires a type annotation`,
          span: p.span,
        });
        params.push({ name: p.name.name, type: ANY, optional: false, hasDefault: p.defaultValue !== undefined });
      }
    }

    // Push scope for function body
    this.scope.pushScope();
    for (const p of params) {
      this.declareBinding(p.name, p.type, false, node.span);
    }

    // Infer body type
    const bodyType = this.inferExpression(node.body);

    // Check return type annotation (using generics-aware resolution when type params present)
    let returnType: Type;
    if (node.returnType) {
      returnType = generics.length > 0
        ? this.resolveTypeNodeWithGenerics(node.returnType, generics)
        : this.resolveTypeNode(node.returnType);
      if (bodyType.kind !== 'error' && !isAssignableTo(bodyType, returnType)) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(bodyType)}' is not assignable to return type '${typeToString(returnType)}'`,
          span: node.body.span,
        });
      }
    } else {
      returnType = bodyType;
    }

    this.scope.popScope();

    const fnType: FunctionType = {
      kind: 'function',
      params,
      returnType,
    };

    if (typeParams && typeParams.length > 0) {
      const result: Record<string, unknown> = { ...fnType };
      result['typeParams'] = typeParams;
      return result as unknown as FunctionType;
    }

    return fnType;
  }

  /**
   * Infer the type of a `try`/`catch` expression.
   *
   * The catch parameter is typed as `Any`. Returns the common type of the
   * try and catch bodies, or a union if they differ.
   */
  private inferTryCatchExpr(node: TryCatchExpr): Type {
    const tryType = this.inferBlockExpr(node.tryBody);

    this.scope.pushScope();
    // Catch parameter is Any
    this.declareBinding(node.catchParam.name, ANY, false, node.catchParam.span);
    const catchType = this.inferBlockExpr(node.catchBody);
    this.scope.popScope();

    if (typesEqual(tryType, catchType)) return tryType;
    return simplifyUnion([tryType, catchType]);
  }

  /** Infer the type of an array literal. Empty arrays get a fresh type variable element. */
  private inferArrayExpr(node: ArrayExpr): Type {
    if (node.elements.length === 0) {
      return { kind: 'array', element: freshTypeVar() } as ArrayType;
    }

    const elementTypes = node.elements.map(e => this.inferExpression(e));

    const allSame = elementTypes.every(t => typesEqual(t, elementTypes[0]));
    if (allSame) {
      return { kind: 'array', element: elementTypes[0] } as ArrayType;
    }

    return { kind: 'array', element: simplifyUnion(elementTypes) } as ArrayType;
  }

  /** Infer the type of a record literal by inferring each field value's type. */
  private inferRecordExpr(node: RecordExpr): Type {
    const fields = new Map<string, Type>();
    for (const field of node.fields) {
      const fieldType = this.inferExpression(field.value);
      fields.set(field.name.name, fieldType);
    }
    return { kind: 'record', fields } as RecordType;
  }

  /** Infer the type of a template string (always `string`). Checks interpolated expressions. */
  private inferTemplateString(node: TemplateString): Type {
    // Infer all expression parts (for side effects / error checking)
    for (const part of node.parts) {
      if (part.kind === 'TemplateExprPart') {
        this.inferExpression(part.expression);
      }
    }
    return STR;
  }

  // ── Statement checking ──────────────────────────────────

  /** Dispatch a statement to its appropriate handler (for, while, assignment, throw, return). */
  private checkStatement(stmt: Statement): void {
    switch (stmt.kind) {
      case 'ForStatement':
        this.checkForStatement(stmt as ForStatement);
        break;
      case 'WhileStatement':
        this.checkWhileStatement(stmt as WhileStatement);
        break;
      case 'AssignmentStatement':
        this.checkAssignmentStatement(stmt as AssignmentStatement);
        break;
      case 'ThrowStatement':
        this.checkThrowStatement(stmt as ThrowStatement);
        break;
      case 'ReturnStatement':
        this.checkReturnStatement(stmt as ReturnStatement);
        break;
      case 'ExpressionStatement':
        this.inferExpression((stmt as ExpressionStatement).expression);
        break;
      default:
        break;
    }
  }

  /**
   * Check a `for (x in iterable)` statement.
   *
   * Validates that the iterable is an array type and binds the loop variable
   * to the element type. Reports E217 for non-iterable types.
   */
  private checkForStatement(node: ForStatement): void {
    const iterableType = resolveType(this.inferExpression(node.iterable));

    if (iterableType.kind === 'error') {
      // Don't cascade — just use Any for the loop variable
      this.scope.pushScope();
      this.declareBinding(node.variable.name, ANY, false, node.variable.span);
      this.inferBlockExpr(node.body);
      this.scope.popScope();
      return;
    }

    if (iterableType.kind !== 'array') {
      this.diagnostics.report({
        severity: 'error',
        code: D.E217,
        message: `Type '${typeToString(iterableType)}' is not iterable. Expected Array type`,
        span: node.iterable.span,
      });
      this.scope.pushScope();
      this.declareBinding(node.variable.name, ERROR_TYPE, false, node.variable.span);
      this.inferBlockExpr(node.body);
      this.scope.popScope();
      return;
    }

    this.scope.pushScope();
    this.declareBinding(node.variable.name, iterableType.element, false, node.variable.span);
    this.inferBlockExpr(node.body);
    this.scope.popScope();
  }

  /** Check a `while` statement: validates the condition is boolean, then checks the body. */
  private checkWhileStatement(node: WhileStatement): void {
    const condType = resolveType(this.inferExpression(node.condition));
    if (condType.kind !== 'error' && condType.kind !== 'any') {
      if (!(condType.kind === 'primitive' && condType.name === 'boolean')) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(condType)}' is not assignable to type 'boolean'`,
          span: node.condition.span,
        });
      }
    }
    this.inferBlockExpr(node.body);
  }

  /**
   * Check an assignment statement: verify mutability, validate the value type
   * against the binding's declared type, and report E202/E201 as needed.
   */
  private checkAssignmentStatement(node: AssignmentStatement): void {
    const valueType = resolveType(this.inferExpression(node.value));

    if (node.target.kind === 'Identifier') {
      const name = (node.target as Identifier).name;
      if (!this.scope.assertMutable(name, node.span, this.diagnostics)) {
        // assertMutable already reported the error, or binding doesn't exist
        if (this.scope.resolve(name) === undefined) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E201,
            message: `Cannot find name '${name}'`,
            span: node.target.span,
          });
        }
        return;
      }

      const binding = this.scope.resolve(name);
      if (binding && valueType.kind !== 'error') {
        if (!isAssignableTo(valueType, binding.type)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Type '${typeToString(valueType)}' is not assignable to type '${typeToString(binding.type)}'`,
            span: node.value.span,
          });
        }
      }
    } else {
      // Member expression or indexed assignment
      this.inferExpression(node.target);
    }
  }

  /** Check a `throw` statement by inferring the thrown value's type. */
  private checkThrowStatement(node: ThrowStatement): void {
    this.inferExpression(node.value);
  }

  /** Check a `return` statement by inferring the returned value's type (if present). */
  private checkReturnStatement(node: ReturnStatement): void {
    if (node.value) {
      this.inferExpression(node.value);
    }
  }

  // ── Pattern checking ────────────────────────────────────

  /**
   * Check a match pattern against an expected type and introduce bindings.
   *
   * Binding patterns in a nullable context narrow to the non-null inner type.
   * Variant patterns delegate to {@link checkVariantPattern} for ADT field matching.
   *
   * @param pattern      - The pattern to check.
   * @param expectedType - The type of the match subject (or narrowed sub-type).
   */
  private checkPattern(pattern: Pattern, expectedType: Type): void {
    const resolved = resolveType(expectedType);

    switch (pattern.kind) {
      case 'WildcardPattern':
        break;

      case 'BindingPattern': {
        const bp = pattern as BindingPattern;
        // In a nullable context, narrow to the non-null type
        const bindType = resolved.kind === 'nullable' ? resolved.inner : resolved;
        this.declareBinding(bp.name.name, bindType, false, bp.span);
        break;
      }

      case 'NullPattern':
        // Valid if the subject is nullable
        break;

      case 'LiteralPattern':
        // No bindings introduced
        break;

      case 'VariantPattern': {
        const vp = pattern as VariantPattern;
        this.checkVariantPattern(vp, resolved);
        break;
      }

      case 'RecordPattern': {
        const rp = pattern as RecordPattern;
        if (resolved.kind === 'record') {
          for (const field of rp.fields) {
            const fieldType = resolved.fields.get(field.name.name);
            if (fieldType) {
              if (field.pattern) {
                this.checkPattern(field.pattern, fieldType);
              } else {
                // Shorthand: { name } binds name to the field value
                this.declareBinding(field.name.name, fieldType, false, field.name.span);
              }
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Check a variant pattern against an ADT subject type.
   *
   * Finds the matching variant in the ADT and binds sub-pattern fields by position.
   * Handles nullable ADT subjects by unwrapping to the inner ADT.
   */
  private checkVariantPattern(pattern: VariantPattern, subjectType: Type): void {
    const resolved = resolveType(subjectType);

    // Find the ADT that contains this variant
    let adtType: ADTType | undefined;
    if (resolved.kind === 'adt') {
      adtType = resolved;
    } else if (resolved.kind === 'nullable' && resolved.inner.kind === 'adt') {
      adtType = resolved.inner;
    }

    if (!adtType) {
      // Check scope for ADT constructors
      const binding = this.scope.resolve(pattern.name.name);
      if (binding) {
        // If it's a function (constructor), we can use it
        return;
      }
      return;
    }

    const variant = adtType.variants.find(v => v.name === pattern.name.name);
    if (!variant) return;

    // Bind variant fields by position.
    // NOTE: VariantPattern.fields is a positional Pattern[] (no field names),
    // so binding is inherently positional. Variant field order must be stable.
    if (pattern.fields && pattern.fields.length > 0) {
      const fieldEntries = Array.from(variant.fields.entries());
      for (let i = 0; i < pattern.fields.length && i < fieldEntries.length; i++) {
        const [_fieldName, fieldType] = fieldEntries[i];
        this.checkPattern(pattern.fields[i], fieldType);
      }
    }
  }

  // ── Type resolution ─────────────────────────────────────

  /** Resolve a type annotation AST node to an internal {@link Type}. */
  private resolveTypeNode(node: TypeNode): Type {
    return this.resolveTypeNodeWithGenerics(node, []);
  }

  /**
   * Resolve a type annotation AST node to an internal {@link Type}, with
   * generic type parameters in scope.
   *
   * Handles named types (primitives, `Array`, scope lookups), nullable types,
   * function types, record types, union types, and tuple types. Reports E212
   * for unknown type names.
   *
   * @param node     - The type annotation node.
   * @param generics - Generic type parameters currently in scope.
   * @returns The resolved internal type.
   */
  private resolveTypeNodeWithGenerics(node: TypeNode, generics: readonly { kind: 'generic'; name: string }[]): Type {
    switch (node.kind) {
      case 'NamedType': {
        const nt = node as NamedType;
        const name = nt.name.name;

        // Check generics first
        for (const g of generics) {
          if (g.name === name) return g;
        }

        // Primitive types
        switch (name) {
          case 'number': return NUM;
          case 'string': return STR;
          case 'boolean': return BOOL;
          case 'void': return VOID;
          case 'never': return NEVER;
          case 'Any': return ANY;
          case 'Array': {
            const elemType = nt.typeArgs && nt.typeArgs.length > 0
              ? this.resolveTypeNodeWithGenerics(nt.typeArgs[0], generics)
              : ANY;
            return { kind: 'array', element: elemType } as import('./types.js').ArrayType;
          }
          default: break;
        }

        // Look up in scope
        const scopeType = this.scope.resolveType(name);
        if (scopeType) {
          if (scopeType.kind === 'adt' && nt.typeArgs && nt.typeArgs.length > 0) {
            // Instantiate generic ADT
            const args = nt.typeArgs.map(a => this.resolveTypeNodeWithGenerics(a, generics));
            return { ...scopeType, typeArgs: args };
          }
          return scopeType;
        }

        this.diagnostics.report({
          severity: 'error',
          code: D.E212,
          message: `Cannot find type '${name}'`,
          span: nt.name.span,
        });
        return ERROR_TYPE;
      }

      case 'NullableType': {
        const inner = this.resolveTypeNodeWithGenerics((node as NullableTypeNode).inner, generics);
        return makeNullable(inner);
      }

      case 'FunctionType': {
        const ft = node as FunctionTypeNode;
        const params: ParamType[] = ft.params.map((p, i) => ({
          name: `p${i}`,
          type: this.resolveTypeNodeWithGenerics(p, generics),
          optional: false,
          hasDefault: false,
        }));
        const returnType = this.resolveTypeNodeWithGenerics(ft.returnType, generics);
        return { kind: 'function', params, returnType } as FunctionType;
      }

      case 'RecordType': {
        const rt = node as RecordTypeNode;
        const fields = new Map<string, Type>();
        for (const f of rt.fields) {
          fields.set(f.name.name, this.resolveTypeNodeWithGenerics(f.type, generics));
        }
        return { kind: 'record', fields } as RecordType;
      }

      case 'UnionType': {
        const ut = node as UnionTypeNode;
        const members = ut.members.map(m => this.resolveTypeNodeWithGenerics(m, generics));
        return simplifyUnion(members);
      }

      case 'TupleType': {
        const tt = node as TupleTypeNode;
        const elements = tt.elements.map(e => this.resolveTypeNodeWithGenerics(e, generics));
        return { kind: 'tuple', elements };
      }

      default:
        return ERROR_TYPE;
    }
  }

  // ── Generic instantiation ───────────────────────────────

  /**
   * Instantiate a generic function call by resolving type parameters.
   *
   * If explicit type arguments are provided, uses those directly. Otherwise,
   * infers type parameters from argument types via {@link unifyForInference}.
   * Any unresolved parameters are filled with fresh type variables.
   *
   * @param fn   - The generic function type to instantiate.
   * @param node - The call site (provides type arguments and argument expressions).
   * @returns A monomorphized {@link FunctionType} with all type parameters substituted.
   */
  private instantiateCall(fn: FunctionType, node: { typeArgs?: readonly import('../parser/ast.js').TypeNode[]; args: readonly Expression[] }): FunctionType {
    if (!fn.typeParams || fn.typeParams.length === 0) return fn;

    // Create a mapping from type param names to their resolved types
    const typeMap = new Map<string, Type>();

    if (node.typeArgs && node.typeArgs.length > 0) {
      // Explicit type arguments
      for (let i = 0; i < fn.typeParams.length && i < node.typeArgs.length; i++) {
        typeMap.set(fn.typeParams[i].name, this.resolveTypeNode(node.typeArgs[i]));
      }
    } else {
      // Infer from arguments
      for (let i = 0; i < fn.params.length && i < node.args.length; i++) {
        const argType = this.inferExpression(node.args[i]);
        this.unifyForInference(fn.params[i].type, argType, typeMap);
      }
    }

    // Fill unresolved params with fresh type variables
    for (const tp of fn.typeParams) {
      if (!typeMap.has(tp.name)) {
        typeMap.set(tp.name, freshTypeVar());
      }
    }

    return this.substituteTypeParams(fn, typeMap);
  }

  /**
   * Occurs check: test whether a generic type parameter name appears anywhere in a type.
   *
   * Used during type inference to prevent infinite types (e.g. `T = Array<T>`).
   *
   * @param name - The generic parameter name to search for.
   * @param type - The type to search within.
   * @returns `true` if the name occurs in the type.
   */
  private occursIn(name: string, type: Type): boolean {
    const t = resolveType(type);
    switch (t.kind) {
      case 'generic': return t.name === name;
      case 'function': {
        const fn = t as FunctionType;
        return fn.params.some(p => this.occursIn(name, p.type)) || this.occursIn(name, fn.returnType);
      }
      case 'array': return this.occursIn(name, t.element);
      case 'nullable': return this.occursIn(name, t.inner);
      case 'adt': return t.typeArgs.some(a => this.occursIn(name, a));
      case 'tuple': return t.elements.some(e => this.occursIn(name, e));
      case 'union': return t.members.some(m => this.occursIn(name, m));
      case 'record': return [...t.fields.values()].some(v => this.occursIn(name, v));
      case 'promise': return this.occursIn(name, t.inner);
      default: return false;
    }
  }

  /**
   * Unify a parameter type with an argument type to infer generic type parameters.
   *
   * When the parameter type is a generic, maps it to the argument type (with an
   * occurs check). For structural types (functions, arrays, ADTs, etc.), recurses
   * into sub-components to gather more mappings.
   *
   * @param paramType - The formal parameter type (may contain generic references).
   * @param argType   - The actual argument type.
   * @param typeMap   - Accumulator for inferred `name → type` mappings.
   */
  private unifyForInference(paramType: Type, argType: Type, typeMap: Map<string, Type>): void {
    const p = resolveType(paramType);
    const a = resolveType(argType);

    if (p.kind === 'generic') {
      if (!typeMap.has(p.name)) {
        if (this.occursIn(p.name, a)) return; // infinite type guard
        typeMap.set(p.name, a);
      }
      return;
    }

    // Recurse into structural types
    if (p.kind === 'function' && a.kind === 'function') {
      for (let i = 0; i < p.params.length && i < a.params.length; i++) {
        this.unifyForInference(p.params[i].type, a.params[i].type, typeMap);
      }
      this.unifyForInference(p.returnType, a.returnType, typeMap);
    }

    if (p.kind === 'array' && a.kind === 'array') {
      this.unifyForInference(p.element, a.element, typeMap);
    }

    if (p.kind === 'nullable' && a.kind === 'nullable') {
      this.unifyForInference(p.inner, a.inner, typeMap);
    }

    if (p.kind === 'adt' && a.kind === 'adt' && p.name === a.name) {
      for (let i = 0; i < p.typeArgs.length && i < a.typeArgs.length; i++) {
        this.unifyForInference(p.typeArgs[i], a.typeArgs[i], typeMap);
      }
    }
  }

  /**
   * Substitute generic type parameters in a function type using the given mapping.
   *
   * @param fn      - The generic function type.
   * @param typeMap - Mapping from type parameter names to concrete types.
   * @returns A new function type with all generic references replaced.
   */
  private substituteTypeParams(fn: FunctionType, typeMap: Map<string, Type>): FunctionType {
    const params = fn.params.map(p => ({
      ...p,
      type: this.substitute(p.type, typeMap),
    }));
    const returnType = this.substitute(fn.returnType, typeMap);
    return { kind: 'function', params, returnType };
  }

  /**
   * Recursively substitute generic type parameter references in a type.
   *
   * Returns the mapped type for generics, or recurses into composite types
   * (functions, arrays, ADTs, tuples, unions, records, promises, nullables).
   *
   * @param type    - The type to substitute within.
   * @param typeMap - Mapping from type parameter names to concrete types.
   * @returns The substituted type.
   */
  private substitute(type: Type, typeMap: Map<string, Type>): Type {
    const resolved = resolveType(type);

    switch (resolved.kind) {
      case 'generic': {
        const mapped = typeMap.get(resolved.name);
        return mapped ?? resolved;
      }
      case 'function': {
        const fn = resolved as FunctionType;
        return {
          kind: 'function',
          params: fn.params.map(p => ({ ...p, type: this.substitute(p.type, typeMap) })),
          returnType: this.substitute(fn.returnType, typeMap),
        } as FunctionType;
      }
      case 'array':
        return { kind: 'array', element: this.substitute(resolved.element, typeMap) } as ArrayType;
      case 'nullable':
        return makeNullable(this.substitute(resolved.inner, typeMap));
      case 'adt': {
        const adt = resolved;
        return {
          kind: 'adt',
          name: adt.name,
          typeArgs: adt.typeArgs.map(a => this.substitute(a, typeMap)),
          variants: adt.variants,
        } as ADTType;
      }
      case 'tuple':
        return { kind: 'tuple', elements: resolved.elements.map(e => this.substitute(e, typeMap)) };
      case 'union':
        return simplifyUnion(resolved.members.map(m => this.substitute(m, typeMap)));
      case 'record': {
        const fields = new Map<string, Type>();
        for (const [k, v] of resolved.fields) {
          fields.set(k, this.substitute(v, typeMap));
        }
        return { kind: 'record', fields } as RecordType;
      }
      case 'promise':
        return { kind: 'promise', inner: this.substitute(resolved.inner, typeMap) };
      default:
        return resolved;
    }
  }

  // ── Null narrowing ──────────────────────────────────────

  /**
   * Apply null narrowing based on a condition expression.
   *
   * Supports:
   * - `x != null` / `null != x` — narrows `x` from `T?` to `T` in the `then` branch.
   * - `x == null` / `null == x` — narrows in the `else` branch.
   * - `&&` — both sides narrowed in `then`.
   * - `||` — both sides narrowed in `else`.
   * - `!condition` — flips the branch for recursive narrowing.
   *
   * @param condition - The boolean condition expression.
   * @param branch    - Which branch we're narrowing for (`'then'` or `'else'`).
   */
  private applyNarrowing(condition: Expression, branch: 'then' | 'else'): void {
    if (condition.kind === 'BinaryExpr') {
      const binExpr = condition as BinaryExpr;

      // Handle && — in 'then' branch, both sides are true
      if (binExpr.operator === '&&') {
        if (branch === 'then') {
          this.applyNarrowing(binExpr.left, 'then');
          this.applyNarrowing(binExpr.right, 'then');
        }
        return;
      }

      // Handle || — in 'else' branch, both sides are false
      if (binExpr.operator === '||') {
        if (branch === 'else') {
          this.applyNarrowing(binExpr.left, 'else');
          this.applyNarrowing(binExpr.right, 'else');
        }
        return;
      }

      // Handle null comparisons with both operand orders
      if (binExpr.operator === '!=' || binExpr.operator === '==') {
        let identName: string | null = null;
        if (binExpr.left.kind === 'Identifier' && binExpr.right.kind === 'NullLiteral') {
          identName = (binExpr.left as Identifier).name;
        } else if (binExpr.right.kind === 'Identifier' && binExpr.left.kind === 'NullLiteral') {
          identName = (binExpr.right as Identifier).name;
        }

        if (identName !== null) {
          const binding = this.scope.resolve(identName);
          if (binding && binding.type.kind === 'nullable') {
            const isNotNull = (binExpr.operator === '!=' && branch === 'then') ||
                              (binExpr.operator === '==' && branch === 'else');
            if (isNotNull) {
              this.declareBinding(identName, binding.type.inner, binding.mutable, binding.declared);
            }
          }
        }
      }
    }

    // Handle unary negation: !condition flips the branch
    if (condition.kind === 'UnaryExpr') {
      const unary = condition as UnaryExpr;
      if (unary.operator === '!') {
        this.applyNarrowing(unary.operand, branch === 'then' ? 'else' : 'then');
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Declare a new value binding in the current scope with duplicate detection.
   *
   * Reports E213 if a binding with the same name already exists in the current scope,
   * including a related-span pointing to the first declaration.
   *
   * @param name    - The binding name.
   * @param type    - The binding's type.
   * @param mutable - Whether the binding is mutable (`let mut`).
   * @param span    - Source span of the declaration.
   */
  private declareBinding(name: string, type: Type, mutable: boolean, span: Span): void {
    if (this.scope.isInCurrentScope(name)) {
      const existing = this.scope.resolve(name);
      const diag: Record<string, unknown> = {
        severity: 'error',
        code: D.E213,
        message: `Duplicate declaration: '${name}' is already declared in this scope`,
        span,
      };
      if (existing !== undefined) {
        diag['relatedSpans'] = [{ span: existing.declared, message: `'${name}' first declared here` }];
      }
      this.diagnostics.report(diag as unknown as Diagnostic);
      return;
    }
    this.scope.declare(name, {
      type,
      mutable,
      declared: span,
      referenced: false,
    });
  }

  /**
   * Annotate an AST node with its resolved type.
   *
   * Sets the `resolvedType` property on the node via a `Record<string, unknown>` cast
   * (required by `exactOptionalPropertyTypes`). The emitter and other downstream
   * consumers read this property to access type information.
   */
  private setResolvedType(node: object, type: Type): void {
    (node as Record<string, unknown>)['resolvedType'] = type;
  }
}

