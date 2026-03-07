import { describe, it, expect } from 'vitest';
import { checkExhaustiveness } from './exhaustiveness.js';
import type { Type, PrimitiveType, NullableType, ADTType, ADTVariant } from './types.js';
import type { Pattern, Expression } from '../parser/ast.js';
import type { Span } from '../utils/span.js';

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

function nullable(inner: Type): NullableType {
  return { kind: 'nullable', inner };
}

function makeAdt(name: string, variantNames: string[]): ADTType {
  const variants: ADTVariant[] = variantNames.map(n => ({
    name: n,
    fields: new Map(),
  }));
  return { kind: 'adt', name, typeArgs: [], variants };
}

function makeAdtWithFields(name: string, variants: { name: string; fields: Record<string, Type> }[]): ADTType {
  return {
    kind: 'adt',
    name,
    typeArgs: [],
    variants: variants.map(v => ({
      name: v.name,
      fields: new Map(Object.entries(v.fields)),
    })),
  };
}

function variantPattern(name: string, fields?: Pattern[]): Pattern {
  const result: Record<string, unknown> = {
    kind: 'VariantPattern',
    name: { kind: 'Identifier', name, span: dummySpan() },
    span: dummySpan(),
  };
  if (fields !== undefined) result['fields'] = fields;
  return result as unknown as Pattern;
}

function wildcardPattern(): Pattern {
  return { kind: 'WildcardPattern', span: dummySpan() } as Pattern;
}

function bindingPattern(name: string): Pattern {
  return {
    kind: 'BindingPattern',
    name: { kind: 'Identifier', name, span: dummySpan() },
    span: dummySpan(),
  } as Pattern;
}

function nullPattern(): Pattern {
  return { kind: 'NullPattern', span: dummySpan() } as Pattern;
}

function literalPattern(value: boolean): Pattern {
  return {
    kind: 'LiteralPattern',
    literal: { kind: 'BooleanLiteral', value, span: dummySpan() },
    span: dummySpan(),
  } as Pattern;
}

function numberLiteralPattern(value: number): Pattern {
  return {
    kind: 'LiteralPattern',
    literal: { kind: 'NumberLiteral', value, span: dummySpan() },
    span: dummySpan(),
  } as Pattern;
}

function stringLiteralPattern(value: string): Pattern {
  return {
    kind: 'LiteralPattern',
    literal: { kind: 'StringLiteral', value, span: dummySpan() },
    span: dummySpan(),
  } as Pattern;
}

