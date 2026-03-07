import { describe, it, expect } from 'vitest';
import { ScopeManager } from './scope.js';
import type { PrimitiveType, Type } from './types.js';
import type { Span } from '../utils/span.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';

// ── Helpers ──────────────────────────────────────────────────────────

const num: PrimitiveType = { kind: 'primitive', name: 'number' };
const str: PrimitiveType = { kind: 'primitive', name: 'string' };
const bool: PrimitiveType = { kind: 'primitive', name: 'boolean' };

function dummySpan(): Span {
  return {
    file: 'test.efs',
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: 1, line: 1, column: 1 },
  };
}

function binding(type: Type, mutable = false) {
  return { type, mutable, declared: dummySpan(), referenced: false };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('scope.ts', () => {

  describe('declare and resolve', () => {
    it('declares and resolves a binding', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      const info = scope.resolve('x');
      expect(info).toBeDefined();
      expect(info!.type).toEqual(num);
    });

    it('resolves walks up scope chain', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.pushScope();
      const info = scope.resolve('x');
      expect(info).toBeDefined();
      expect(info!.type).toEqual(num);
    });

    it('inner scope shadows outer scope', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.pushScope();
      scope.declare('x', binding(str));
      const info = scope.resolve('x');
      expect(info).toBeDefined();
      expect(info!.type).toEqual(str);
    });

    it('duplicate in same scope throws', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      expect(() => scope.declare('x', binding(str))).toThrow();
    });

    it('same name in inner scope is OK (shadowing)', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.pushScope();
      expect(() => scope.declare('x', binding(str))).not.toThrow();
    });

    it('undefined name resolves to undefined', () => {
      const scope = new ScopeManager();
      expect(scope.resolve('x')).toBeUndefined();
    });
  });

  describe('type bindings', () => {
    it('type bindings are separate from value bindings', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.declareType('x', str);
      expect(scope.resolve('x')!.type).toEqual(num);
      expect(scope.resolveType('x')).toEqual(str);
    });

    it('type bindings walk up scope chain', () => {
      const scope = new ScopeManager();
      scope.declareType('T', num);
      scope.pushScope();
      expect(scope.resolveType('T')).toEqual(num);
    });

    it('undefined type resolves to undefined', () => {
      const scope = new ScopeManager();
      expect(scope.resolveType('T')).toBeUndefined();
    });
  });

  describe('assertMutable', () => {
    it('immutable binding reports diagnostic', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num, false));
      const diag = new DiagnosticCollectorImpl();
      const result = scope.assertMutable('x', dummySpan(), diag);
      expect(result).toBe(false);
      expect(diag.hasErrors()).toBe(true);
    });

    it('mutable binding succeeds', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num, true));
      const diag = new DiagnosticCollectorImpl();
      const result = scope.assertMutable('x', dummySpan(), diag);
      expect(result).toBe(true);
      expect(diag.hasErrors()).toBe(false);
    });

    it('undefined binding returns false', () => {
      const scope = new ScopeManager();
      const diag = new DiagnosticCollectorImpl();
      const result = scope.assertMutable('x', dummySpan(), diag);
      expect(result).toBe(false);
    });

    it('E202 includes relatedSpan pointing to declaration', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num, false));
      const diag = new DiagnosticCollectorImpl();
      scope.assertMutable('x', dummySpan(), diag);
      const errors = diag.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].relatedSpans).toBeDefined();
      expect(errors[0].relatedSpans!).toHaveLength(1);
      expect(errors[0].relatedSpans![0].message).toContain('immutable');
    });

    it('E202 relatedSpan message includes binding name', () => {
      const scope = new ScopeManager();
      scope.declare('myVar', binding(num, false));
      const diag = new DiagnosticCollectorImpl();
      scope.assertMutable('myVar', dummySpan(), diag);
      const errors = diag.getErrors();
      expect(errors[0].relatedSpans![0].message).toContain('myVar');
    });

    it('E202 includes suggested fix for let mut', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num, false));
      const diag = new DiagnosticCollectorImpl();
      scope.assertMutable('x', dummySpan(), diag);
      const errors = diag.getErrors();
      expect(errors[0].fix).toBeDefined();
      expect(errors[0].fix!.description).toContain('let mut');
    });

    it('E202 suggested fix has empty edits', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num, false));
      const diag = new DiagnosticCollectorImpl();
      scope.assertMutable('x', dummySpan(), diag);
      const errors = diag.getErrors();
      expect(errors[0].fix!.edits).toHaveLength(0);
    });
  });

  describe('referenced tracking', () => {
    it('getUnreferencedBindings returns only unreferenced', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.declare('y', binding(str));
      scope.markReferenced('x');
      const unreferenced = scope.getUnreferencedBindings();
      expect(unreferenced.length).toBe(1);
      expect(unreferenced[0].type).toEqual(str);
    });

    it('markReferenced prevents appearing as unreferenced', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.markReferenced('x');
      expect(scope.getUnreferencedBindings().length).toBe(0);
    });

    it('all bindings unreferenced when none marked', () => {
      const scope = new ScopeManager();
      scope.declare('a', binding(num));
      scope.declare('b', binding(str));
      expect(scope.getUnreferencedBindings().length).toBe(2);
    });
  });

  describe('popScope', () => {
    it('restores parent scope', () => {
      const scope = new ScopeManager();
      scope.declare('x', binding(num));
      scope.pushScope();
      scope.declare('y', binding(str));
      expect(scope.resolve('y')).toBeDefined();
      scope.popScope();
      expect(scope.resolve('y')).toBeUndefined();
      expect(scope.resolve('x')).toBeDefined();
    });

    it('popping global scope throws', () => {
      const scope = new ScopeManager();
      expect(() => scope.popScope()).toThrow();
    });
  });
});
