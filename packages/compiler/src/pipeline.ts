/**
 * @module pipeline
 *
 * Core multi-file compilation pipeline. Orchestrates the full compilation
 * process: BFS module graph construction, topological ordering, and
 * per-file lex → parse → check → codegen in dependency order.
 *
 * Called by {@link runPipeline} in `compiler.ts`; not intended for direct use.
 */

import type { Program, ImportDeclaration, ExportDeclaration } from './parser/ast.js';
import type { Diagnostic } from './diagnostics/diagnostic.js';
import type { DiagnosticCollector } from './diagnostics/collector.js';
import type { FileSystem } from './filesystem.js';
import type { CodegenBackend, OutputFile } from './codegen/backend.js';
import type { ExportedTypeSignature } from './checker/types.js';
import type { TypeDeclarationProvider, ResolvedModule } from './interop/provider.js';
import type { PassRegistry } from './passes/registry.js';
import type { ModuleGraph, ImportEdge } from './graph/module-graph.js';
import { ModuleGraphImpl, fnv1aHash } from './graph/module-graph.js';
import { tokenize } from './lexer/lexer.js';
import { parse } from './parser/parser.js';
import { check } from './checker/checker.js';
import { createPrelude } from './prelude/prelude.js';
import { DiagnosticCollectorImpl } from './diagnostics/collector.js';
import { D } from './diagnostics/codes.js';

// ── Types ──────────────────────────────────────────────────

/** Options for controlling code generation output. */
export interface PipelineOptions {
  readonly sourceMap: boolean;
  readonly outDir: string;
}

/** Result of a full project compilation via {@link compileProject}. */
export interface PipelineResult {
  /** All generated output files (JS, DTS, source maps). */
  readonly outputFiles: readonly OutputFile[];
  /** Every diagnostic emitted during compilation. */
  readonly diagnostics: readonly Diagnostic[];
  /** The module dependency graph. */
  readonly moduleGraph: ModuleGraph;
  /** Parsed ASTs keyed by file path, cached for reuse by the host. */
  readonly astCache: ReadonlyMap<string, Program>;
}

// ── Synthetic span for graph-level diagnostics ─────────────

/**
 * Create a zero-length span at the start of a file.
 * Used for diagnostics that are not tied to a specific source location
 * (e.g. module resolution errors, cycle detection).
 * @param file - The file path to associate with the span.
 */
function syntheticSpan(file: string) {
  return { file, start: { offset: 0, line: 1, column: 0 }, end: { offset: 0, line: 1, column: 0 } };
}

// ── Pipeline ───────────────────────────────────────────────

/**
 * Compile a set of EffectScript source files into JS and DTS output.
 *
 * Phases:
 * 1. **Graph construction** — BFS over imports to build the module graph, parsing each file.
 * 2. **Topological sort** — Determine compilation order (errors on cycles).
 * 3. **Per-file compilation** — For each file in order: build import map, run pre-check
 *    passes, type-check, run post-check passes, and emit via the backend.
 * 4. **Post-compilation warnings** — Warn about modules with no exports.
 *
 * @param filePaths - Absolute paths to the entry `.efs` files.
 * @param options - Source map and output directory settings.
 * @param fileSystem - File system abstraction for reading source files.
 * @param diagnostics - Collector for accumulating all diagnostics.
 * @param typeProvider - Provider for resolving and extracting external declarations.
 * @param passRegistry - Registry of custom AST passes (pre-check and post-check).
 * @param backend - Code-generation backend to emit output files.
 * @returns Compilation results including output files, diagnostics, graph, and AST cache.
 */
