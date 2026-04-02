/** Minimal console declaration for Node.js runtime (no @types/node dependency). */
declare const console: {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  log(...args: unknown[]): void;
};
