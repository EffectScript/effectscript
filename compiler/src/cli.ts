/**
 * @module cli
 * EffectScript compiler CLI — argument parsing, command dispatch, and watch mode.
 *
 * Provides the {@link main} entry point that is called by `bin.ts`.
 * Commands: `build`, `check`, `run`, `init`, `fmt` (stub), `lint` (stub).
 */
import type { FileSystem } from './filesystem.js';
import { D } from './diagnostics/codes.js';
import { EFS_EXT } from './utils/constants.js';

// ── Parsed Arguments ───────────────────────────────────────

/** Options parsed from CLI flags (e.g. `--outDir`, `--watch`). */
export interface CLIOptions {
  outDir?: string;
  sourceMap?: boolean;
  config?: string;
  noColor?: boolean;
  quiet?: boolean;
  showDiagnostics?: boolean;
  noCache?: boolean;
  watch?: boolean;
}

/** Result of parsing CLI arguments: a command name, optional path, and options. */
export interface ParsedArgs {
  command: 'build' | 'check' | 'run' | 'init' | 'fmt' | 'lint' | 'help' | 'version' | 'unknown';
  path?: string;
  options: CLIOptions;
}

// ── Argument Parser ────────────────────────────────────────

/** Set of recognized CLI command names. */
const COMMANDS = new Set(['build', 'check', 'run', 'init', 'fmt', 'lint']);

/**
 * Parse raw CLI arguments into a structured {@link ParsedArgs}.
 *
 * Handles flags (`--outDir`, `--watch`, etc.), commands, and positional path arguments.
 * Returns early for `--help` and `--version`.
 *
 * @param argv - Arguments from `process.argv.slice(2)` (no node/script prefix)
 * @returns Parsed command, options, and optional path
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const options: CLIOptions = {};
  let command: ParsedArgs['command'] = 'help';
  let path: string | undefined;
  let commandSet = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      return { command: 'help', options };
    }

    if (arg === '--version' || arg === '-v') {
      return { command: 'version', options };
    }

    if (arg === '--outDir' && i + 1 < argv.length) {
      options.outDir = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--config' && i + 1 < argv.length) {
      options.config = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--sourceMap') {
      options.sourceMap = true;
      i++;
      continue;
    }

    if (arg === '--no-sourceMap') {
      options.sourceMap = false;
      i++;
      continue;
    }

    if (arg === '--no-color') {
      options.noColor = true;
      i++;
      continue;
    }

    if (arg === '--quiet') {
      options.quiet = true;
      i++;
      continue;
    }

    if (arg === '--diagnostics') {
      options.showDiagnostics = true;
      i++;
      continue;
    }

    if (arg === '--no-cache') {
      options.noCache = true;
      i++;
      continue;
    }

    if (arg === '--watch') {
      options.watch = true;
      i++;
      continue;
    }

    // Command or path
    if (!commandSet) {
      if (COMMANDS.has(arg)) {
        command = arg as ParsedArgs['command'];
      } else {
        command = 'unknown';
        path = arg;
      }
      commandSet = true;
    } else if (path === undefined) {
      path = arg;
    }

    i++;
  }

  const result: Record<string, unknown> = { command, options };
  if (path !== undefined) result['path'] = path;
  return result as unknown as ParsedArgs;
}

// ── Init Command ───────────────────────────────────────────

/** Result of an `esc init` operation. */
export interface InitResult {
  exitCode: number;
  message: string;
}

/** Default `esc.json` content written by `esc init`. */
const DEFAULT_ESC_JSON = JSON.stringify(
  {
    compilerOptions: {
      outDir: './dist',
      sourceMap: true,
      target: 'es2020',
    },
    include: ['src/**/*.efs'],
    exclude: ['node_modules'],
  },
  null,
  2,
);

/** Default `src/main.efs` content written by `esc init`. */
const DEFAULT_MAIN_EFS = `export let main = (): void => {
  print("Hello, EffectScript!")
}
`;

/** Default `.gitignore` content written by `esc init` (if not already present). */
const DEFAULT_GITIGNORE = `dist/
node_modules/
.efs-cache/
`;

