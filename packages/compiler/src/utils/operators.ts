/**
 * @module operators
 *
 * Single source of truth for binary operator precedence in EffectScript.
 *
 * Used by both the parser (Pratt parsing) and the JS emitter
 * (parenthesization decisions).
 */

/**
 * Maps binary operator tokens to their precedence level.
 *
 * Higher number = tighter binding. Levels:
 * - 2: `||` (logical OR)
 * - 3: `&&` (logical AND)
 * - 4: `==`, `!=` (equality)
 * - 5: `<`, `>`, `<=`, `>=` (comparison)
 * - 6: `??` (nullish coalescing — between comparison and arithmetic;
 *   JS prohibits mixing with `&&`/`||` without parens, enforced by E117)
 * - 7: `+`, `-` (additive)
 * - 8: `*`, `/`, `%` (multiplicative)
 */
export const OPERATOR_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4,
  '<': 5, '>': 5, '<=': 5, '>=': 5,
  '??': 6,
  '+': 7, '-': 7,
  '*': 8, '/': 8, '%': 8,
};

/**
 * Returns the precedence level for a binary operator token.
 *
 * @param op - The operator string (e.g. `"+"`, `"&&"`, `"??"`).
 * @returns The precedence level, or `0` if the operator is unknown.
 */
export function getOperatorPrecedence(op: string): number {
  return OPERATOR_PRECEDENCE[op] ?? 0;
}
