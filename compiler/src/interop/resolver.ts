/**
 * @module resolver
 *
 * Resolves import specifiers to on-disk module files. Handles both relative
 * paths (`./foo`, `../bar`) and bare/scoped package specifiers (`lodash`,
 * `@scope/pkg`). Relative resolution checks `.efs`, `.d.ts`, `.ts`, `.js`,
 * and directory `index` files in priority order. Bare specifiers delegate to
 * the TypeScript compiler's `resolveModuleName` with Node16 resolution.
 */
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import type { FileSystem } from '../filesystem.js';
import { EFS_EXT, JS_EXT, DTS_EXT } from '../utils/constants.js';

// ── Types ───────────────────────────────────────────────────

/**
 * A successfully resolved module, indicating its absolute path on disk,
 * its kind (EffectScript source, TypeScript declaration, or JavaScript),
 * and optionally the npm package name it belongs to.
 */
export interface ResolvedModule {
  readonly path: string;
  readonly kind: 'efs' | 'dts' | 'js';
  readonly packageName?: string;
}

/** Configuration for the module resolver. */
export interface ModuleResolverOptions {
  /** Project root directory. Used as context for resolution. */
  readonly basePath: string;
  /** Optional override for the `node_modules` search path. */
  readonly nodeModulesPath?: string;
}

/** Resolves an import specifier to an on-disk module. */
export interface ModuleResolver {
  /**
   * @param specifier  The import specifier string (relative or bare).
   * @param fromFile   Absolute path of the file containing the import.
   * @returns The resolved module, or `null` if resolution fails.
   */
  resolve(specifier: string, fromFile: string): ResolvedModule | null;
}

// ── Implementation ──────────────────────────────────────────

/**
 * Node.js–style module resolver.
 *
 * - Relative specifiers (`./`, `../`) are resolved by probing the filesystem
 *   for `.efs` → `.d.ts` → `.ts` → `.js` → directory index files.
 * - Bare specifiers are resolved via `ts.resolveModuleName` using Node16 module
 *   resolution, which searches `node_modules` and reads `package.json` exports.
 */
export class NodeModuleResolver implements ModuleResolver {
  private readonly fileSystem: FileSystem | undefined;

  /**
   * @param _options     Resolver configuration (base path, optional node_modules override).
   * @param fileSystem   Optional virtual filesystem used for `.efs` existence checks.
   */
  constructor(_options: ModuleResolverOptions, fileSystem?: FileSystem) {
    this.fileSystem = fileSystem;
  }

  /**
   * Resolves `specifier` relative to `fromFile`.
   * @returns The resolved module, or `null` if no matching file is found.
   */
  resolve(specifier: string, fromFile: string): ResolvedModule | null {
    if (!specifier) return null;

    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return this.resolveRelative(specifier, fromFile);
    }

    return this.resolveBare(specifier, fromFile);
  }

  /**
   * Resolves a relative specifier by probing for file extensions in priority
   * order: `.efs` → `.d.ts` → `.ts` → `.js` → directory index files.
   * Uses the virtual {@link FileSystem} for `.efs` checks when available.
   */
  private resolveRelative(specifier: string, fromFile: string): ResolvedModule | null {
    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, specifier);

    // Check .efs first (via FileSystem abstraction if available)
    const efsPath = resolved + EFS_EXT;
    if (this.fileSystem ? this.fileSystem.fileExists(efsPath) : fs.existsSync(efsPath)) {
      return { path: efsPath, kind: 'efs' };
    }

    // Check .d.ts
    const dtsPath = resolved + DTS_EXT;
    if (fs.existsSync(dtsPath)) {
      return { path: dtsPath, kind: 'dts' };
    }

    // Check .ts
    const tsPath = resolved + '.ts';
    if (fs.existsSync(tsPath)) {
      return { path: tsPath, kind: 'dts' };
    }

    // Check .js
    const jsPath = resolved + JS_EXT;
    if (fs.existsSync(jsPath)) {
      return { path: jsPath, kind: 'js' };
    }

    // Check directory index files
    const indexDts = path.join(resolved, `index${DTS_EXT}`);
    if (fs.existsSync(indexDts)) {
      return { path: indexDts, kind: 'dts' };
    }

    const indexTs = path.join(resolved, 'index.ts');
    if (fs.existsSync(indexTs)) {
      return { path: indexTs, kind: 'dts' };
    }

    const indexJs = path.join(resolved, `index${JS_EXT}`);
    if (fs.existsSync(indexJs)) {
      return { path: indexJs, kind: 'js' };
    }

    return null;
  }

  /**
   * Resolves a bare specifier (e.g. `"lodash"`, `"@scope/pkg"`) using the
   * TypeScript compiler's Node16 module resolution algorithm.
   */
  private resolveBare(specifier: string, fromFile: string): ResolvedModule | null {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
    };

    const result = ts.resolveModuleName(
      specifier,
      fromFile,
      compilerOptions,
      ts.sys,
    );

    if (result.resolvedModule) {
      const resolvedPath = result.resolvedModule.resolvedFileName;
      const kind: ResolvedModule['kind'] = resolvedPath.endsWith(DTS_EXT) || resolvedPath.endsWith('.ts')
        ? 'dts'
        : 'js';
      const packageName = this.extractPackageName(specifier);
      const resolvedModule: Record<string, unknown> = { path: resolvedPath, kind };
      if (packageName !== undefined) resolvedModule['packageName'] = packageName;
      return resolvedModule as unknown as ResolvedModule;
    }

    return null;
  }

  /**
   * Extracts the npm package name from a bare specifier.
   * Handles scoped packages (`@scope/name/sub` → `@scope/name`) and
   * regular packages (`name/sub` → `name`).
   */
  private extractPackageName(specifier: string): string | undefined {
    if (specifier.startsWith('@')) {
      // Scoped package: @scope/name or @scope/name/sub
      const parts = specifier.split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
    // Regular package: name or name/sub
    const parts = specifier.split('/');
    return parts[0];
  }
}
