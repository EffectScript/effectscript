import { describe, it, expect } from 'vitest';
import { omitUndefined } from './type-helpers.js';

describe('omitUndefined', () => {
  it('strips undefined-valued keys', () => {
    interface Target {
      readonly a: string;
      readonly b?: number;
    }
    const result = omitUndefined<Target>({ a: 'hello', b: undefined });
    expect(result).toEqual({ a: 'hello' });
    expect('b' in result).toBe(false);
  });

  it('preserves falsy values (false, 0, null, "")', () => {
    interface Target {
      readonly a: boolean;
      readonly b: number;
      readonly c: string | null;
      readonly d: string;
    }
    const result = omitUndefined<Target>({ a: false, b: 0, c: null, d: '' });
    expect(result).toEqual({ a: false, b: 0, c: null, d: '' });
  });

  it('returns empty object when all values are undefined', () => {
    interface Target {
      readonly a?: string;
      readonly b?: number;
    }
    const result = omitUndefined<Target>({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  it('returns full object when no values are undefined', () => {
    interface Target {
      readonly a: string;
      readonly b: number;
      readonly c: boolean;
    }
    const result = omitUndefined<Target>({ a: 'x', b: 42, c: true });
    expect(result).toEqual({ a: 'x', b: 42, c: true });
  });

  it('works with readonly target properties', () => {
    interface Target {
      readonly kind: 'Foo';
      readonly name: string;
      readonly span: { start: number; end: number };
      readonly extra?: string;
    }
    const result = omitUndefined<Target>({
      kind: 'Foo',
      name: 'bar',
      span: { start: 0, end: 3 },
      extra: undefined,
    });
    expect(result.kind).toBe('Foo');
    expect(result.name).toBe('bar');
    expect('extra' in result).toBe(false);
  });

  it('works with array-valued properties', () => {
    interface Target {
      readonly items: readonly string[];
      readonly optional?: readonly number[];
    }
    const result = omitUndefined<Target>({
      items: ['a', 'b'],
      optional: undefined,
    });
    expect(result.items).toEqual(['a', 'b']);
    expect('optional' in result).toBe(false);
  });
});