export function compileProject(
  filePaths: readonly string[],
  options: PipelineOptions,
  fileSystem: FileSystem,
  diagnostics: DiagnosticCollector,
  typeProvider: TypeDeclarationProvider,
  passRegistry: PassRegistry,
  backend: CodegenBackend,
): PipelineResult {
  const graphBuilder = new ModuleGraphImpl();
  const astCache = new Map<string, Program>();

  // Phase 1: Build the module graph via BFS
  buildGraph(filePaths, fileSystem, typeProvider, graphBuilder, astCache, diagnostics);

  const graph: ModuleGraph = graphBuilder.build();

  // Phase 2: Topological sort
  let compilationOrder: readonly string[];
  try {
    compilationOrder = graph.getCompilationOrder();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.report({
      severity: 'error',
      code: D.E501,
      message,
      span: syntheticSpan('<module-graph>'),
    });
    return {
      outputFiles: [],
      diagnostics: diagnostics.getAll(),
      moduleGraph: graph,
      astCache,
    };
  }

  // Phase 3: Compile each file in topological order
  const allOutputFiles: OutputFile[] = [];

  for (const filePath of compilationOrder) {
    const ast = astCache.get(filePath);
    if (!ast) continue;

    // Build import map for this file
    const importMap = buildImportMap(ast, filePath, graph, typeProvider);

    // Run pre-check passes
    const passContext = { filePath, diagnostics, options: {} };
    const preResult = passRegistry.runPreCheckPasses(ast, passContext);

    // Type check with per-file collector to gate codegen
    const fileCollector = new DiagnosticCollectorImpl();
    const prelude = createPrelude();
    const checkerOutput = check({
      ast: preResult.ast,
      imports: importMap,
      prelude,
      diagnostics: fileCollector,
    });

    // Forward per-file diagnostics to main collector
    let fileErrorCount = 0;
    for (const diag of fileCollector.getAll()) {
      diagnostics.report(diag);
      if (diag.severity === 'error') fileErrorCount++;
    }

    // Store exports for downstream dependents
    graphBuilder.setExports(filePath, checkerOutput.exports);

    // Run post-check passes
    const postResult = passRegistry.runPostCheckPasses(checkerOutput.typedAST, passContext);

    // Codegen: skip if this file has errors
    if (fileErrorCount === 0) {
      const codegenResult = backend.emit(postResult.ast, {
        sourceMap: options.sourceMap,
        filePath,
        outDir: options.outDir,
      });

      for (const diag of codegenResult.diagnostics) {
        diagnostics.report(diag);
      }
      for (const file of codegenResult.files) {
        allOutputFiles.push(file);
      }
    }
  }

  // Phase 4: Post-compilation warnings
  emitEmptyExportWarnings(compilationOrder, graph, diagnostics);

  return {
    outputFiles: allOutputFiles,
    diagnostics: diagnostics.getAll(),
    moduleGraph: graph,
    astCache,
  };
}

// ── Graph Construction (BFS) ───────────────────────────────

/**
 * Build the module dependency graph via breadth-first traversal of imports.
 *
 * Starting from the entry files, reads and parses each `.efs` file, discovers
 * its import/export declarations, resolves them, and adds nodes and edges to
 * the graph builder. Parsed ASTs are cached for reuse during compilation.
 *
 * @param entryFiles - Absolute paths to the root `.efs` files.
 * @param fileSystem - File system for reading source content.
 * @param typeProvider - Resolves import specifiers to file paths.
 * @param graphBuilder - Mutable module graph under construction.
 * @param astCache - Map to populate with parsed ASTs keyed by file path.
 * @param diagnostics - Collector for reporting resolution and read errors.
 */
function buildGraph(
  entryFiles: readonly string[],
  fileSystem: FileSystem,
  typeProvider: TypeDeclarationProvider,
  graphBuilder: ModuleGraphImpl,
  astCache: Map<string, Program>,
  diagnostics: DiagnosticCollector,
): void {
  const visited = new Set<string>();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const content = fileSystem.readFile(filePath);
    if (content === undefined) {
      diagnostics.report({
        severity: 'error',
        code: D.E502,
        message: `Cannot read file '${filePath}': file does not exist or is not accessible`,
        span: syntheticSpan(filePath),
      });
      continue;
    }

    const fileHash = fnv1aHash(content);
    graphBuilder.addNode(filePath, 'efs', fileHash);

    // Lex + parse (cache AST for reuse in compilation phase)
    const parseCollector = new DiagnosticCollectorImpl();
    const tokens = tokenize(content, filePath, parseCollector);
    const ast = parse(tokens, filePath, parseCollector);
    astCache.set(filePath, ast);

    for (const diag of parseCollector.getAll()) {
      diagnostics.report(diag);
    }

    // Discover imports and add edges
    for (const source of extractImportSources(ast)) {
      const resolved = typeProvider.resolveModule(source.specifier, filePath);

      if (!resolved) {
        diagnostics.report({
          severity: 'error',
          code: D.E500,
          message: `Cannot resolve module '${source.specifier}'. Check that the package is installed or the path is correct`,
          span: syntheticSpan(filePath),
        });
        continue;
      }

      const edge: ImportEdge = {
        specifier: source.specifier,
        resolvedPath: resolved.path,
        importedNames: source.importedNames,
        isDefault: source.isDefault,
      };

      if (resolved.kind === 'efs') {
        if (!visited.has(resolved.path)) {
          if (fileSystem.fileExists(resolved.path)) {
            queue.push(resolved.path);
          } else {
            diagnostics.report({
              severity: 'error',
              code: D.E500,
              message: `Module '${source.specifier}' resolved to '${resolved.path}', but the file does not exist`,
              span: syntheticSpan(filePath),
            });
            continue;
          }
        }
        // Placeholder node (real hash computed when file is visited)
        graphBuilder.addNode(resolved.path, 'efs', '');
        graphBuilder.addImportEdge(filePath, edge);
      } else {
        graphBuilder.addNode(resolved.path, 'external', '', resolved.packageName);
        graphBuilder.addImportEdge(filePath, edge);
      }
    }
  }
}

