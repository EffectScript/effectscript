/**
 * @module scope
 *
 * Lexical scope management for the type checker.
 *
 * The {@link ScopeManager} maintains a linked-list stack of scopes. Each
 * scope holds two namespaces: **values** (variables, functions, constructors)
 * and **types** (type aliases, ADT names). Name resolution walks the chain
 * from innermost to outermost scope, returning the first match.
 *
 * The manager also provides mutability enforcement ({@link ScopeManager.assertMutable})
 * and unused-binding detection ({@link ScopeManager.getUnreferencedBindings}).
 */

import type { Span } from '../utils/span.js';
import type { Type } from './types.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';

// ── Binding Info ────────────────────────────────────────────

/** Metadata for a declared value binding (variable, function, constructor). */
export interface BindingInfo {
  /** The type of the binding. Mutable: Pass 2 may refine placeholder types from Pass 1b. */
  type: Type;
  /** Whether the binding was declared with `var` (mutable). */
  readonly mutable: boolean;
  /** Source location of the declaration (used in related-span diagnostics). */
  readonly declared: Span;
  /** Whether the binding has been referenced at least once. Mutated during checking. */
  referenced: boolean;
  /** Whether this binding is a function parameter (subject to value semantics). */
  readonly parameter: boolean;
  /** Whether content mutation is allowed (only relevant when parameter is true). */
  readonly contentMutable: boolean;
}

// ── Scope ───────────────────────────────────────────────────

/**
 * A single lexical scope node in the scope chain.
 *
 * Scopes form a singly-linked list via `parent`. The root scope
 * (global) has `parent === undefined`.
 */
interface Scope {
  /** Value bindings declared in this scope. */
  readonly values: Map<string, BindingInfo>;
  /** Type bindings declared in this scope. */
  readonly types: Map<string, Type>;
  /** The enclosing scope, or `undefined` for the global scope. */
  readonly parent: Scope | undefined;
}

// ── ScopeManager ────────────────────────────────────────────

/**
 * Manages a stack of lexical scopes for value and type name resolution.
 *
 * The checker pushes a new scope on block/function entry and pops it on exit.
 * Name resolution walks the chain from innermost to outermost, returning the
 * first match. The global (root) scope cannot be popped.
 */
export class ScopeManager {
  /** The current innermost scope. */
  private current: Scope;

  /** Create a new scope manager with an empty global scope. */
  constructor() {
    this.current = { values: new Map(), types: new Map(), parent: undefined };
  }

  /** Push a new child scope onto the scope chain. */
  pushScope(): void {
    this.current = { values: new Map(), types: new Map(), parent: this.current };
  }

  /**
   * Pop the current scope, returning to the parent.
   *
   * @throws If called when already at the global (root) scope.
   */
  popScope(): void {
    if (this.current.parent === undefined) {
      throw new Error('Cannot pop the global scope');
    }
    this.current = this.current.parent;
  }

  // ── Value bindings ──────────────────────────────────────

  /**
   * Declare a new value binding in the current scope.
   *
   * @param name - The binding name.
   * @param info - The binding metadata (type, mutability, span).
   * @throws If a binding with the same name already exists in the current scope.
   */
  declare(name: string, info: BindingInfo): void {
    if (this.current.values.has(name)) {
      throw new Error(`Duplicate declaration '${name}' in the same scope`);
    }
    this.current.values.set(name, info);
  }

  /**
   * Look up a value binding by name, searching from innermost to outermost scope.
   *
   * @param name - The binding name to look up.
   * @returns The {@link BindingInfo} if found, or `undefined` if not declared.
   */
  resolve(name: string): BindingInfo | undefined {
    let scope: Scope | undefined = this.current;
    while (scope !== undefined) {
      const info = scope.values.get(name);
      if (info !== undefined) return info;
      scope = scope.parent;
    }
    return undefined;
  }

  /** Returns true if `name` is already declared in the current (innermost) scope. */
  isInCurrentScope(name: string): boolean {
    return this.current.values.has(name);
  }

  /**
   * Mark a binding as referenced (used). Walks the scope chain to find it.
   *
   * No-op if the name is not found in any scope.
   *
   * @param name - The binding name to mark.
   */
  markReferenced(name: string): void {
    let scope: Scope | undefined = this.current;
    while (scope !== undefined) {
      const info = scope.values.get(name);
      if (info !== undefined) {
        info.referenced = true;
        return;
      }
      scope = scope.parent;
    }
  }

  // ── Type bindings ───────────────────────────────────────

  /**
   * Declare a type binding in the current scope (e.g. a type alias or ADT).
   *
   * Overwrites any existing type with the same name in the current scope.
   *
   * @param name - The type name.
   * @param type - The type to bind.
   */
  declareType(name: string, type: Type): void {
    this.current.types.set(name, type);
  }

  /**
   * Look up a type binding by name, searching from innermost to outermost scope.
   *
   * @param name - The type name to look up.
   * @returns The resolved {@link Type} if found, or `undefined`.
   */
  resolveType(name: string): Type | undefined {
    let scope: Scope | undefined = this.current;
    while (scope !== undefined) {
      const t = scope.types.get(name);
      if (t !== undefined) return t;
      scope = scope.parent;
    }
    return undefined;
  }

  /**
   * Reverse-lookup: find the type alias name for a given type.
   * Searches from innermost to outermost scope, returning the first match.
   */
  findTypeName(type: Type): string | undefined {
    let scope: Scope | undefined = this.current;
    while (scope !== undefined) {
      for (const [name, t] of scope.types) {
        if (t === type) return name;
      }
      scope = scope.parent;
    }
    return undefined;
  }

  // ── Mutability check ───────────────────────────────────

  /**
   * Assert that a binding is mutable. Reports E202 if it is not.
   *
   * @param name        - The binding name to check.
   * @param span        - The source span of the assignment (for the diagnostic).
   * @param diagnostics - Collector to report the error to.
   * @returns `true` if the binding is mutable, `false` otherwise (including when not found).
   */
  assertMutable(name: string, span: Span, diagnostics: DiagnosticCollector): boolean {
    const info = this.resolve(name);
    if (info === undefined) return false;
    if (!info.mutable) {
      diagnostics.report({
        severity: 'error',
        code: D.E202,
        message: `Cannot assign to immutable binding '${name}'`,
        span,
        relatedSpans: [{
          span: info.declared,
          message: `'${name}' declared as immutable here`,
        }],
        fix: {
          description: `Declare '${name}' as mutable with 'var'`,
          edits: [],
        },
      });
      return false;
    }
    return true;
  }

  // ── Unused binding detection ───────────────────────────

  /**
   * Collect all bindings across all scopes that were never referenced.
   *
   * Used at the end of type checking to emit unused-variable warnings.
   *
   * @returns An array of {@link BindingInfo} entries with `referenced === false`.
   */
  getUnreferencedBindings(): readonly BindingInfo[] {
    const result: BindingInfo[] = [];
    let scope: Scope | undefined = this.current;
    while (scope !== undefined) {
      for (const info of scope.values.values()) {
        if (!info.referenced) {
          result.push(info);
        }
      }
      scope = scope.parent;
    }
    return result;
  }
}