/** Default `package.json` content written by `esc init` (if not already present). */
const DEFAULT_PACKAGE_JSON = JSON.stringify(
  {
    name: 'my-effectscript-project',
    version: '0.1.0',
    type: 'module',
  },
  null,
  2,
);

/**
 * Initialize a new EffectScript project in the given directory.
 *
 * Creates `esc.json`, `src/main.efs`, and optionally `.gitignore` and `package.json`.
 * If a config file already exists, reports that the project is already initialized.
 *
 * @param dir - Absolute path to the project directory
 * @param fileSystem - FileSystem used to read/write project files
 * @returns An {@link InitResult} with exit code and user-facing message
 */
export function handleInit(dir: string, fileSystem: FileSystem): InitResult {
  // Check if already initialized
  if (fileSystem.fileExists(`${dir}/esc.json`) || fileSystem.fileExists(`${dir}/effectscript.json`)) {
    return {
      exitCode: 0,
      message: `Project already initialized in ${dir}`,
    };
  }

  fileSystem.writeFile(`${dir}/esc.json`, DEFAULT_ESC_JSON);
  fileSystem.writeFile(`${dir}/src/main.efs`, DEFAULT_MAIN_EFS);

  // Create .gitignore and package.json if they don't already exist
  if (!fileSystem.fileExists(`${dir}/.gitignore`)) {
    fileSystem.writeFile(`${dir}/.gitignore`, DEFAULT_GITIGNORE);
  }
  if (!fileSystem.fileExists(`${dir}/package.json`)) {
    fileSystem.writeFile(`${dir}/package.json`, DEFAULT_PACKAGE_JSON);
  }

  return {
    exitCode: 0,
    message: `Project initialized in ${dir}`,
  };
}

// ── Help Text ──────────────────────────────────────────────

/** Help text displayed by `esc --help`. */
export const HELP_TEXT = `Usage: esc <command> [path] [options]

Commands:
  build [path]    Compile .efs files
  check [path]    Type-check without output
  run <file>      Compile and execute
  init [dir]      Scaffold new project

Options:
  --outDir <dir>     Output directory (overrides config)
  --sourceMap        Enable source maps
  --no-sourceMap     Disable source maps
  --config <path>    Path to config file
  --no-color         Disable ANSI colors
  --quiet            Suppress warnings (show only errors)
  --diagnostics      Show compiler timing and stats
  --watch            Watch for changes and recompile
  --no-cache         Disable disk declaration cache
  --help             Show help
  --version          Show version
`;

/** Current EffectScript compiler version. */
export const VERSION = '0.2.0';

// ── Main (CLI entry point) ─────────────────────────────────

/**
 * CLI entry point — parses arguments and dispatches to the appropriate command handler.
 *
 * @param argv - Raw arguments (typically `process.argv.slice(2)`)
 * @returns Exit code (0 for success, non-zero for failure)
 */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.command) {
    case 'help':
      process.stderr.write(HELP_TEXT);
      return 0;

    case 'version':
      process.stderr.write(`esc ${VERSION}\n`);
      return 0;

    case 'unknown':
      process.stderr.write(
        `error[${D.E603}]: Unknown command '${args.path}'. Run 'esc --help' for usage.\n`,
      );
      return 1;

    case 'init':
      return handleInitCommand(args);

    case 'build':
      return handleBuildCommand(args);

    case 'check':
      return handleCheckCommand(args);

    case 'run':
      return handleRunCommand(args);

    case 'fmt':
      process.stderr.write('Formatter coming in a future version.\n');
      return 0;

    case 'lint':
      process.stderr.write('Linter coming in a future version.\n');
      return 0;
  }
}

/**
 * Handle `esc init` — scaffolds a new project with default config and source files.
 *
 * @param args - Parsed CLI arguments (path defaults to cwd)
 * @returns Exit code
 */
async function handleInitCommand(args: ParsedArgs): Promise<number> {
  const { NodeFileSystem } = await import('./filesystem.js');
  const fs = new NodeFileSystem();
  const dir = args.path ? resolveAbsolute(args.path) : process.cwd();
  const result = handleInit(dir, fs);
  process.stderr.write(result.message + '\n');
  return result.exitCode;
}