// ── Import Source Extraction ───────────────────────────────

/** A normalized import reference extracted from an import or re-export declaration. */
interface ImportSource {
  /** The raw module specifier string (e.g. `"./utils"` or `"lodash"`). */
  specifier: string;
  /** Names imported from the module (named imports and re-export specifiers). */
  importedNames: string[];
  /** Whether the declaration includes a default import. */
  isDefault: boolean;
}

/**
 * Extract all import sources from a program's top-level declarations.
 * Handles both `import` and re-export `export ... from "..."` declarations.
 * @param ast - The parsed program to scan.
 * @returns An array of normalized import sources.
 */
function extractImportSources(ast: Program): ImportSource[] {
  const sources: ImportSource[] = [];

  for (const item of ast.body) {
    if (item.kind === 'ImportDeclaration') {
      const decl = item as ImportDeclaration;
      sources.push({
        specifier: decl.source.value,
        importedNames: decl.specifiers.map(s => s.imported.name),
        isDefault: decl.defaultImport !== undefined,
      });
    } else if (item.kind === 'ExportDeclaration') {
      const decl = item as ExportDeclaration;
      if (decl.source) {
        sources.push({
          specifier: decl.source.value,
          importedNames: decl.specifiers?.map(s => s.local.name) ?? [],
          isDefault: false,
        });
      }
    }
  }

  return sources;
}

// ── Import Map Construction ────────────────────────────────

/**
 * Build the import map for a single file's type-checking phase.
 *
 * For each import/re-export in the file, resolves the module specifier and
 * looks up its exported type signature — from the graph for `.efs` modules,
 * or from the type provider for external packages.
 *
 * @param ast - The parsed program whose imports are being resolved.
 * @param filePath - Absolute path of the file being compiled.
 * @param graph - The completed module graph (for `.efs` module exports).
 * @param typeProvider - Provider for resolving specifiers and extracting external types.
 * @returns A map from module specifier to its exported type signature.
 */
function buildImportMap(
  ast: Program,
  filePath: string,
  graph: ModuleGraph,
  typeProvider: TypeDeclarationProvider,
): Map<string, ExportedTypeSignature> {
  const importMap = new Map<string, ExportedTypeSignature>();
  const specifiers = new Map<string, ResolvedModule>();

  for (const item of ast.body) {
    if (item.kind === 'ImportDeclaration') {
      const decl = item as ImportDeclaration;
      const resolved = typeProvider.resolveModule(decl.source.value, filePath);
      if (resolved) specifiers.set(decl.source.value, resolved);
    } else if (item.kind === 'ExportDeclaration') {
      const decl = item as ExportDeclaration;
      if (decl.source) {
        const resolved = typeProvider.resolveModule(decl.source.value, filePath);
        if (resolved) specifiers.set(decl.source.value, resolved);
      }
    }
  }

  for (const [specifier, resolved] of specifiers) {
    if (resolved.kind === 'efs') {
      const exports = graph.getExports(resolved.path);
      if (exports) importMap.set(specifier, exports);
    } else {
      importMap.set(specifier, typeProvider.getExportedTypes(resolved.path));
    }
  }

  return importMap;
}

// ── W500: Warn about empty-export modules ──────────────────

/**
 * Emit W500 warnings for `.efs` dependencies that export nothing.
 *
 * Iterates over each compiled file's dependencies and warns if any
 * dependent `.efs` module has zero exported values, types, and constructors.
 *
 * @param compilationOrder - Files in topological compilation order.
 * @param graph - The module graph to query for exports.
 * @param diagnostics - Collector to report warnings to.
 */
function emitEmptyExportWarnings(
  compilationOrder: readonly string[],
  graph: ModuleGraph,
  diagnostics: DiagnosticCollector,
): void {
  for (const filePath of compilationOrder) {
    const deps = graph.getDependencies(filePath);
    for (const dep of deps) {
      if (dep.kind !== 'efs') continue;
      const sig = graph.getExports(dep.path);
      if (!sig) continue;
      if (sig.values.size === 0 && sig.types.size === 0 && sig.adtConstructors.size === 0 && sig.extensions.size === 0) {
        diagnostics.report({
          severity: 'warning',
          code: D.W500,
          message: `Module '${dep.path}' has no exports`,
          span: syntheticSpan(filePath),
        });
      }
    }
  }
}
