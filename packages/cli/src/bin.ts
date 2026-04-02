#!/usr/bin/env node
/**
 * @module bin
 * CLI entry point for the EffectScript compiler (`esc`).
 * Invoked as `npx esc` or directly via the shebang line.
 * Delegates all argument parsing and command dispatch to {@link main}.
 */
import { main } from './cli.js';

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);