// ── Shared Compiler Setup ──────────────────────────────────

/** Shared context for build and check commands after common setup (config, host, file discovery). */
interface CompilerContext {
  readonly fs: import('./filesystem.js').FileSystem;
  readonly host: import('./host.js').CompilerHost;
  readonly files: string[];
  readonly formatDiagnostics: typeof import('./diagnostics/formatter.js').formatDiagnostics;
  readonly color: boolean;
  readonly quiet: boolean;
}

/**
 * Extract and validate the common setup needed by build and check commands.
 *
 * Loads config, discovers source files, and creates a compiler host.
 * Returns a numeric exit code if setup fails (e.g. no `.efs` files found).
 *
 * @param args - Parsed CLI arguments
 * @returns A {@link CompilerContext} on success, or an exit code on failure
 */
async function setupCompilerContext(args: ParsedArgs): Promise<CompilerContext | number> {
  const { NodeFileSystem } = await import('./filesystem.js');
  const { loadConfig, resolveConfig } = await import('./config.js');
  const { createCompilerHost } = await import('./host.js');
  const { formatDiagnostics } = await import('./diagnostics/formatter.js');

  const fs = new NodeFileSystem();
  const cwd = process.cwd();
  const config = loadConfig(cwd, fs, args.options.config);
  const resolved = resolveConfig(config, buildCLIOverrides(args.options));

  const files = discoverFiles(args.path, resolved, fs);
  if (files.length === 0) {
    process.stderr.write(`error[${D.E601}]: No .efs files found\n`);
    return 1;
  }

  const hostOpts: Record<string, unknown> = {
    fileSystem: fs,
    compilerOptions: resolved.compilerOptions,
    basePath: cwd,
  };
  if (args.options.noCache !== undefined) hostOpts['noCache'] = args.options.noCache;
  const host = createCompilerHost(hostOpts as unknown as import('./host.js').CompilerHostOptions);

  const color = !args.options.noColor && (process.stderr.isTTY ?? false) && !process.env['NO_COLOR'];

  return { fs, host, files, formatDiagnostics, color, quiet: args.options.quiet ?? false };
}

/**
 * Handle `esc build` — compile `.efs` files and write JS/DTS output.
 * Supports `--watch` for continuous recompilation on file changes.
 *
 * @param args - Parsed CLI arguments
 * @returns Exit code (0 if all files compiled without errors)
 */
async function handleBuildCommand(args: ParsedArgs): Promise<number> {
  const ctx = await setupCompilerContext(args);
  if (typeof ctx === 'number') return ctx;

  const { fs, host, files, formatDiagnostics, color, quiet } = ctx;

  const runBuild = async (): Promise<boolean> => {
    const result = await host.compile(files);

    const formatted = formatDiagnostics(result.diagnostics, {
      color,
      quiet,
      sourceLoader: (file) => fs.readFile(file),
    });
    if (formatted) process.stderr.write(formatted + '\n');

    for (const file of result.outputFiles) {
      fs.writeFile(file.path, file.content);
    }

    if (args.options.showDiagnostics) {
      const timings = host.getTimings();
      const stats = host.getStats();
      process.stderr.write(`\nCompiled ${stats.filesCompiled} files in ${timings.total.durationMs}ms\n`);
    }

    return result.success;
  };

  if (args.options.watch) {
    return watchAndRecompile(files, runBuild);
  }

  const success = await runBuild();
  return success ? 0 : 1;
}

/**
 * Handle `esc check` — type-check `.efs` files without emitting output.
 * Supports `--watch` for continuous checking on file changes.
 *
 * @param args - Parsed CLI arguments
 * @returns Exit code (0 if no type errors)
 */
async function handleCheckCommand(args: ParsedArgs): Promise<number> {
  const ctx = await setupCompilerContext(args);
  if (typeof ctx === 'number') return ctx;

  const { fs, host, files, formatDiagnostics, color, quiet } = ctx;

  const runCheck = async (): Promise<boolean> => {
    const diagnostics = await host.check(files);

    const formatted = formatDiagnostics(diagnostics, {
      color,
      quiet,
      sourceLoader: (file) => fs.readFile(file),
    });
    if (formatted) process.stderr.write(formatted + '\n');

    return !diagnostics.some(d => d.severity === 'error');
  };

  if (args.options.watch) {
    return watchAndRecompile(files, runCheck);
  }

  const success = await runCheck();
  return success ? 0 : 1;
}