function arm(pattern: Pattern, guard?: Expression) {
  return { pattern, guard };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('exhaustiveness.ts', () => {

  describe('ADT exhaustiveness', () => {
    it('all variants covered → exhaustive', () => {
      const adtType = makeAdt('Color', ['Red', 'Green', 'Blue']);
      const result = checkExhaustiveness(adtType, [
        arm(variantPattern('Red')),
        arm(variantPattern('Green')),
        arm(variantPattern('Blue')),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
      expect(result.missingPatterns).toEqual([]);
    });

    it('missing variant → not exhaustive', () => {
      const adtType = makeAdt('Color', ['Red', 'Green', 'Blue']);
      const result = checkExhaustiveness(adtType, [
        arm(variantPattern('Red')),
        arm(variantPattern('Green')),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
      expect(result.missingPatterns).toContain('Blue');
    });

    it('wildcard covers remaining variants', () => {
      const adtType = makeAdt('Color', ['Red', 'Green', 'Blue']);
      const result = checkExhaustiveness(adtType, [
        arm(variantPattern('Red')),
        arm(wildcardPattern()),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });

    it('binding pattern covers all variants', () => {
      const adtType = makeAdt('Color', ['Red', 'Green', 'Blue']);
      const result = checkExhaustiveness(adtType, [
        arm(bindingPattern('c')),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('nullable exhaustiveness', () => {
    it('both null and non-null covered → exhaustive', () => {
      const nullableNum = nullable(num);
      const result = checkExhaustiveness(nullableNum, [
        arm(nullPattern()),
        arm(bindingPattern('n')),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });

    it('missing null case → not exhaustive', () => {
      const nullableNum = nullable(num);
      const result = checkExhaustiveness(nullableNum, [
        arm(bindingPattern('n')),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
      expect(result.missingPatterns).toContain('null');
    });

    it('missing non-null case → not exhaustive', () => {
      const nullableNum = nullable(num);
      const result = checkExhaustiveness(nullableNum, [
        arm(nullPattern()),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
    });

    it('wildcard covers both cases', () => {
      const nullableNum = nullable(num);
      const result = checkExhaustiveness(nullableNum, [
        arm(wildcardPattern()),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('boolean exhaustiveness', () => {
    it('both true and false → exhaustive', () => {
      const result = checkExhaustiveness(bool, [
        arm(literalPattern(true)),
        arm(literalPattern(false)),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });

    it('missing one → not exhaustive', () => {
      const result = checkExhaustiveness(bool, [
        arm(literalPattern(true)),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
      expect(result.missingPatterns).toContain('false');
    });

    it('wildcard covers boolean', () => {
      const result = checkExhaustiveness(bool, [
        arm(wildcardPattern()),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('guard clauses', () => {
    it("guarded arms don't count as covering", () => {
      const adtType = makeAdt('Option', ['Some', 'None']);
      const guardExpr = { kind: 'BooleanLiteral', value: true, span: dummySpan() } as Expression;
      const result = checkExhaustiveness(adtType, [
        arm(variantPattern('Some'), guardExpr),
        arm(variantPattern('None'), guardExpr),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
    });

    it('unguarded arm after guarded covers', () => {
      const adtType = makeAdt('Option', ['Some', 'None']);
      const guardExpr = { kind: 'BooleanLiteral', value: true, span: dummySpan() } as Expression;
      const result = checkExhaustiveness(adtType, [
        arm(variantPattern('Some'), guardExpr),
        arm(variantPattern('Some')),
        arm(variantPattern('None')),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('literal patterns on infinite domains', () => {
    it('number literals are never exhaustive without wildcard', () => {
      const result = checkExhaustiveness(num, [
        arm(numberLiteralPattern(1)),
        arm(numberLiteralPattern(2)),
        arm(numberLiteralPattern(3)),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
    });

    it('string literals are never exhaustive without wildcard', () => {
      const result = checkExhaustiveness(str, [
        arm(stringLiteralPattern('a')),
        arm(stringLiteralPattern('b')),
      ], dummySpan());
      expect(result.exhaustive).toBe(false);
    });

    it('wildcard covers infinite domain', () => {
      const result = checkExhaustiveness(num, [
        arm(numberLiteralPattern(1)),
        arm(wildcardPattern()),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('empty arms', () => {
    it('empty arms → not exhaustive', () => {
      const result = checkExhaustiveness(num, [], dummySpan());
      expect(result.exhaustive).toBe(false);
    });
  });

  describe('nested patterns', () => {
    it('nested variant patterns with partial coverage require wildcard', () => {
      const innerAdt = makeAdtWithFields('Inner', [
        { name: 'A', fields: { val: num } },
        { name: 'B', fields: { val: num } },
      ]);
      // Even if we match Ok with nested A and B, conservative approach treats as partial
      const result = checkExhaustiveness(innerAdt, [
        arm(variantPattern('A', [numberLiteralPattern(1)])),
        arm(variantPattern('B')),
      ], dummySpan());
      // A is covered with a literal sub-pattern (partial), B is fully covered
      // Conservative: A with literal sub-pattern = partial, needs wildcard
      expect(result.exhaustive).toBe(false);
    });

    it('nested variant patterns fully covered with binding sub-patterns', () => {
      const innerAdt = makeAdtWithFields('Inner', [
        { name: 'A', fields: { val: num } },
        { name: 'B', fields: { val: num } },
      ]);
      const result = checkExhaustiveness(innerAdt, [
        arm(variantPattern('A', [bindingPattern('x')])),
        arm(variantPattern('B', [bindingPattern('y')])),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });

  describe('nullable ADT', () => {
    it('matching on nullable ADT covers null and all variants', () => {
      const adtType = makeAdt('Option', ['Some', 'None']);
      const nullableAdt = nullable(adtType);
      const result = checkExhaustiveness(nullableAdt, [
        arm(nullPattern()),
        arm(variantPattern('Some')),
        arm(variantPattern('None')),
      ], dummySpan());
      expect(result.exhaustive).toBe(true);
    });
  });
});
