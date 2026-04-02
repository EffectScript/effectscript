/**
 * @module exhaustiveness
 *
 * Match expression exhaustiveness checking.
 *
 * Given a subject type and a list of match arms, determines whether
 * the arms collectively cover all possible values. Supports:
 * - **ADTs**: all variant names must appear (or a wildcard).
 * - **Booleans**: both `true` and `false` must be covered.
 * - **Nullable types**: both the `null` case and the non-null inner type must be covered.
 * - **Infinite domains** (number, string): never exhaustive without a wildcard.
 *
 * Guarded arms (`if expr`) are excluded from coverage analysis because
 * the guard may fail at runtime.
 */

import type { Span } from '../utils/span.js';
import type { Type, LiteralType } from './types.js';
import { resolveType } from './types.js';
import type { Pattern, Expression } from '../parser/ast.js';

// ── Public API ──────────────────────────────────────────────

/** The result of an exhaustiveness check on a match expression. */
export interface ExhaustivenessResult {
  /** Whether the match arms cover all possible values. */
  readonly exhaustive: boolean;
  /** Human-readable descriptions of patterns not covered (empty if exhaustive). */
  readonly missingPatterns: readonly string[];
}

/** A single arm of a match expression: a pattern with an optional guard. */
export interface MatchArm {
  /** The pattern to match against. */
  readonly pattern: Pattern;
  /** Optional guard expression — arms with guards don't count as covering. */
  readonly guard?: Expression;
}

/**
 * Check whether a set of match arms exhaustively covers a subject type.
 *
 * Arms with guard expressions are filtered out (they don't guarantee coverage).
 * For nullable types, only wildcard (`_`) is a full catch-all — binding patterns
 * narrow to the non-null type and don't cover `null`.
 *
 * @param subjectType - The type being matched against.
 * @param arms        - The match arms to analyze.
 * @param _span       - Source span (reserved for future diagnostic use).
 * @returns An {@link ExhaustivenessResult} indicating coverage and any missing patterns.
 */
export function checkExhaustiveness(
  subjectType: Type,
  arms: readonly MatchArm[],
  _span: Span,
): ExhaustivenessResult {
  const resolved = resolveType(subjectType);

  // Platform unwrap: delegate to inner type for exhaustiveness checking
  if (resolved.kind === 'platform') {
    return checkExhaustiveness(resolved.inner, arms, _span);
  }

  // Filter out guarded arms — they don't count as covering
  const unguardedArms = arms.filter(a => a.guard === undefined);

  // For nullable types, only wildcard (_) is a full catch-all.
  // Binding patterns narrow to the non-null type, so they don't cover null.
  if (resolved.kind === 'nullable') {
    if (unguardedArms.some(a => a.pattern.kind === 'WildcardPattern')) {
      return { exhaustive: true, missingPatterns: [] };
    }
  } else {
    // For non-nullable types, any catch-all (wildcard or binding) covers everything
    if (unguardedArms.some(a => isCatchAll(a.pattern))) {
      return { exhaustive: true, missingPatterns: [] };
    }
  }

  switch (resolved.kind) {
    case 'adt':
      return checkADTExhaustiveness(resolved.variants, unguardedArms);

    case 'nullable':
      return checkNullableExhaustiveness(resolved.inner, unguardedArms);

    case 'primitive':
      if (resolved.name === 'boolean') {
        return checkBooleanExhaustiveness(unguardedArms);
      }
      // Infinite domains (number, string) — never exhaustive without wildcard
      return {
        exhaustive: false,
        missingPatterns: [`<other ${resolved.name} values>`],
      };

    case 'union': {
      const allLiterals = resolved.members.every(m => resolveType(m).kind === 'literal');
      if (allLiterals) {
        return checkLiteralUnionExhaustiveness(resolved.members, unguardedArms);
      }
      // Mixed unions (not all literals) — require wildcard
      return { exhaustive: false, missingPatterns: ['_'] };
    }

    case 'tuple':
      // Tuple types behave like infinite domains — need a catch-all pattern.
      // A TuplePattern where all elements are catch-all counts (handled above via isCatchAll).
      return { exhaustive: false, missingPatterns: ['(_, ...)'] };

    case 'interface':
      // Interfaces cannot be exhaustively destructured — require wildcard
      return { exhaustive: false, missingPatterns: ['_'] };

    default:
      // For other types (records, etc.) — require wildcard
      return { exhaustive: false, missingPatterns: ['_'] };
  }
}

