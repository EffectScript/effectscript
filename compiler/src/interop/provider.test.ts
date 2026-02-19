import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { TsCompilerApiProvider } from './provider.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { FunctionType, RecordType, ExportedTypeSignature } from '../checker/types.js';

const fixturesDir = path.resolve(import.meta.dirname, '__fixtures__');
const basePath = path.resolve(import.meta.dirname, '../..');

describe('TsCompilerApiProvider', () => {
  let provider: TsCompilerApiProvider;
  let diagnostics: DiagnosticCollectorImpl;

  beforeEach(() => {
    diagnostics = new DiagnosticCollectorImpl();
    provider = new TsCompilerApiProvider({ basePath, diagnostics });
  });

  describe('getExportedTypes', () => {
    it('extracts types from simple-functions.d.ts', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'simple-functions.d.ts'));
      expect(sig.values.has('greet')).toBe(true);
      expect(sig.values.has('add')).toBe(true);
      expect(sig.values.has('PI')).toBe(true);
      expect(sig.values.has('NAME')).toBe(true);

      const greetType = sig.values.get('greet') as FunctionType;
      expect(greetType.kind).toBe('function');
      expect(greetType.returnType).toEqual({ kind: 'primitive', name: 'string' });

      const piType = sig.values.get('PI')!;
      expect(piType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('extracts class with constructor into values and adtConstructors', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'simple-classes.d.ts'));
      expect(sig.values.has('Point')).toBe(true);
      expect(sig.adtConstructors.has('Point')).toBe(true);

      const pointCtor = sig.adtConstructors.get('Point')!;
      expect(pointCtor.kind).toBe('function');
      expect(pointCtor.params).toHaveLength(2);
      expect(pointCtor.returnType.kind).toBe('record');
    });

    it('handles private constructor (no adtConstructors entry)', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'simple-classes.d.ts'));
      expect(sig.values.has('Singleton')).toBe(true);
      // Singleton has private constructor → no constructor in adtConstructors
      expect(sig.adtConstructors.has('Singleton')).toBe(false);
    });

    it('categorizes type aliases into types map', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'complex-types.d.ts'));
      expect(sig.types.has('Person')).toBe(true);
      const personType = sig.types.get('Person');
      expect(personType?.kind).toBe('record');
      if (personType?.kind === 'record') {
        expect(personType.fields.has('name')).toBe(true);
        expect(personType.fields.has('age')).toBe(true);
      }
    });

    it('categorizes interfaces into types map', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'complex-types.d.ts'));
      expect(sig.types.has('Named')).toBe(true);
      expect(sig.types.has('Aged')).toBe(true);
    });

    it('handles default export', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'default-export.d.ts'));
      expect(sig.values.has('default')).toBe(true);
      const defaultType = sig.values.get('default')!;
      expect(defaultType.kind).toBe('function');
      // Also has named export
      expect(sig.values.has('version')).toBe(true);
    });

    it('returns cached result on second call', () => {
      const dtsPath = path.join(fixturesDir, 'simple-functions.d.ts');
      const sig1 = provider.getExportedTypes(dtsPath);
      const sig2 = provider.getExportedTypes(dtsPath);
      expect(sig1).toBe(sig2);
    });

    it('returns empty signature for non-existent file', () => {
      const sig = provider.getExportedTypes('/nonexistent/path.d.ts');
      expect(sig.values.size).toBe(0);
      expect(sig.types.size).toBe(0);
      expect(sig.adtConstructors.size).toBe(0);
      expect(diagnostics.hasErrors()).toBe(true);
    });

    it('handles react-minimal fixture', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'react-minimal.d.ts'));
      expect(sig.values.has('useState')).toBe(true);
      expect(sig.values.has('useEffect')).toBe(true);
      expect(sig.values.has('createElement')).toBe(true);

      const useState = sig.values.get('useState') as FunctionType;
      expect(useState.kind).toBe('function');
      expect(useState.typeParams).toBeDefined();
    });
  });

  describe('getConstructorSignature', () => {
    it('returns constructor for Point class', () => {
      const dtsPath = path.join(fixturesDir, 'simple-classes.d.ts');
      const ctor = provider.getConstructorSignature(dtsPath, 'Point');
      expect(ctor).not.toBeNull();
      expect(ctor!.kind).toBe('function');
      expect(ctor!.params).toHaveLength(2);
    });

    it('returns null for non-existent class', () => {
      const dtsPath = path.join(fixturesDir, 'simple-classes.d.ts');
      const ctor = provider.getConstructorSignature(dtsPath, 'NonExistent');
      expect(ctor).toBeNull();
    });

    it('caches constructor results', () => {
      const dtsPath = path.join(fixturesDir, 'simple-classes.d.ts');
      const ctor1 = provider.getConstructorSignature(dtsPath, 'Point');
      const ctor2 = provider.getConstructorSignature(dtsPath, 'Point');
      expect(ctor1).toBe(ctor2);
    });
  });

  describe('resolveModule', () => {
    it('resolves relative .d.ts module', () => {
      const result = provider.resolveModule(
        './simple-functions',
        path.join(fixturesDir, 'source.efs'),
      );
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('dts');
    });

    it('returns null for non-existent module', () => {
      const result = provider.resolveModule(
        './nonexistent',
        path.join(fixturesDir, 'source.efs'),
      );
      expect(result).toBeNull();
    });
  });

  describe('invalidation', () => {
    it('invalidation clears cached types', () => {
      const dtsPath = path.join(fixturesDir, 'simple-functions.d.ts');
      const sig1 = provider.getExportedTypes(dtsPath);
      provider.invalidate(dtsPath);
      const sig2 = provider.getExportedTypes(dtsPath);
      // After invalidation, a fresh extraction occurs
      expect(sig1).not.toBe(sig2);
      // But the content should be the same
      expect(sig2.values.has('greet')).toBe(true);
    });
  });

  describe('integration with checker types', () => {
    it('produces ExportedTypeSignature compatible with checker imports', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'simple-functions.d.ts'));

      // Verify the signature shape matches what the checker expects
      const imports = new Map<string, ExportedTypeSignature>();
      imports.set('my-lib', sig);

      // The checker would look up imports like this:
      const libSig = imports.get('my-lib');
      expect(libSig).toBeDefined();
      expect(libSig!.values.get('greet')).toBeDefined();
      expect(libSig!.values.get('PI')).toBeDefined();
    });
  });
});
