import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { TsCompilerApiProvider } from './provider.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { FunctionType, RecordType, InterfaceType, ExportedTypeSignature } from '../checker/types.js';

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
      // With InterfaceType mapping, constructor returns the instance InterfaceType
      expect(pointCtor.returnType.kind).toBe('interface');
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

  describe('export = handling', () => {
    it('export = function + namespace produces default and named exports', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'export-equals-simple.d.ts'));
      // Default export should be the function
      expect(sig.values.has('default')).toBe(true);
      const defaultType = sig.values.get('default')!;
      expect(defaultType.kind).toBe('function');

      // Namespace members should be exposed as named exports
      expect(sig.values.has('helper')).toBe(true);
      const helperType = sig.values.get('helper')!;
      expect(helperType.kind).toBe('function');

      expect(sig.values.has('VERSION')).toBe(true);
    });

    it('export = class produces default constructor export', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'export-equals-class.d.ts'));
      expect(sig.values.has('default')).toBe(true);
    });

    it('export = namespace produces default and named function exports', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'export-equals-namespace.d.ts'));
      expect(sig.values.has('default')).toBe(true);
      expect(sig.values.has('createElement')).toBe(true);
      expect(sig.values.has('useState')).toBe(true);
      // Interface should go into types
      expect(sig.types.has('Props')).toBe(true);
    });

    it('supports combined default + named imports from export = module', () => {
      // Verifies: import myLib, { helper, VERSION } from "my-lib"
      // Both the default export (myLib) and named exports (helper, VERSION)
      // must be available from the same ExportedTypeSignature
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'export-equals-simple.d.ts'));

      // Default import: myLib (the function)
      const defaultExport = sig.values.get('default');
      expect(defaultExport).toBeDefined();
      expect(defaultExport!.kind).toBe('function');

      // Named imports: helper and VERSION (from the namespace)
      const helper = sig.values.get('helper');
      expect(helper).toBeDefined();
      expect(helper!.kind).toBe('function');

      const version = sig.values.get('VERSION');
      expect(version).toBeDefined();
      expect(version!.kind).toBe('primitive');

      // Type imports: Config (from the namespace)
      expect(sig.types.has('Config')).toBe(true);
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

  // ── Static class members (P2-3) ────────────────────────────────

  describe('static class members', () => {
    it('class with static methods exposes them in class value InterfaceType', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'static-members.d.ts'));
      expect(sig.values.has('Container')).toBe(true);
      const containerType = sig.values.get('Container')!;
      // Classes now map to InterfaceType class value type
      expect(containerType.kind).toBe('interface');
      const iface = containerType as InterfaceType;
      // Static methods are in the class value type's methods map
      expect(iface.methods.has('create')).toBe(true);
      expect(iface.methods.has('empty')).toBe(true);
      const createMethod = iface.methods.get('create')!;
      expect(createMethod.kind).toBe('function');
      // Constructor is available
      expect(iface.constructSignature).toBeDefined();
    });

    it('class without static members has class value type as InterfaceType', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'static-members.d.ts'));
      expect(sig.values.has('Point')).toBe(true);
      const pointType = sig.values.get('Point')!;
      // Classes now map to InterfaceType class value type with constructSignature
      expect(pointType.kind).toBe('interface');
      const iface = pointType as InterfaceType;
      expect(iface.constructSignature).toBeDefined();
      expect(iface.constructSignature!.params).toHaveLength(2);
      // Instance type is the constructor's returnType
      const instanceType = iface.constructSignature!.returnType as InterfaceType;
      expect(instanceType.kind).toBe('interface');
      expect(instanceType.properties.has('x')).toBe(true);
      expect(instanceType.properties.has('y')).toBe(true);
    });

    it('constructor is still available in adtConstructors', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'static-members.d.ts'));
      expect(sig.adtConstructors.has('Container')).toBe(true);
      expect(sig.adtConstructors.has('Point')).toBe(true);
    });
  });

  // ── Enum member access (P2-2) ──────────────────────────────────

  describe('enum member access', () => {
    it('numeric enum is mapped to record with number literal fields', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'complex-types.d.ts'));
      expect(sig.values.has('NumericColor')).toBe(true);
      const enumType = sig.values.get('NumericColor')!;
      expect(enumType.kind).toBe('record');
      const rec = enumType as RecordType;
      expect(rec.fields.has('Red')).toBe(true);
      expect(rec.fields.has('Green')).toBe(true);
      expect(rec.fields.has('Blue')).toBe(true);
      expect(rec.fields.get('Red')).toEqual({ kind: 'literal', base: 'number', value: 0 });
    });

    it('string enum is mapped to record with string literal fields', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'complex-types.d.ts'));
      expect(sig.values.has('StringDirection')).toBe(true);
      const enumType = sig.values.get('StringDirection')!;
      expect(enumType.kind).toBe('record');
      const rec = enumType as RecordType;
      expect(rec.fields.has('Up')).toBe(true);
      expect(rec.fields.has('Down')).toBe(true);
      expect(rec.fields.get('Up')).toEqual({ kind: 'literal', base: 'string', value: 'UP' });
    });

    it('mixed enum has fields typed per member', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'complex-types.d.ts'));
      expect(sig.values.has('MixedEnum')).toBe(true);
      const enumType = sig.values.get('MixedEnum')!;
      expect(enumType.kind).toBe('record');
      const rec = enumType as RecordType;
      expect(rec.fields.has('A')).toBe(true);
      expect(rec.fields.has('B')).toBe(true);
    });
  });

  // ── Alias re-export handling (P1-4) ────────────────────────────

  describe('alias re-exports', () => {
    it('re-exported function via export { X } from "..." is visible', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'alias-reexport.d.ts'));
      // Direct export should work
      expect(sig.values.has('directFn')).toBe(true);
      // Re-exported alias should also work
      expect(sig.values.has('otherFn')).toBe(true);
      const otherFnType = sig.values.get('otherFn') as FunctionType;
      expect(otherFnType.kind).toBe('function');
      expect(otherFnType.returnType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('namespace re-export (import * as X; export { X }) is visible', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'alias-reexport.d.ts'));
      // Namespace re-export should be visible as a value
      expect(sig.values.has('submod')).toBe(true);
      // The namespace should be a record with the exported members
      const submodType = sig.values.get('submod')!;
      expect(submodType.kind).toBe('record');
      const rec = submodType as RecordType;
      expect(rec.fields.has('otherFn')).toBe(true);
    });
  });

  // ── InterfaceType class mapping ──────────────────────────────

  describe('interface type class mapping', () => {
    it('TS declare class maps to InterfaceType with constructSignature in values', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.values.has('Command')).toBe(true);
      const classValue = sig.values.get('Command')! as InterfaceType;
      expect(classValue.kind).toBe('interface');
      expect(classValue.constructSignature).toBeDefined();
      expect(classValue.constructSignature!.kind).toBe('function');
      expect(classValue.constructSignature!.params).toHaveLength(1);
      // Instance type stored in types map
      expect(sig.types.has('Command')).toBe(true);
      const instanceType = sig.types.get('Command')! as InterfaceType;
      expect(instanceType.kind).toBe('interface');
      expect(instanceType.properties.has('name')).toBe(true);
      expect(instanceType.methods.has('run')).toBe(true);
      // Constructor returnType is the instance type
      expect(classValue.constructSignature!.returnType).toBe(instanceType);
    });

    it('TS declare class with private constructor has no constructSignature', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.values.has('Singleton')).toBe(true);
      const classValue = sig.values.get('Singleton')! as InterfaceType;
      expect(classValue.kind).toBe('interface');
      // Private constructor → no constructSignature
      expect(classValue.constructSignature).toBeUndefined();
      // No adtConstructors entry either
      expect(sig.adtConstructors.has('Singleton')).toBe(false);
    });

    it('generic class constructor carries type params from class', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.values.has('Container')).toBe(true);
      const classValue = sig.values.get('Container')! as InterfaceType;
      expect(classValue.kind).toBe('interface');
      expect(classValue.constructSignature).toBeDefined();
      // Constructor should have typeParams propagated from class
      expect(classValue.constructSignature!.typeParams).toBeDefined();
      expect(classValue.constructSignature!.typeParams!.length).toBe(1);
      expect(classValue.constructSignature!.typeParams![0].name).toBe('T');
    });

    it('class with static members separates static and instance types', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.values.has('Factory')).toBe(true);
      const classValue = sig.values.get('Factory')! as InterfaceType;
      expect(classValue.kind).toBe('interface');
      // Static methods are on class value type
      expect(classValue.methods.has('create')).toBe(true);
      // Instance members are NOT on class value type
      expect(classValue.properties.has('id')).toBe(false);
      expect(classValue.methods.has('create')).toBe(true);
      // Instance type is in types map
      const instanceType = sig.types.get('Factory')! as InterfaceType;
      expect(instanceType.kind).toBe('interface');
      expect(instanceType.properties.has('id')).toBe(true);
    });

    it('TS interface (non-class) maps to types only, not values', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.types.has('Serializable')).toBe(true);
      expect(sig.values.has('Serializable')).toBe(false);
      const iface = sig.types.get('Serializable')! as InterfaceType;
      expect(iface.kind).toBe('interface');
      expect(iface.methods.has('serialize')).toBe(true);
    });

    it('callable interface maps with __call method', () => {
      const sig = provider.getExportedTypes(path.join(fixturesDir, 'interface-types.d.ts'));
      expect(sig.types.has('Logger')).toBe(true);
      const iface = sig.types.get('Logger')! as InterfaceType;
      expect(iface.kind).toBe('interface');
      expect(iface.methods.has('__call')).toBe(true);
      expect(iface.properties.has('level')).toBe(true);
    });
  });
});
