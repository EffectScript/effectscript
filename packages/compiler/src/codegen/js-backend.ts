/**
 * @module js-backend
 *
 * JavaScript code generation backend.
 *
 * {@link JSBackend} is the concrete {@link CodegenBackend} implementation that
 * ties together the JS emitter, DTS emitter, and source map generator to
 * produce the full set of output files (`.js`, `.d.ts`, and optionally `.js.map`)
 * for each compiled EffectScript source file.
 */

import type { Program } from '../parser/ast.js';
import type { CodegenBackend, CodegenOptions, CodegenResult, OutputFile } from './backend.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import { emitJSWithContext } from './js-emitter.js';
import { emitDTS } from './dts-emitter.js';
import { generateSourceMap } from './source-map.js';

/**
 * JavaScript code generation backend.
 *
 * Produces `.js`, `.d.ts`, and optionally `.js.map` files from a typed AST.
 * Delegates to {@link emitJSWithContext} for JS output, {@link emitDTS} for
 * TypeScript declarations, and {@link generateSourceMap} for source maps.
 */
export class JSBackend implements CodegenBackend {
  readonly name = 'javascript';

  /**
   * Emit all output files for a single source file.
   *
   * @param ast     - The type-checked AST.
   * @param options - Code generation options (source map, file paths, output dir).
   * @returns The generated files and any diagnostics.
   */
  emit(ast: Program, options: CodegenOptions): CodegenResult {
    const diagnostics: Diagnostic[] = [];
    const files: OutputFile[] = [];

    // Compute output file paths
    const baseName = getBaseName(options.filePath);
    const jsPath = `${options.outDir}/${baseName}.js`;
    const dtsPath = `${options.outDir}/${baseName}.d.ts`;

    // Emit JS
    const { source: jsSource, context } = emitJSWithContext(ast);

    // Append source map URL if source maps enabled
    let jsContent = jsSource;
    if (options.sourceMap) {
      const mapFileName = `${baseName}.js.map`;
      if (jsContent.length > 0 && !jsContent.endsWith('\n')) {
        jsContent += '\n';
      }
      jsContent += `//# sourceMappingURL=${mapFileName}\n`;
    }

    files.push({ path: jsPath, content: jsContent, kind: 'js' });

    // Emit .d.ts
    const dtsContent = emitDTS(ast);
    files.push({ path: dtsPath, content: dtsContent, kind: 'dts' });

    // Emit source map
    if (options.sourceMap) {
      const mapPath = `${options.outDir}/${baseName}.js.map`;
      const mapContent = generateSourceMap(
        context.getMappings(),
        options.filePath,
        `${baseName}.js`,
      );
      files.push({ path: mapPath, content: mapContent, kind: 'sourcemap' });
    }

    return { files, diagnostics };
  }
}

/**
 * Extract the base file name without extension from a file path.
 *
 * @param filePath - The full file path (e.g. `"src/main.efs"`).
 * @returns The file name without extension (e.g. `"main"`).
 */
function getBaseName(filePath: string): string {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1];
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
}
