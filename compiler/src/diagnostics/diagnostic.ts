/**
 * @module diagnostic
 *
 * Core diagnostic types used throughout the compiler to report errors,
 * warnings, and informational messages with source locations.
 */

import type { Span } from '../utils/span.js';

/** Severity level of a diagnostic. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A compiler diagnostic — an error, warning, or informational message
 * tied to a source location.
 */
export interface Diagnostic {
  /** Whether this is an error, warning, or informational message. */
  readonly severity: DiagnosticSeverity;
  /** Machine-readable code (e.g. `"E200"`, `"W301"`). */
  readonly code: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Source location where the diagnostic originates. */
  readonly span: Span;
  /** Additional source locations that help explain the diagnostic. */
  readonly relatedSpans?: readonly RelatedSpan[];
  /** An optional machine-applicable fix suggestion. */
  readonly fix?: SuggestedFix;
}

/**
 * A secondary source location attached to a {@link Diagnostic} to provide
 * additional context (e.g. "first declared here").
 */
export interface RelatedSpan {
  /** The secondary source location. */
  readonly span: Span;
  /** Explanation of this related location's relevance. */
  readonly message: string;
}

/**
 * A suggested automatic fix for a diagnostic, consisting of a description
 * and one or more text edits to apply.
 */
export interface SuggestedFix {
  /** Human-readable description of the fix (e.g. "Change `let` to `let mut`"). */
  readonly description: string;
  /** Text edits that implement the fix. */
  readonly edits: readonly TextEdit[];
}

/**
 * A single text replacement within a source file, used as part of a
 * {@link SuggestedFix}.
 */
export interface TextEdit {
  /** The span of text to replace. */
  readonly span: Span;
  /** The replacement text (may be empty for deletions). */
  readonly replacement: string;
}

/*
 * Diagnostic code ranges:
 *   E001–E099  Lexer errors
 *   E100–E199  Parser errors
 *   E200–E399  Type checker errors
 *   E400–E499  Codegen errors
 *   E500–E599  Module graph / pipeline errors
 *   E600–E699  Host / CLI errors
 *   W001–W999  Warnings
 *
 * Actual codes are defined as each phase is implemented.
 */
