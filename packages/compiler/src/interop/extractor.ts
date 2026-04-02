/**
 * @module extractor
 *
 * Extracts exported symbols from TypeScript `.d.ts` declaration files using the
 * TypeScript compiler API. Creates a TS `Program` lazily and caches it across
 * calls so that multiple imports from the same package share a single type-check
 * pass. The program is recreated whenever a new root file is added.
 */
import * as ts from 'typescript';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { D } from '../diagnostics/codes.js';
import type { Span } from '../utils/span.js';

// ── Types ───────────────────────────────────────────────────

/** The result of extracting a single `.d.ts` file: its exported symbols plus the TS checker and program needed to inspect them. */
export interface ExtractedModule {
  readonly exports: Map<string, ts.Symbol>;
  readonly typeChecker: ts.TypeChecker;
  readonly program: ts.Program;
}

/**
 * Extracts exported symbols from TypeScript declaration files.
 * Implementations may cache the underlying TS program for efficiency.
 */
export interface TypeExtractor {
  /**
   * Parses and type-checks `dtsPath`, returning its exported symbols.
   * @param dtsPath  Absolute path to a `.d.ts` file.
   * @returns The extracted module, or `null` if extraction fails (diagnostics are reported).
   */
  extract(dtsPath: string): ExtractedModule | null;

  /** Invalidates the cached TS program, forcing a full recreation on the next call to {@link extract}. */
  invalidateProgram(): void;
}

// ── Synthetic span for interop diagnostics ──────────────────

/** Placeholder span used when reporting diagnostics that originate from the interop layer (no real source location). */
const interopSpan: Span = {
  file: '<interop>',
  start: { offset: 0, line: 0, column: 0 },
  end: { offset: 0, line: 0, column: 0 },
};

// ── Implementation ──────────────────────────────────────────

/**
 * TypeScript compiler API–based implementation of {@link TypeExtractor}.
 *
 * Maintains a lazily-created `ts.Program` that is shared across all
 * {@link extract} calls. When a new root file is encountered the program
 * is recreated to include it.
 */
export class TsTypeExtractor implements TypeExtractor {
  private readonly diagnostics: DiagnosticCollector;
  private program: ts.Program | null = null;
  private rootFiles: Set<string> = new Set();

  /** @param diagnostics  Collector to report E301 errors to. */
  constructor(diagnostics: DiagnosticCollector) {
    this.diagnostics = diagnostics;
  }

  /**
   * Extracts exported symbols from a `.d.ts` file.
   *
   * If `dtsPath` is not yet a root file the program is invalidated and
   * recreated with the new file included. Reports E301 if the source file
   * cannot be loaded or has no module exports.
   */
  extract(dtsPath: string): ExtractedModule | null {
    // Track root files; recreate program if new files are added
    const isNew = !this.rootFiles.has(dtsPath);
    if (isNew) {
      this.rootFiles.add(dtsPath);
      this.program = null; // Force recreation
    }

    const program = this.getOrCreateProgram();
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(dtsPath);

    if (!sourceFile) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E301,
        message: `Failed to extract types from '${dtsPath}': declaration file not found`,
        span: interopSpan,
      });
      return null;
    }

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      this.diagnostics.report({
        severity: 'error',
        code: D.E301,
        message: `Failed to extract types from '${dtsPath}': file has no module exports`,
        span: interopSpan,
      });
      return null;
    }

    const exports = new Map<string, ts.Symbol>();
    const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
    for (const sym of exportedSymbols) {
      exports.set(sym.getName(), sym);
    }

    // Handle `export = X` pattern: synthesize a `default` entry and merge
    // namespace members as named exports (matching TS esModuleInterop behavior)
    if (!exports.has('default') && moduleSymbol.exports) {
      const exportEqualsSymbol = moduleSymbol.exports.get(
        'export=' as ts.__String,
      );
      if (exportEqualsSymbol) {
        // Resolve the aliased symbol to get the actual exported value
        let resolved: ts.Symbol;
        try {
          resolved = checker.getAliasedSymbol(exportEqualsSymbol);
        } catch {
          // getAliasedSymbol throws when the symbol is not actually an alias
          // (e.g., namespace-only exports). Fall back to the raw symbol.
          resolved = exportEqualsSymbol;
        }
        exports.set('default', resolved);

        // If the resolved symbol has a ValueModule (namespace) with exports,
        // merge its members as named exports
        const nsExports = resolved.exports;
        if (nsExports) {
          nsExports.forEach((nsSym, nsName) => {
            const name = nsName as string;
            // Skip internal symbols and the export= itself
            if (name.startsWith('__') || exports.has(name)) return;
            exports.set(name, nsSym);
          });
        }
      }
    }

    return { exports, typeChecker: checker, program };
  }

  /** @inheritdoc */
  invalidateProgram(): void {
    this.program = null;
  }

  /**
   * Returns the cached `ts.Program`, creating one if needed.
   * The program targets ES2020 with strict mode and skips lib checking for speed.
   */
  private getOrCreateProgram(): ts.Program {
    if (this.program) {
      return this.program;
    }

    this.program = ts.createProgram(Array.from(this.rootFiles), {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
      declaration: true,
      strict: true,
      skipLibCheck: true,
    });

    return this.program;
  }
}
