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
 * Diagnostic codes: E200–E218, E220–E223, E230–E232, E240–E241, E250–E251, E253–E255, E261–E264 (errors), W200–W203 (warnings).
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
  ExtensionFunctionDeclaration,
  Identifier, NumberLiteral, StringLiteral, BooleanLiteral,
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
  LiteralTypeNode,
  IntersectionType as IntersectionTypeNode,
  VariantPattern, BindingPattern,
  RecordPattern, TuplePattern,
  NewExpr,
  AwaitExpr,
  NamedArgument,
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
  TypeParam,
  PromiseType,
  ExportedTypeSignature,
  ExportedExtension,
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
  lookupRecordField,
  isRecordLike,
  NUM, STR, BOOL, VOID, NEVER, ANY, NULL_TYPE, ERROR_TYPE,
  widenLiteral,
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

// ── Extension Entry ─────────────────────────────────────────

/** Metadata for a registered extension function in the extension registry. */
interface ExtensionEntry {
  readonly receiverType: Type;
  readonly methodName: string;
  readonly fnType: FunctionType;
  readonly emitName: string;
}

/** Result of a field lookup that found an extension method. */
interface ExtensionLookupResult {
  readonly type: Type;
  readonly extensionEmitName: string;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Check if a resolved type is a specific primitive or a literal of that primitive.
 *
 * For example, `isNumeric(type)` returns true for both `number` and `42` (literal number).
 * Used by operator checking to accept literal types where primitives are expected.
 */
function isPrimitiveLike(type: Type, name: 'number' | 'string' | 'boolean'): boolean {
  if (type.kind === 'primitive') return type.name === name;
  if (type.kind === 'literal') return type.base === name;
  return false;
}

// ── Value Parameter Semantics ────────────────────────────────

/** Built-in Array methods that mutate their receiver. */
const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'push', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'splice', 'fill',
]);

/** Built-in Set methods that mutate their receiver. */
const MUTATING_SET_METHODS: ReadonlySet<string> = new Set([
  'add', 'delete', 'clear',
]);

/** Built-in Map methods that mutate their receiver. */
const MUTATING_MAP_METHODS: ReadonlySet<string> = new Set([
  'set', 'delete', 'clear',
]);

/**
 * Walk a member expression chain to find the root identifier.
 * For `a.b.c.push(x)`, returns the Identifier for `a`.
 * Returns `undefined` for dynamic expressions that cannot be traced to a binding.
 */
function getRootIdentifier(expr: Expression): import('../parser/ast.js').Identifier | undefined {
  if (expr.kind === 'Identifier') return expr as import('../parser/ast.js').Identifier;
  if (expr.kind === 'MemberExpr') return getRootIdentifier((expr as MemberExpr).object);
  return undefined;
}

/**
 * Check if a method call is a known mutating method on the given receiver type.
 * Resolves the receiver's type and checks the appropriate mutating-method set.
 */
