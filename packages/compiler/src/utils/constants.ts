/**
 * @module utils/constants
 *
 * Shared file-extension constants and import-path rewriting for the
 * EffectScript compiler. Used by the codegen emitters, pipeline, and CLI
 * to ensure consistent `.efs` → `.js` path transformations.
 */

/** EffectScript source file extension. */
export const EFS_EXT = '.efs';

/** JavaScript output file extension. */
export const JS_EXT = '.js';

/** TypeScript declaration file extension. */
export const DTS_EXT = '.d.ts';

/**
 * Rewrite an import path for compiled output.
 *
 * - External packages (no leading `.` or `/`) are returned unchanged.
 * - Paths already ending in `.js` are returned as-is.
 * - Relative `.efs` imports are rewritten to `.js`.
 * - Other relative imports get a `.js` extension appended.
 */
export function rewriteImportPath(source: string): string {
  if (!source.startsWith('.') && !source.startsWith('/')) return source;
  if (source.endsWith(JS_EXT)) return source;
  if (source.endsWith(EFS_EXT)) return source.slice(0, -EFS_EXT.length) + JS_EXT;
  return source + JS_EXT;
}
