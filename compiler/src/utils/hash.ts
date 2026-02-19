/**
 * @module utils/hash
 *
 * Lightweight string hashing utilities used across the compiler.
 */

/**
 * Compute a 32-bit FNV-1a hash of a string, returned as an 8-character hex string.
 *
 * Used for content hashing of source files to support future incremental compilation.
 * FNV-1a provides good distribution with minimal code and no external dependencies.
 */
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
  }
  // Convert to unsigned 32-bit hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}