function isMutatingMethod(receiverType: Type, methodName: string): boolean {
  const resolved = resolveType(receiverType);
  switch (resolved.kind) {
    case 'array': return MUTATING_ARRAY_METHODS.has(methodName);
    case 'set': return MUTATING_SET_METHODS.has(methodName);
    case 'map': return MUTATING_MAP_METHODS.has(methodName);
    case 'any': return false;
    default: return false;
  }
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
  /** Accumulated exported extensions (populated during checking). */
  private readonly exportedExtensions = new Map<string, ExportedExtension>();

  /** Tracks the receiver type when inside an extension function body. */
  private currentExtensionReceiverType: Type | undefined;
  /** Tracks the current function's return type for use by checkReturnStatement. */
  private currentReturnType: Type | undefined;
  /** Tracks async nesting depth (0 = not in async context). */
  private asyncDepth = 0;
  /** The inner T of Promise<T> when inside an async function with annotated return type. */
  private asyncExpectedInnerType: Type | undefined;

  /**
   * Scope-parallel extension registry. Each entry mirrors a scope level.
   * Outer map: type identity key → inner map: method name → ExtensionEntry.
   */
  private readonly extensionScopes: Array<Map<string, Map<string, ExtensionEntry>>> = [];

  /**
   * Maps in-scope generic type parameter names to their constraints.
   * Used by lookupNativeField to resolve constraint-based field access.
   * The value is the constraint type, or undefined for unconstrained params.
   */
  private readonly genericContext = new Map<string, Type | undefined>();

  constructor(input: CheckerInput) {
    this.ast = input.ast;
    this.diagnostics = input.diagnostics;
    this.imports = input.imports;
    this.scope = new ScopeManager();
    registerPrelude(input.prelude, this.scope);
    // Push the initial extension scope (prelude level)
    this.extensionScopes.push(new Map());
  }

  /**
   * Run the two-pass type checker and return the annotated AST + exports.
   *
   * Pass 1 registers type declarations and forward-declared let bindings.
   * Pass 2 checks each top-level item in source order.
   */
  run(): CheckerOutput {
    // Pass 0: Process imports (makes imported types available for Pass 1/1b)
    for (const item of this.ast.body) {
      if (item.kind === 'ImportDeclaration') {
        this.checkImportDeclaration(item as ImportDeclaration);
      }
    }

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
    //          and extension function declarations
    for (const item of this.ast.body) {
      // Extension function registration
      const extDecl = this.extractExtensionDecl(item);
      if (extDecl) {
        this.registerExtensionFunction(extDecl);
        continue;
      }

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
            result['typeParams'] = this.buildTypeParams(arrow.typeParams!, generics);
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
        extensions: this.exportedExtensions,
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
        // Already processed in Pass 0
        break;
      case 'ExportDeclaration':
        this.checkExportDeclaration(item as ExportDeclaration);
        break;
      case 'ExtensionFunctionDeclaration':
        this.checkExtensionFunctionDeclaration(item as ExtensionFunctionDeclaration);
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
        name === PRELUDE_NAMES.Err || name === PRELUDE_NAMES.attempt ||
        name === PRELUDE_NAMES.Set || name === PRELUDE_NAMES.Map) {
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

    // Resolve declared type BEFORE inference so it can be used as expectedType.
    // This is safe because resolveTypeNode is a pure lookup in the type scope
    // (populated during Pass 1/1b), and inferExpression does not modify the
    // type scope — so the order between them cannot affect results.
    let declaredType: Type | undefined;
    if (decl.typeAnnotation) {
      declaredType = this.resolveTypeNode(decl.typeAnnotation);
    }

    // Pass declared type as expected type to inference (bidirectional).
    const inferredType = this.inferExpression(decl.initializer, declaredType);

    if (declaredType) {
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
      // Widen literal types for mutable bindings (let mut x = "hello" → string)
      const bindingType = decl.mutable ? widenLiteral(inferredType) : inferredType;

      // Infer type from initializer
      if (!this.scope.isInCurrentScope(decl.name.name)) {
        this.declareBinding(decl.name.name, bindingType, decl.mutable, decl.span);
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
      this.setResolvedType(decl, bindingType);
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

    // Build TypeParam[] with resolved constraints for ADT type
    const resolvedTypeParams = typeParams.length > 0
      ? this.buildTypeParams(decl.typeParams!, typeParams)
      : undefined;

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

    // General type alias: type HttpMethod = "GET" | "POST"
    if (decl.typeAlias !== undefined) {
      const aliasType = this.resolveTypeNodeWithGenerics(decl.typeAlias, typeParams);
      this.scope.declareType(decl.name.name, aliasType);
      this.setResolvedType(decl, aliasType);
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

    const adtBase: Record<string, unknown> = {
      kind: 'adt',
      name: decl.name.name,
      typeArgs: typeParams,
      variants,
    };
    if (resolvedTypeParams) adtBase['typeParams'] = resolvedTypeParams;
    const adtType = adtBase as unknown as ADTType;

    this.scope.declareType(decl.name.name, adtType);

    // Register variant constructors in scope and set resolvedType on AST nodes
    for (let vi = 0; vi < variants.length; vi++) {
      const variant = variants[vi];
      const variantNode = decl.variants[vi];
      if (variant.fields.size === 0) {
        // Unit variant — it IS the ADT value
        this.declareBinding(variant.name, adtType, false, decl.span);
        this.setResolvedType(variantNode, adtType);
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
        if (resolvedTypeParams) {
          ctorBase['typeParams'] = resolvedTypeParams;
        } else if (typeParams.length > 0) {
          ctorBase['typeParams'] = typeParams.map(g => ({ name: g.name }));
        }
        const ctorType = ctorBase as unknown as FunctionType;
        this.declareBinding(variant.name, ctorType, false, decl.span);
        this.setResolvedType(variantNode, ctorType);
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
        const importedValue = sig.values.get(importedName);
        const importedTypeEntry = sig.types.get(importedName);
        const importedType = importedValue ?? importedTypeEntry;
        if (importedType) {
          this.declareBinding(localName, importedType, false, spec.span);
          // Register imported types in the type scope so they're resolvable in annotations
          if (importedTypeEntry) {
            this.scope.declareType(localName, importedTypeEntry);
          }
          // If this import matches an exported extension, register it in the extension registry
          const ext = sig.extensions.get(importedName);
          if (ext) {
            this.registerExtensionEntry(ext);
          }
        } else {
          // Check if the name matches a method name of an exported extension → E223
          let suggested = false;
          for (const ext of sig.extensions.values()) {
            if (ext.methodName === importedName) {
              this.diagnostics.report({
                severity: 'error',
                code: D.E223,
                message: `Module '${source}' does not export '${importedName}'. Did you mean '${ext.emitName}'? (extension 'fun ${typeToString(ext.receiverType)}.${ext.methodName}()')`,
                span: spec.span,
              });
              suggested = true;
              break;
            }
          }
          if (!suggested) {
            this.diagnostics.report({
              severity: 'error',
              code: D.E211,
              message: `Module '${source}' has no exported member '${importedName}'`,
              span: spec.span,
            });
          }
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
      } else if (decl.declaration.kind === 'ExtensionFunctionDeclaration') {
        // Extension function checking happens in checkTopLevel via the outer declaration
        this.checkExtensionFunctionDeclaration(decl.declaration);
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
  private inferExpression(node: Expression, expectedType?: Type): Type {
    // Resolve expectedType once here so leaf methods receive a concrete type.
    const rawResolved = expectedType ? resolveType(expectedType) : undefined;
    // Unwrap nullable: if expected type is T?, use T as the effective expected type.
    // The assignability check in checkLetDeclaration uses the original declaredType
    // (not expectedType), so nullable assignability is still enforced.
    const resolved = rawResolved?.kind === 'nullable' ? rawResolved.inner : rawResolved;

    let type: Type;

    switch (node.kind) {
      case 'NumberLiteral':
        type = { kind: 'literal', base: 'number', value: (node as NumberLiteral).value };
        break;
      case 'StringLiteral':
        type = { kind: 'literal', base: 'string', value: (node as StringLiteral).value };
        break;
      case 'BooleanLiteral':
        type = { kind: 'literal', base: 'boolean', value: (node as BooleanLiteral).value };
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
        type = this.inferCallExpr(node as CallExpr, resolved);
        break;
      case 'NewExpr':
        type = this.inferNewExpr(node as NewExpr, resolved);
        break;
      case 'MemberExpr':
        type = this.inferMemberExpr(node as MemberExpr);
        break;
      case 'IfExpr':
        type = this.inferIfExpr(node as IfExpr, resolved);
        break;
      case 'MatchExpr':
        type = this.inferMatchExpr(node as MatchExpr, resolved);
        break;
      case 'BlockExpr':
        type = this.inferBlockExpr(node as BlockExpr, resolved);
        break;
      case 'ArrowFunction':
        type = this.inferArrowFunction(node as ArrowFunction, resolved);
        break;
      case 'TryCatchExpr':
        type = this.inferTryCatchExpr(node as TryCatchExpr, resolved);
        break;
      case 'ArrayExpr':
        type = this.inferArrayExpr(node as ArrayExpr, resolved);
        break;
      case 'RecordExpr':
        type = this.inferRecordExpr(node as RecordExpr, resolved);
        break;
      case 'TemplateString':
        type = this.inferTemplateString(node as TemplateString);
        break;
      case 'ThisExpr':
        type = this.inferThisExpr(node);
        break;
      case 'AwaitExpr':
        type = this.inferAwaitExpr(node as AwaitExpr);
        break;
      case 'NamedArgument':
        // NamedArgument nodes are resolved inside inferCallLike; reaching here
        // means a NamedArgument appeared outside a call site — return error.
        type = ERROR_TYPE;
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
   * Handles null coalescing (`??`), arithmetic (`+`, `-`, `*`, `/`, `%`),
   * comparison (`==`, `!=`, `<`, `>`, `<=`, `>=`), and logical (`&&`, `||`) operators.
   * Reports E216 for type mismatches.
   */
  private inferBinaryExpr(node: BinaryExpr): Type {
    const leftType = resolveType(this.inferExpression(node.left));
    const rightType = resolveType(this.inferExpression(node.right));

    // Error propagation
    if (leftType.kind === 'error' || rightType.kind === 'error') return ERROR_TYPE;

    const op = node.operator;

    // Any type is permissive — arithmetic/comparison with Any returns Any.
    // Logical operators (&&, ||) use existing logic to return the non-Any side.
    if ((leftType.kind === 'any' || rightType.kind === 'any') &&
        op !== '&&' && op !== '||' && op !== '??') {
      return ANY;
    }

    // Null coalescing
    if (op === '??') {
      if (leftType.kind === 'nullable') {
        return leftType.inner;
      }
      return leftType;
    }

    // Arithmetic operators
    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
      if (op === '+') {
        // + accepts number+number or string+string (including literal types)
        if (isPrimitiveLike(leftType, 'number') && isPrimitiveLike(rightType, 'number')) {
          return NUM;
        }
        if (isPrimitiveLike(leftType, 'string') && isPrimitiveLike(rightType, 'string')) {
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
      // Other arithmetic: both must be number (including literal types)
      if (isPrimitiveLike(leftType, 'number') && isPrimitiveLike(rightType, 'number')) {
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
      if (isPrimitiveLike(leftType, 'boolean') && isPrimitiveLike(rightType, 'boolean')) {
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
      if (isPrimitiveLike(operandType, 'number')) {
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
      if (isPrimitiveLike(operandType, 'boolean')) {
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
  private inferCallExpr(node: CallExpr, expectedType?: Type): Type {
    const result = this.inferCallLike(node, expectedType);

    // Value parameter semantics: reject mutating method calls on immutable parameters (E240)
    if (node.callee.kind === 'MemberExpr') {
      const member = node.callee as MemberExpr;
      const methodName = member.property.name;
      const root = getRootIdentifier(member.object);
      if (root) {
        const binding = this.scope.resolve(root.name);
        if (binding && binding.parameter && !binding.contentMutable) {
          // Resolve the type of the direct receiver (member.object), not the root
          const receiverType = member.object.resolvedType;
          if (receiverType && isMutatingMethod(receiverType, methodName)) {
            this.diagnostics.report({
              severity: 'error',
              code: D.E240,
              message: `Cannot call mutating method '${methodName}' on immutable parameter '${root.name}'`,
              span: node.callee.span,
              relatedSpans: [{ span: binding.declared, message: `'${root.name}' declared as immutable parameter here` }],
              fix: { description: `Declare parameter as 'mut ${root.name}' to allow mutation`, edits: [] },
            });
          }
        }
      }
    }

    // Async attempt overload: attempt(asyncFn) → Promise<Result<T, Error>>
    // When attempt is called with a function that returns Promise<T>,
    // rewrite Result<Promise<T>, Error> → Promise<Result<T, Error>>
    if (node.callee.kind === 'Identifier' &&
        (node.callee as Identifier).name === PRELUDE_NAMES.attempt &&
        node.args.length === 1) {
      const argResolved = node.args[0].resolvedType ? resolveType(node.args[0].resolvedType) : undefined;
      if (argResolved?.kind === 'function') {
        const argFn = argResolved as FunctionType;
        const argRet = resolveType(argFn.returnType);
        if (argRet.kind === 'promise') {
          const innerT = (argRet as PromiseType).inner;
          // Tag the node for the emitter
          (node as unknown as Record<string, unknown>)['isAsyncAttempt'] = true;
          // Rewrite return type: Result<Promise<T>, Error> → Promise<Result<T, Error>>
          if (result.kind === 'adt' && (result as ADTType).name === 'Result') {
            const resultAdt = result as ADTType;
            const newResultAdt: ADTType = {
              kind: 'adt',
              name: 'Result',
              typeArgs: [innerT, resultAdt.typeArgs[1]],
              variants: resultAdt.variants,
            };
            return { kind: 'promise', inner: newResultAdt } as PromiseType;
          }
        }
      }
    }

    return result;
  }

  /** Infer the type of a `new` expression. Delegates to {@link inferCallLike}. */
  private inferNewExpr(node: NewExpr, expectedType?: Type): Type {
    return this.inferCallLike(node, expectedType);
  }

  /**
   * Partition call arguments into positional and named, build a parameter-indexed
   * resolved args array, and validate named argument constraints (E253/E254/E255).
   *
   * Returns the resolved args array (parameter-indexed, `undefined` for skipped params)
   * or `undefined` if all args are positional (no named args present).
   */
  private resolveNamedArgs(
    node: { args: readonly Expression[]; span: Span },
    fn: FunctionType,
  ): (Expression | undefined)[] | undefined {
    // Quick check: are there any named arguments?
    const hasNamed = node.args.some(a => a.kind === 'NamedArgument');
    if (!hasNamed) return undefined;

    const positionalArgs: Expression[] = [];
    const namedArgs = new Map<string, { node: NamedArgument; index: number }>();
    let hasErrors = false;

    // Partition args into positional and named
    for (let i = 0; i < node.args.length; i++) {
      const arg = node.args[i];
      if (arg.kind === 'NamedArgument') {
        const na = arg as NamedArgument;
        if (namedArgs.has(na.name.name)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E255,
            message: `Parameter '${na.name.name}' is already provided`,
            span: na.span,
          });
          hasErrors = true;
        }
        namedArgs.set(na.name.name, { node: na, index: i });
      } else {
        if (namedArgs.size > 0) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E253,
            message: 'Positional argument cannot follow named argument',
            span: arg.span,
          });
          hasErrors = true;
        }
        positionalArgs.push(arg);
      }
    }

    // Build resolved args array indexed by parameter position
    const resolvedArgs: (Expression | undefined)[] = new Array(fn.params.length).fill(undefined);

    // Fill positional
    for (let i = 0; i < positionalArgs.length && i < fn.params.length; i++) {
      resolvedArgs[i] = positionalArgs[i];
    }

    // Fill named
    for (const [name, { node: na }] of namedArgs) {
      const paramIndex = fn.params.findIndex(p => p.name === name);
      if (paramIndex === -1) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E254,
          message: `Unknown parameter name '${name}'`,
          span: na.name.span,
        });
        hasErrors = true;
      } else if (resolvedArgs[paramIndex] !== undefined) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E255,
          message: `Parameter '${name}' is already provided`,
          span: na.span,
        });
        hasErrors = true;
      } else {
        resolvedArgs[paramIndex] = na.value;
      }
    }

    // Check all required params are filled
    if (!hasErrors) {
      for (let i = 0; i < fn.params.length; i++) {
        if (resolvedArgs[i] === undefined && !fn.params[i].optional && !fn.params[i].hasDefault) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E207,
            message: `Missing required argument for parameter '${fn.params[i].name}'`,
            span: node.span,
          });
        }
      }
    }

    return resolvedArgs;
  }

  /**
   * Shared implementation for call and new expressions.
   *
   * Resolves the callee type, resolves named arguments (if present), instantiates
   * generics if needed (two-pass for generic calls without explicit type args),
   * checks argument count and types, and returns the function's return type.
   * Reports E208 for non-callable types and E207 for argument count mismatches.
   */
  private inferCallLike(
    node: { callee: Expression; typeArgs?: readonly import('../parser/ast.js').TypeNode[]; args: readonly Expression[]; span: Span; resolvedArgs?: readonly (Expression | undefined)[] },
    expectedType?: Type
  ): Type {
    const calleeType = resolveType(this.inferExpression(node.callee));
    if (calleeType.kind === 'error') return ERROR_TYPE;

    // Handle optional chaining: s?.method(args) — callee type is nullable function.
    // Unwrap nullable, check the call normally, and wrap the result in nullable.
    if (calleeType.kind === 'nullable' && resolveType(calleeType.inner).kind === 'function' &&
        node.callee.kind === 'MemberExpr' && (node.callee as MemberExpr).optional) {
      const innerFn = resolveType(calleeType.inner) as FunctionType;
      const innerResolved = this.resolveNamedArgs(node, innerFn);
      if (innerResolved !== undefined) {
        node.resolvedArgs = innerResolved;
      }
      const innerEffective = innerResolved ?? (node.args as (Expression | undefined)[]);
      const innerResult = this.inferCallLikeWithFn(innerFn, node, innerEffective);
      if (innerResult.kind === 'error') return ERROR_TYPE;
      return makeNullable(innerResult);
    }

    // Any type is callable — returns Any (P1-5)
    if (calleeType.kind === 'any') {
      // Still infer argument types for side effects / diagnostics within args
      for (const arg of node.args) {
        // Unwrap NamedArgument to infer the value expression
        this.inferExpression(arg.kind === 'NamedArgument' ? (arg as NamedArgument).value : arg);
      }
      return ANY;
    }

    if (calleeType.kind !== 'function') {
      const diagnostic: Record<string, unknown> = {
        severity: 'error',
        code: D.E208,
        message: `Type '${typeToString(calleeType)}' is not callable`,
        span: node.callee.span,
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

    const fn = calleeType;

    // Resolve named arguments to parameter positions
    const resolved = this.resolveNamedArgs(node, fn);
    if (resolved !== undefined) {
      // Annotate the node for the emitter
      node.resolvedArgs = resolved;
    }

    // Use resolved args (parameter-indexed) when named args are present,
    // otherwise use node.args directly (positional, unchanged)
    const effectiveArgs = resolved ?? (node.args as (Expression | undefined)[]);

    const hasTypeParams = fn.typeParams && fn.typeParams.length > 0;

    // --- Generic instantiation: two-pass approach ---
    if (hasTypeParams && !node.typeArgs?.length) {
      const typeMap = new Map<string, Type>();

      // Pass 1: Infer type params from non-lambda arguments
      for (let i = 0; i < fn.params.length; i++) {
        const argExpr = effectiveArgs[i];
        if (argExpr !== undefined && argExpr.kind !== 'ArrowFunction') {
          const argType = this.inferExpression(argExpr);
          this.unifyForInference(fn.params[i].type, argType, typeMap);
        }
      }

      // Also unify from expectedType if callee returns a generic ADT
      if (expectedType) {
        const retType = fn.returnType;
        if (retType.kind === 'adt' && expectedType.kind === 'adt' &&
            retType.name === expectedType.name &&
            retType.typeArgs.length === expectedType.typeArgs.length) {
          for (let i = 0; i < retType.typeArgs.length; i++) {
            const retArg = retType.typeArgs[i];
            const expectedArg = resolveType(expectedType.typeArgs[i]);
            if (retArg.kind === 'generic' && !typeMap.has(retArg.name) &&
                expectedArg.kind !== 'typevar') {
              typeMap.set(retArg.name, expectedArg);
            }
          }
        }
      }

      // Fill unresolved type params with fresh type variables for the initial
      // instantiation (provides contextual types to lambdas in Pass 2).
      const freshFilledParams: string[] = [];
      for (const tp of fn.typeParams!) {
        if (!typeMap.has(tp.name)) {
          typeMap.set(tp.name, freshTypeVar());
          freshFilledParams.push(tp.name);
        }
      }

      const instantiated = this.substituteTypeParams(fn, typeMap);

      // Remove fresh-typevar entries so Pass 2 unification can bind them
      for (const name of freshFilledParams) {
        typeMap.delete(name);
      }

      // Pass 2: Infer lambda arguments with contextual types from instantiated params
      for (let i = 0; i < fn.params.length; i++) {
        const argExpr = effectiveArgs[i];
        if (argExpr !== undefined && argExpr.kind === 'ArrowFunction') {
          const expectedParamType = resolveType(instantiated.params[i].type);
          const argType = this.inferExpression(argExpr, expectedParamType);
          this.unifyForInference(fn.params[i].type, argType, typeMap);
        }
      }

      // Fill any still-unresolved type params with fresh type variables
      for (const tp of fn.typeParams!) {
        if (!typeMap.has(tp.name)) {
          typeMap.set(tp.name, freshTypeVar());
        }
      }

      // Re-substitute with all resolved bindings (from both passes)
      const finalInstantiated = this.substituteTypeParams(fn, typeMap);

      // Validate constraints on inferred type arguments
      if (fn.typeParams) {
        this.validateConstraints(fn.typeParams, typeMap, node.span);
      }

      return this.checkArgCountAndTypes(node, finalInstantiated, effectiveArgs);
    }

    // --- Non-generic or explicit type args ---
    return this.inferCallLikeWithFn(fn, node, effectiveArgs);
  }

  /**
   * Validate arguments against a resolved function type and return the call's result type.
   *
   * @param effectiveArgs - Parameter-indexed args when named args are present, or source-order args.
   */
  private inferCallLikeWithFn(
    fn: FunctionType,
    node: { callee: Expression; typeArgs?: readonly import('../parser/ast.js').TypeNode[]; args: readonly Expression[]; span: Span },
    effectiveArgs: readonly (Expression | undefined)[],
  ): Type {
    // Instantiate generic function if needed
    const instantiated = fn.typeParams && fn.typeParams.length > 0
      ? this.instantiateCall(fn, node) : fn;

    // Validate constraints on explicit type arguments
    if (fn.typeParams && fn.typeParams.length > 0 && node.typeArgs && node.typeArgs.length > 0) {
      const typeMap = new Map<string, Type>();
      for (let i = 0; i < fn.typeParams.length && i < node.typeArgs.length; i++) {
        typeMap.set(fn.typeParams[i].name, this.resolveTypeNode(node.typeArgs[i]));
      }
      this.validateConstraints(fn.typeParams, typeMap, node.span);
    }

    // When named args were resolved, arg count/required checks were done in resolveNamedArgs.
    // For positional-only calls, check arg count as before.
    const hasResolvedArgs = effectiveArgs !== node.args;
    if (!hasResolvedArgs) {
      const requiredParams = instantiated.params.filter(p => !p.optional && !p.hasDefault).length;
      const maxArgs = instantiated.rest ? Infinity : instantiated.params.length;
      if (node.args.length < requiredParams || node.args.length > maxArgs) {
        const diagnostic: Record<string, unknown> = {
          severity: 'error',
          code: D.E207,
          message: `Expected ${requiredParams}${requiredParams !== instantiated.params.length ? '-' + instantiated.params.length : ''}${instantiated.rest ? '+' : ''} arguments, but got ${node.args.length}`,
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
    }

    // Infer and check argument types using parameter-indexed effective args
    for (let i = 0; i < effectiveArgs.length; i++) {
      const argExpr = effectiveArgs[i];
      if (argExpr === undefined) continue; // skipped defaulted param

      let expectedParamType: Type | undefined;
      if (i < instantiated.params.length) {
        expectedParamType = resolveType(instantiated.params[i].type);
      } else if (instantiated.rest) {
        expectedParamType = resolveType(instantiated.rest.elementType);
      }
      const isLambda = argExpr.kind === 'ArrowFunction';
      const argType = resolveType(this.inferExpression(argExpr,
        isLambda ? expectedParamType : undefined));
      if (argType.kind !== 'error' && expectedParamType) {
        if (!isAssignableTo(argType, expectedParamType)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Argument of type '${typeToString(argType)}' is not assignable to parameter of type '${typeToString(expectedParamType)}'`,
            span: argExpr.span,
          });
        }
      }
    }

    return resolveType(instantiated.returnType);
  }

  /**
   * Shared helper: check argument count (E207) and argument type assignability (E200).
   * Used by the two-pass generic branch of inferCallLike.
   *
   * @param effectiveArgs - Parameter-indexed args when named args are present, or source-order args.
   */
  private checkArgCountAndTypes(
    node: { callee: Expression; args: readonly Expression[]; span: Span },
    instantiated: FunctionType,
    effectiveArgs: readonly (Expression | undefined)[],
  ): Type {
    // When named args were resolved, arg count checks were done in resolveNamedArgs.
    const hasResolvedArgs = effectiveArgs !== node.args;
    if (!hasResolvedArgs) {
      const requiredParams = instantiated.params.filter(p => !p.optional && !p.hasDefault).length;
      const maxArgs = instantiated.rest ? Infinity : instantiated.params.length;
      if (node.args.length < requiredParams || node.args.length > maxArgs) {
        const diagnostic: Record<string, unknown> = {
          severity: 'error',
          code: D.E207,
          message: `Expected ${requiredParams}${requiredParams !== instantiated.params.length ? '-' + instantiated.params.length : ''}${instantiated.rest ? '+' : ''} arguments, but got ${node.args.length}`,
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
    }

    // Arg type assignability check — args already inferred, read resolvedType
    for (let i = 0; i < effectiveArgs.length; i++) {
      const argExpr = effectiveArgs[i];
      if (argExpr === undefined) continue; // skipped defaulted param
      const argType = resolveType(argExpr.resolvedType ?? ERROR_TYPE);
      let paramType: Type | undefined;
      if (i < instantiated.params.length) {
        paramType = resolveType(instantiated.params[i].type);
      } else if (instantiated.rest) {
        paramType = resolveType(instantiated.rest.elementType);
      }
      if (argType.kind !== 'error' && paramType) {
        if (!isAssignableTo(argType, paramType)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Argument of type '${typeToString(argType)}' is not assignable to parameter of type '${typeToString(paramType)}'`,
            span: argExpr.span,
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
      const result = this.lookupFieldWithExtensions(innerType, fieldName, node.property.span);
      if (result === undefined) return ERROR_TYPE;
      if (typeof result === 'object' && 'extensionEmitName' in result) {
        node.extensionEmitName = result.extensionEmitName;
        return makeNullable(result.type);
      }
      return makeNullable(result as Type);
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

    const result = this.lookupFieldWithExtensions(objType, fieldName, node.property.span);
    if (result === undefined) return ERROR_TYPE;
    if (typeof result === 'object' && 'extensionEmitName' in result) {
      node.extensionEmitName = result.extensionEmitName;
      return result.type;
    }
    return result as Type;
  }

  /**
   * Look up a native field or method on a type (no extension fallback).
   * Returns `undefined` if the field is not found natively.
   */
  private lookupNativeField(objType: Type, fieldName: string): Type | undefined {
    const resolved = resolveType(objType);

    if (isRecordLike(resolved)) {
      return lookupRecordField(resolved, fieldName);
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
        case 'first':
        case 'last':
          return {
            kind: 'function',
            params: [],
            returnType: makeNullable(elemType),
          } as FunctionType;
        case 'flatMap': {
          const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
          const callbackType: FunctionType = {
            kind: 'function',
            params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
            returnType: { kind: 'array', element: uParam } as ArrayType,
          };
          return {
            kind: 'function',
            typeParams: [{ name: 'U' }],
            params: [{ name: 'fn', type: callbackType, optional: false, hasDefault: false }],
            returnType: { kind: 'array', element: uParam } as ArrayType,
          } as FunctionType;
        }
        case 'find':
          return {
            kind: 'function',
            params: [{ name: 'fn', type: {
              kind: 'function',
              params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
              returnType: BOOL,
            } as FunctionType, optional: false, hasDefault: false }],
            returnType: makeNullable(elemType),
          } as FunctionType;
        case 'findIndex':
          return {
            kind: 'function',
            params: [{ name: 'fn', type: {
              kind: 'function',
              params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
              returnType: BOOL,
            } as FunctionType, optional: false, hasDefault: false }],
            returnType: NUM,
          } as FunctionType;
        case 'indexOf':
          return {
            kind: 'function',
            params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
            returnType: NUM,
          } as FunctionType;
        case 'reduce': {
          const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
          const reducerType: FunctionType = {
            kind: 'function',
            params: [
              { name: 'acc', type: uParam, optional: false, hasDefault: false },
              { name: 'item', type: elemType, optional: false, hasDefault: false },
            ],
            returnType: uParam,
          };
          return {
            kind: 'function',
            typeParams: [{ name: 'U' }],
            params: [
              { name: 'fn', type: reducerType, optional: false, hasDefault: false },
              { name: 'init', type: uParam, optional: false, hasDefault: false },
            ],
            returnType: uParam,
          } as FunctionType;
        }
        case 'fold': {
          const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
          const reducerType: FunctionType = {
            kind: 'function',
            params: [
              { name: 'acc', type: uParam, optional: false, hasDefault: false },
              { name: 'item', type: elemType, optional: false, hasDefault: false },
            ],
            returnType: uParam,
          };
          return {
            kind: 'function',
            typeParams: [{ name: 'U' }],
            params: [
              { name: 'init', type: uParam, optional: false, hasDefault: false },
              { name: 'fn', type: reducerType, optional: false, hasDefault: false },
            ],
            returnType: uParam,
          } as FunctionType;
        }
        case 'every':
        case 'some':
          return {
            kind: 'function',
            params: [{ name: 'fn', type: {
              kind: 'function',
              params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
              returnType: BOOL,
            } as FunctionType, optional: false, hasDefault: false }],
            returnType: BOOL,
          } as FunctionType;
        case 'isEmpty':
          return {
            kind: 'function',
            params: [],
            returnType: BOOL,
          } as FunctionType;
        case 'sort': {
          const comparatorParam: ParamType = {
            name: 'fn',
            type: {
              kind: 'function',
              params: [
                { name: 'a', type: elemType, optional: false, hasDefault: false },
                { name: 'b', type: elemType, optional: false, hasDefault: false },
              ],
              returnType: NUM,
            } as FunctionType,
            optional: true,
            hasDefault: false,
          };
          return {
            kind: 'function',
            params: [comparatorParam],
            returnType: VOID,
          } as FunctionType;
        }
        case 'withIndex':
          return {
            kind: 'function',
            params: [],
            returnType: {
              kind: 'array',
              element: { kind: 'tuple', elements: [NUM, elemType] },
            },
          } as FunctionType;
      }
      return undefined;
    }

    if (resolved.kind === 'set') {
      return this.lookupSetField(resolved.element, fieldName);
    }

    if (resolved.kind === 'map') {
      return this.lookupMapField(resolved.key, resolved.value, fieldName);
    }

    if (isPrimitiveLike(resolved, 'string')) {
      return this.lookupStringField(fieldName);
    }

    if (isPrimitiveLike(resolved, 'number')) {
      return this.lookupNumberField(fieldName);
    }

    if (isPrimitiveLike(resolved, 'boolean')) {
      return this.lookupBooleanField(fieldName);
    }

    if (resolved.kind === 'any' || resolved.kind === 'error') return ANY;

    // Generic with constraint: look up field on the constraint type
    if (resolved.kind === 'generic') {
      const constraint = this.getConstraintForGeneric(resolved.name);
      if (constraint) {
        return this.lookupNativeField(constraint, fieldName);
      }
    }

    // ADTs, promises, etc. have no native fields
    return undefined;
  }

  /**
   * Look up a field with extension fallback.
   * First tries native fields, then extension methods.
   * Reports E209 only if both fail.
   *
   * @returns The field type, an ExtensionLookupResult, or undefined (with E209 reported).
   */
  private lookupFieldWithExtensions(
    objType: Type,
    fieldName: string,
    span: Span,
  ): Type | ExtensionLookupResult | undefined {
    // 1. Try native lookup
    const nativeResult = this.lookupNativeField(objType, fieldName);
    if (nativeResult !== undefined) return nativeResult;

    // 2. Try extension lookup
    const resolved = resolveType(objType);
    const ext = this.lookupExtension(resolved, fieldName);
    if (ext) {
      // For generic extensions, instantiate type params by unifying receiver type
      const extFnType = this.instantiateExtension(ext, resolved);
      return { type: extFnType, extensionEmitName: ext.emitName };
    }

    // 3. Neither found → report E209
    this.diagnostics.report({
      severity: 'error',
      code: D.E209,
      message: `Property '${fieldName}' does not exist on type '${typeToString(resolved)}'`,
      span,
    });
    return undefined;
  }

  /**
   * Instantiate a generic extension function type for a specific receiver.
   * Unifies the extension's receiver type with the actual object type to infer type params.
   */
  private instantiateExtension(ext: ExtensionEntry, actualObjType: Type): Type {
    const fn = ext.fnType;
    if (!fn.typeParams || fn.typeParams.length === 0) return fn;

    // Build type map by unifying the extension's receiver type with the actual object type
    const typeMap = new Map<string, Type>();
    for (const tp of fn.typeParams) {
      typeMap.set(tp.name, freshTypeVar());
    }
    this.unifyForInference(ext.receiverType, actualObjType, typeMap);

    // Substitute type params in the function type
    return this.substituteTypeParams(fn, typeMap);
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

  /** Look up a method or property on `Set<T>`. */
  private lookupSetField(elemType: Type, fieldName: string): Type | undefined {
    switch (fieldName) {
      case 'size': return NUM;
      case 'has':
        return {
          kind: 'function',
          params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
          returnType: BOOL,
        } as FunctionType;
      case 'add':
        return {
          kind: 'function',
          params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
          returnType: VOID,
        } as FunctionType;
      case 'delete':
        return {
          kind: 'function',
          params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
          returnType: BOOL,
        } as FunctionType;
      case 'clear':
        return { kind: 'function', params: [], returnType: VOID } as FunctionType;
      case 'map': {
        const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
        const callbackType: FunctionType = {
          kind: 'function',
          params: [{ name: 'item', type: elemType, optional: false, hasDefault: false }],
          returnType: uParam,
        };
        return {
          kind: 'function',
          typeParams: [{ name: 'U' }],
          params: [{ name: 'fn', type: callbackType, optional: false, hasDefault: false }],
          returnType: { kind: 'set', element: uParam } as import('./types.js').SetType,
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
          returnType: { kind: 'set', element: elemType } as import('./types.js').SetType,
        } as FunctionType;
      case 'toArray':
        return {
          kind: 'function',
          params: [],
          returnType: { kind: 'array', element: elemType } as ArrayType,
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
      case 'union':
      case 'intersect':
      case 'difference':
        return {
          kind: 'function',
          params: [{ name: 'other', type: { kind: 'set', element: elemType } as import('./types.js').SetType, optional: false, hasDefault: false }],
          returnType: { kind: 'set', element: elemType } as import('./types.js').SetType,
        } as FunctionType;
    }
    return undefined;
  }

  /** Look up a method or property on `Map<K, V>`. */
  private lookupMapField(keyType: Type, valueType: Type, fieldName: string): Type | undefined {
    switch (fieldName) {
      case 'size': return NUM;
      case 'get':
        return {
          kind: 'function',
          params: [{ name: 'key', type: keyType, optional: false, hasDefault: false }],
          returnType: makeNullable(valueType),
        } as FunctionType;
      case 'has':
        return {
          kind: 'function',
          params: [{ name: 'key', type: keyType, optional: false, hasDefault: false }],
          returnType: BOOL,
        } as FunctionType;
      case 'set':
        return {
          kind: 'function',
          params: [
            { name: 'key', type: keyType, optional: false, hasDefault: false },
            { name: 'value', type: valueType, optional: false, hasDefault: false },
          ],
          returnType: VOID,
        } as FunctionType;
      case 'delete':
        return {
          kind: 'function',
          params: [{ name: 'key', type: keyType, optional: false, hasDefault: false }],
          returnType: BOOL,
        } as FunctionType;
      case 'clear':
        return { kind: 'function', params: [], returnType: VOID } as FunctionType;
      case 'keys':
        return {
          kind: 'function',
          params: [],
          returnType: { kind: 'array', element: keyType } as ArrayType,
        } as FunctionType;
      case 'values':
        return {
          kind: 'function',
          params: [],
          returnType: { kind: 'array', element: valueType } as ArrayType,
        } as FunctionType;
      case 'entries':
        return {
          kind: 'function',
          params: [],
          returnType: { kind: 'array', element: { kind: 'tuple', elements: [keyType, valueType] } } as ArrayType,
        } as FunctionType;
      case 'forEach':
        return {
          kind: 'function',
          params: [{ name: 'fn', type: {
            kind: 'function',
            params: [
              { name: 'value', type: valueType, optional: false, hasDefault: false },
              { name: 'key', type: keyType, optional: false, hasDefault: false },
            ],
            returnType: VOID,
          } as FunctionType, optional: false, hasDefault: false }],
          returnType: VOID,
        } as FunctionType;
      case 'map': {
        const uParam: import('./types.js').GenericType = { kind: 'generic', name: 'U' };
        const callbackType: FunctionType = {
          kind: 'function',
          params: [
            { name: 'value', type: valueType, optional: false, hasDefault: false },
            { name: 'key', type: keyType, optional: false, hasDefault: false },
          ],
          returnType: uParam,
        };
        return {
          kind: 'function',
          typeParams: [{ name: 'U' }],
          params: [{ name: 'fn', type: callbackType, optional: false, hasDefault: false }],
          returnType: { kind: 'map', key: keyType, value: uParam } as import('./types.js').MapType,
        } as FunctionType;
      }
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
  private inferIfExpr(node: IfExpr, expectedType?: Type): Type {
    const condType = resolveType(this.inferExpression(node.condition));
    if (condType.kind !== 'error' && condType.kind !== 'any') {
      if (!isPrimitiveLike(condType, 'boolean')) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(condType)}' is not assignable to type 'boolean'`,
          span: node.condition.span,
        });
      }
    }

    // Apply null narrowing in branches — passing expectedType to each branch.
    this.scope.pushScope();
    this.applyNarrowing(node.condition, 'then');
    const consequentType = this.inferExpression(node.consequent, expectedType);
    this.scope.popScope();

    if (node.alternate) {
      this.scope.pushScope();
      this.applyNarrowing(node.condition, 'else');
      const alternateType = this.inferExpression(node.alternate, expectedType);
      this.scope.popScope();

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
  private inferMatchExpr(node: MatchExpr, expectedType?: Type): Type {
    const subjectType = resolveType(this.inferExpression(node.subject));
    const armTypes: Type[] = [];

    for (const matchArm of node.arms) {
      this.scope.pushScope();

      // Check pattern and introduce bindings
      this.checkPattern(matchArm.pattern, subjectType);

      // Check guard
      if (matchArm.guard) {
        const guardType = resolveType(this.inferExpression(matchArm.guard));
        if (guardType.kind !== 'error' && !isPrimitiveLike(guardType, 'boolean')) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Type '${typeToString(guardType)}' is not assignable to type 'boolean'`,
            span: matchArm.guard.span,
          });
        }
      }

      // Forward expectedType to each arm body
      const bodyType = this.inferExpression(matchArm.body, expectedType);
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
  private inferBlockExpr(node: BlockExpr, expectedType?: Type): Type {
    if (node.body.length === 0) return VOID;

    this.scope.pushScope();
    let lastType: Type = VOID;

    for (let i = 0; i < node.body.length; i++) {
      const item = node.body[i];
      const isLast = i === node.body.length - 1;

      if (item.kind === 'LetDeclaration') {
        this.checkLetDeclaration(item as LetDeclaration);
        lastType = VOID;
      } else if (item.kind === 'ReturnStatement') {
        // ReturnStatement must be checked BEFORE the isStatement() branch.
        // checkReturnStatement uses currentReturnType to pass expectedType
        // to the return value expression.
        this.checkStatement(item);
        const ret = item as ReturnStatement;
        if (ret.value) {
          const resolvedVal = (ret.value as unknown as Record<string, unknown>)['resolvedType'] as Type | undefined;
          lastType = resolvedVal ?? VOID;
        } else {
          lastType = VOID;
        }
      } else if (isStatement(item)) {
        this.checkStatement(item);
        lastType = VOID;
      } else {
        // Expression — only pass expectedType to the final expression.
        lastType = this.inferExpression(item as Expression, isLast ? expectedType : undefined);
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
  private inferArrowFunction(node: ArrowFunction, expectedType?: Type): Type {
    // expectedType is already resolved by inferExpression — no resolveType needed here
    const contextualFn = expectedType?.kind === 'function' ? expectedType as FunctionType : undefined;

    // Extract type parameters FIRST so they're available during param/return type resolution
    const generics = node.typeParams?.map(tp => ({
      kind: 'generic' as const,
      name: tp.name.name,
    })) ?? [];

    // Build TypeParam[] with resolved constraints
    const typeParams = generics.length > 0
      ? this.buildTypeParams(node.typeParams!, generics)
      : undefined;

    const params: ParamType[] = [];

    // Check parameter types (using generics-aware resolution when type params present)
    for (let i = 0; i < node.params.length; i++) {
      const p = node.params[i];
      if (p.type) {
        // Explicit annotation — use it (unchanged)
        const pType = generics.length > 0
          ? this.resolveTypeNodeWithGenerics(p.type, generics)
          : this.resolveTypeNode(p.type);
        params.push({ name: p.name.name, type: pType, optional: false, hasDefault: p.defaultValue !== undefined });
      } else if (contextualFn && i < contextualFn.params.length) {
        // No annotation, but contextual type available — use it.
        const ctxParam = contextualFn.params[i];
        const param: Record<string, unknown> = {
          name: p.name.name,
          type: ctxParam.type,
          optional: ctxParam.optional,
          hasDefault: p.defaultValue !== undefined,
        };
        if (ctxParam.nullKind !== undefined) param['nullKind'] = ctxParam.nullKind;
        params.push(param as unknown as ParamType);
      } else {
        // No annotation, no context — error (unchanged)
        this.diagnostics.report({
          severity: 'error',
          code: D.E205,
          message: `Parameter '${p.name.name}' requires a type annotation`,
          span: p.span,
        });
        params.push({ name: p.name.name, type: ANY, optional: false, hasDefault: p.defaultValue !== undefined });
      }
    }

    // Determine the effective return type for expectedType propagation.
    // Priority: (1) explicit return type annotation, (2) contextual function's return type.
    const declaredReturnType = node.returnType
      ? (generics.length > 0
          ? this.resolveTypeNodeWithGenerics(node.returnType, generics)
          : this.resolveTypeNode(node.returnType))
      : undefined;

    // ── Async-specific return type validation ──
    const isAsync = node.async === true;
    let asyncInnerType: Type | undefined;

    if (isAsync && declaredReturnType !== undefined) {
      const resolvedDeclared = resolveType(declaredReturnType);
      if (resolvedDeclared.kind !== 'promise') {
        this.diagnostics.report({
          severity: 'error',
          code: D.E230,
          message: `Async function return type must be 'Promise<T>', found '${typeToString(resolvedDeclared)}'`,
          span: node.returnType!.span,
        });
      } else {
        asyncInnerType = (resolvedDeclared as PromiseType).inner;
      }
    }

    // For async functions, the body is checked against the inner T, not Promise<T>
    const bodyExpectedType = isAsync && asyncInnerType !== undefined
      ? asyncInnerType
      : (declaredReturnType ?? contextualFn?.returnType);

    // Push generic context for constraint-based field access
    const savedGenericContext = this.pushGenericContext(typeParams);

    // Push scope for function body
    this.scope.pushScope();
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const astParam = node.params[i];
      this.declareBinding(p.name, p.type, false, node.span, true, astParam.mutable);
    }

    // Save and set currentReturnType for checkReturnStatement
    const savedReturnType = this.currentReturnType;
    // For async functions, checkReturnStatement should check against inner T
    this.currentReturnType = isAsync && asyncInnerType !== undefined
      ? asyncInnerType
      : (declaredReturnType ?? contextualFn?.returnType);

    // Save and set async context
    const savedAsyncDepth = this.asyncDepth;
    const savedAsyncExpectedInnerType = this.asyncExpectedInnerType;
    if (isAsync) {
      this.asyncDepth++;
      this.asyncExpectedInnerType = asyncInnerType;
    } else {
      // Non-async arrow: reset asyncDepth to prevent await leaking
      this.asyncDepth = 0;
    }

    // Infer body type with expectedType propagation
    const bodyType = this.inferExpression(node.body, bodyExpectedType);

    // Restore async context
    this.asyncDepth = savedAsyncDepth;
    this.asyncExpectedInnerType = savedAsyncExpectedInnerType;

    // Helper: does a block body end with a return statement?
    const blockEndsInReturn = node.body.kind === 'BlockExpr' &&
      (node.body as BlockExpr).body.length > 0 &&
      (node.body as BlockExpr).body[(node.body as BlockExpr).body.length - 1].kind === 'ReturnStatement';

    // Determine the return type
    let returnType: Type;
    if (isAsync) {
      if (declaredReturnType !== undefined) {
        returnType = declaredReturnType;
        // Body-vs-annotation check: body must be assignable to inner T
        if (!blockEndsInReturn && asyncInnerType !== undefined) {
          if (bodyType.kind !== 'error' && !isAssignableTo(bodyType, asyncInnerType)) {
            this.diagnostics.report({
              severity: 'error',
              code: D.E200,
              message: `Type '${typeToString(bodyType)}' is not assignable to return type '${typeToString(declaredReturnType)}'`,
              span: node.body.span,
            });
          }
        }
      } else {
        // Inferred return type: wrap in Promise (no double-wrap)
        if (bodyType.kind === 'promise') {
          returnType = bodyType; // Already a Promise, no double-wrap
        } else {
          returnType = { kind: 'promise', inner: bodyType } as PromiseType;
        }
      }
    } else {
      if (declaredReturnType !== undefined) {
        returnType = declaredReturnType;

        // Body-vs-annotation assignability check.
        // SKIP when block body ends in `return` — checkReturnStatement already
        // validates the return value. Firing here too would produce a duplicate E200.
        if (!blockEndsInReturn) {
          if (bodyType.kind !== 'error' && !isAssignableTo(bodyType, declaredReturnType)) {
            this.diagnostics.report({
              severity: 'error',
              code: D.E200,
              message: `Type '${typeToString(bodyType)}' is not assignable to return type '${typeToString(declaredReturnType)}'`,
              span: node.body.span,
            });
          }
        }
      } else {
        returnType = bodyType;
      }
    }

    // Restore currentReturnType
    this.currentReturnType = savedReturnType;

    this.scope.popScope();

    // Restore generic context
    this.popGenericContext(savedGenericContext);

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
  private inferTryCatchExpr(node: TryCatchExpr, expectedType?: Type): Type {
    const tryType = this.inferBlockExpr(node.tryBody, expectedType);

    this.scope.pushScope();
    // Catch parameter is Any
    this.declareBinding(node.catchParam.name, ANY, false, node.catchParam.span);
    const catchType = this.inferBlockExpr(node.catchBody, expectedType);
    this.scope.popScope();

    if (typesEqual(tryType, catchType)) return tryType;
    return simplifyUnion([tryType, catchType]);
  }

  /** Infer the type of an array literal. Uses expectedType for empty arrays and element context. */
  private inferArrayExpr(node: ArrayExpr, expectedType?: Type): Type {
    if (node.elements.length === 0) {
      // expectedType is already resolved by inferExpression
      if (expectedType && expectedType.kind === 'array') {
        return { kind: 'array', element: (expectedType as ArrayType).element } as ArrayType;
      }
      return { kind: 'array', element: freshTypeVar() } as ArrayType;
    }

    // Non-empty arrays: propagate element expected type if available.
    const elementExpected = expectedType?.kind === 'array'
      ? (expectedType as ArrayType).element
      : undefined;

    const elementTypes = node.elements.map(e =>
      this.inferExpression(e, elementExpected)
    );

    // Widen literal element types when no expected type constrains them.
    // ["GET", "POST"] → Array<string>, not Array<"GET" | "POST">.
    const widened = elementExpected
      ? elementTypes
      : elementTypes.map(widenLiteral);

    const allSame = widened.every(t => typesEqual(t, widened[0]));
    if (allSame) {
      return { kind: 'array', element: widened[0] } as ArrayType;
    }

    return { kind: 'array', element: simplifyUnion(widened) } as ArrayType;
  }

  /** Infer the type of a record literal. Propagates expected field types from record annotation. */
  private inferRecordExpr(node: RecordExpr, expectedType?: Type): Type {
    const resolvedExpected = expectedType ? resolveType(expectedType) : undefined;
    const expectedRecordLike = resolvedExpected && isRecordLike(resolvedExpected) ? resolvedExpected : undefined;

    const fields = new Map<string, Type>();
    for (const field of node.fields) {
      // Look up matching field in expected type by name
      const expectedFieldType = expectedRecordLike
        ? lookupRecordField(expectedRecordLike, field.name.name)
        : undefined;
      const fieldType = this.inferExpression(field.value, expectedFieldType);
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

  // ── Extension function support ──────────────────────────

  /** Extract an ExtensionFunctionDeclaration from a top-level item (handles export wrapping). */
  private extractExtensionDecl(item: Declaration | Statement): ExtensionFunctionDeclaration | undefined {
    if (item.kind === 'ExtensionFunctionDeclaration') {
      return item as ExtensionFunctionDeclaration;
    }
    if (item.kind === 'ExportDeclaration') {
      const decl = (item as ExportDeclaration).declaration;
      if (decl?.kind === 'ExtensionFunctionDeclaration') {
        return decl;
      }
    }
    return undefined;
  }

  /**
   * Compute the type identity key for extension registry lookup.
   * Returns undefined if the type cannot be used as an extension receiver.
   */
  private getTypeKey(type: Type): string | undefined {
    const resolved = resolveType(type);
    switch (resolved.kind) {
      case 'primitive':
        return resolved.name;
      case 'literal':
        return resolved.base;
      case 'array': return 'Array';
      case 'adt': return resolved.name;
      case 'record': {
        // Named record types: look up the name in scope
        const name = this.scope.findTypeName(resolved);
        return name;
      }
      case 'promise': return 'Promise';
      case 'set': return 'Set';
      case 'map': return 'Map';
      case 'generic': return undefined; // Bare type parameter → E221
      case 'typevar': return undefined;
      default: return undefined;
    }
  }

  /**
   * Register an extension function declaration during Pass 1b.
   * Resolves the receiver type, computes the emit name, and registers in both
   * the scope (as a binding) and the extension registry.
   */
  private registerExtensionFunction(decl: ExtensionFunctionDeclaration): void {
    // Resolve type params for the extension
    const generics = decl.typeParams?.map(tp => ({
      kind: 'generic' as const,
      name: tp.name.name,
    })) ?? [];

    // Resolve receiver type
    const receiverType = generics.length > 0
      ? this.resolveTypeNodeWithGenerics(decl.receiverType, generics)
      : this.resolveTypeNode(decl.receiverType);

    // Check for bare type parameter
    const resolvedReceiver = resolveType(receiverType);
    if (resolvedReceiver.kind === 'generic' || resolvedReceiver.kind === 'typevar') {
      this.diagnostics.report({
        severity: 'error',
        code: D.E221,
        message: `Extension function receiver type '${typeToString(receiverType)}' could not be resolved (bare type parameter cannot be a receiver)`,
        span: decl.receiverType.span,
      });
      return;
    }

    // Check for unresolved type (error type from failed resolution)
    if (resolvedReceiver.kind === 'error') {
      // E212 already reported by resolveTypeNode
      return;
    }

    // Store resolved receiver type on the AST node for DTS emitter
    decl.resolvedReceiverType = receiverType;

    // Compute emit name
    const receiverTypeName = this.getReceiverTypeName(decl.receiverType);
    const emitName = `${receiverTypeName}_${decl.name.name}`;

    // Resolve param types
    const paramTypes: ParamType[] = decl.params.map(p => {
      const pType = p.type
        ? (generics.length > 0
          ? this.resolveTypeNodeWithGenerics(p.type, generics)
          : this.resolveTypeNode(p.type))
        : ANY;
      return {
        name: p.name.name,
        type: pType,
        optional: false,
        hasDefault: p.defaultValue !== undefined,
      };
    });

    // Resolve return type
    const returnType = generics.length > 0
      ? this.resolveTypeNodeWithGenerics(decl.returnType, generics)
      : this.resolveTypeNode(decl.returnType);

    // Build function type (without receiver as param)
    const fnType: FunctionType = { kind: 'function', params: paramTypes, returnType };
    const resolvedTypeParams = generics.length > 0
      ? this.buildTypeParams(decl.typeParams!, generics)
      : undefined;
    const fnTypeWithGenerics: FunctionType = resolvedTypeParams
      ? { ...fnType, typeParams: resolvedTypeParams }
      : fnType;

    // Register as binding in scope (for export/import)
    // Use custom E213 message that includes extension context
    if (this.scope.isInCurrentScope(emitName)) {
      const existing = this.scope.resolve(emitName);
      const diag: Record<string, unknown> = {
        severity: 'error',
        code: D.E213,
        message: `Duplicate binding '${emitName}' (generated from extension 'fun ${receiverTypeName}.${decl.name.name}()')`,
        span: decl.span,
      };
      if (existing !== undefined) {
        diag['relatedSpans'] = [{ span: existing.declared, message: `'${emitName}' first declared here` }];
      }
      this.diagnostics.report(diag as unknown as Diagnostic);
      return;
    }
    this.scope.declare(emitName, {
      type: fnTypeWithGenerics,
      mutable: false,
      declared: decl.span,
      referenced: false,
      parameter: false,
      contentMutable: false,
    });

    // Register in extension registry
    const entry: ExtensionEntry = {
      receiverType,
      methodName: decl.name.name,
      fnType: fnTypeWithGenerics,
      emitName,
    };
    this.registerExtensionEntry(entry);

    // Handle exports
    if (decl.exported) {
      this.exportedValues.set(emitName, fnTypeWithGenerics);
      this.exportedExtensions.set(emitName, {
        receiverType,
        methodName: decl.name.name,
        fnType: fnTypeWithGenerics,
        emitName,
      });
    }
  }

  /** Register an extension entry in the current scope's extension map. */
  private registerExtensionEntry(entry: ExtensionEntry): void {
    const currentExtMap = this.extensionScopes[this.extensionScopes.length - 1];
    const typeKey = this.getTypeKey(entry.receiverType);
    if (typeKey === undefined) return;

    let methodMap = currentExtMap.get(typeKey);
    if (!methodMap) {
      methodMap = new Map();
      currentExtMap.set(typeKey, methodMap);
    }
    methodMap.set(entry.methodName, entry);
  }

  /** Extract the receiver type name from a TypeNode for emit name generation. */
  private getReceiverTypeName(typeNode: TypeNode): string {
    if (typeNode.kind === 'NamedType') {
      return (typeNode as NamedType).name.name;
    }
    return 'unknown';
  }

  /**
   * Check an extension function declaration body.
   * Sets currentExtensionReceiverType, pushes scope, checks body,
   * verifies return type, clears receiver type.
   */
  private checkExtensionFunctionDeclaration(decl: ExtensionFunctionDeclaration): void {
    // The extension was already registered in Pass 1b.
    // Now check the body.
    const generics = decl.typeParams?.map(tp => ({
      kind: 'generic' as const,
      name: tp.name.name,
    })) ?? [];

    // Build TypeParam[] with resolved constraints
    const typeParams = generics.length > 0
      ? this.buildTypeParams(decl.typeParams!, generics)
      : undefined;

    const receiverType = generics.length > 0
      ? this.resolveTypeNodeWithGenerics(decl.receiverType, generics)
      : this.resolveTypeNode(decl.receiverType);

    const resolvedReceiver = resolveType(receiverType);
    if (resolvedReceiver.kind === 'error' || resolvedReceiver.kind === 'generic' || resolvedReceiver.kind === 'typevar') {
      // Error already reported during registration
      this.setResolvedType(decl, ERROR_TYPE);
      return;
    }

    // Store resolved receiver type
    decl.resolvedReceiverType = receiverType;

    // Set extension receiver type for `this` resolution
    const prevReceiverType = this.currentExtensionReceiverType;
    this.currentExtensionReceiverType = receiverType;

    // Push generic context for constraint-based field access
    const savedGenericContext = this.pushGenericContext(typeParams);

    // Push scope for the body
    this.scope.pushScope();
    this.extensionScopes.push(new Map());

    // Declare params in scope — extension function params follow value parameter semantics
    for (const p of decl.params) {
      if (p.type) {
        const pType = generics.length > 0
          ? this.resolveTypeNodeWithGenerics(p.type, generics)
          : this.resolveTypeNode(p.type);
        this.scope.declare(p.name.name, {
          type: pType,
          mutable: false,
          declared: p.span,
          referenced: true, // params are always "referenced"
          parameter: true,
          contentMutable: p.mutable,
        });
      }
    }

    // Verify return type
    const returnType = generics.length > 0
      ? this.resolveTypeNodeWithGenerics(decl.returnType, generics)
      : this.resolveTypeNode(decl.returnType);

    const isAsync = decl.async === true;

    // Async: validate return type is Promise<T> and extract inner type
    let asyncInnerType: Type | undefined;
    if (isAsync) {
      if (returnType.kind === 'promise') {
        asyncInnerType = returnType.inner;
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E230,
          message: `Async function return type must be 'Promise<T>', found '${typeToString(returnType)}'`,
          span: decl.returnType.span,
        });
      }
    }

    // Save and set async context
    const savedAsyncDepth = this.asyncDepth;
    const savedAsyncExpectedInnerType = this.asyncExpectedInnerType;
    const savedReturnType = this.currentReturnType;
    if (isAsync) {
      this.asyncDepth++;
      this.asyncExpectedInnerType = asyncInnerType;
      this.currentReturnType = asyncInnerType;
    } else {
      this.asyncDepth = 0;
      this.currentReturnType = returnType;
    }

    // Check body
    const bodyType = this.inferExpression(decl.body);

    // Restore async context and return type
    this.asyncDepth = savedAsyncDepth;
    this.asyncExpectedInnerType = savedAsyncExpectedInnerType;
    this.currentReturnType = savedReturnType;

    // Body-vs-annotation type check
    const checkAgainstType = isAsync && asyncInnerType !== undefined ? asyncInnerType : returnType;
    if (bodyType.kind !== 'error' && !isAssignableTo(bodyType, checkAgainstType)) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E200,
        message: `Type '${typeToString(bodyType)}' is not assignable to return type '${typeToString(returnType)}'`,
        span: decl.body.span,
      });
    }

    // Pop scope
    this.extensionScopes.pop();
    this.scope.popScope();

    // Restore generic context
    this.popGenericContext(savedGenericContext);

    // Restore receiver type
    this.currentExtensionReceiverType = prevReceiverType;

    // Build the full function type for the resolved type
    const paramTypes: ParamType[] = decl.params.map(p => {
      const pType = p.type
        ? (generics.length > 0
          ? this.resolveTypeNodeWithGenerics(p.type, generics)
          : this.resolveTypeNode(p.type))
        : ANY;
      return { name: p.name.name, type: pType, optional: false, hasDefault: false };
    });
    const fnType: FunctionType = { kind: 'function', params: paramTypes, returnType };
    if (typeParams && typeParams.length > 0) {
      const result: Record<string, unknown> = { ...fnType };
      result['typeParams'] = typeParams;
      this.setResolvedType(decl, result as unknown as FunctionType);
    } else {
      this.setResolvedType(decl, fnType);
    }
  }

  /** Infer the type of `this` — returns the extension receiver type or reports E220. */
  private inferThisExpr(node: Expression): Type {
    if (this.currentExtensionReceiverType !== undefined) {
      return this.currentExtensionReceiverType;
    }
    this.diagnostics.report({
      severity: 'error',
      code: D.E220,
      message: `'this' can only be used inside an extension function`,
      span: node.span,
    });
    return ERROR_TYPE;
  }

  /**
   * Infer the type of an `await` expression.
   *
   * Rules:
   * - `await` is only valid inside an async function (asyncDepth > 0), else E231.
   * - The operand must be `Promise<T>` → result is `T`, else E232.
   * - `await Any` → `Any` (escape hatch).
   */
  private inferAwaitExpr(node: AwaitExpr): Type {
    if (this.asyncDepth === 0) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E231,
        message: `'await' can only be used inside an async function`,
        span: node.span,
      });
    }

    const argType = resolveType(this.inferExpression(node.argument));
    if (argType.kind === 'any') return ANY;
    if (argType.kind === 'error') return ERROR_TYPE;

    if (argType.kind === 'promise') {
      return (argType as PromiseType).inner;
    }

    this.diagnostics.report({
      severity: 'error',
      code: D.E232,
      message: `'await' requires a Promise type, found '${typeToString(argType)}'`,
      span: node.argument.span,
    });
    return ERROR_TYPE;
  }

  /**
   * Look up an extension method for a given type and method name.
   * Walks the extension scope stack from innermost to outermost.
   */
  private lookupExtension(objType: Type, methodName: string): ExtensionEntry | undefined {
    const typeKey = this.getTypeKey(objType);
    if (typeKey === undefined) return undefined;

    // Walk from innermost to outermost
    for (let i = this.extensionScopes.length - 1; i >= 0; i--) {
      const scopeMap = this.extensionScopes[i];
      const methodMap = scopeMap.get(typeKey);
      if (methodMap) {
        const entry = methodMap.get(methodName);
        if (entry) return entry;
      }
    }
    return undefined;
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
   * Check a for-loop statement: simple iteration, range, or destructuring.
   *
   * - Range (`for (i in 0..<10)`): validates bounds are numbers, binds `i` as number
   * - Record destructuring: validates iterable is Array<RecordType>, binds fields
   * - Tuple destructuring: validates iterable is Array<TupleType>, binds elements
   * - Simple identifier: validates iterable is Array, binds to element type
   */
  private checkForStatement(node: ForStatement): void {
    // ── Range iteration ──
    if (node.range) {
      // Destructuring with ranges is invalid
      if (node.variable.kind !== 'Identifier') {
        this.diagnostics.report({
          severity: 'error',
          code: D.E264,
          message: 'Range iteration requires a simple variable, not a destructuring pattern',
          span: node.variable.span,
        });
      }

      // Validate range bounds are numbers
      const startType = resolveType(this.inferExpression(node.range.start));
      if (startType.kind !== 'error' && startType.kind !== 'any' && !isPrimitiveLike(startType, 'number')) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E261,
          message: `Range bound must be a number, got '${typeToString(startType)}'`,
          span: node.range.start.span,
        });
      }

      const endType = resolveType(this.inferExpression(node.range.end));
      if (endType.kind !== 'error' && endType.kind !== 'any' && !isPrimitiveLike(endType, 'number')) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E261,
          message: `Range bound must be a number, got '${typeToString(endType)}'`,
          span: node.range.end.span,
        });
      }

      this.scope.pushScope();
      if (node.variable.kind === 'Identifier') {
        this.declareBinding(node.variable.name, NUM, false, node.variable.span);
      }
      this.inferBlockExpr(node.body);
      this.scope.popScope();
      return;
    }

    // ── Array iteration (simple, record destructuring, tuple destructuring) ──
    const iterableType = resolveType(this.inferExpression(node.iterable));

    if (iterableType.kind === 'error') {
      this.scope.pushScope();
      this.bindForVariable(node.variable, ANY);
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
      this.bindForVariable(node.variable, ERROR_TYPE);
      this.inferBlockExpr(node.body);
      this.scope.popScope();
      return;
    }

    const elemType = resolveType(iterableType.element);

    this.scope.pushScope();

    if (node.variable.kind === 'Identifier') {
      // Simple iteration
      this.declareBinding(node.variable.name, elemType, false, node.variable.span);
    } else if (node.variable.kind === 'RecordPattern') {
      this.checkForRecordDestructuring(node.variable, elemType);
    } else if (node.variable.kind === 'TuplePattern') {
      this.checkForTupleDestructuring(node.variable, elemType);
    }

    this.inferBlockExpr(node.body);
    this.scope.popScope();
  }

  /** Bind all names in a for-loop variable to `type` (fallback for error recovery). */
  private bindForVariable(variable: ForStatement['variable'], type: Type): void {
    if (variable.kind === 'Identifier') {
      this.declareBinding(variable.name, type, false, variable.span);
    } else if (variable.kind === 'RecordPattern') {
      for (const field of variable.fields) {
        this.declareBinding(field.name.name, type, false, field.name.span);
      }
    } else if (variable.kind === 'TuplePattern') {
      for (const el of variable.elements) {
        if (el.kind === 'Identifier') {
          this.declareBinding(el.name, type, false, el.span);
        }
      }
    }
  }

  /** Check record destructuring in a for-loop variable position. */
  private checkForRecordDestructuring(pattern: RecordPattern, elemType: Type): void {
    // Nullable element types cannot be destructured
    if (elemType.kind === 'nullable') {
      this.diagnostics.report({
        severity: 'error',
        code: D.E262,
        message: `Cannot destructure type '${typeToString(elemType)}' — expected a record or tuple`,
        span: pattern.span,
      });
      for (const field of pattern.fields) {
        this.declareBinding(field.name.name, ERROR_TYPE, false, field.name.span);
      }
      return;
    }

    if (!isRecordLike(elemType)) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E262,
        message: `Cannot destructure type '${typeToString(elemType)}' — expected a record or tuple`,
        span: pattern.span,
      });
      for (const field of pattern.fields) {
        this.declareBinding(field.name.name, ERROR_TYPE, false, field.name.span);
      }
      return;
    }

    for (const field of pattern.fields) {
      const fieldType = lookupRecordField(elemType, field.name.name);
      if (fieldType) {
        this.declareBinding(field.name.name, fieldType, false, field.name.span);
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E209,
          message: `Property '${field.name.name}' does not exist on type '${typeToString(elemType)}'`,
          span: field.name.span,
        });
        this.declareBinding(field.name.name, ERROR_TYPE, false, field.name.span);
      }
    }
  }

  /** Check tuple destructuring in a for-loop variable position. */
  private checkForTupleDestructuring(pattern: TuplePattern, elemType: Type): void {
    // Nullable element types cannot be destructured
    if (elemType.kind === 'nullable') {
      this.diagnostics.report({
        severity: 'error',
        code: D.E262,
        message: `Cannot destructure type '${typeToString(elemType)}' — expected a record or tuple`,
        span: pattern.span,
      });
      for (const el of pattern.elements) {
        if (el.kind === 'Identifier') {
          this.declareBinding(el.name, ERROR_TYPE, false, el.span);
        }
      }
      return;
    }

    if (elemType.kind !== 'tuple') {
      this.diagnostics.report({
        severity: 'error',
        code: D.E262,
        message: `Cannot destructure type '${typeToString(elemType)}' — expected a record or tuple`,
        span: pattern.span,
      });
      for (const el of pattern.elements) {
        if (el.kind === 'Identifier') {
          this.declareBinding(el.name, ERROR_TYPE, false, el.span);
        }
      }
      return;
    }

    if (elemType.elements.length !== pattern.elements.length) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E263,
        message: `Tuple has ${elemType.elements.length} elements but pattern has ${pattern.elements.length}`,
        span: pattern.span,
      });
    }

    for (let idx = 0; idx < pattern.elements.length; idx++) {
      const el = pattern.elements[idx];
      const tupleElemType = idx < elemType.elements.length ? elemType.elements[idx] : ERROR_TYPE;
      if (el.kind === 'Identifier') {
        this.declareBinding(el.name, tupleElemType, false, el.span);
      }
      // WildcardPattern — no binding needed
    }
  }

  /** Check a `while` statement: validates the condition is boolean, then checks the body. */
  private checkWhileStatement(node: WhileStatement): void {
    const condType = resolveType(this.inferExpression(node.condition));
    if (condType.kind !== 'error' && condType.kind !== 'any') {
      if (!isPrimitiveLike(condType, 'boolean')) {
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
    } else if (node.target.kind === 'MemberExpr') {
      // Member expression assignment — check value parameter immutability (E241)
      this.inferExpression(node.target);
      const root = getRootIdentifier(node.target);
      if (root) {
        const binding = this.scope.resolve(root.name);
        if (binding && binding.parameter && !binding.contentMutable) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E241,
            message: `Cannot mutate immutable parameter '${root.name}'`,
            span: node.span,
            relatedSpans: [{ span: binding.declared, message: `'${root.name}' declared as immutable parameter here` }],
            fix: { description: `Declare parameter as 'mut ${root.name}' to allow mutation`, edits: [] },
          });
        }
      }
    } else {
      // Other assignment target
      this.inferExpression(node.target);
    }
  }

  /** Check a `throw` statement by inferring the thrown value's type. */
  private checkThrowStatement(node: ThrowStatement): void {
    this.inferExpression(node.value);
  }

  /**
   * Check a `return` statement by inferring the returned value's type (if present).
   * Passes currentReturnType as expectedType for contextual inference, and checks
   * assignability against the declared return type.
   */
  private checkReturnStatement(node: ReturnStatement): void {
    if (!node.value) {
      // Bare return — check void against the declared return type
      if (this.currentReturnType !== undefined) {
        const resolved = resolveType(this.currentReturnType);
        if (resolved.kind !== 'typevar' && !isAssignableTo(VOID, resolved)) {
          this.diagnostics.report({
            severity: 'error',
            code: D.E200,
            message: `Type 'void' is not assignable to return type '${typeToString(resolved)}'`,
            span: node.span,
          });
        }
      }
      return;
    }

    // Pass currentReturnType as expectedType for contextual inference
    const valueType = resolveType(this.inferExpression(node.value, this.currentReturnType));
    if (valueType.kind === 'error') return;

    // Check assignability against declared return type
    if (this.currentReturnType !== undefined) {
      const resolved = resolveType(this.currentReturnType);
      // Guard against unresolved type variables
      if (resolved.kind !== 'typevar' && !isAssignableTo(valueType, resolved)) {
        // D6: In async context, also accept Promise<T> when expected T
        if (this.asyncDepth > 0 && valueType.kind === 'promise') {
          const promiseInner = (valueType as PromiseType).inner;
          if (isAssignableTo(promiseInner, resolved)) return;
        }
        this.diagnostics.report({
          severity: 'error',
          code: D.E200,
          message: `Type '${typeToString(valueType)}' is not assignable to return type '${typeToString(resolved)}'`,
          span: node.value.span,
        });
      }
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
        if (isRecordLike(resolved)) {
          for (const field of rp.fields) {
            const fieldType = lookupRecordField(resolved, field.name.name);
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

  // ── Generic constraint helpers ──────────────────────────

  /**
   * Build TypeParam[] with resolved constraints from AST TypeParameter nodes.
   * Uses the `omitUndefined`-compliant Record pattern for `exactOptionalPropertyTypes`.
   */
  private buildTypeParams(
    astParams: readonly import('../parser/ast.js').TypeParameter[],
    generics: readonly { kind: 'generic'; name: string }[],
  ): TypeParam[] {
    return astParams.map(tp => {
      const result: Record<string, unknown> = { name: tp.name.name };
      if (tp.constraint) {
        result['constraint'] = this.resolveTypeNodeWithGenerics(tp.constraint, generics);
      }
      return result as unknown as TypeParam;
    });
  }

  /**
   * Push type parameter constraints into genericContext for field access resolution.
   * Returns saved state for restoration via popGenericContext.
   */
  private pushGenericContext(
    typeParams: readonly TypeParam[] | undefined,
  ): Map<string, { had: boolean; value: Type | undefined }> {
    const saved = new Map<string, { had: boolean; value: Type | undefined }>();
    if (!typeParams) return saved;
    for (const tp of typeParams) {
      saved.set(tp.name, {
        had: this.genericContext.has(tp.name),
        value: this.genericContext.get(tp.name),
      });
      this.genericContext.set(tp.name, tp.constraint);
    }
    return saved;
  }

  /** Restore genericContext from saved state produced by pushGenericContext. */
  private popGenericContext(saved: Map<string, { had: boolean; value: Type | undefined }>): void {
    for (const [name, prev] of saved) {
      if (prev.had) {
        this.genericContext.set(name, prev.value);
      } else {
        this.genericContext.delete(name);
      }
    }
  }

  /**
   * Look up the constraint for an in-scope generic type parameter.
   * Returns the constraint type, or undefined if the parameter is unconstrained or not in scope.
   */
  private getConstraintForGeneric(name: string): Type | undefined {
    return this.genericContext.get(name);
  }

  /**
   * Validate type arguments against constraints after generic instantiation.
   * Checks each inferred/explicit type arg against the corresponding TypeParam.constraint.
   */
  private validateConstraints(
    typeParams: readonly TypeParam[],
    typeMap: ReadonlyMap<string, Type>,
    span: Span,
  ): void {
    for (const tp of typeParams) {
      const arg = typeMap.get(tp.name);
      if (!tp.constraint || !arg) continue;
      const resolvedArg = resolveType(arg);
      // Skip constraint check for unresolved type variables, error types, and generic types
      if (resolvedArg.kind === 'error' || resolvedArg.kind === 'typevar' || resolvedArg.kind === 'generic') continue;
      // Any satisfies any constraint
      if (resolvedArg.kind === 'any') continue;

      // Substitute constraint: it may reference other type params (e.g., <T, U: Array<T>>)
      // Widen literals in the map so that e.g. T=1 becomes T=number when substituting
      // into another param's constraint — Array<number> should satisfy Array<T> where T was inferred as 1
      const widenedMap = new Map<string, Type>();
      for (const [k, v] of typeMap) {
        widenedMap.set(k, widenLiteral(v));
      }
      const substitutedConstraint = this.substituteType(tp.constraint, widenedMap);
      if (!isAssignableTo(resolvedArg, substitutedConstraint)) {
        this.diagnostics.report({
          severity: 'error',
          code: D.E250,
          message: `Type '${typeToString(resolvedArg)}' does not satisfy constraint '${typeToString(substitutedConstraint)}'`,
          span,
        });
      }
    }
  }

  /**
   * Substitute generic type parameter names in a type using a type map.
   * Used by constraint validation to substitute constraint types that reference other params.
   */
  private substituteType(type: Type, typeMap: ReadonlyMap<string, Type>): Type {
    const resolved = resolveType(type);
    switch (resolved.kind) {
      case 'generic': {
        const mapped = typeMap.get(resolved.name);
        return mapped ? resolveType(mapped) : resolved;
      }
      case 'array':
        return { kind: 'array', element: this.substituteType(resolved.element, typeMap) };
      case 'nullable':
        return { kind: 'nullable', inner: this.substituteType(resolved.inner, typeMap) };
      case 'function': {
        const params = resolved.params.map(p => ({
          ...p,
          type: this.substituteType(p.type, typeMap),
        }));
        return { kind: 'function', params, returnType: this.substituteType(resolved.returnType, typeMap) };
      }
      case 'record': {
        const fields = new Map<string, Type>();
        for (const [name, fieldType] of resolved.fields) {
          fields.set(name, this.substituteType(fieldType, typeMap));
        }
        return { kind: 'record', fields };
      }
      case 'adt': {
        const typeArgs = resolved.typeArgs.map(a => this.substituteType(a, typeMap));
        return { ...resolved, typeArgs };
      }
      case 'tuple': {
        const elements = resolved.elements.map(e => this.substituteType(e, typeMap));
        return { kind: 'tuple', elements };
      }
      case 'union': {
        const members = resolved.members.map(m => this.substituteType(m, typeMap));
        return simplifyUnion(members);
      }
      case 'promise':
        return { kind: 'promise', inner: this.substituteType(resolved.inner, typeMap) };
      case 'set':
        return { kind: 'set', element: this.substituteType(resolved.element, typeMap) };
      case 'map':
        return { kind: 'map', key: this.substituteType(resolved.key, typeMap), value: this.substituteType(resolved.value, typeMap) };
      default:
        return resolved;
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
          case 'Promise': {
            const innerType = nt.typeArgs && nt.typeArgs.length > 0
              ? this.resolveTypeNodeWithGenerics(nt.typeArgs[0], generics)
              : ANY;
            return { kind: 'promise', inner: innerType } as import('./types.js').PromiseType;
          }
          case 'Set': {
            if (nt.typeArgs && nt.typeArgs.length > 1) {
              this.diagnostics.report({
                severity: 'error',
                code: D.E200,
                message: `Set expects 0 or 1 type arguments, got ${nt.typeArgs.length}`,
                span: nt.name.span,
              });
            }
            const elemType = nt.typeArgs && nt.typeArgs.length > 0
              ? this.resolveTypeNodeWithGenerics(nt.typeArgs[0], generics)
              : ANY;
            return { kind: 'set', element: elemType } as import('./types.js').SetType;
          }
          case 'Map': {
            if (nt.typeArgs && (nt.typeArgs.length === 1 || nt.typeArgs.length > 2)) {
              this.diagnostics.report({
                severity: 'error',
                code: D.E200,
                message: `Map expects 0 or 2 type arguments, got ${nt.typeArgs.length}`,
                span: nt.name.span,
              });
            }
            const keyType = nt.typeArgs && nt.typeArgs.length >= 1
              ? this.resolveTypeNodeWithGenerics(nt.typeArgs[0], generics)
              : ANY;
            const valType = nt.typeArgs && nt.typeArgs.length >= 2
              ? this.resolveTypeNodeWithGenerics(nt.typeArgs[1], generics)
              : ANY;
            return { kind: 'map', key: keyType, value: valType } as import('./types.js').MapType;
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

        // Check genericContext for outer generic type parameters
        if (this.genericContext.has(name)) {
          return { kind: 'generic' as const, name };
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
        // Single-element "tuple" is just grouping parens — unwrap to the inner type.
        // This makes `((number) => void)?` correctly resolve to a nullable function.
        if (elements.length === 1) return elements[0];
        return { kind: 'tuple', elements };
      }

      case 'LiteralTypeNode': {
        const ltn = node as LiteralTypeNode;
        const lit = ltn.literal;
        if (lit.kind === 'StringLiteral') {
          return { kind: 'literal', base: 'string', value: lit.value };
        }
        if (lit.kind === 'NumberLiteral') {
          return { kind: 'literal', base: 'number', value: lit.value };
        }
        // BooleanLiteral
        return { kind: 'literal', base: 'boolean', value: lit.value };
      }

      case 'IntersectionType': {
        const it = node as IntersectionTypeNode;
        const members = it.members.map(m => this.resolveTypeNodeWithGenerics(m, generics));
        return this.mergeIntersection(members, it.span);
      }

      default:
        return ERROR_TYPE;
    }
  }

  /**
   * Merge intersection type members into a single record type.
   * All members must be record types (after resolution); non-record members report E251.
   */
  private mergeIntersection(members: readonly Type[], span: Span): Type {
    const mergedFields = new Map<string, Type>();
    for (const member of members) {
      const resolved = resolveType(member);
      // Resolve named type aliases that may be records
      if (resolved.kind === 'record') {
        for (const [name, type] of resolved.fields) {
          if (!mergedFields.has(name)) {
            mergedFields.set(name, type);
          }
          // Field name conflicts: leftmost member wins (per design)
        }
      } else {
        this.diagnostics.report({
          severity: 'error',
          code: D.E251,
          message: `Intersection constraint members must be record types; '${typeToString(resolved)}' is not a record type`,
          span,
        });
        return ERROR_TYPE;
      }
    }
    return { kind: 'record', fields: mergedFields } as RecordType;
  }

  // ── Generic instantiation ───────────────────────────────

  /**
   * Instantiate a generic function with explicit type arguments only.
   *
   * The argument-inference branch has been removed — all generic-without-explicit-typeargs
   * calls now use the two-pass approach in inferCallLike.
   */
  private instantiateCall(fn: FunctionType, node: { typeArgs?: readonly import('../parser/ast.js').TypeNode[]; args: readonly Expression[] }): FunctionType {
    if (!fn.typeParams || fn.typeParams.length === 0) return fn;

    const typeMap = new Map<string, Type>();

    if (node.typeArgs && node.typeArgs.length > 0) {
      for (let i = 0; i < fn.typeParams.length && i < node.typeArgs.length; i++) {
        typeMap.set(fn.typeParams[i].name, this.resolveTypeNode(node.typeArgs[i]));
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
      case 'set': return this.occursIn(name, t.element);
      case 'map': return this.occursIn(name, t.key) || this.occursIn(name, t.value);
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
      } else {
        // Multiple inference sites: if existing binding is a literal and new
        // candidate is its base primitive, widen to the primitive.
        const existing = typeMap.get(p.name)!;
        if (existing.kind === 'literal' && a.kind === 'primitive' && existing.base === a.name) {
          typeMap.set(p.name, a);
        }
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

    if (p.kind === 'promise' && a.kind === 'promise') {
      this.unifyForInference(p.inner, a.inner, typeMap);
    }

    if (p.kind === 'set' && a.kind === 'set') {
      this.unifyForInference(p.element, a.element, typeMap);
    }

    if (p.kind === 'map' && a.kind === 'map') {
      this.unifyForInference(p.key, a.key, typeMap);
      this.unifyForInference(p.value, a.value, typeMap);
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
      case 'set':
        return { kind: 'set', element: this.substitute(resolved.element, typeMap) };
      case 'map':
        return { kind: 'map', key: this.substitute(resolved.key, typeMap), value: this.substitute(resolved.value, typeMap) };
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
              this.declareBinding(identName, binding.type.inner, binding.mutable, binding.declared, binding.parameter, binding.contentMutable);
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
   * @param name           - The binding name.
   * @param type           - The binding's type.
   * @param mutable        - Whether the binding is mutable (`let mut`).
   * @param span           - Source span of the declaration.
   * @param parameter      - Whether this binding is a function parameter.
   * @param contentMutable - Whether content mutation is allowed (only for parameters).
   */
  private declareBinding(
    name: string, type: Type, mutable: boolean, span: Span,
    parameter = false, contentMutable = false,
  ): void {
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
      parameter,
      contentMutable,
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

