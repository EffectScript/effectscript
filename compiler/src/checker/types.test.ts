import { describe, it, expect } from 'vitest';
import {
  type Type,
  type PrimitiveType,
  type NullableType,
  type FunctionType,
  type RecordType,
  type ArrayType,
  type TupleType,
  type UnionType,
  type ADTType,
  type GenericType,
  type TypeVariable,
  type PromiseType,
  type ErrorType,
  type AnyType,
  type NullType,
  type LiteralType,
  type ADTVariant,
  type ParamType,
  isAssignableTo,
  isNullable,
  unwrapNullable,
  makeNullable,
  typesEqual,
  typeToString,
  flattenUnion,
  simplifyUnion,
  resolveType,
  freshTypeVar,
  widenLiteral,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────

const num: PrimitiveType = { kind: 'primitive', name: 'number' };
const str: PrimitiveType = { kind: 'primitive', name: 'string' };
const bool: PrimitiveType = { kind: 'primitive', name: 'boolean' };
const voidT: PrimitiveType = { kind: 'primitive', name: 'void' };
const never: PrimitiveType = { kind: 'primitive', name: 'never' };
const anyT: AnyType = { kind: 'any' };
const nullT: NullType = { kind: 'null' };
const errorT: ErrorType = { kind: 'error' };

function nullable(inner: Type): NullableType {
  return { kind: 'nullable', inner };
}

function fnType(params: ParamType[], returnType: Type): FunctionType {
  return { kind: 'function', params, returnType };
}

function param(name: string, type: Type, optional = false, hasDefault = false): ParamType {
  return { name, type, optional, hasDefault };
}

function record(fields: Record<string, Type>): RecordType {
  return { kind: 'record', fields: new Map(Object.entries(fields)) };
}

function array(element: Type): ArrayType {
  return { kind: 'array', element };
}

function tuple(...elements: Type[]): TupleType {
  return { kind: 'tuple', elements };
}

function union(...members: Type[]): UnionType {
  return { kind: 'union', members };
}

function adt(name: string, typeArgs: Type[], variants: ADTVariant[]): ADTType {
  return { kind: 'adt', name, typeArgs, variants };
}

function generic(name: string): GenericType {
  return { kind: 'generic', name };
}

function promise(inner: Type): PromiseType {
  return { kind: 'promise', inner };
}

function literal(base: 'string' | 'number' | 'boolean', value: string | number | boolean): LiteralType {
  return { kind: 'literal', base, value };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('types.ts', () => {

  // ── Assignability ────────────────────────────────────────────────

  describe('isAssignableTo', () => {
    it('primitive to same primitive', () => {
      expect(isAssignableTo(num, num)).toBe(true);
      expect(isAssignableTo(str, str)).toBe(true);
      expect(isAssignableTo(bool, bool)).toBe(true);
    });

    it('primitive to different primitive', () => {
      expect(isAssignableTo(num, str)).toBe(false);
      expect(isAssignableTo(str, bool)).toBe(false);
      expect(isAssignableTo(bool, num)).toBe(false);
    });

    it('Any is assignable to everything and everything to Any', () => {
      expect(isAssignableTo(anyT, num)).toBe(true);
      expect(isAssignableTo(anyT, str)).toBe(true);
      expect(isAssignableTo(num, anyT)).toBe(true);
      expect(isAssignableTo(str, anyT)).toBe(true);
      expect(isAssignableTo(anyT, anyT)).toBe(true);
    });

    it('ErrorType behaves like Any for assignability', () => {
      expect(isAssignableTo(errorT, num)).toBe(true);
      expect(isAssignableTo(num, errorT)).toBe(true);
      expect(isAssignableTo(errorT, errorT)).toBe(true);
    });

    it('never is assignable to everything', () => {
      expect(isAssignableTo(never, num)).toBe(true);
      expect(isAssignableTo(never, str)).toBe(true);
      expect(isAssignableTo(never, nullable(num))).toBe(true);
    });

    it('nothing is assignable to never (except never and Any)', () => {
      expect(isAssignableTo(num, never)).toBe(false);
      expect(isAssignableTo(str, never)).toBe(false);
      expect(isAssignableTo(never, never)).toBe(true);
      expect(isAssignableTo(anyT, never)).toBe(true);
      expect(isAssignableTo(errorT, never)).toBe(true);
    });

    it('null assignable to T? but not to T', () => {
      expect(isAssignableTo(nullT, nullable(num))).toBe(true);
      expect(isAssignableTo(nullT, num)).toBe(false);
    });

    it('T assignable to T?', () => {
      expect(isAssignableTo(num, nullable(num))).toBe(true);
      expect(isAssignableTo(str, nullable(str))).toBe(true);
    });

    it('T? not assignable to T', () => {
      expect(isAssignableTo(nullable(num), num)).toBe(false);
      expect(isAssignableTo(nullable(str), str)).toBe(false);
    });

    it('record width subtyping: extra fields OK', () => {
      const source = record({ a: num, b: str });
      const target = record({ a: num });
      expect(isAssignableTo(source, target)).toBe(true);
    });

    it('record depth subtyping: nested records checked recursively', () => {
      const source = record({ user: record({ name: str, age: num }) });
      const target = record({ user: record({ name: str }) });
      expect(isAssignableTo(source, target)).toBe(true);
    });

    it('record missing field', () => {
      const source = record({ a: num });
      const target = record({ a: num, b: str });
      expect(isAssignableTo(source, target)).toBe(false);
    });

    it('record field type mismatch', () => {
      const source = record({ a: str });
      const target = record({ a: num });
      expect(isAssignableTo(source, target)).toBe(false);
    });

    it('function types: compatible params and return', () => {
      const f1 = fnType([param('x', num)], str);
      const f2 = fnType([param('x', num)], str);
      expect(isAssignableTo(f1, f2)).toBe(true);
    });

    it('function contravariance on params', () => {
      // (Any) => void is assignable to (number) => void (contravariant)
      const f1 = fnType([param('x', anyT)], voidT);
      const f2 = fnType([param('x', num)], voidT);
      expect(isAssignableTo(f1, f2)).toBe(true);
    });

    it('function covariance on return type', () => {
      // () => number is assignable to () => number|string
      const f1 = fnType([], num);
      const f2 = fnType([], union(num, str));
      expect(isAssignableTo(f1, f2)).toBe(true);
    });

    it('function param count mismatch', () => {
      const f1 = fnType([param('x', num)], voidT);
      const f2 = fnType([param('x', num), param('y', str)], voidT);
      expect(isAssignableTo(f1, f2)).toBe(false);
    });

    it('function optional params: fewer required params OK', () => {
      const f1 = fnType([param('x', num)], voidT);
      const f2 = fnType([param('x', num), param('y', str, true)], voidT);
      expect(isAssignableTo(f1, f2)).toBe(true);
    });

    it('array covariance', () => {
      expect(isAssignableTo(array(num), array(num))).toBe(true);
      expect(isAssignableTo(array(num), array(str))).toBe(false);
    });

    it('tuple same length and elements assignable', () => {
      expect(isAssignableTo(tuple(num, str), tuple(num, str))).toBe(true);
    });

    it('tuple length mismatch', () => {
      expect(isAssignableTo(tuple(num), tuple(num, str))).toBe(false);
    });

    it('tuple element mismatch', () => {
      expect(isAssignableTo(tuple(num, num), tuple(num, str))).toBe(false);
    });

    it('union assignability: T assignable to T | U', () => {
      expect(isAssignableTo(num, union(num, str))).toBe(true);
      expect(isAssignableTo(str, union(num, str))).toBe(true);
    });

    it('union assignability: T | U assignable to V if both T and U assignable to V', () => {
      expect(isAssignableTo(union(num, num), num)).toBe(true);
      expect(isAssignableTo(union(num, str), num)).toBe(false);
    });

    it('union assignable to nullable: string | null → string?', () => {
      expect(isAssignableTo(union(str, nullT), nullable(str))).toBe(true);
    });

    it('union assignable to nullable: number | null → number?', () => {
      expect(isAssignableTo(union(num, nullT), nullable(num))).toBe(true);
    });

    it('union NOT assignable to mismatched nullable: string | number | null → string?', () => {
      expect(isAssignableTo(union(str, num, nullT), nullable(str))).toBe(false);
    });

    it('ADT nominal: same name = assignable', () => {
      const a1 = adt('Result', [num, str], []);
      const a2 = adt('Result', [num, str], []);
      expect(isAssignableTo(a1, a2)).toBe(true);
    });

    it('ADT nominal: different name = not assignable', () => {
      const a1 = adt('Result', [], []);
      const a2 = adt('Option', [], []);
      expect(isAssignableTo(a1, a2)).toBe(false);
    });

    it('ADT with different type args = not assignable', () => {
      const a1 = adt('Result', [num, str], []);
      const a2 = adt('Result', [str, str], []);
      expect(isAssignableTo(a1, a2)).toBe(false);
    });

    it('promise covariance', () => {
      expect(isAssignableTo(promise(num), promise(num))).toBe(true);
      expect(isAssignableTo(promise(num), promise(str))).toBe(false);
    });

    it('generic types equal if same name', () => {
      expect(isAssignableTo(generic('T'), generic('T'))).toBe(true);
      expect(isAssignableTo(generic('T'), generic('U'))).toBe(false);
    });

    it('void assignable to void', () => {
      expect(isAssignableTo(voidT, voidT)).toBe(true);
    });

    it('null assignable to null', () => {
      expect(isAssignableTo(nullT, nullT)).toBe(true);
    });

    it('resolves type variables before checking', () => {
      const tv = freshTypeVar();
      tv.resolved = num;
      expect(isAssignableTo(tv, num)).toBe(true);
      expect(isAssignableTo(num, tv)).toBe(true);
    });
  });

  // ── Nullable Helpers ─────────────────────────────────────────────

  describe('isNullable', () => {
    it('nullable type returns true', () => {
      expect(isNullable(nullable(num))).toBe(true);
    });

    it('non-nullable type returns false', () => {
      expect(isNullable(num)).toBe(false);
      expect(isNullable(str)).toBe(false);
    });

    it('null type is not "nullable" (it IS null, not T?)', () => {
      expect(isNullable(nullT)).toBe(false);
    });
  });

  describe('unwrapNullable', () => {
    it('unwraps T? to T', () => {
      expect(unwrapNullable(nullable(num))).toEqual(num);
    });

    it('returns non-nullable type as-is', () => {
      expect(unwrapNullable(num)).toEqual(num);
    });
  });

  describe('makeNullable', () => {
    it('wraps T as T?', () => {
      expect(makeNullable(num)).toEqual(nullable(num));
    });

    it('normalizes double-nullable T?? to T?', () => {
      expect(makeNullable(nullable(num))).toEqual(nullable(num));
    });

    it('null becomes null? which wraps null', () => {
      const result = makeNullable(nullT);
      expect(result.kind).toBe('nullable');
    });
  });

  // ── typesEqual ───────────────────────────────────────────────────

  describe('typesEqual', () => {
    it('same primitive', () => {
      expect(typesEqual(num, num)).toBe(true);
    });

    it('different primitive', () => {
      expect(typesEqual(num, str)).toBe(false);
    });

    it('nullable types', () => {
      expect(typesEqual(nullable(num), nullable(num))).toBe(true);
      expect(typesEqual(nullable(num), nullable(str))).toBe(false);
    });

    it('function types', () => {
      const f1 = fnType([param('x', num)], str);
      const f2 = fnType([param('x', num)], str);
      const f3 = fnType([param('x', str)], str);
      expect(typesEqual(f1, f2)).toBe(true);
      expect(typesEqual(f1, f3)).toBe(false);
    });

    it('record types', () => {
      expect(typesEqual(record({ a: num }), record({ a: num }))).toBe(true);
      expect(typesEqual(record({ a: num }), record({ a: str }))).toBe(false);
      expect(typesEqual(record({ a: num }), record({ a: num, b: str }))).toBe(false);
    });

    it('array types', () => {
      expect(typesEqual(array(num), array(num))).toBe(true);
      expect(typesEqual(array(num), array(str))).toBe(false);
    });

    it('tuple types', () => {
      expect(typesEqual(tuple(num, str), tuple(num, str))).toBe(true);
      expect(typesEqual(tuple(num), tuple(num, str))).toBe(false);
    });

    it('union types', () => {
      expect(typesEqual(union(num, str), union(num, str))).toBe(true);
      expect(typesEqual(union(num, str), union(str, num))).toBe(false);
    });

    it('ADT types', () => {
      const v: ADTVariant = { name: 'Ok', fields: new Map([['value', num]]) };
      expect(typesEqual(adt('R', [num], [v]), adt('R', [num], [v]))).toBe(true);
      expect(typesEqual(adt('R', [num], [v]), adt('S', [num], [v]))).toBe(false);
    });

    it('generic types', () => {
      expect(typesEqual(generic('T'), generic('T'))).toBe(true);
      expect(typesEqual(generic('T'), generic('U'))).toBe(false);
    });

    it('promise types', () => {
      expect(typesEqual(promise(num), promise(num))).toBe(true);
      expect(typesEqual(promise(num), promise(str))).toBe(false);
    });

    it('any, null, error', () => {
      expect(typesEqual(anyT, anyT)).toBe(true);
      expect(typesEqual(nullT, nullT)).toBe(true);
      expect(typesEqual(errorT, errorT)).toBe(true);
      expect(typesEqual(anyT, nullT)).toBe(false);
    });

    it('resolves type variables before comparing', () => {
      const tv = freshTypeVar();
      tv.resolved = num;
      expect(typesEqual(tv, num)).toBe(true);
    });
  });

  // ── typeToString ─────────────────────────────────────────────────

  describe('typeToString', () => {
    it('primitives', () => {
      expect(typeToString(num)).toBe('number');
      expect(typeToString(str)).toBe('string');
      expect(typeToString(bool)).toBe('boolean');
      expect(typeToString(voidT)).toBe('void');
      expect(typeToString(never)).toBe('never');
    });

    it('any, null, error', () => {
      expect(typeToString(anyT)).toBe('Any');
      expect(typeToString(nullT)).toBe('null');
      expect(typeToString(errorT)).toBe('<error>');
    });

    it('nullable', () => {
      expect(typeToString(nullable(num))).toBe('number?');
    });

    it('function', () => {
      expect(typeToString(fnType([param('x', num)], str))).toBe('(number) => string');
      expect(typeToString(fnType([], voidT))).toBe('() => void');
      expect(typeToString(fnType([param('a', num), param('b', str)], bool))).toBe('(number, string) => boolean');
    });

    it('function with rest params', () => {
      const fn: FunctionType = { kind: 'function', params: [param('msg', str)], returnType: voidT, rest: { name: 'args', elementType: str } };
      expect(typeToString(fn)).toBe('(string, ...string[]) => void');
      const restOnly: FunctionType = { kind: 'function', params: [], returnType: num, rest: { name: 'nums', elementType: num } };
      expect(typeToString(restOnly)).toBe('(...number[]) => number');
    });

    it('record', () => {
      const result = typeToString(record({ name: str, age: num }));
      expect(result).toBe('{ name: string, age: number }');
    });

    it('array', () => {
      expect(typeToString(array(num))).toBe('Array<number>');
    });

    it('tuple', () => {
      expect(typeToString(tuple(num, str))).toBe('(number, string)');
    });

    it('union', () => {
      expect(typeToString(union(num, str))).toBe('number | string');
    });

    it('ADT', () => {
      expect(typeToString(adt('Result', [num, str], []))).toBe('Result<number, string>');
      expect(typeToString(adt('Option', [], []))).toBe('Option');
    });

    it('generic', () => {
      expect(typeToString(generic('T'))).toBe('T');
    });

    it('promise', () => {
      expect(typeToString(promise(num))).toBe('Promise<number>');
    });

    it('type variable (unresolved)', () => {
      const tv = freshTypeVar();
      expect(typeToString(tv)).toMatch(/^\?T\d+$/);
    });

    it('type variable (resolved)', () => {
      const tv = freshTypeVar();
      tv.resolved = num;
      expect(typeToString(tv)).toBe('number');
    });

    it('self-referential record type does not stack overflow', () => {
      // Simulate: interface Node { value: string; next: Node }
      const fields = new Map<string, Type>();
      const selfRef: RecordType = { kind: 'record', fields };
      fields.set('value', str);
      fields.set('next', selfRef);
      // Should terminate and contain <recursive> for the cycle
      const result = typeToString(selfRef);
      expect(result).toContain('value: string');
      expect(result).toContain('<recursive>');
    });

    it('mutually recursive types (A→B→A) terminate', () => {
      // Simulate: interface A { b: B }, interface B { a: A }
      const fieldsA = new Map<string, Type>();
      const fieldsB = new Map<string, Type>();
      const typeA: RecordType = { kind: 'record', fields: fieldsA };
      const typeB: RecordType = { kind: 'record', fields: fieldsB };
      fieldsA.set('b', typeB);
      fieldsB.set('a', typeA);
      const result = typeToString(typeA);
      expect(result).toContain('<recursive>');
    });

    it('deeply nested type (20+ levels) terminates', () => {
      // Build a chain of nested records: { inner: { inner: { ... } } }
      let current: Type = str;
      for (let i = 0; i < 50; i++) {
        current = { kind: 'record', fields: new Map([['inner', current]]) };
      }
      // Should terminate without stack overflow — and no false-positive cycle detection
      const result = typeToString(current);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).not.toContain('<recursive>');
    });

    it('self-referential function param does not stack overflow', () => {
      // Simulate: (self: RecordWithSelf) => void where RecordWithSelf has method returning itself
      const fields = new Map<string, Type>();
      const selfRecord: RecordType = { kind: 'record', fields };
      const selfFn: FunctionType = {
        kind: 'function',
        params: [{ name: 'self', type: selfRecord, optional: false, hasDefault: false }],
        returnType: selfRecord,
      };
      fields.set('method', selfFn);
      const result = typeToString(selfRecord);
      expect(result).toContain('<recursive>');
    });

    it('set type', () => {
      expect(typeToString({ kind: 'set', element: num })).toBe('Set<number>');
    });

    it('map type', () => {
      expect(typeToString({ kind: 'map', key: str, value: num })).toBe('Map<string, number>');
    });
  });

  // ── flattenUnion ─────────────────────────────────────────────────

  describe('flattenUnion', () => {
    it('flattens nested unions', () => {
      const result = flattenUnion([union(num, str), bool]);
      expect(result).toEqual([num, str, bool]);
    });

    it('leaves non-union members as-is', () => {
      const result = flattenUnion([num, str]);
      expect(result).toEqual([num, str]);
    });

    it('deeply nested', () => {
      const result = flattenUnion([union(union(num, str), bool)]);
      expect(result).toEqual([num, str, bool]);
    });
  });

  // ── simplifyUnion ────────────────────────────────────────────────

  describe('simplifyUnion', () => {
    it('single member returns the type itself', () => {
      expect(simplifyUnion([num])).toEqual(num);
    });

    it('deduplicates identical types', () => {
      const result = simplifyUnion([num, num, str]);
      expect(result).toEqual(union(num, str));
    });

    it('returns union for multiple distinct types', () => {
      const result = simplifyUnion([num, str, bool]);
      expect(result).toEqual(union(num, str, bool));
    });

    it('empty array returns never', () => {
      expect(simplifyUnion([])).toEqual(never);
    });

    it('unifies same-ADT members with mixed typevar args', () => {
      const tv1 = freshTypeVar(); // unresolved
      const tv2 = freshTypeVar(); // unresolved
      const okBranch = adt('Result', [num, tv1], []);
      const errBranch = adt('Result', [tv2, str], []);
      const result = simplifyUnion([okBranch, errBranch]);
      expect(result.kind).toBe('adt');
      if (result.kind === 'adt') {
        expect(result.name).toBe('Result');
        expect(result.typeArgs).toHaveLength(2);
        expect(result.typeArgs[0]).toEqual(num);
        expect(result.typeArgs[1]).toEqual(str);
      }
    });

    it('does not unify different-named ADTs', () => {
      const a = adt('Result', [num], []);
      const b = adt('Option', [num], []);
      const result = simplifyUnion([a, b]);
      expect(result.kind).toBe('union');
    });

    it('unifies same-ADT with all concrete args', () => {
      const a = adt('Result', [num, str], []);
      const b = adt('Result', [num, str], []);
      const result = simplifyUnion([a, b]);
      expect(result.kind).toBe('adt');
      if (result.kind === 'adt') {
        expect(result.typeArgs).toEqual([num, str]);
      }
    });
  });

  // ── resolveType ──────────────────────────────────────────────────

  describe('resolveType', () => {
    it('returns non-typevar as-is', () => {
      expect(resolveType(num)).toEqual(num);
    });

    it('resolves single type variable', () => {
      const tv = freshTypeVar();
      tv.resolved = str;
      expect(resolveType(tv)).toEqual(str);
    });

    it('follows chains of type variables', () => {
      const tv1 = freshTypeVar();
      const tv2 = freshTypeVar();
      tv1.resolved = tv2;
      tv2.resolved = num;
      expect(resolveType(tv1)).toEqual(num);
    });

    it('returns unresolved type variable as-is', () => {
      const tv = freshTypeVar();
      const result = resolveType(tv);
      expect(result.kind).toBe('typevar');
    });
  });

  // ── freshTypeVar ─────────────────────────────────────────────────

  describe('freshTypeVar', () => {
    it('creates type variables with unique IDs', () => {
      const tv1 = freshTypeVar();
      const tv2 = freshTypeVar();
      expect(tv1.id).not.toBe(tv2.id);
    });

    it('starts unresolved', () => {
      const tv = freshTypeVar();
      expect(tv.resolved).toBeUndefined();
    });
  });

  // ── Literal Type ──────────────────────────────────────────────────

  describe('LiteralType', () => {
    describe('typesEqual', () => {
      it('same string literal', () => {
        expect(typesEqual(literal('string', 'GET'), literal('string', 'GET'))).toBe(true);
      });

      it('different string literals', () => {
        expect(typesEqual(literal('string', 'GET'), literal('string', 'POST'))).toBe(false);
      });

      it('same number literal', () => {
        expect(typesEqual(literal('number', 42), literal('number', 42))).toBe(true);
      });

      it('different number literals', () => {
        expect(typesEqual(literal('number', 42), literal('number', 43))).toBe(false);
      });

      it('same boolean literal', () => {
        expect(typesEqual(literal('boolean', true), literal('boolean', true))).toBe(true);
      });

      it('different boolean literals', () => {
        expect(typesEqual(literal('boolean', true), literal('boolean', false))).toBe(false);
      });

      it('literal vs primitive is not equal', () => {
        expect(typesEqual(literal('string', 'GET'), str)).toBe(false);
        expect(typesEqual(literal('number', 42), num)).toBe(false);
      });
    });

    describe('typeToString', () => {
      it('string literal', () => {
        expect(typeToString(literal('string', 'GET'))).toBe('"GET"');
      });

      it('number literal', () => {
        expect(typeToString(literal('number', 42))).toBe('42');
      });

      it('boolean literal true', () => {
        expect(typeToString(literal('boolean', true))).toBe('true');
      });

      it('boolean literal false', () => {
        expect(typeToString(literal('boolean', false))).toBe('false');
      });
    });

    describe('isAssignableTo', () => {
      it('literal assignable to same literal', () => {
        expect(isAssignableTo(literal('string', 'GET'), literal('string', 'GET'))).toBe(true);
      });

      it('literal NOT assignable to different literal', () => {
        expect(isAssignableTo(literal('string', 'GET'), literal('string', 'POST'))).toBe(false);
      });

      it('string literal assignable to string', () => {
        expect(isAssignableTo(literal('string', 'GET'), str)).toBe(true);
      });

      it('number literal assignable to number', () => {
        expect(isAssignableTo(literal('number', 42), num)).toBe(true);
      });

      it('boolean literal assignable to boolean', () => {
        expect(isAssignableTo(literal('boolean', true), bool)).toBe(true);
      });

      it('string NOT assignable to string literal', () => {
        expect(isAssignableTo(str, literal('string', 'GET'))).toBe(false);
      });

      it('number NOT assignable to number literal', () => {
        expect(isAssignableTo(num, literal('number', 42))).toBe(false);
      });

      it('literal union assignable to base primitive', () => {
        expect(isAssignableTo(
          union(literal('string', 'GET'), literal('string', 'POST')),
          str,
        )).toBe(true);
      });

      it('base primitive NOT assignable to literal union', () => {
        expect(isAssignableTo(
          str,
          union(literal('string', 'GET'), literal('string', 'POST')),
        )).toBe(false);
      });

      it('literal assignable to union containing it', () => {
        expect(isAssignableTo(
          literal('string', 'GET'),
          union(literal('string', 'GET'), literal('string', 'POST')),
        )).toBe(true);
      });

      it('literal NOT assignable to union not containing it', () => {
        expect(isAssignableTo(
          literal('string', 'PATCH'),
          union(literal('string', 'GET'), literal('string', 'POST')),
        )).toBe(false);
      });
    });

    describe('widenLiteral', () => {
      it('widens string literal to string', () => {
        expect(widenLiteral(literal('string', 'hello'))).toEqual(str);
      });

      it('widens number literal to number', () => {
        expect(widenLiteral(literal('number', 42))).toEqual(num);
      });

      it('widens boolean literal to boolean', () => {
        expect(widenLiteral(literal('boolean', true))).toEqual(bool);
      });

      it('returns non-literal type unchanged', () => {
        expect(widenLiteral(str)).toEqual(str);
        expect(widenLiteral(num)).toEqual(num);
      });
    });

    describe('simplifyUnion with literals', () => {
      it('string | "hello" simplifies to string', () => {
        const result = simplifyUnion([str, literal('string', 'hello')]);
        expect(result).toEqual(str);
      });

      it('"GET" | "POST" stays as union', () => {
        const result = simplifyUnion([literal('string', 'GET'), literal('string', 'POST')]);
        expect(result.kind).toBe('union');
        if (result.kind === 'union') {
          expect(result.members).toHaveLength(2);
        }
      });

      it('true | false simplifies to boolean', () => {
        const result = simplifyUnion([literal('boolean', true), literal('boolean', false)]);
        expect(result).toEqual(bool);
      });

      it('number | 42 simplifies to number', () => {
        const result = simplifyUnion([num, literal('number', 42)]);
        expect(result).toEqual(num);
      });

      it('boolean | true simplifies to boolean', () => {
        const result = simplifyUnion([bool, literal('boolean', true)]);
        expect(result).toEqual(bool);
      });

      it('deduplicates literal types', () => {
        const result = simplifyUnion([literal('string', 'GET'), literal('string', 'GET'), literal('string', 'POST')]);
        expect(result.kind).toBe('union');
        if (result.kind === 'union') {
          expect(result.members).toHaveLength(2);
        }
      });
    });
  });
});
