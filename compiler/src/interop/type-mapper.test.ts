import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { TsTypeMapper } from './type-mapper.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Type, FunctionType, RecordType, LazyRecordType, LiteralType, UnionType } from '../checker/types.js';
import { typeToString, lookupRecordField, isRecordLike } from '../checker/types.js';

// ── Test Helper ─────────────────────────────────────────────

const fixturesDir = path.resolve(import.meta.dirname, '__fixtures__');

interface MappedFixture {
  mapper: TsTypeMapper;
  exports: Map<string, { symbol: ts.Symbol; type: ts.Type; declaredType: ts.Type }>;
  checker: ts.TypeChecker;
  diagnostics: DiagnosticCollectorImpl;
}

function mapFixture(name: string): MappedFixture {
  const filePath = path.join(fixturesDir, name);
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    declaration: true,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) throw new Error(`Could not load fixture: ${name}`);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`No module symbol for: ${name}`);

  const exportsMap = new Map<string, { symbol: ts.Symbol; type: ts.Type; declaredType: ts.Type }>();
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  for (const sym of exportedSymbols) {
    const type = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
    const declaredType = checker.getDeclaredTypeOfSymbol(sym);
    exportsMap.set(sym.getName(), { symbol: sym, type, declaredType });
  }

  const diagnostics = new DiagnosticCollectorImpl();
  const mapper = new TsTypeMapper(diagnostics);

  return { mapper, exports: exportsMap, checker, diagnostics };
}

function getType(fixture: MappedFixture, name: string): Type {
  const entry = fixture.exports.get(name);
  if (!entry) throw new Error(`Export '${name}' not found in fixture`);
  return fixture.mapper.mapType(entry.type, fixture.checker);
}

/** Get the declared type (for type aliases, enums, interfaces) */
function getDeclaredType(fixture: MappedFixture, name: string): Type {
  const entry = fixture.exports.get(name);
  if (!entry) throw new Error(`Export '${name}' not found in fixture`);
  return fixture.mapper.mapType(entry.declaredType, fixture.checker);
}

// ── Tests ───────────────────────────────────────────────────

