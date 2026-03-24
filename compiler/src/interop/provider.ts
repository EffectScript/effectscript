/**
 * @module provider
 *
 * High-level facade that orchestrates module resolution, type extraction, and
 * type mapping to produce EffectScript-compatible {@link ExportedTypeSignature}
 * values from external TypeScript/JS packages. This is the main entry point
 * used by the checker when an `import` references an external module.
 */
import * as ts from 'typescript';
import type { Type, RecordType, FunctionType, ExportedTypeSignature } from '../checker/types.js';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import type { FileSystem } from '../filesystem.js';
import { InMemoryDeclarationCache } from './cache.js';
import type { DeclarationCache } from './cache.js';
import { TsTypeExtractor } from './extractor.js';
import type { TypeExtractor, ExtractedModule } from './extractor.js';
import { TsTypeMapper } from './type-mapper.js';
import type { TypeMapper } from './type-mapper.js';
import { NodeModuleResolver } from './resolver.js';
import type { ModuleResolver, ResolvedModule } from './resolver.js';

// ── Interfaces ──────────────────────────────────────────────

export type { ResolvedModule } from './resolver.js';

/**
 * Provides EffectScript type signatures for external TypeScript/JS modules.
 * Handles resolution, extraction, mapping, and caching in a single interface.
 */
export interface TypeDeclarationProvider {
  /**
   * Resolves an import specifier to an on-disk module.
   * @param specifier  The import specifier (e.g. `"lodash"` or `"./utils"`).
   * @param fromFile   Absolute path of the importing file (for relative resolution).
   * @returns The resolved module, or `null` if resolution fails.
   */
  resolveModule(specifier: string, fromFile: string): ResolvedModule | null;

  /**
   * Returns the exported types, values, and ADT constructors for a module.
   * Results are cached; subsequent calls for the same `modulePath` return
   * the cached signature.
   * @param modulePath  Absolute path to the resolved `.d.ts` or `.ts` file.
   */
  getExportedTypes(modulePath: string): ExportedTypeSignature;

  /**
   * Returns the constructor signature for a named class export, or `null`
   * if the export is not a class or has a private constructor.
   * @param modulePath  Absolute path to the declaration file.
   * @param name        The exported class name.
   */
  getConstructorSignature(modulePath: string, name: string): FunctionType | null;

  /** Invalidates cached data for `modulePath`, forcing re-extraction on next access. */
  invalidate(modulePath: string): void;
}

/** Configuration options for creating a {@link TsCompilerApiProvider}. */
export interface ProviderOptions {
  /** Project root directory used for module resolution. */
  readonly basePath: string;
  /** Diagnostic collector for reporting extraction warnings and errors. */
  readonly diagnostics: DiagnosticCollector;
  /** Optional virtual filesystem (used in tests and in-memory compilation). */
  readonly fileSystem?: FileSystem;
  /** Optional declaration cache (defaults to {@link InMemoryDeclarationCache}). */
  readonly cache?: DeclarationCache;
}

// ── Empty signature constant ────────────────────────────────

/** Sentinel signature returned when extraction fails, avoiding repeated extraction attempts. */
const EMPTY_SIGNATURE: ExportedTypeSignature = {
  types: new Map(),
  values: new Map(),
  adtConstructors: new Map(),
  extensions: new Map(),
};

// ── Implementation ──────────────────────────────────────────

/**
 * TypeScript compiler API–based implementation of {@link TypeDeclarationProvider}.
 *
 * Composes a {@link ModuleResolver}, {@link TypeExtractor}, {@link TypeMapper},
 * and {@link DeclarationCache} to resolve, parse, map, and cache external
 * module signatures.
 */
export class TsCompilerApiProvider implements TypeDeclarationProvider {
  private readonly resolver: ModuleResolver;
  private readonly extractor: TypeExtractor;
  private readonly mapper: TypeMapper;
  private readonly cache: DeclarationCache;

  /** @param options  Configuration including base path, diagnostics, and optional overrides. */
  constructor(options: ProviderOptions) {
    this.resolver = new NodeModuleResolver(
      { basePath: options.basePath },
      options.fileSystem,
    );
    this.extractor = new TsTypeExtractor(options.diagnostics);
    this.mapper = new TsTypeMapper(options.diagnostics);
    this.cache = options.cache ?? new InMemoryDeclarationCache();
  }

  /** @inheritdoc */
  resolveModule(specifier: string, fromFile: string): ResolvedModule | null {
    return this.resolver.resolve(specifier, fromFile);
  }

  /**
   * Returns the cached signature or extracts one from the declaration file.
   * Each exported symbol is categorized into `types`, `values`, or
   * `adtConstructors` via {@link categorizeExport}.
   */
  getExportedTypes(modulePath: string): ExportedTypeSignature {
    // Cache check
    const cached = this.cache.get(modulePath);
    if (cached) return cached;

    // Extract
    const extracted = this.extractor.extract(modulePath);
    if (!extracted) {
      this.cache.set(modulePath, EMPTY_SIGNATURE);
      return EMPTY_SIGNATURE;
    }

    // Map each export
    const types = new Map<string, Type>();
    const values = new Map<string, Type>();
    const adtConstructors = new Map<string, FunctionType>();

    for (const [name, sym] of extracted.exports) {
      this.categorizeExport(
        name, sym, extracted, types, values, adtConstructors,
      );
    }

    const signature: ExportedTypeSignature = { types, values, adtConstructors, extensions: new Map() };
    this.cache.set(modulePath, signature);
    return signature;
  }

