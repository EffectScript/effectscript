import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as ts from 'typescript';
import { TsTypeExtractor } from './extractor.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';

const fixturesDir = path.resolve(import.meta.dirname, '__fixtures__');

describe('TsTypeExtractor', () => {
  let extractor: TsTypeExtractor;
  let diagnostics: DiagnosticCollectorImpl;

  beforeEach(() => {
    diagnostics = new DiagnosticCollectorImpl();
    extractor = new TsTypeExtractor(diagnostics);
  });

  it('extracts exports from simple-functions.d.ts', () => {
    const result = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('greet')).toBe(true);
    expect(result!.exports.has('add')).toBe(true);
    expect(result!.exports.has('isValid')).toBe(true);
    expect(result!.exports.has('doNothing')).toBe(true);
    expect(result!.exports.has('PI')).toBe(true);
    expect(result!.exports.has('NAME')).toBe(true);
  });

  it('extracts exports from simple-classes.d.ts', () => {
    const result = extractor.extract(path.join(fixturesDir, 'simple-classes.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('Point')).toBe(true);
    expect(result!.exports.has('Singleton')).toBe(true);
  });

  it('extracts exports from generics.d.ts', () => {
    const result = extractor.extract(path.join(fixturesDir, 'generics.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('identity')).toBe(true);
    expect(result!.exports.has('pair')).toBe(true);
    expect(result!.exports.has('mapArray')).toBe(true);
    expect(result!.exports.has('Container')).toBe(true);
  });

  it('extracts exports from nullable-types.d.ts', () => {
    const result = extractor.extract(path.join(fixturesDir, 'nullable-types.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('findItem')).toBe(true);
    expect(result!.exports.has('Config')).toBe(true);
  });

  it('extracts exports from complex-types.d.ts', () => {
    const result = extractor.extract(path.join(fixturesDir, 'complex-types.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('Named')).toBe(true);
    expect(result!.exports.has('Aged')).toBe(true);
    expect(result!.exports.has('Person')).toBe(true);
    expect(result!.exports.has('StringDirection')).toBe(true);
  });

  it('extracts default export', () => {
    const result = extractor.extract(path.join(fixturesDir, 'default-export.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('default')).toBe(true);
    expect(result!.exports.has('version')).toBe(true);
  });

  it('extracts circular types without error', () => {
    const result = extractor.extract(path.join(fixturesDir, 'circular-types.d.ts'));
    expect(result).not.toBeNull();
    expect(result!.exports.has('TreeNode')).toBe(true);
    expect(result!.exports.has('NodeA')).toBe(true);
    expect(result!.exports.has('NodeB')).toBe(true);
  });

  it('returns null and reports E301 for non-existent path', () => {
    const result = extractor.extract('/nonexistent/path.d.ts');
    expect(result).toBeNull();
    expect(diagnostics.hasErrors()).toBe(true);
    const errors = diagnostics.getErrors();
    expect(errors.some(e => e.code === 'E301')).toBe(true);
  });

  it('reuses program across extractions of different files', () => {
    const result1 = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    const result2 = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    // Same file → same program (no new rootFile added)
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.program).toBe(result2!.program);
  });

  it('recreates program when new file is added', () => {
    const result1 = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    const result2 = extractor.extract(path.join(fixturesDir, 'simple-classes.d.ts'));
    // New file → new program
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.program).not.toBe(result2!.program);
  });

  it('invalidateProgram forces recreation', () => {
    const result1 = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    extractor.invalidateProgram();
    const result2 = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    // After invalidation, same file still triggers a new program (since it's already in rootFiles, no new file)
    // Actually invalidateProgram just nulls the program, rootFiles stay the same
    // Next extract sees rootFiles already has this path (isNew = false), program is null
    // so it creates a new one
    expect(result1!.program).not.toBe(result2!.program);
  });

  it('provides valid typeChecker for extracted module', () => {
    const result = extractor.extract(path.join(fixturesDir, 'simple-functions.d.ts'));
    expect(result).not.toBeNull();
    const greetSym = result!.exports.get('greet')!;
    const sourceFile = result!.program.getSourceFile(path.join(fixturesDir, 'simple-functions.d.ts'))!;
    const greetType = result!.typeChecker.getTypeOfSymbolAtLocation(greetSym, sourceFile);
    const callSigs = greetType.getCallSignatures();
    expect(callSigs.length).toBeGreaterThan(0);
  });
});
