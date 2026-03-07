/**
 * @module emit-context
 *
 * Emit context for code generation.
 *
 * {@link EmitContext} is the structured output buffer used by the JS and DTS
 * emitters. It provides indentation management, line/column position tracking,
 * and source map mapping collection. All emitter functions write through an
 * EmitContext rather than concatenating strings directly.
 */

import type { Span } from '../utils/span.js';

// ── Source Mapping ─────────────────────────────────────────

/** A single mapping from a generated position to a source position. */
export interface SourceMapping {
  /** Generated output line (1-based). */
  readonly generatedLine: number;
  /** Generated output column (0-based). */
  readonly generatedColumn: number;
  /** Original source line (1-based). */
  readonly sourceLine: number;
  /** Original source column (0-based). */
  readonly sourceColumn: number;
  /** Original source file path. */
  readonly sourceFile: string;
}

// ── EmitContext ────────────────────────────────────────────

/**
 * Structured output buffer for code generation with indentation and source mapping.
 *
 * Tracks the current line and column in the generated output so that source map
 * mappings can be recorded at any point. Output is accumulated in string segments
 * and joined via {@link getOutput}.
 */
export class EmitContext {
  /** Accumulated output segments. */
  private readonly output: string[] = [];
  /** Current indentation depth (number of indent levels). */
  private indentLevel = 0;
  /** String used for one level of indentation (2 spaces). */
  private readonly indentStr = '  ';
  /** Current line in the generated output (1-based). */
  private line = 1;
  /** Current column in the generated output (0-based). */
  private column = 0;
  /** Collected source map mappings. */
  private readonly mappings: SourceMapping[] = [];

  /** Append text, updating position tracking. */
  write(text: string): void {
    this.output.push(text);
    this.updatePosition(text);
  }

  /** Write text followed by a newline. */
  writeLine(text: string): void {
    this.output.push(text);
    this.output.push('\n');
    this.updatePosition(text);
    this.line++;
    this.column = 0;
  }

  /** Write text with the current indentation prefix. */
  writeIndented(text: string): void {
    const indent = this.indentStr.repeat(this.indentLevel);
    this.output.push(indent);
    this.output.push(text);
    this.updatePosition(indent + text);
  }

  /** Write indented text followed by a newline. */
  writeLineIndented(text: string): void {
    const indent = this.indentStr.repeat(this.indentLevel);
    this.output.push(indent);
    this.output.push(text);
    this.output.push('\n');
    this.updatePosition(indent + text);
    this.line++;
    this.column = 0;
  }

  /** Increase indentation by one level. */
  indent(): void {
    this.indentLevel++;
  }

  /** Decrease indentation by one level (minimum 0). */
  dedent(): void {
    if (this.indentLevel > 0) {
      this.indentLevel--;
    }
  }

  /** Emit a newline character. */
  newLine(): void {
    this.output.push('\n');
    this.line++;
    this.column = 0;
  }

  /** Record a source map mapping from the current generated position to the given source span. */
  addMapping(sourceSpan: Span): void {
    this.mappings.push({
      generatedLine: this.line,
      generatedColumn: this.column,
      sourceLine: sourceSpan.start.line,
      sourceColumn: sourceSpan.start.column,
      sourceFile: sourceSpan.file,
    });
  }

  /** Join all output segments into a single string. */
  getOutput(): string {
    return this.output.join('');
  }

  /** Get collected source map mappings. */
  getMappings(): readonly SourceMapping[] {
    return this.mappings;
  }

  /** Current generated line (1-based). */
  getGeneratedLine(): number {
    return this.line;
  }

  /** Current generated column (0-based). */
  getGeneratedColumn(): number {
    return this.column;
  }

  /** Update line/column tracking for the given text (no newline handling — that's done by callers). */
  private updatePosition(text: string): void {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        this.line++;
        this.column = 0;
      } else {
        this.column++;
      }
    }
  }
}
