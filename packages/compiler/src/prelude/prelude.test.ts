import { describe, it, expect } from 'vitest';
import { createPrelude, registerPrelude } from './prelude.js';
import { ScopeManager } from '../checker/scope.js';
import type { Type, ADTType, FunctionType } from '../checker/types.js';

describe('prelude.ts', () => {
  describe('createPrelude', () => {
    it('creates prelude with Result type', () => {
      const prelude = createPrelude();
      const resultType = prelude.types.get('Result');
      expect(resultType).toBeDefined();
      expect(resultType!.kind).toBe('adt');
      const adt = resultType as ADTType;
      expect(adt.name).toBe('Result');
      expect(adt.typeArgs.length).toBe(2);
      expect(adt.variants.length).toBe(2);
      expect(adt.variants[0].name).toBe('Ok');
      expect(adt.variants[1].name).toBe('Err');
    });

    it('creates Ok constructor function', () => {
      const prelude = createPrelude();
      const ok = prelude.adtConstructors.get('Ok');
      expect(ok).toBeDefined();
      expect(ok!.kind).toBe('function');
      expect(ok!.params.length).toBe(1);
      expect(ok!.params[0].name).toBe('value');
    });

    it('creates Err constructor function', () => {
      const prelude = createPrelude();
      const err = prelude.adtConstructors.get('Err');
      expect(err).toBeDefined();
      expect(err!.kind).toBe('function');
      expect(err!.params.length).toBe(1);
      expect(err!.params[0].name).toBe('error');
    });

    it('creates attempt function', () => {
      const prelude = createPrelude();
      const attempt = prelude.values.get('attempt');
      expect(attempt).toBeDefined();
      expect(attempt!.kind).toBe('function');
      const fn = attempt as FunctionType;
      expect(fn.params.length).toBe(1);
      expect(fn.typeParams).toBeDefined();
      expect(fn.typeParams!.length).toBe(1);
      // Return type is Result<T, Error>
      expect(fn.returnType.kind).toBe('adt');
    });

    it('creates print function', () => {
      const prelude = createPrelude();
      const print = prelude.values.get('print');
      expect(print).toBeDefined();
      expect(print!.kind).toBe('function');
      const fn = print as FunctionType;
      expect(fn.params.length).toBe(1);
      expect(fn.params[0].type.kind).toBe('any');
      expect(fn.returnType.kind).toBe('primitive');
      expect((fn.returnType as { name: string }).name).toBe('void');
    });
  });

  describe('registerPrelude', () => {
    it('registers Result type in scope', () => {
      const prelude = createPrelude();
      const scope = new ScopeManager();
      registerPrelude(prelude, scope);
      expect(scope.resolveType('Result')).toBeDefined();
    });

    it('registers Ok and Err constructors in scope', () => {
      const prelude = createPrelude();
      const scope = new ScopeManager();
      registerPrelude(prelude, scope);
      expect(scope.resolve('Ok')).toBeDefined();
      expect(scope.resolve('Err')).toBeDefined();
    });

    it('registers attempt in scope', () => {
      const prelude = createPrelude();
      const scope = new ScopeManager();
      registerPrelude(prelude, scope);
      expect(scope.resolve('attempt')).toBeDefined();
    });

    it('registers print in scope', () => {
      const prelude = createPrelude();
      const scope = new ScopeManager();
      registerPrelude(prelude, scope);
      expect(scope.resolve('print')).toBeDefined();
    });

    it('prelude bindings are not mutable', () => {
      const prelude = createPrelude();
      const scope = new ScopeManager();
      registerPrelude(prelude, scope);
      const okBinding = scope.resolve('Ok');
      expect(okBinding!.mutable).toBe(false);
    });
  });
});