// ── Watch Mode ──────────────────────────────────────────────

/** Format a timestamp for watch mode output (HH:MM:SS). */
function formatTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Extract unique parent directories from a list of file paths. */
function getWatchDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const idx = file.lastIndexOf('/');
    if (idx > 0) dirs.add(file.slice(0, idx));
  }
  return [...dirs];
}

/**
 * Watch source directories for .efs file changes and recompile.
 * Runs the initial compilation, then watches for changes with 100ms debouncing.
 * Never returns (keeps process alive until SIGINT).
 */
async function watchAndRecompile(
  files: readonly string[],
  recompile: () => Promise<boolean>,
): Promise<number> {
  const nodeFs = await import('fs');

  // Initial compilation
  process.stderr.write(`[${formatTimestamp()}] Starting compilation...\n`);
  await recompile();
  process.stderr.write(`[${formatTimestamp()}] Watching for file changes...\n\n`);

  // Watch directories containing source files
  const dirs = getWatchDirs(files);
  const watchers: import('fs').FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerRecompile = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      process.stderr.write(`[${formatTimestamp()}] File change detected. Starting compilation...\n`);
      await recompile();
      process.stderr.write(`[${formatTimestamp()}] Watching for file changes...\n\n`);
    }, 100);
  };

  for (const dir of dirs) {
    try {
      const watcher = nodeFs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith(EFS_EXT)) {
          triggerRecompile();
        }
      });
      watchers.push(watcher);
    } catch {
      // Directory may not exist or be unwatchable — skip silently
    }
  }

  // Clean exit on SIGINT
  process.on('SIGINT', () => {
    for (const w of watchers) w.close();
    process.exit(0);
  });

  // Keep process alive indefinitely
  await new Promise<void>(() => {});
  return 0;
}

/**
 * Handle `esc run <file>` — compile a single `.efs` file to a temp directory and execute it with Node.js.
 *
 * The temp directory is cleaned up on exit. The child process exit code is propagated.
 *
 * @param args - Parsed CLI arguments (must have `path` set to a `.efs` file)
 * @returns Exit code from the executed script, or 1 on compilation failure
 */
async function handleRunCommand(args: ParsedArgs): Promise<number> {
  const { NodeFileSystem } = await import('./filesystem.js');
  const { loadConfig, resolveConfig } = await import('./config.js');
  const { createCompilerHost } = await import('./host.js');
  const { formatDiagnostics } = await import('./diagnostics/formatter.js');
  const os = await import('os');
  const path = await import('path');
  const childProcess = await import('child_process');
  const nodeFs = await import('fs');

  if (!args.path) {
    process.stderr.write('error: esc run requires a file argument\n');
    return 1;
  }

  if (!args.path.endsWith(EFS_EXT)) {
    process.stderr.write(`error[${D.E603}]: 'esc run' requires a .efs file path, not a directory. Got: ${args.path}\n`);
    return 1;
  }

  const fs = new NodeFileSystem();
  const cwd = process.cwd();
  const config = loadConfig(cwd, fs, args.options.config);

  const entryFile = resolveAbsolute(args.path);
  const tmpDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'esc-run-'));

  const resolved = resolveConfig(config, { outDir: tmpDir, sourceMap: false });

  // Discover all files (entry + dependencies found by the pipeline)
  const files = [entryFile];
  if (files.length === 0) {
    process.stderr.write(`error[${D.E601}]: No .efs files found\n`);
    return 1;
  }

  const runHostOpts: Record<string, unknown> = {
    fileSystem: fs,
    compilerOptions: resolved.compilerOptions,
    basePath: cwd,
  };
  if (args.options.noCache !== undefined) runHostOpts['noCache'] = args.options.noCache;
  const host = createCompilerHost(runHostOpts as unknown as import('./host.js').CompilerHostOptions);

  const result = await host.compile(files, { outDir: tmpDir, sourceMap: false });

  if (!result.success) {
    const color = !args.options.noColor && (process.stderr.isTTY ?? false) && !process.env['NO_COLOR'];
    const formatted = formatDiagnostics(result.diagnostics, {
      color,
      quiet: args.options.quiet ?? false,
      sourceLoader: (file) => fs.readFile(file),
    });
    if (formatted) process.stderr.write(formatted + '\n');
    return 1;
  }

  // Write output files to temp dir
  for (const file of result.outputFiles) {
    fs.writeFile(file.path, file.content);
  }

  // Emit package.json with "type": "module" so Node.js treats .js as ESM
  fs.writeFile(path.join(tmpDir, 'package.json'), '{"type":"module"}\n');

  // Find entry point JS file
  const entryBase = path.basename(entryFile, EFS_EXT);
  const entryJs = path.join(tmpDir, `${entryBase}.js`);

  try {
    childProcess.execFileSync('node', [entryJs], {
      stdio: 'inherit',
    });
    return 0;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
      return err.status;
    }
    return 1;
  } finally {
    try {
      nodeFs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-fatal
    }
  }
}