// ── Internal ────────────────────────────────────────────────

/** Check if a pattern is a catch-all (wildcard `_`, a binding `x`, or a tuple of catch-alls). */
function isCatchAll(pattern: Pattern): boolean {
  if (pattern.kind === 'WildcardPattern' || pattern.kind === 'BindingPattern') return true;
  if (pattern.kind === 'Identifier') return true;
  if (pattern.kind === 'TuplePattern') return pattern.elements.every(el => isCatchAll(el));
  return false;
}

/**
 * Check exhaustiveness for an ADT type by tracking which variant names are covered.
 *
 * A variant is considered covered if it appears in a {@link VariantPattern} whose
 * sub-patterns are all catch-alls (or absent). Partial sub-pattern matching
 * (e.g. matching a specific field value) does not remove the variant from the
 * uncovered set.
 *
 * @param variants - The ADT's variant definitions.
 * @param arms     - The unguarded match arms.
 * @returns Exhaustiveness result listing any uncovered variant names.
 */
function checkADTExhaustiveness(
  variants: readonly { readonly name: string; readonly fields: ReadonlyMap<string, Type> }[],
  arms: readonly MatchArm[],
): ExhaustivenessResult {
  const uncovered = new Set(variants.map(v => v.name));

  for (const matchArm of arms) {
    const pat = matchArm.pattern;
    if (pat.kind === 'VariantPattern') {
      const variantName = pat.name.name;
      // Check if sub-patterns are all catch-all or absent (fully covering)
      if (isVariantFullyCovered(pat)) {
        uncovered.delete(variantName);
      }
      // If sub-patterns contain literals, it's a partial cover — don't remove from uncovered
    }
  }

  if (uncovered.size === 0) {
    return { exhaustive: true, missingPatterns: [] };
  }
  return { exhaustive: false, missingPatterns: Array.from(uncovered) };
}

/**
 * Check whether a variant pattern fully covers its variant (all sub-patterns are catch-alls).
 *
 * @param pat - The pattern to check (must be a VariantPattern).
 * @returns `true` if the variant has no sub-patterns or all sub-patterns are catch-alls.
 */
function isVariantFullyCovered(pat: Pattern): boolean {
  if (pat.kind !== 'VariantPattern') return false;
  // No sub-patterns means the variant itself is fully covered
  if (pat.fields === undefined || pat.fields.length === 0) return true;
  // All sub-patterns must be catch-all (binding or wildcard)
  return pat.fields.every(subPat => isCatchAll(subPat));
}

/**
 * Check exhaustiveness for a nullable type (`T?`).
 *
 * Both the `null` case and the non-null inner type must be covered.
 * If non-null arms exist but don't include a catch-all, the inner type
 * is recursively checked for exhaustiveness (e.g. an ADT inner type
 * might be exhaustively matched by its variants).
 *
 * @param inner - The non-null inner type of the nullable.
 * @param arms  - The unguarded match arms.
 * @returns Exhaustiveness result listing `'null'` and/or the inner type description if missing.
 */
