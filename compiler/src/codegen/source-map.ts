/**
 * @module source-map
 *
 * Source Map v3 generation for EffectScript → JavaScript.
 *
 * Implements the Source Map v3 specification with:
 * - {@link encodeVLQ}: Base64 VLQ encoding for individual integers.
 * - {@link generateSourceMap}: Produces a complete Source Map v3 JSON string
 *   from the {@link SourceMapping} entries collected by {@link EmitContext}.
 *
 * The encoder handles single-source maps (EffectScript produces one `.efs`
 * source per `.js` output) with optional inline source content.
 */

import type { SourceMapping } from './emit-context.js';

// ── VLQ Encoding ───────────────────────────────────────────

/** Base64 alphabet used for VLQ encoding (per Source Map v3 spec). */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode a single integer as a VLQ (Variable-Length Quantity) string
 * using Base64 VLQ encoding as specified in the Source Map v3 spec.
 */
export function encodeVLQ(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let result = '';

  do {
    let digit = vlq & 0x1F; // 5 bits
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 0x20; // continuation bit
    }
    result += BASE64_CHARS[digit];
  } while (vlq > 0);

  return result;
}

// ── Source Map Generator ──────────────────────────────────

/**
 * Generate a Source Map v3 JSON string from collected mappings.
 *
 * @param mappings - Source position mappings from EmitContext
 * @param sourceFile - Original source file path (for `sources` array)
 * @param generatedFile - Generated JS file path (for `file` field)
 * @param sourceContent - Optional source file content (for `sourcesContent`)
 * @returns JSON string conforming to Source Map v3
 */
export function generateSourceMap(
  mappings: readonly SourceMapping[],
  sourceFile: string,
  generatedFile: string,
  sourceContent?: string,
): string {
  const mappingsStr = encodeMappings(mappings);

  const map: Record<string, unknown> = {
    version: 3,
    file: generatedFile,
    sources: [sourceFile],
    names: [],
    mappings: mappingsStr,
  };

  if (sourceContent !== undefined) {
    map['sourcesContent'] = [sourceContent];
  }

  return JSON.stringify(map);
}

/**
 * Encode all mappings into the Source Map v3 "mappings" string format.
 * Segments within a line are comma-separated; lines are semicolon-separated.
 * Each segment is 4 VLQ-encoded values (relative to previous):
 *   1. generated column
 *   2. source index (always 0 for single-file)
 *   3. source line
 *   4. source column
 */
function encodeMappings(mappings: readonly SourceMapping[]): string {
  if (mappings.length === 0) return '';

  // Sort by generated line, then column
  const sorted = [...mappings].sort((a, b) =>
    a.generatedLine !== b.generatedLine
      ? a.generatedLine - b.generatedLine
      : a.generatedColumn - b.generatedColumn
  );

  const lines: string[][] = [];
  let prevGeneratedColumn = 0;
  let prevSourceLine = 0;
  let prevSourceColumn = 0;
  let currentLine = 1;

  for (const mapping of sorted) {
    // Fill in empty lines up to this mapping's line
    while (currentLine < mapping.generatedLine) {
      lines.push([]);
      prevGeneratedColumn = 0; // reset per line
      currentLine++;
    }

    // Ensure we have an array for the current line
    if (lines.length < currentLine) {
      lines.push([]);
    }

    const segment =
      encodeVLQ(mapping.generatedColumn - prevGeneratedColumn) +
      encodeVLQ(0) + // source index (always 0 for single source)
      encodeVLQ(mapping.sourceLine - 1 - prevSourceLine) + // source line (0-based delta)
      encodeVLQ(mapping.sourceColumn - prevSourceColumn);

    lines[lines.length - 1].push(segment);

    prevGeneratedColumn = mapping.generatedColumn;
    prevSourceLine = mapping.sourceLine - 1; // store as 0-based
    prevSourceColumn = mapping.sourceColumn;
  }

  return lines.map(segments => segments.join(',')).join(';');
}