// ── CLI Options → Config Overrides ─────────────────────────

/**
 * Convert CLI options into a config override record for {@link resolveConfig}.
 *
 * @param opts - Parsed CLI options
 * @returns Record with `outDir` and/or `sourceMap` keys if specified on the command line
 */
function buildCLIOverrides(opts: CLIOptions): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (opts.outDir !== undefined) overrides['outDir'] = resolveAbsolute(opts.outDir);
  if (opts.sourceMap !== undefined) overrides['sourceMap'] = opts.sourceMap;
  return overrides;
}

// ── File Discovery ─────────────────────────────────────────

/**
 * Discover `.efs` source files to compile.
 *
 * If a path argument is given, it is treated as either a single file or a directory.
 * Otherwise, the `include`/`exclude` patterns from the project config are used.
 *
 * @param pathArg - Optional path from CLI (file or directory)
 * @param config - Project configuration with include/exclude patterns
 * @param fileSystem - FileSystem to enumerate files
 * @returns Array of absolute paths to `.efs` files
 */
function discoverFiles(
  pathArg: string | undefined,
  config: import('./config.js').ProjectConfig,
  fileSystem: FileSystem,
): string[] {
  if (pathArg) {
    const resolved = resolveAbsolute(pathArg);

    // Single file
    if (resolved.endsWith(EFS_EXT)) {
      return fileSystem.fileExists(resolved) ? [resolved] : [];
    }

    // Directory — find .efs files
    return fileSystem.readDirectory(resolved, [EFS_EXT], [...config.exclude]) as string[];
  }

  // No path — use include/exclude patterns from config
  // For v0.2, use the first include pattern to determine the directory
  const files: string[] = [];
  for (const pattern of config.include) {
    // Simple pattern handling: extract the directory prefix before any glob
    const dir = extractDir(pattern);
    const found = fileSystem.readDirectory(dir, [EFS_EXT], [...config.exclude]);
    for (const f of found) {
      if (!files.includes(f)) files.push(f);
    }
  }
  return files;
}

/**
 * Extract the literal directory prefix from a glob pattern.
 *
 * Splits on `/` and takes path segments before the first one containing
 * glob characters (`*`, `?`, `{`).
 *
 * @param pattern - Glob include pattern
 * @returns Absolute directory path
 */
function extractDir(pattern: string): string {
  // Find the first segment that contains a glob character
  const parts = pattern.split('/');
  const dirParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{')) break;
    dirParts.push(part);
  }
  const dir = dirParts.join('/') || '.';
  return resolveAbsolute(dir);
}

/**
 * Resolve a path to an absolute path using `process.cwd()` as base.
 * Already-absolute paths are returned unchanged.
 *
 * @param p - Relative or absolute file path
 * @returns Absolute path
 */
function resolveAbsolute(p: string): string {
  if (p.startsWith('/')) return p;
  return `${process.cwd()}/${p}`;
}
