/**
 * @module config
 * Project configuration loading and merging for the EffectScript compiler.
 *
 * Searches for `esc.json` or `effectscript.json` in the project root,
 * parses compiler options, and merges CLI flag overrides.
 */
import type { FileSystem } from './filesystem.js';

// ── Types ──────────────────────────────────────────────────

/** Compiler options controlling output format, directory, and passes. */
export interface CompilerOptions {
  readonly outDir: string;
  readonly sourceMap: boolean;
  readonly target: string;
  readonly noEmit?: boolean;
  readonly passes?: Readonly<Record<string, boolean>>;
  /** Maximum lazy field resolutions per compilation before budget exhaustion. Defaults to 500. */
  readonly lazyResolutionBudget?: number;
}

/** Full project configuration: compiler options plus include/exclude file patterns. */
export interface ProjectConfig {
  readonly compilerOptions: CompilerOptions;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

// ── Defaults ───────────────────────────────────────────────

/** Default configuration used when no config file is found. */
export const DEFAULT_CONFIG: ProjectConfig = {
  compilerOptions: {
    outDir: './dist',
    sourceMap: true,
    target: 'es2020',
  },
  include: ['src/**/*.efs'],
  exclude: ['node_modules'],
};

// ── Config loading ─────────────────────────────────────────

/** Config file names searched in order within the project directory. */
const CONFIG_NAMES = ['esc.json', 'effectscript.json'] as const;

/**
 * Load project configuration.
 *
 * @param projectDir - Absolute path to the project root directory
 * @param fileSystem - FileSystem to read config from
 * @param configPath - Optional explicit config path (overrides search)
 */
export function loadConfig(
  projectDir: string,
  fileSystem: FileSystem,
  configPath?: string,
): ProjectConfig {
  if (configPath !== undefined) {
    return loadFromPath(configPath, fileSystem);
  }

  // Search for config in project directory
  for (const name of CONFIG_NAMES) {
    const path = `${projectDir}/${name}`;
    if (fileSystem.fileExists(path)) {
      return loadFromPath(path, fileSystem);
    }
  }

  // No config found — return defaults
  return DEFAULT_CONFIG;
}

/**
 * Load and parse a config file from an explicit path.
 *
 * Reads the file, parses it as JSON, and extracts `compilerOptions`, `include`,
 * and `exclude` fields with fallbacks to {@link DEFAULT_CONFIG}.
 *
 * @param configPath - Absolute path to the config file
 * @param fileSystem - FileSystem to read the file
 * @returns Parsed {@link ProjectConfig}
 * @throws If the file cannot be read or is not valid JSON
 */
function loadFromPath(configPath: string, fileSystem: FileSystem): ProjectConfig {
  const content = fileSystem.readFile(configPath);
  if (content === undefined) {
    throw new Error(`Failed to load config file '${configPath}': file not found`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config file '${configPath}': ${reason}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Failed to load config file '${configPath}': expected JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const configDir = dirname(configPath);

  // Parse compilerOptions
  const rawOpts = typeof obj['compilerOptions'] === 'object' && obj['compilerOptions'] !== null
    ? obj['compilerOptions'] as Record<string, unknown>
    : {};

  const outDirRaw = typeof rawOpts['outDir'] === 'string'
    ? rawOpts['outDir']
    : DEFAULT_CONFIG.compilerOptions.outDir;

  const outDir = isAbsolute(outDirRaw)
    ? outDirRaw
    : resolvePath(configDir, outDirRaw);

  const sourceMap = typeof rawOpts['sourceMap'] === 'boolean'
    ? rawOpts['sourceMap']
    : DEFAULT_CONFIG.compilerOptions.sourceMap;

  const target = typeof rawOpts['target'] === 'string'
    ? rawOpts['target']
    : DEFAULT_CONFIG.compilerOptions.target;

  const lazyResolutionBudget = typeof rawOpts['lazyResolutionBudget'] === 'number'
    ? rawOpts['lazyResolutionBudget']
    : undefined;

  const compilerOptions: Record<string, unknown> = { outDir, sourceMap, target };
  if (lazyResolutionBudget !== undefined) compilerOptions['lazyResolutionBudget'] = lazyResolutionBudget;

  // Parse include/exclude
  const include = isStringArray(obj['include'])
    ? obj['include']
    : DEFAULT_CONFIG.include;

  const exclude = isStringArray(obj['exclude'])
    ? obj['exclude']
    : DEFAULT_CONFIG.exclude;

  return { compilerOptions: compilerOptions as unknown as CompilerOptions, include, exclude };
}

// ── CLI merging ────────────────────────────────────────────

/**
 * Merge CLI flag overrides into a base project configuration.
 *
 * CLI flags take precedence over the config file. Only `outDir` and `sourceMap`
 * can be overridden from the command line.
 *
 * @param base - Base configuration (from config file or defaults)
 * @param cliOptions - Override record with optional `outDir` and `sourceMap` keys
 * @returns Merged {@link ProjectConfig}
 */
export function resolveConfig(
  base: ProjectConfig,
  cliOptions: Record<string, unknown>,
): ProjectConfig {
  const result: Record<string, unknown> = {
    outDir: base.compilerOptions.outDir,
    sourceMap: base.compilerOptions.sourceMap,
    target: base.compilerOptions.target,
  };

  if (cliOptions.outDir !== undefined) result['outDir'] = cliOptions.outDir;
  if (cliOptions.sourceMap !== undefined) result['sourceMap'] = cliOptions.sourceMap;
  if (base.compilerOptions.lazyResolutionBudget !== undefined) result['lazyResolutionBudget'] = base.compilerOptions.lazyResolutionBudget;
  if (typeof cliOptions.lazyResolutionBudget === 'number') result['lazyResolutionBudget'] = cliOptions.lazyResolutionBudget;

  return {
    compilerOptions: result as unknown as CompilerOptions,
    include: base.include,
    exclude: base.exclude,
  };
}

// ── Path utilities (no dependency on node:path) ────────────

/** Type guard: checks whether a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/** Check whether a path is absolute (starts with `/`). */
function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Return the directory portion of a path (everything before the last `/`). */
function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** Join a base directory and a relative path, stripping a leading `./` from the relative part. */
function resolvePath(base: string, relative: string): string {
  // Strip leading ./
  const cleaned = relative.startsWith('./') ? relative.slice(2) : relative;
  return base.endsWith('/') ? `${base}${cleaned}` : `${base}/${cleaned}`;
}