function checkNullableExhaustiveness(
  inner: Type,
  arms: readonly MatchArm[],
): ExhaustivenessResult {
  let nullCovered = false;
  let nonNullCovered = false;

  // Collect non-null arms to check inner type exhaustiveness
  const nonNullArms: MatchArm[] = [];

  for (const matchArm of arms) {
    const pat = matchArm.pattern;
    if (pat.kind === 'NullPattern') {
      nullCovered = true;
    } else {
      nonNullArms.push(matchArm);
      // A catch-all also covers null
      if (isCatchAll(pat)) {
        nonNullCovered = true;
      }
    }
  }

  // Check if non-null arms cover the inner type
  if (!nonNullCovered && nonNullArms.length > 0) {
    const innerResult = checkExhaustiveness(inner, nonNullArms, dummySpan());
    nonNullCovered = innerResult.exhaustive;
  }

  const missing: string[] = [];
  if (!nullCovered) missing.push('null');
  if (!nonNullCovered) missing.push(typeDescription(inner));

  return {
    exhaustive: missing.length === 0,
    missingPatterns: missing,
  };
}

/**
 * Check exhaustiveness for boolean types by verifying both `true` and `false` are covered.
 *
 * @param arms - The unguarded match arms.
 * @returns Exhaustiveness result listing `'true'` and/or `'false'` if missing.
 */
function checkBooleanExhaustiveness(
  arms: readonly MatchArm[],
): ExhaustivenessResult {
  let trueCovered = false;
  let falseCovered = false;

  for (const matchArm of arms) {
    const pat = matchArm.pattern;
    if (pat.kind === 'LiteralPattern' && pat.literal.kind === 'BooleanLiteral') {
      if (pat.literal.value) trueCovered = true;
      else falseCovered = true;
    }
  }

  const missing: string[] = [];
  if (!trueCovered) missing.push('true');
  if (!falseCovered) missing.push('false');

  return {
    exhaustive: missing.length === 0,
    missingPatterns: missing,
  };
}

/**
 * Check exhaustiveness for a union of literal types by tracking which values are covered.
 *
 * Each literal member is tracked by a composite key (`base:value`). Match arms with
 * literal patterns remove the corresponding key. If all keys are removed, the match
 * is exhaustive.
 */
function checkLiteralUnionExhaustiveness(
  members: readonly Type[],
  arms: readonly MatchArm[],
): ExhaustivenessResult {
  const uncovered = new Map<string, string>();
  for (const member of members) {
    const lit = resolveType(member) as LiteralType;
    const key = `${lit.base}:${String(lit.value)}`;
    const display = lit.base === 'string' ? `"${lit.value}"` : String(lit.value);
    uncovered.set(key, display);
  }

  for (const matchArm of arms) {
    const pat = matchArm.pattern;
    if (pat.kind === 'LiteralPattern') {
      const lit = pat.literal;
      let key: string;
      if (lit.kind === 'StringLiteral') key = `string:${lit.value}`;
      else if (lit.kind === 'NumberLiteral') key = `number:${lit.value}`;
      else key = `boolean:${lit.value}`;
      uncovered.delete(key);
    }
  }

  if (uncovered.size === 0) {
    return { exhaustive: true, missingPatterns: [] };
  }
  return { exhaustive: false, missingPatterns: Array.from(uncovered.values()) };
}

/**
 * Produce a short human-readable description of a type for diagnostic messages.
 *
 * @param type - The type to describe.
 * @returns The type name (e.g. `'number'`, `'Result'`) or `'<non-null>'` as fallback.
 */
function typeDescription(type: Type): string {
  const resolved = resolveType(type);
  switch (resolved.kind) {
    case 'primitive': return resolved.name;
    case 'adt': return resolved.name;
    case 'literal': return resolved.base === 'string' ? `"${resolved.value}"` : String(resolved.value);
    case 'union': return resolved.members.map(m => typeDescription(m)).join(' | ');
    case 'platform': return typeDescription(resolved.inner);
    default: return '<non-null>';
  }
}

/** Create a synthetic span for internal recursive calls that don't need real source locations. */
function dummySpan(): Span {
  return {
    file: '<internal>',
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: 0, line: 1, column: 0 },
  };
}