  /**
   * Looks up or extracts the constructor signature for a class export.
   * Caches the result (including `null` for non-class exports) to avoid
   * repeated extraction.
   */
  getConstructorSignature(modulePath: string, name: string): FunctionType | null {
    // Check constructor cache
    const cached = this.cache.getConstructor(modulePath, name);
    if (cached !== undefined) return cached;

    // Extract and map
    const extracted = this.extractor.extract(modulePath);
    if (!extracted) {
      this.cache.setConstructor(modulePath, name, null);
      return null;
    }

    const sym = extracted.exports.get(name);
    if (!sym) {
      this.cache.setConstructor(modulePath, name, null);
      return null;
    }

    const sourceFile = extracted.program.getSourceFile(modulePath);
    const symType = extracted.typeChecker.getTypeOfSymbolAtLocation(
      sym, sourceFile ?? ({} as ts.Node),
    );
    const ctor = this.mapper.mapConstructor(symType, extracted.typeChecker);
    this.cache.setConstructor(modulePath, name, ctor);
    return ctor;
  }

  /** @inheritdoc */
  invalidate(modulePath: string): void {
    this.cache.invalidate(modulePath);
    this.extractor.invalidateProgram();
  }

  /**
   * Routes an exported symbol into the appropriate map based on its TS symbol flags.
   *
   * - `TypeAlias` / `Interface` → `types`
   * - `Class` → `values` (instance type) + `adtConstructors` (constructor)
   * - `Enum` → `values` (declared type, not the enum object)
   * - Everything else (functions, variables) → `values`
   */
  private categorizeExport(
    name: string,
    sym: ts.Symbol,
    extracted: ExtractedModule,
    types: Map<string, Type>,
    values: Map<string, Type>,
    adtConstructors: Map<string, FunctionType>,
  ): void {
    // Resolve alias symbols to their target before checking flags.
    // Re-exports (`export { X } from "..."`) produce alias symbols whose flags
    // don't include the target's category flags (TypeAlias, Class, etc.).
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        resolved = extracted.typeChecker.getAliasedSymbol(sym);
      } catch {
        // getAliasedSymbol may throw for broken alias chains — fall back to original
        resolved = sym;
      }
    }
    const flags = resolved.flags;
    const sourceFile = extracted.program.getSourceFile(
      Array.from(extracted.exports.values())[0]
        ? (extracted.program.getRootFileNames()[0] ?? '')
        : '',
    );

    // Type alias → types map
    if (flags & ts.SymbolFlags.TypeAlias) {
      const declaredType = extracted.typeChecker.getDeclaredTypeOfSymbol(resolved);
      const mapped = this.mapper.mapType(declaredType, extracted.typeChecker);
      types.set(name, mapped);
      return;
    }

    // Interface → types map
    if ((flags & ts.SymbolFlags.Interface) && !(flags & ts.SymbolFlags.Class)) {
      const declaredType = extracted.typeChecker.getDeclaredTypeOfSymbol(resolved);
      const mapped = this.mapper.mapType(declaredType, extracted.typeChecker);
      types.set(name, mapped);
      return;
    }

    // Class → values (static side as record) + adtConstructors (constructor)
    if (flags & ts.SymbolFlags.Class) {
      const symType = extracted.typeChecker.getTypeOfSymbolAtLocation(
        resolved, sourceFile ?? ({} as ts.Node),
      );

      // Extract static members as a record type.
      // `getTypeOfSymbolAtLocation` returns the constructor/static type,
      // whose properties include static methods and fields.
      const staticFields = new Map<string, Type>();
      const staticProps = symType.getProperties();
      for (const prop of staticProps) {
        const propName = prop.getName();
        // Skip prototype and internal symbols
        if (propName === 'prototype' || propName.startsWith('__')) continue;
        const propDecls = prop.getDeclarations();
        const propDecl = propDecls?.[0];
        if (propDecl) {
          const propType = extracted.typeChecker.getTypeOfSymbolAtLocation(prop, propDecl);
          staticFields.set(propName, this.mapper.mapType(propType, extracted.typeChecker));
        }
      }

      // If there are static members, use a record type; otherwise fall back to instance type
      if (staticFields.size > 0) {
        values.set(name, { kind: 'record', fields: staticFields } as RecordType);
      } else {
        const declaredType = extracted.typeChecker.getDeclaredTypeOfSymbol(resolved);
        const instanceMapped = this.mapper.mapType(declaredType, extracted.typeChecker);
        values.set(name, instanceMapped);
      }

      // Constructor for adtConstructors
      const ctor = this.mapper.mapConstructor(symType, extracted.typeChecker);
      if (ctor) {
        adtConstructors.set(name, ctor);
      }
      return;
    }

    // Enum → values map: create a record type with member names as fields.
    // This enables `Direction.Up` access on enum values.
    if (flags & ts.SymbolFlags.Enum) {
      const fields = new Map<string, Type>();
      const enumMembers = resolved.exports;
      if (enumMembers) {
        enumMembers.forEach((memberSym, memberName) => {
          const mName = memberName as string;
          if (mName.startsWith('__')) return; // Skip internal symbols
          const memberType = extracted.typeChecker.getTypeOfSymbolAtLocation(
            memberSym, sourceFile ?? ({} as ts.Node),
          );
          fields.set(mName, this.mapper.mapType(memberType, extracted.typeChecker));
        });
      }
      values.set(name, { kind: 'record', fields } as RecordType);
      return;
    }

    // Everything else (functions, variables, etc.) → values map
    const symType = extracted.typeChecker.getTypeOfSymbolAtLocation(
      resolved, sourceFile ?? ({} as ts.Node),
    );
    const mapped = this.mapper.mapType(symType, extracted.typeChecker);
    values.set(name, mapped);
  }
}
