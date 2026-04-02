/**
 * Tests for platform type system features: PlatformType, makePlatform,
 * unwrapPlatform, and platform-aware behavior in typesEqual, isAssignableTo,
 * typeToString, widenLiteral, makeNullable, and simplifyUnion.
 */
import { describe, it, expect } from 'vitest';
import type { PlatformType } from './types.js';
import {
  makePlatform,
  unwrapPlatform,
  typesEqual,
  isAssignableTo,
  typeToString,
  widenLiteral,
  makeNullable,
  simplifyUnion,
  resolveType,
  STR,
  NUM,
  BOOL,
  ANY,
  ERROR_TYPE,
  MAX_SUBSTITUTE_DEPTH,
} from './types.js';

// ── Test helpers ─────────────────────────────────────────────

function platformStr(reason: PlatformType['reason'] = 'unmappable'): PlatformType {
  return makePlatform(STR, reason) as PlatformType;
}

function platformNum(reason: PlatformType['reason'] = 'unmappable'): PlatformType {
  return makePlatform(NUM, reason) as PlatformType;
}

// ── Tests ────────────────────────────────────────────────────

describe('PlatformType core', () => {
  // Test 1: PlatformType creation and normalization
  describe('makePlatform', () => {
    it('creates a platform type with the given inner type and reason', () => {
      const p = makePlatform(STR, 'unmappable');
      expect(p.kind).toBe('platform');
      expect((p as PlatformType).inner).toBe(STR);
      expect((p as PlatformType).reason).toBe('unmappable');
    });

    it('normalizes nested platform types (no double wrapping)', () => {
      const inner = makePlatform(STR, 'recursive-limit') as PlatformType;
      const outer = makePlatform(inner, 'budget-cap');
      expect(outer.kind).toBe('platform');
      expect((outer as PlatformType).inner).toBe(STR);
      expect((outer as PlatformType).reason).toBe('budget-cap');
    });

    it('collapses PlatformType wrapping ErrorType to ErrorType', () => {
      const result = makePlatform(ERROR_TYPE, 'unmappable');
      expect(result.kind).toBe('error');
    });

    it('preserves different reason kinds', () => {
      const reasons: PlatformType['reason'][] = [
        'recursive-limit',
        'budget-cap',
        'unmappable',
        'conditional',
        'indexed-access',
      ];
      for (const reason of reasons) {
        const p = makePlatform(STR, reason) as PlatformType;
        expect(p.reason).toBe(reason);
      }
    });
  });

  // Test: unwrapPlatform utility
  describe('unwrapPlatform', () => {
    it('unwraps platform type and returns inner + reason', () => {
      const p = makePlatform(STR, 'unmappable');
      const { inner, reason } = unwrapPlatform(p);
      expect(inner).toBe(STR);
      expect(reason).toBe('unmappable');
    });

    it('returns non-platform type with reason undefined', () => {
      const { inner, reason } = unwrapPlatform(STR);
      expect(inner).toBe(STR);
      expect(reason).toBeUndefined();
    });
  });

  // Test 2: typesEqual
  describe('typesEqual', () => {
    it('platform types are equal when inner types are equal (reason ignored)', () => {
      const a = makePlatform(STR, 'unmappable');
      const b = makePlatform(STR, 'recursive-limit');
      expect(typesEqual(a, b)).toBe(true);
    });

    it('platform types are not equal when inner types differ', () => {
      const a = makePlatform(STR, 'unmappable');
      const b = makePlatform(NUM, 'unmappable');
      expect(typesEqual(a, b)).toBe(false);
    });

    it('platform(string) is not equal to string (different kinds)', () => {
      const a = makePlatform(STR, 'unmappable');
      expect(typesEqual(a, STR)).toBe(false);
    });
  });

  // Test 3: isAssignableTo
  describe('isAssignableTo', () => {
    it('platform source is assignable to exact target (delegates to inner)', () => {
      expect(isAssignableTo(platformStr(), STR)).toBe(true);
    });

    it('exact source is assignable to platform target', () => {
      expect(isAssignableTo(STR, platformStr())).toBe(true);
    });

    it('platform-to-platform delegates to inner-to-inner', () => {
      expect(isAssignableTo(platformStr(), platformStr())).toBe(true);
      expect(isAssignableTo(platformStr(), platformNum())).toBe(false);
    });

    it('platform assignable to Any', () => {
      expect(isAssignableTo(platformStr(), ANY)).toBe(true);
    });

    it('Any assignable to platform', () => {
      expect(isAssignableTo(ANY, platformStr())).toBe(true);
    });

    it('incompatible inner type is not assignable', () => {
      expect(isAssignableTo(platformStr(), NUM)).toBe(false);
    });
  });

  // Test 4: typeToString
  describe('typeToString', () => {
    it('renders platform type with ! suffix', () => {
      expect(typeToString(platformStr())).toBe('string!');
    });

    it('renders platform number with ! suffix', () => {
      expect(typeToString(platformNum())).toBe('number!');
    });

    it('parenthesizes function types before !', () => {
      const fn = { kind: 'function' as const, params: [], returnType: STR };
      const p = makePlatform(fn, 'unmappable');
      expect(typeToString(p)).toBe('(() => string)!');
    });

    it('parenthesizes union types before !', () => {
      const union = { kind: 'union' as const, members: [STR, NUM] };
      const p = makePlatform(union, 'unmappable');
      expect(typeToString(p)).toBe('(string | number)!');
    });

    it('does not double !! on nested platform normalization', () => {
      const inner = makePlatform(STR, 'recursive-limit');
      const outer = makePlatform(inner, 'budget-cap');
      expect(typeToString(outer)).toBe('string!');
    });

    it('renders platform record with !', () => {
      const record = { kind: 'record' as const, fields: new Map([['name', STR]]) };
      const p = makePlatform(record, 'unmappable');
      expect(typeToString(p)).toBe('{ name: string }!');
    });

    it('renders platform Any as Any!', () => {
      const p = makePlatform(ANY, 'conditional');
      expect(typeToString(p)).toBe('Any!');
    });
  });

  // Test 5: resolveType passes through platform types unchanged
  describe('resolveType', () => {
    it('passes platform types through unchanged', () => {
      const p = makePlatform(STR, 'unmappable');
      expect(resolveType(p)).toBe(p);
    });
  });

  // Test: widenLiteral through platform
  describe('widenLiteral', () => {
    it('widens platform(literal) to platform(primitive)', () => {
      const lit = { kind: 'literal' as const, base: 'string' as const, value: 'hello' };
      const p = makePlatform(lit, 'unmappable');
      const widened = widenLiteral(p);
      expect(widened.kind).toBe('platform');
      expect((widened as PlatformType).inner).toEqual(STR);
    });

    it('passes through platform(non-literal) unchanged', () => {
      const p = makePlatform(STR, 'unmappable');
      expect(widenLiteral(p)).toBe(p);
    });
  });

  // Test: makeNullable with platform types
  describe('makeNullable with platform', () => {
    it('produces platform(nullable(T)) from platform(T)', () => {
      const p = makePlatform(STR, 'unmappable');
      const result = makeNullable(p);
      expect(result.kind).toBe('platform');
      const plat = result as PlatformType;
      expect(plat.inner.kind).toBe('nullable');
      expect(typeToString(result)).toBe('string?!');
    });
  });

  // Test: simplifyUnion with platform types
  describe('simplifyUnion with platform', () => {
    it('string! | string simplifies to string (exact wins)', () => {
      const result = simplifyUnion([platformStr(), STR]);
      expect(result.kind).toBe('primitive');
      expect(typeToString(result)).toBe('string');
    });

    it('string! | number! simplifies to (string | number)!', () => {
      const result = simplifyUnion([platformStr(), platformNum()]);
      expect(result.kind).toBe('platform');
      const inner = (result as PlatformType).inner;
      expect(inner.kind).toBe('union');
    });

    it('string! | number stays as string! | number (per-member)', () => {
      const result = simplifyUnion([platformStr(), NUM]);
      expect(result.kind).toBe('union');
      // First member should be platform string, second should be exact number
      if (result.kind === 'union') {
        expect(result.members[0].kind).toBe('platform');
        expect(result.members[1].kind).toBe('primitive');
      }
    });
  });

  // Test: MAX_SUBSTITUTE_DEPTH constant
  describe('MAX_SUBSTITUTE_DEPTH', () => {
    it('is 40', () => {
      expect(MAX_SUBSTITUTE_DEPTH).toBe(40);
    });
  });
});