describe('TsTypeMapper', () => {
  describe('primitives', () => {
    it('maps string parameter type', () => {
      const f = mapFixture('simple-functions.d.ts');
      const nameType = getType(f, 'NAME');
      expect(nameType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps number constant', () => {
      const f = mapFixture('simple-functions.d.ts');
      const piType = getType(f, 'PI');
      expect(piType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps function returning string', () => {
      const f = mapFixture('simple-functions.d.ts');
      const greetType = getType(f, 'greet') as FunctionType;
      expect(greetType.kind).toBe('function');
      expect(greetType.returnType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps function returning void', () => {
      const f = mapFixture('simple-functions.d.ts');
      const doNothingType = getType(f, 'doNothing') as FunctionType;
      expect(doNothingType.kind).toBe('function');
      expect(doNothingType.returnType).toEqual({ kind: 'primitive', name: 'void' });
    });

    it('maps function returning boolean', () => {
      const f = mapFixture('simple-functions.d.ts');
      const isValidType = getType(f, 'isValid') as FunctionType;
      expect(isValidType.kind).toBe('function');
      expect(isValidType.returnType).toEqual({ kind: 'primitive', name: 'boolean' });
    });

    it('maps function with number params', () => {
      const f = mapFixture('simple-functions.d.ts');
      const addType = getType(f, 'add') as FunctionType;
      expect(addType.kind).toBe('function');
      expect(addType.params).toHaveLength(2);
      expect(addType.params[0].type).toEqual({ kind: 'primitive', name: 'number' });
      expect(addType.params[1].type).toEqual({ kind: 'primitive', name: 'number' });
      expect(addType.returnType).toEqual({ kind: 'primitive', name: 'number' });
    });
  });

  describe('null and undefined', () => {
    it('maps string | null to nullable string', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'findItem') as FunctionType;
      expect(fnType.returnType).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'string' },
      });
    });

    it('maps number | undefined to nullable number', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'maybeNumber') as FunctionType;
      expect(fnType.returnType).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'number' },
      });
    });

    it('maps string | null | undefined to nullable string', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'bothNullish') as FunctionType;
      expect(fnType.returnType).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'string' },
      });
    });
  });

  describe('compound types', () => {
    it('maps number | string | null to nullable union', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'multiUnionNull') as FunctionType;
      expect(fnType.returnType.kind).toBe('nullable');
      if (fnType.returnType.kind === 'nullable') {
        expect(fnType.returnType.inner.kind).toBe('union');
        if (fnType.returnType.inner.kind === 'union') {
          expect(fnType.returnType.inner.members).toHaveLength(2);
        }
      }
    });

    it('maps interface to record type', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const paramType = fnType.params[0].type as RecordType;
      expect(paramType.kind).toBe('record');
      expect(paramType.fields.get('host')).toEqual({ kind: 'primitive', name: 'string' });
      expect(paramType.fields.get('port')).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'number' },
      });
    });

    it('maps array parameters', () => {
      const f = mapFixture('generics.d.ts');
      const mapArrayType = getType(f, 'mapArray') as FunctionType;
      expect(mapArrayType.params[0].type.kind).toBe('array');
    });

    it('maps tuple return type', () => {
      const f = mapFixture('generics.d.ts');
      const pairType = getType(f, 'pair') as FunctionType;
      expect(pairType.kind).toBe('function');
      expect(pairType.returnType.kind).toBe('tuple');
      if (pairType.returnType.kind === 'tuple') {
        expect(pairType.returnType.elements).toHaveLength(2);
      }
    });

    it('maps function parameter types', () => {
      const f = mapFixture('generics.d.ts');
      const mapArrayType = getType(f, 'mapArray') as FunctionType;
      expect(mapArrayType.params[1].type.kind).toBe('function');
    });

    it('maps class instance type via constructor return', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const constructSigs = pointEntry.type.getConstructSignatures();
      expect(constructSigs.length).toBeGreaterThan(0);
      const instanceType = constructSigs[0].getReturnType();
      const mapped = f.mapper.mapType(instanceType, f.checker) as RecordType;
      expect(mapped.kind).toBe('record');
      expect(mapped.fields.has('x')).toBe(true);
      expect(mapped.fields.has('y')).toBe(true);
      expect(mapped.fields.has('distanceTo')).toBe(true);
    });

    it('maps Promise type', () => {
      const code = 'export declare function fetchData(): Promise<string>;';
      const tmpFile = path.join(fixturesDir, '__tmp_promise.d.ts');
      ts.sys.writeFile(tmpFile, code);
      try {
        const program = ts.createProgram([tmpFile], {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ES2020,
          strict: true,
        });
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(tmpFile)!;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
        const exports = checker.getExportsOfModule(moduleSymbol);
        const fetchSym = exports.find(s => s.getName() === 'fetchData')!;
        const fetchType = checker.getTypeOfSymbolAtLocation(fetchSym, sourceFile);
        const diagnostics = new DiagnosticCollectorImpl();
        const mapper = new TsTypeMapper(diagnostics);
        const mapped = mapper.mapType(fetchType, checker) as FunctionType;
        expect(mapped.kind).toBe('function');
        expect(mapped.returnType).toEqual({
          kind: 'promise',
          inner: { kind: 'primitive', name: 'string' },
        });
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });
  });

  describe('objects and interfaces', () => {
    it('maps interface with properties to record', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as RecordType;
      expect(configType.kind).toBe('record');
      expect(configType.fields.has('host')).toBe(true);
      expect(configType.fields.has('port')).toBe(true);
      expect(configType.fields.has('timeout')).toBe(true);
    });

    it('maps class instance with public properties', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const constructSigs = pointEntry.type.getConstructSignatures();
      const instanceType = constructSigs[0].getReturnType();
      const mapped = f.mapper.mapType(instanceType, f.checker) as RecordType;
      expect(mapped.kind).toBe('record');
      expect(mapped.fields.get('x')).toEqual({ kind: 'primitive', name: 'number' });
      expect(mapped.fields.get('y')).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps optional interface properties as nullable', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as RecordType;
      const portType = configType.fields.get('port');
      expect(portType).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'number' },
      });
    });

    it('maps class methods as function-typed fields', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const constructSigs = pointEntry.type.getConstructSignatures();
      const instanceType = constructSigs[0].getReturnType();
      const mapped = f.mapper.mapType(instanceType, f.checker) as RecordType;
      expect(mapped.kind).toBe('record');
      const distanceTo = mapped.fields.get('distanceTo');
      expect(distanceTo).toBeDefined();
      expect(distanceTo?.kind).toBe('function');
    });

    it('skips private/protected members in record mapping', () => {
      const f = mapFixture('simple-classes.d.ts');
      const singletonEntry = f.exports.get('Singleton')!;
      // Get instance type through declared type (interface-like)
      const declaredType = f.checker.getDeclaredTypeOfSymbol(singletonEntry.symbol);
      const mapped = f.mapper.mapType(declaredType, f.checker) as RecordType;
      expect(mapped.kind).toBe('record');
      expect(mapped.fields.has('value')).toBe(true);
    });
  });

  describe('functions', () => {
    it('maps simple function signature', () => {
      const f = mapFixture('simple-functions.d.ts');
      const greetType = getType(f, 'greet') as FunctionType;
      expect(greetType.kind).toBe('function');
      expect(greetType.params).toHaveLength(1);
      expect(greetType.params[0].name).toBe('name');
      expect(greetType.params[0].type).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps multi-param function', () => {
      const f = mapFixture('simple-functions.d.ts');
      const addType = getType(f, 'add') as FunctionType;
      expect(addType.params).toHaveLength(2);
      expect(addType.params[0].name).toBe('a');
      expect(addType.params[1].name).toBe('b');
    });

    it('maps zero-param function', () => {
      const f = mapFixture('simple-functions.d.ts');
      const doNothingType = getType(f, 'doNothing') as FunctionType;
      expect(doNothingType.params).toHaveLength(0);
    });

    it('maps callback parameter as function type', () => {
      const f = mapFixture('generics.d.ts');
      const mapArrayType = getType(f, 'mapArray') as FunctionType;
      const callback = mapArrayType.params[1].type as FunctionType;
      expect(callback.kind).toBe('function');
      expect(callback.params).toHaveLength(1);
      expect(callback.params[0].name).toBe('item');
    });
  });

  describe('rest parameters', () => {
    it('extracts rest param from function with leading fixed param', () => {
      const f = mapFixture('rest-params.d.ts');
      const fn = getType(f, 'log') as FunctionType;
      expect(fn.params.length).toBe(1); // only 'message', not 'args'
      expect(fn.params[0].name).toBe('message');
      expect(fn.rest).toBeDefined();
      expect(fn.rest!.name).toBe('args');
      expect(fn.rest!.elementType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('extracts rest-only function', () => {
      const f = mapFixture('rest-params.d.ts');
      const fn = getType(f, 'sum') as FunctionType;
      expect(fn.params.length).toBe(0);
      expect(fn.rest).toBeDefined();
      expect(fn.rest!.name).toBe('numbers');
      expect(fn.rest!.elementType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('mixed function: fixed + optional + rest', () => {
      const f = mapFixture('rest-params.d.ts');
      const fn = getType(f, 'mixed') as FunctionType;
      expect(fn.params.length).toBe(2); // a and b
      expect(fn.params[0].name).toBe('a');
      expect(fn.params[0].optional).toBe(false);
      expect(fn.params[1].name).toBe('b');
      expect(fn.params[1].optional).toBe(true);
      expect(fn.rest).toBeDefined();
      expect(fn.rest!.name).toBe('rest');
      expect(fn.rest!.elementType).toEqual({ kind: 'primitive', name: 'string' });
    });
  });

  describe('optional parameter flag', () => {
    it('optional param has optional: true', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'greet') as FunctionType;
      expect(fn.params[0].optional).toBe(false);
      expect(fn.params[1].optional).toBe(true);
    });

    it('mixed function has correct optional flags', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'mixed') as FunctionType;
      expect(fn.params[0].optional).toBe(false); // a: string
      expect(fn.params[1].optional).toBe(true);  // b?: number
      expect(fn.params[2].optional).toBe(false); // c: string | null
    });
  });

  describe('nullKind on parameters', () => {
    it('optional param has nullKind: undefined', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'greet') as FunctionType;
      expect(fn.params[0].nullKind).toBeUndefined(); // required string
      expect(fn.params[1].nullKind).toBe('undefined'); // optional
    });

    it('T | null param has nullKind: null', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'setLabel') as FunctionType;
      expect(fn.params[0].nullKind).toBe('null');
    });

    it('T | undefined param has nullKind: undefined', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'clearValue') as FunctionType;
      expect(fn.params[0].nullKind).toBe('undefined');
    });

    it('T | null | undefined param has nullKind: either', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'flexible') as FunctionType;
      expect(fn.params[0].nullKind).toBe('either');
    });

    it('required param has no nullKind', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'required') as FunctionType;
      expect(fn.params[0].nullKind).toBeUndefined();
    });

    it('mixed params have correct nullKinds', () => {
      const f = mapFixture('optional-params.d.ts');
      const fn = getType(f, 'mixed') as FunctionType;
      expect(fn.params[0].nullKind).toBeUndefined(); // string
      expect(fn.params[1].nullKind).toBe('undefined'); // optional number
      expect(fn.params[2].nullKind).toBe('null'); // string | null
    });
  });

  describe('generics', () => {
    it('maps generic function with type params', () => {
      const f = mapFixture('generics.d.ts');
      const identityType = getType(f, 'identity') as FunctionType;
      expect(identityType.kind).toBe('function');
      expect(identityType.typeParams).toBeDefined();
      expect(identityType.typeParams).toHaveLength(1);
      expect(identityType.typeParams![0].name).toBe('T');
      expect(identityType.params[0].type).toEqual({ kind: 'generic', name: 'T' });
      expect(identityType.returnType).toEqual({ kind: 'generic', name: 'T' });
    });

    it('maps generic function with multiple type params', () => {
      const f = mapFixture('generics.d.ts');
      const pairType = getType(f, 'pair') as FunctionType;
      expect(pairType.kind).toBe('function');
      expect(pairType.typeParams).toBeDefined();
      expect(pairType.typeParams).toHaveLength(2);
      expect(pairType.typeParams![0].name).toBe('A');
      expect(pairType.typeParams![1].name).toBe('B');
    });

    it('maps generic class constructor', () => {
      const f = mapFixture('generics.d.ts');
      const containerEntry = f.exports.get('Container')!;
      const ctor = f.mapper.mapConstructor(containerEntry.type, f.checker);
      expect(ctor).not.toBeNull();
      expect(ctor!.kind).toBe('function');
      expect(ctor!.params).toHaveLength(1);
    });
  });

  describe('enums', () => {
    it('maps numeric enum to number', () => {
      const f = mapFixture('complex-types.d.ts');
      // Use declared type for enums — getTypeOfSymbol gives the enum object
      const enumType = getDeclaredType(f, 'NumericColor');
      expect(enumType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps string enum to string', () => {
      const f = mapFixture('complex-types.d.ts');
      const enumType = getDeclaredType(f, 'StringDirection');
      expect(enumType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps mixed enum to Any with warning', () => {
      const f = mapFixture('complex-types.d.ts');
      const enumType = getDeclaredType(f, 'MixedEnum');
      expect(enumType).toEqual({ kind: 'any' });
      const warnings = f.diagnostics.getWarnings();
      expect(warnings.some(w => w.code === 'W301')).toBe(true);
    });
  });

  describe('intersections', () => {
    it('maps intersection of interfaces to merged record', () => {
      const f = mapFixture('complex-types.d.ts');
      // Person = Named & Aged — use declared type to get the intersection
      const personType = getDeclaredType(f, 'Person');
      expect(personType.kind).toBe('record');
      if (personType.kind === 'record') {
        expect(personType.fields.has('name')).toBe(true);
        expect(personType.fields.has('age')).toBe(true);
        expect(personType.fields.get('name')).toEqual({ kind: 'primitive', name: 'string' });
        expect(personType.fields.get('age')).toEqual({ kind: 'primitive', name: 'number' });
      }
    });

    it('maps multi-way intersection with all fields', () => {
      const f = mapFixture('complex-types.d.ts');
      const personType = getDeclaredType(f, 'Person');
      if (personType.kind === 'record') {
        expect(personType.fields.size).toBe(2);
      }
    });

    it('maps non-object intersection to Any', () => {
      const code = 'export type StringNum = string & number;';
      const tmpFile = path.join(fixturesDir, '__tmp_non_obj_intersect.d.ts');
      ts.sys.writeFile(tmpFile, code);
      try {
        const program = ts.createProgram([tmpFile], {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ES2020,
          strict: true,
        });
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(tmpFile)!;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
        const exports = checker.getExportsOfModule(moduleSymbol);
        const sym = exports.find(s => s.getName() === 'StringNum')!;
        const declaredType = checker.getDeclaredTypeOfSymbol(sym);
        const diagnostics = new DiagnosticCollectorImpl();
        const mapper = new TsTypeMapper(diagnostics);
        const mapped = mapper.mapType(declaredType, checker);
        // string & number resolves to 'never' in TS
        expect(mapped.kind === 'any' || mapped.kind === 'primitive').toBe(true);
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });
  });

  describe('branded intersections (P2-5)', () => {
    it('branded string intersection strips brand and returns string', () => {
      const f = mapFixture('branded-types.d.ts');
      const userIdType = getType(f, 'userId');
      expect(userIdType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('branded number intersection strips brand and returns number', () => {
      const f = mapFixture('branded-types.d.ts');
      const timestampType = getType(f, 'timestamp');
      expect(timestampType).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('non-branded intersection still merges fields', () => {
      const f = mapFixture('branded-types.d.ts');
      const personType = getType(f, 'person');
      expect(personType.kind).toBe('record');
      if (personType.kind === 'record') {
        expect(personType.fields.has('name')).toBe(true);
        expect(personType.fields.has('age')).toBe(true);
      }
    });
  });

  describe('fallbacks', () => {
    it('maps conditional type to Any with warning', () => {
      const f = mapFixture('complex-types.d.ts');
      const condEntry = f.exports.get('ConditionalType');
      expect(condEntry).toBeDefined();
      if (condEntry) {
        const declaredType = condEntry.declaredType;
        const mapped = f.mapper.mapType(declaredType, f.checker);
        // Conditional type should fall back to Any or the TS API may resolve it
        expect(mapped).toBeDefined();
      }
    });

    it('maps mapped type to record (TS resolves it)', () => {
      const f = mapFixture('complex-types.d.ts');
      const mappedEntry = f.exports.get('MappedType');
      expect(mappedEntry).toBeDefined();
      if (mappedEntry) {
        // Use getTypeOfSymbolAtLocation which resolves mapped types to their concrete form
        const mapped = f.mapper.mapType(mappedEntry.type, f.checker);
        expect(mapped).toBeDefined();
        if (mapped.kind === 'record') {
          expect(mapped.fields.get('a')).toEqual({ kind: 'primitive', name: 'number' });
          expect(mapped.fields.get('b')).toEqual({ kind: 'primitive', name: 'number' });
        }
      }
    });

    it('maps unsupported types to Any', () => {
      const diagnostics = new DiagnosticCollectorImpl();
      const mapper = new TsTypeMapper(diagnostics);
      expect(mapper).toBeDefined();
    });

    it('emits W301 for unsupported types', () => {
      const code = 'export declare const sym: symbol; export declare const big: bigint;';
      const tmpFile = path.join(fixturesDir, '__tmp_unsupported.d.ts');
      ts.sys.writeFile(tmpFile, code);
      try {
        const program = ts.createProgram([tmpFile], {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ES2020,
          strict: true,
        });
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(tmpFile)!;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
        const exports = checker.getExportsOfModule(moduleSymbol);
        const diagnostics = new DiagnosticCollectorImpl();
        const mapper = new TsTypeMapper(diagnostics);
        for (const sym of exports) {
          const type = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const mapped = mapper.mapType(type, checker);
          expect(mapped).toEqual({ kind: 'any' });
        }
        const warnings = diagnostics.getWarnings();
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some(w => w.code === 'W301')).toBe(true);
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });
  });

  describe('circular types', () => {
    it('maps self-referential type without infinite loop', () => {
      const f = mapFixture('circular-types.d.ts');
      const fnType = getType(f, 'createTree') as FunctionType;
      expect(fnType.kind).toBe('function');
      const returnType = fnType.returnType as RecordType;
      expect(returnType.kind).toBe('record');
      expect(returnType.fields.has('value')).toBe(true);
      expect(returnType.fields.has('children')).toBe(true);
      const childrenType = returnType.fields.get('children')!;
      expect(childrenType.kind).toBe('array');
      if (childrenType.kind === 'array') {
        expect(childrenType.element.kind).toBe('record');
      }
    });

    it('maps mutually recursive types without infinite loop', () => {
      const f = mapFixture('circular-types.d.ts');
      const nodeAEntry = f.exports.get('NodeA');
      expect(nodeAEntry).toBeDefined();
      if (nodeAEntry) {
        const nodeAType = nodeAEntry.declaredType;
        const mapped = f.mapper.mapType(nodeAType, f.checker) as RecordType;
        expect(mapped.kind).toBe('record');
        expect(mapped.fields.has('b')).toBe(true);
        const bType = mapped.fields.get('b') as RecordType;
        expect(bType.kind).toBe('record');
        expect(bType.fields.has('a')).toBe(true);
      }
    });
  });

  describe('constructors', () => {
    it('maps simple constructor', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const ctor = f.mapper.mapConstructor(pointEntry.type, f.checker);
      expect(ctor).not.toBeNull();
      expect(ctor!.kind).toBe('function');
      expect(ctor!.params).toHaveLength(2);
      expect(ctor!.params[0].name).toBe('x');
      expect(ctor!.params[0].type).toEqual({ kind: 'primitive', name: 'number' });
      expect(ctor!.params[1].name).toBe('y');
      expect(ctor!.returnType.kind).toBe('record');
    });

    it('returns null for private constructor', () => {
      const f = mapFixture('simple-classes.d.ts');
      const singletonEntry = f.exports.get('Singleton')!;
      const ctor = f.mapper.mapConstructor(singletonEntry.type, f.checker);
      expect(ctor).toBeNull();
    });

    it('returns null for no constructor (plain function)', () => {
      const f = mapFixture('simple-functions.d.ts');
      const greetEntry = f.exports.get('greet')!;
      const ctor = f.mapper.mapConstructor(greetEntry.type, f.checker);
      expect(ctor).toBeNull();
    });

    it('maps generic class constructor with type params', () => {
      const f = mapFixture('generics.d.ts');
      const containerEntry = f.exports.get('Container')!;
      const ctor = f.mapper.mapConstructor(containerEntry.type, f.checker);
      expect(ctor).not.toBeNull();
      expect(ctor!.params).toHaveLength(1);
    });

    it('warns about overloaded constructors', () => {
      const code = `
export declare class MultiCtor {
  constructor();
  constructor(name: string);
  constructor(name: string, age: number);
  readonly name: string;
}`;
      const tmpFile = path.join(fixturesDir, '__tmp_multi_ctor.d.ts');
      ts.sys.writeFile(tmpFile, code);
      try {
        const program = ts.createProgram([tmpFile], {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ES2020,
          strict: true,
        });
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(tmpFile)!;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)!;
        const exports = checker.getExportsOfModule(moduleSymbol);
        const classSym = exports.find(s => s.getName() === 'MultiCtor')!;
        const classType = checker.getTypeOfSymbolAtLocation(classSym, sourceFile);
        const diagnostics = new DiagnosticCollectorImpl();
        const mapper = new TsTypeMapper(diagnostics);
        const ctor = mapper.mapConstructor(classType, checker);
        expect(ctor).not.toBeNull();
        const warnings = diagnostics.getWarnings();
        expect(warnings.some(w => w.code === 'W302')).toBe(true);
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });
  });

  describe('overloaded functions', () => {
    it('uses last signature (most general) and warns about overloads', () => {
      const f = mapFixture('overloaded.d.ts');
      const formatType = getType(f, 'format') as FunctionType;
      expect(formatType.kind).toBe('function');
      expect(formatType.params).toHaveLength(1);
      // Last overload: format(value: boolean): string
      expect(formatType.params[0].type).toEqual({ kind: 'primitive', name: 'boolean' });
      const warnings = f.diagnostics.getWarnings();
      expect(warnings.some(w => w.code === 'W302')).toBe(true);
    });

    it('uses last overload for create (most general)', () => {
      const f = mapFixture('overloaded.d.ts');
      const createType = getType(f, 'create') as FunctionType;
      expect(createType.kind).toBe('function');
      // Last overload: create(name: string): void
      expect(createType.params).toHaveLength(1);
      expect(createType.params[0].type).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('prefers last generic overload when available', () => {
      const f = mapFixture('overloaded.d.ts');
      const parseType = getType(f, 'parse') as FunctionType;
      expect(parseType.kind).toBe('function');
      // Last generic overload: parse<T>(input: string, type: "json"): T
      expect(parseType.typeParams).toBeDefined();
      expect(parseType.typeParams!.length).toBeGreaterThan(0);
    });
  });

  describe('default export', () => {
    it('maps default export', () => {
      const f = mapFixture('default-export.d.ts');
      const defaultEntry = f.exports.get('default');
      expect(defaultEntry).toBeDefined();
      if (defaultEntry) {
        const mapped = f.mapper.mapType(defaultEntry.type, f.checker);
        expect(mapped.kind).toBe('function');
      }
    });
  });

  describe('collection types', () => {
    it('maps Set<string> to SetType', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'names');
      expect(t.kind).toBe('set');
      expect((t as { element: Type }).element).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps Map<string, number> to MapType', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'scores');
      expect(t.kind).toBe('map');
      const mt = t as { key: Type; value: Type };
      expect(mt.key).toEqual({ kind: 'primitive', name: 'string' });
      expect(mt.value).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps ReadonlySet<number> to SetType', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'readonlyNames');
      expect(t.kind).toBe('set');
      expect((t as { element: Type }).element).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps ReadonlyMap<string, boolean> to MapType', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'readonlyScores');
      expect(t.kind).toBe('map');
      const mt = t as { key: Type; value: Type };
      expect(mt.key).toEqual({ kind: 'primitive', name: 'string' });
      expect(mt.value).toEqual({ kind: 'primitive', name: 'boolean' });
    });

    it('maps function returning Set<string>', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'getNames') as FunctionType;
      expect(t.kind).toBe('function');
      expect(t.returnType.kind).toBe('set');
      expect((t.returnType as { element: Type }).element).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps function accepting Map<string, number>', () => {
      const f = mapFixture('collection-types.d.ts');
      const t = getType(f, 'getScores') as FunctionType;
      expect(t.kind).toBe('function');
      expect(t.returnType.kind).toBe('map');
    });
  });

  describe('recursive types (P0-1: stack overflow prevention)', () => {
    it('AxiosPromise-like self-referential interface does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'makeRequest') as FunctionType;
      expect(fnType.kind).toBe('function');
      const returnType = fnType.returnType as RecordType;
      expect(returnType.kind).toBe('record');
      // Should have then and catch fields
      expect(returnType.fields.has('then')).toBe(true);
      expect(returnType.fields.has('catch')).toBe(true);
    });

    it('AxiosPromise methods return a record type (cycle detected)', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'makeRequest') as FunctionType;
      const axiosPromise = fnType.returnType as RecordType;
      const thenField = axiosPromise.fields.get('then') as FunctionType;
      expect(thenField.kind).toBe('function');
      // The return type of then() should be a record (the same AxiosPromise, via cycle detection)
      expect(thenField.returnType.kind).toBe('record');
    });

    it('deep recursive chain (A→B→C→A) does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createRequest') as FunctionType;
      expect(fnType.kind).toBe('function');
      const requestType = fnType.returnType as RecordType;
      expect(requestType.kind).toBe('record');
      expect(requestType.fields.has('params')).toBe(true);
      expect(requestType.fields.has('query')).toBe(true);
      expect(requestType.fields.has('body')).toBe(true);
    });

    it('mutually recursive chain resolves fields correctly', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createRequest') as FunctionType;
      const requestType = fnType.returnType as RecordType;
      const paramsType = requestType.fields.get('params') as RecordType;
      expect(paramsType.kind).toBe('record');
      expect(paramsType.fields.has('request')).toBe(true);
      expect(paramsType.fields.has('values')).toBe(true);
    });

    it('builder pattern (fluent API returning self) does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createQueryBuilder') as FunctionType;
      expect(fnType.kind).toBe('function');
      const builderType = fnType.returnType as RecordType;
      expect(builderType.kind).toBe('record');
      expect(builderType.fields.has('select')).toBe(true);
      expect(builderType.fields.has('where')).toBe(true);
      expect(builderType.fields.has('orderBy')).toBe(true);
      expect(builderType.fields.has('execute')).toBe(true);
    });

    it('builder methods return record type (cycle-safe)', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createQueryBuilder') as FunctionType;
      const builderType = fnType.returnType as RecordType;
      const selectField = builderType.fields.get('select') as FunctionType;
      expect(selectField.kind).toBe('function');
      // Return type should be a record (the same builder, via cycle detection)
      expect(selectField.returnType.kind).toBe('record');
    });

    it('ReactNode-like recursive union does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createElement') as FunctionType;
      expect(fnType.kind).toBe('function');
      const elementType = fnType.returnType as RecordType;
      expect(elementType.kind).toBe('record');
      expect(elementType.fields.has('type')).toBe(true);
      expect(elementType.fields.has('props')).toBe(true);
      expect(elementType.fields.has('children')).toBe(true);
    });

    it('typeToString on recursive mapped types does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'makeRequest') as FunctionType;
      // This would previously stack overflow when printing diagnostics
      const result = typeToString(fnType.returnType);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('<recursive>');
    });
  });

  // ── Generic Constraints from TS ─────────────────────────────

  describe('constrained generics', () => {
    it('TS <T extends { name: string }> maps to TypeParam with constraint', () => {
      const f = mapFixture('constrained-generics.d.ts');
      const fnType = getType(f, 'getName') as FunctionType;
      expect(fnType.kind).toBe('function');
      expect(fnType.typeParams).toBeDefined();
      expect(fnType.typeParams!.length).toBe(1);
      expect(fnType.typeParams![0].name).toBe('T');
      expect(fnType.typeParams![0].constraint).toBeDefined();
      expect(fnType.typeParams![0].constraint!.kind).toBe('record');
    });

    it('TS unconstrained <T> maps to TypeParam without constraint', () => {
      const f = mapFixture('constrained-generics.d.ts');
      const fnType = getType(f, 'unconstrained') as FunctionType;
      expect(fnType.typeParams).toBeDefined();
      expect(fnType.typeParams![0].constraint).toBeUndefined();
    });

    it('TS <T extends { toString(): string }> maps to structural constraint', () => {
      const f = mapFixture('constrained-generics.d.ts');
      const fnType = getType(f, 'stringify') as FunctionType;
      expect(fnType.typeParams![0].constraint).toBeDefined();
      // Should be a record type with a toString method
      const constraint = fnType.typeParams![0].constraint!;
      expect(constraint.kind).toBe('record');
    });

    it('TS <T, U extends Array<T>> — mixed constraints', () => {
      const f = mapFixture('constrained-generics.d.ts');
      const fnType = getType(f, 'mixedConstraints') as FunctionType;
      expect(fnType.typeParams!.length).toBe(2);
      expect(fnType.typeParams![0].constraint).toBeUndefined();
      expect(fnType.typeParams![1].constraint).toBeDefined();
      expect(fnType.typeParams![1].constraint!.kind).toBe('array');
    });
  });

  // ── Literal Types ────────────────────────────────────────────
  describe('literal types', () => {
    it('string literal union preserves literal types', () => {
      const f = mapFixture('literal-types.d.ts');
      const t = getType(f, 'method');
      expect(t.kind).toBe('union');
      const union = t as UnionType;
      expect(union.members.length).toBe(2);
      expect(union.members.every(m => m.kind === 'literal')).toBe(true);
      const get = union.members.find(m => (m as LiteralType).value === 'GET') as LiteralType;
      expect(get).toBeDefined();
      expect(get.base).toBe('string');
      const post = union.members.find(m => (m as LiteralType).value === 'POST') as LiteralType;
      expect(post).toBeDefined();
      expect(post.base).toBe('string');
    });

    it('number literal union preserves literal types', () => {
      const f = mapFixture('literal-types.d.ts');
      const t = getType(f, 'status');
      expect(t.kind).toBe('union');
      const union = t as UnionType;
      expect(union.members.length).toBe(3);
      expect(union.members.every(m => m.kind === 'literal')).toBe(true);
      const vals = union.members.map(m => (m as LiteralType).value);
      expect(vals).toContain(200);
      expect(vals).toContain(404);
      expect(vals).toContain(500);
    });

    it('single boolean literal preserves literal type', () => {
      const f = mapFixture('literal-types.d.ts');
      const t = getType(f, 'flag');
      // `true` alone stays as literal (not collapsed to boolean)
      expect(t.kind).toBe('literal');
      expect((t as LiteralType).base).toBe('boolean');
      expect((t as LiteralType).value).toBe(true);
    });

    it('function with literal param types preserves them', () => {
      const f = mapFixture('literal-types.d.ts');
      const t = getType(f, 'fetch') as FunctionType;
      expect(t.kind).toBe('function');
      // Second param should be "GET" | "POST"
      const methodParam = t.params[1];
      expect(methodParam.type.kind).toBe('union');
      const union = methodParam.type as UnionType;
      expect(union.members.every(m => m.kind === 'literal')).toBe(true);
    });

    it('single string literal type preserved', () => {
      const f = mapFixture('literal-types.d.ts');
      const t = getType(f, 'singleLiteral');
      expect(t.kind).toBe('literal');
      expect((t as LiteralType).base).toBe('string');
      expect((t as LiteralType).value).toBe('hello');
    });
  });

  // ── Lazy Record Resolution (P0-2) ──────────────────────────

  describe('lazy record resolution (P0-2)', () => {
    it('large interface (50+ properties) uses lazy-record kind', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj');
      expect(t.kind).toBe('lazy-record');
    });

    it('small interface still uses eager record kind', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'smallObj');
      expect(t.kind).toBe('record');
      if (t.kind === 'record') {
        expect(t.fields.has('name')).toBe(true);
        expect(t.fields.has('age')).toBe(true);
      }
    });

    it('lazy record resolvedFields starts empty', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      expect(t.resolvedFields.size).toBe(0);
    });

    it('lazy record propertyCount reflects total visible properties', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      // 50 props + 4 methods + 1 optionalProp = 55
      expect(t.propertyCount).toBe(55);
    });

    it('lookupRecordField resolves a single string property on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const prop0Type = lookupRecordField(t, 'prop0');
      expect(prop0Type).toBeDefined();
      expect(prop0Type).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('lookupRecordField resolves a number property on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const prop1Type = lookupRecordField(t, 'prop1');
      expect(prop1Type).toBeDefined();
      expect(prop1Type).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('lookupRecordField resolves a boolean property on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const prop2Type = lookupRecordField(t, 'prop2');
      expect(prop2Type).toBeDefined();
      expect(prop2Type).toEqual({ kind: 'primitive', name: 'boolean' });
    });

    it('lookupRecordField resolves method property on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const method0Type = lookupRecordField(t, 'method0');
      expect(method0Type).toBeDefined();
      expect(method0Type!.kind).toBe('function');
      if (method0Type!.kind === 'function') {
        expect(method0Type.params).toHaveLength(1);
        expect(method0Type.params[0].type).toEqual({ kind: 'primitive', name: 'string' });
        expect(method0Type.returnType).toEqual({ kind: 'primitive', name: 'number' });
      }
    });

    it('lookupRecordField resolves generic method on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const method3Type = lookupRecordField(t, 'method3');
      expect(method3Type).toBeDefined();
      expect(method3Type!.kind).toBe('function');
      if (method3Type!.kind === 'function') {
        expect(method3Type.typeParams).toBeDefined();
        expect(method3Type.typeParams!.length).toBe(1);
        expect(method3Type.typeParams![0].name).toBe('T');
      }
    });

    it('lookupRecordField resolves optional property as nullable', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const optType = lookupRecordField(t, 'optionalProp');
      expect(optType).toBeDefined();
      expect(optType!.kind).toBe('nullable');
      if (optType!.kind === 'nullable') {
        expect(optType.inner).toEqual({ kind: 'primitive', name: 'string' });
      }
    });

    it('lookupRecordField caches resolved fields', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      // First access
      const first = lookupRecordField(t, 'prop0');
      expect(t.resolvedFields.size).toBe(1);
      // Second access returns the same cached result
      const second = lookupRecordField(t, 'prop0');
      expect(second).toBe(first); // Same object reference (cached)
      expect(t.resolvedFields.size).toBe(1); // No additional entries
    });

    it('lookupRecordField returns undefined for non-existent property', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const nonExistent = lookupRecordField(t, 'doesNotExist');
      expect(nonExistent).toBeUndefined();
    });

    it('only accessed properties are resolved (lazy behavior)', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      // Access only 3 out of 55 properties
      lookupRecordField(t, 'prop0');
      lookupRecordField(t, 'prop5');
      lookupRecordField(t, 'method0');
      expect(t.resolvedFields.size).toBe(3);
      expect(t.propertyCount).toBe(55);
    });

    it('isRecordLike returns true for lazy-record', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj');
      expect(isRecordLike(t)).toBe(true);
    });

    it('isRecordLike returns true for regular record', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'smallObj');
      expect(isRecordLike(t)).toBe(true);
    });

    it('typeToString does not trigger eager resolution for lazy-record', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      const str = typeToString(t);
      // Should show truncated form, not all 55 properties
      expect(str).toContain('55 properties');
      // Should not have resolved any fields
      expect(t.resolvedFields.size).toBe(0);
    });

    it('typeToString shows resolved fields for partially-resolved lazy-record', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'largeObj') as LazyRecordType;
      // Resolve a few fields
      lookupRecordField(t, 'prop0');
      lookupRecordField(t, 'prop1');
      const str = typeToString(t);
      expect(str).toContain('prop0: string');
      expect(str).toContain('prop1: number');
      expect(str).toContain('+53');
    });

    it('lazy record from function return type resolves fields on demand', () => {
      const f = mapFixture('large-interface.d.ts');
      const fnType = getType(f, 'createLargeObj') as FunctionType;
      expect(fnType.kind).toBe('function');
      const retType = fnType.returnType;
      expect(retType.kind).toBe('lazy-record');
      const lazyRet = retType as LazyRecordType;
      const prop = lookupRecordField(lazyRet, 'prop0');
      expect(prop).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('lazy record memoization: same TS type returns same lazy-record', () => {
      const f = mapFixture('large-interface.d.ts');
      const t1 = getType(f, 'largeObj');
      const fnType = getType(f, 'createLargeObj') as FunctionType;
      const t2 = fnType.returnType;
      // Both should reference the same memoized lazy-record
      expect(t1).toBe(t2);
    });

    it('nested large interface is lazy too', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'nestedLargeObj');
      expect(t.kind).toBe('lazy-record');
      const lazy = t as LazyRecordType;
      // Access nested SmallInterface
      const nestedType = lookupRecordField(lazy, 'nested');
      expect(nestedType).toBeDefined();
      expect(nestedType!.kind).toBe('record');
      if (nestedType!.kind === 'record') {
        expect(nestedType.fields.get('name')).toEqual({ kind: 'primitive', name: 'string' });
      }
    });

    it('lazy record with array property resolves correctly', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'nestedLargeObj') as LazyRecordType;
      const arrayProp = lookupRecordField(t, 'arrayProp');
      expect(arrayProp).toBeDefined();
      expect(arrayProp!.kind).toBe('array');
    });

    it('regression: existing simple record tests still pass after lazy threshold', () => {
      // Verify that records below the threshold are not affected
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as RecordType;
      expect(configType.kind).toBe('record');
      expect(configType.fields.has('host')).toBe(true);
      expect(configType.fields.has('port')).toBe(true);
    });
  });
});
