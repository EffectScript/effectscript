/**
 * @module collector
 *
 * Diagnostic collection interface and default implementation.
 * Collects compiler diagnostics with automatic deduplication.
 */

import type { Diagnostic } from './diagnostic.js';

/**
 * Accumulates {@link Diagnostic} instances produced during compilation.
 * Implementations must deduplicate identical diagnostics.
 */
export interface DiagnosticCollector {
  /** Record a diagnostic. Duplicates (same code and span) are silently ignored. */
  report(diagnostic: Diagnostic): void;
  /** Return all collected diagnostics (errors + warnings + info). */
  getAll(): readonly Diagnostic[];
  /** Return only error-severity diagnostics. */
  getErrors(): readonly Diagnostic[];
  /** Return only warning-severity diagnostics. */
  getWarnings(): readonly Diagnostic[];
  /** Return `true` if at least one error has been reported. */
  hasErrors(): boolean;
  /** Remove all collected diagnostics and reset deduplication state. */
  clear(): void;
  /** Discard diagnostics added after the given count (for speculative parsing rollback). */
  rollback(savedCount: number): void;
}

/**
 * Default {@link DiagnosticCollector} backed by an in-memory array.
 * Deduplicates diagnostics by code + span location.
 */
export class DiagnosticCollectorImpl implements DiagnosticCollector {
  private diagnostics: Diagnostic[] = [];
  private seen = new Set<string>();

  /** @inheritdoc */
  report(diagnostic: Diagnostic): void {
    const key = this.deduplicationKey(diagnostic);
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.diagnostics.push(diagnostic);
  }

  /** @inheritdoc */
  getAll(): readonly Diagnostic[] {
    return [...this.diagnostics];
  }

  /** @inheritdoc */
  getErrors(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === 'error');
  }

  /** @inheritdoc */
  getWarnings(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === 'warning');
  }

  /** @inheritdoc */
  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  /** @inheritdoc */
  clear(): void {
    this.diagnostics = [];
    this.seen = new Set();
  }

  /** @inheritdoc */
  rollback(savedCount: number): void {
    const removed = this.diagnostics.splice(savedCount);
    for (const d of removed) {
      this.seen.delete(this.deduplicationKey(d));
    }
  }

  /**
   * Build a deduplication key from a diagnostic's code and span offsets.
   * Two diagnostics with the same key are considered duplicates.
   */
  private deduplicationKey(diagnostic: Diagnostic): string {
    const { code, span } = diagnostic;
    return `${code}|${span.file}|${span.start.offset}|${span.end.offset}`;
  }
}
