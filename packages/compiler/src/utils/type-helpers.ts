/**
 * @module type-helpers
 *
 * Utility for constructing objects that have optional properties under
 * `exactOptionalPropertyTypes: true`. The single internal cast lives here
 * so that all call sites remain cast-free.
 */

/**
 * Build an object of type `T` from a source where every value may be
 * `undefined`. Keys whose values are `undefined` are omitted from the
 * result, satisfying `exactOptionalPropertyTypes`.
 *
 * This centralises the one necessary `as unknown as T` cast — callers
 * get full type safety without any casts of their own.
 */
export function omitUndefined<T extends object>(
  obj: { [K in keyof T]: T[K] | undefined },
): T {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as unknown as T;
}
