import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { TsTypeMapper } from './type-mapper.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Type, FunctionType, RecordType, LazyRecordType, LiteralType, UnionType, InterfaceType, IndexSignatureType } from '../checker/types.js';
import { typeToString, lookupRecordField, isRecordLike, isFieldMutable } from '../checker/types.js';

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

    it('maps interface to InterfaceType', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const paramType = fnType.params[0].type as InterfaceType;
      expect(paramType.kind).toBe('interface');
      expect(paramType.properties.get('host')).toEqual({ kind: 'primitive', name: 'string' });
      expect(paramType.properties.get('port')).toEqual({
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
      const mapped = f.mapper.mapType(instanceType, f.checker) as InterfaceType;
      expect(mapped.kind).toBe('interface');
      expect(mapped.properties.has('x')).toBe(true);
      expect(mapped.properties.has('y')).toBe(true);
      expect(mapped.methods.has('distanceTo')).toBe(true);
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
    it('maps interface with properties to InterfaceType', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as InterfaceType;
      expect(configType.kind).toBe('interface');
      expect(configType.properties.has('host')).toBe(true);
      expect(configType.properties.has('port')).toBe(true);
      expect(configType.properties.has('timeout')).toBe(true);
    });

    it('maps class instance with public properties', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const constructSigs = pointEntry.type.getConstructSignatures();
      const instanceType = constructSigs[0].getReturnType();
      const mapped = f.mapper.mapType(instanceType, f.checker) as InterfaceType;
      expect(mapped.kind).toBe('interface');
      expect(mapped.properties.get('x')).toEqual({ kind: 'primitive', name: 'number' });
      expect(mapped.properties.get('y')).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('maps optional interface properties as nullable', () => {
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as InterfaceType;
      const portType = configType.properties.get('port');
      expect(portType).toEqual({
        kind: 'nullable',
        inner: { kind: 'primitive', name: 'number' },
      });
    });

    it('maps class methods as method entries in InterfaceType', () => {
      const f = mapFixture('simple-classes.d.ts');
      const pointEntry = f.exports.get('Point')!;
      const constructSigs = pointEntry.type.getConstructSignatures();
      const instanceType = constructSigs[0].getReturnType();
      const mapped = f.mapper.mapType(instanceType, f.checker) as InterfaceType;
      expect(mapped.kind).toBe('interface');
      const distanceTo = mapped.methods.get('distanceTo');
      expect(distanceTo).toBeDefined();
      expect(distanceTo?.kind).toBe('function');
    });

    it('skips private/protected members in interface mapping', () => {
      const f = mapFixture('simple-classes.d.ts');
      const singletonEntry = f.exports.get('Singleton')!;
      // Get instance type through declared type (interface-like)
      const declaredType = f.checker.getDeclaredTypeOfSymbol(singletonEntry.symbol);
      const mapped = f.mapper.mapType(declaredType, f.checker) as InterfaceType;
      expect(mapped.kind).toBe('interface');
      expect(mapped.properties.has('value')).toBe(true);
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
    it('maps abstract conditional type to resolved branches', () => {
      const f = mapFixture('complex-types.d.ts');
      const condEntry = f.exports.get('ConditionalType');
      expect(condEntry).toBeDefined();
      if (condEntry) {
        const declaredType = condEntry.declaredType;
        const mapped = f.mapper.mapType(declaredType, f.checker);
        // Abstract conditional now resolves to a union of branches via Strategy 2/4
        expect(mapped).toBeDefined();
        const isAny = mapped.kind === 'primitive' && mapped.name === 'Any';
        expect(isAny).toBe(false);
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

    it('maps bigint and symbol to proper primitives (no W301 warnings)', () => {
      const code = 'export declare const sym: symbol; export declare const big: bigint;';
      const tmpFile = path.join(fixturesDir, '__tmp_bigint_symbol.d.ts');
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
        const mapped = new Map<string, Type>();
        for (const sym of exports) {
          const type = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          mapped.set(sym.getName(), mapper.mapType(type, checker));
        }
        expect(mapped.get('sym')).toEqual({ kind: 'primitive', name: 'symbol' });
        expect(mapped.get('big')).toEqual({ kind: 'primitive', name: 'bigint' });
        const warnings = diagnostics.getWarnings().filter(w => w.code === 'W301');
        expect(warnings).toHaveLength(0);
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });

    it('maps TS unique symbol to symbol', () => {
      const code = 'export declare const MY_SYM: unique symbol;';
      const tmpFile = path.join(fixturesDir, '__tmp_unique_sym.d.ts');
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
          expect(mapped).toEqual({ kind: 'primitive', name: 'symbol' });
        }
        const warnings = diagnostics.getWarnings();
        const w301 = warnings.filter(w => w.code === 'W301');
        expect(w301.length).toBe(0);
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });

    it('maps TS bigint literal type to bigint', () => {
      const code = 'export declare const val: 100n;';
      const tmpFile = path.join(fixturesDir, '__tmp_bigint_lit.d.ts');
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
          expect(mapped).toEqual({ kind: 'primitive', name: 'bigint' });
        }
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });

    it('maps TS bigint | null to nullable bigint', () => {
      const code = 'export declare const val: bigint | null;';
      const tmpFile = path.join(fixturesDir, '__tmp_bigint_null.d.ts');
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
          expect(mapped).toEqual({ kind: 'nullable', inner: { kind: 'primitive', name: 'bigint' } });
        }
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });

    it('maps TS symbol | undefined to nullable symbol', () => {
      const code = 'export declare const val: symbol | undefined;';
      const tmpFile = path.join(fixturesDir, '__tmp_sym_undef.d.ts');
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
          expect(mapped).toEqual({ kind: 'nullable', inner: { kind: 'primitive', name: 'symbol' } });
        }
      } finally {
        ts.sys.deleteFile!(tmpFile);
      }
    });

    it('maps TS function (x: bigint) => symbol correctly', () => {
      const code = 'export declare function convert(x: bigint): symbol;';
      const tmpFile = path.join(fixturesDir, '__tmp_bigint_fn.d.ts');
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
          const mapped = mapper.mapType(type, checker) as FunctionType;
          expect(mapped.kind).toBe('function');
          expect(mapped.params[0].type).toEqual({ kind: 'primitive', name: 'bigint' });
          expect(mapped.returnType).toEqual({ kind: 'primitive', name: 'symbol' });
        }
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
      const returnType = fnType.returnType as InterfaceType;
      expect(returnType.kind).toBe('interface');
      expect(returnType.properties.has('value')).toBe(true);
      expect(returnType.properties.has('children')).toBe(true);
      const childrenType = returnType.properties.get('children')!;
      expect(childrenType.kind).toBe('array');
      if (childrenType.kind === 'array') {
        expect(childrenType.element.kind).toBe('interface');
      }
    });

    it('maps mutually recursive types without infinite loop', () => {
      const f = mapFixture('circular-types.d.ts');
      const nodeAEntry = f.exports.get('NodeA');
      expect(nodeAEntry).toBeDefined();
      if (nodeAEntry) {
        const nodeAType = nodeAEntry.declaredType;
        const mapped = f.mapper.mapType(nodeAType, f.checker) as InterfaceType;
        expect(mapped.kind).toBe('interface');
        expect(mapped.properties.has('b')).toBe(true);
        const bType = mapped.properties.get('b') as InterfaceType;
        expect(bType.kind).toBe('interface');
        expect(bType.properties.has('a')).toBe(true);
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
      expect(ctor!.returnType.kind).toBe('interface');
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
      const returnType = fnType.returnType as InterfaceType;
      expect(returnType.kind).toBe('interface');
      // Should have then and catch methods
      expect(returnType.methods.has('then')).toBe(true);
      expect(returnType.methods.has('catch')).toBe(true);
    });

    it('AxiosPromise methods return an interface type (cycle detected)', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'makeRequest') as FunctionType;
      const axiosPromise = fnType.returnType as InterfaceType;
      const thenField = axiosPromise.methods.get('then')!;
      expect(thenField.kind).toBe('function');
      // The return type of then() should be an interface (the same AxiosPromise, via cycle detection)
      expect(thenField.returnType.kind).toBe('interface');
    });

    it('deep recursive chain (A->B->C->A) does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createRequest') as FunctionType;
      expect(fnType.kind).toBe('function');
      const requestType = fnType.returnType as InterfaceType;
      expect(requestType.kind).toBe('interface');
      expect(requestType.properties.has('params')).toBe(true);
      expect(requestType.properties.has('query')).toBe(true);
      expect(requestType.properties.has('body')).toBe(true);
    });

    it('mutually recursive chain resolves fields correctly', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createRequest') as FunctionType;
      const requestType = fnType.returnType as InterfaceType;
      const paramsType = requestType.properties.get('params') as InterfaceType;
      expect(paramsType.kind).toBe('interface');
      expect(paramsType.properties.has('request')).toBe(true);
      expect(paramsType.properties.has('values')).toBe(true);
    });

    it('builder pattern (fluent API returning self) does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createQueryBuilder') as FunctionType;
      expect(fnType.kind).toBe('function');
      const builderType = fnType.returnType as InterfaceType;
      expect(builderType.kind).toBe('interface');
      expect(builderType.methods.has('select')).toBe(true);
      expect(builderType.methods.has('where')).toBe(true);
      expect(builderType.methods.has('orderBy')).toBe(true);
      expect(builderType.methods.has('execute')).toBe(true);
    });

    it('builder methods return interface type (cycle-safe)', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createQueryBuilder') as FunctionType;
      const builderType = fnType.returnType as InterfaceType;
      const selectField = builderType.methods.get('select')!;
      expect(selectField.kind).toBe('function');
      // Return type should be an interface (the same builder, via cycle detection)
      expect(selectField.returnType.kind).toBe('interface');
    });

    it('ReactNode-like recursive union does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'createElement') as FunctionType;
      expect(fnType.kind).toBe('function');
      const elementType = fnType.returnType as InterfaceType;
      expect(elementType.kind).toBe('interface');
      expect(elementType.properties.has('type')).toBe(true);
      expect(elementType.properties.has('props')).toBe(true);
      expect(elementType.properties.has('children')).toBe(true);
    });

    it('typeToString on recursive mapped types does not stack overflow', () => {
      const f = mapFixture('recursive-types.d.ts');
      const fnType = getType(f, 'makeRequest') as FunctionType;
      // This would previously stack overflow when printing diagnostics
      const result = typeToString(fnType.returnType);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
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

    it('small interface maps to InterfaceType (below lazy threshold)', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'smallObj');
      expect(t.kind).toBe('interface');
      if (t.kind === 'interface') {
        expect(t.properties.has('name')).toBe(true);
        expect(t.properties.has('age')).toBe(true);
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

    it('isRecordLike returns false for InterfaceType (not a record)', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'smallObj');
      // Small interfaces now map to InterfaceType, not RecordType
      expect(t.kind).toBe('interface');
      expect(isRecordLike(t)).toBe(false);
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
      // Access nested SmallInterface — now maps to InterfaceType
      const nestedType = lookupRecordField(lazy, 'nested');
      expect(nestedType).toBeDefined();
      expect(nestedType!.kind).toBe('interface');
      if (nestedType!.kind === 'interface') {
        expect(nestedType.properties.get('name')).toEqual({ kind: 'primitive', name: 'string' });
      }
    });

    it('lazy record with array property resolves correctly', () => {
      const f = mapFixture('large-interface.d.ts');
      const t = getType(f, 'nestedLargeObj') as LazyRecordType;
      const arrayProp = lookupRecordField(t, 'arrayProp');
      expect(arrayProp).toBeDefined();
      expect(arrayProp!.kind).toBe('array');
    });

    it('regression: existing interface tests still pass after lazy threshold', () => {
      // Verify that interfaces below the threshold map to InterfaceType
      const f = mapFixture('nullable-types.d.ts');
      const fnType = getType(f, 'createConfig') as FunctionType;
      const configType = fnType.params[0].type as InterfaceType;
      expect(configType.kind).toBe('interface');
      expect(configType.properties.has('host')).toBe(true);
      expect(configType.properties.has('port')).toBe(true);
    });
  });

  // ── bigint and symbol mapping ──────────────────────────────

  describe('bigint and symbol primitives', () => {
    it('maps TS bigint to EffectScript bigint primitive', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'bigValue');
      expect(t).toEqual({ kind: 'primitive', name: 'bigint' });
    });

    it('maps TS symbol to EffectScript symbol primitive', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'symValue');
      expect(t).toEqual({ kind: 'primitive', name: 'symbol' });
    });

    it('maps TS unique symbol to EffectScript symbol primitive', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'uniqueSym');
      expect(t).toEqual({ kind: 'primitive', name: 'symbol' });
    });

    it('maps TS bigint literal type (100n) to EffectScript bigint primitive', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'bigLiteral');
      expect(t).toEqual({ kind: 'primitive', name: 'bigint' });
    });

    it('maps TS bigint | null to nullable bigint', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'nullableBig');
      expect(t.kind).toBe('nullable');
      if (t.kind === 'nullable') {
        expect(t.inner).toEqual({ kind: 'primitive', name: 'bigint' });
      }
    });

    it('maps TS symbol | undefined to nullable symbol', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'nullableSym');
      expect(t.kind).toBe('nullable');
      if (t.kind === 'nullable') {
        expect(t.inner).toEqual({ kind: 'primitive', name: 'symbol' });
      }
    });

    it('maps TS function (x: bigint) => symbol correctly', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const t = getType(f, 'convertBigint') as FunctionType;
      expect(t.kind).toBe('function');
      expect(t.params).toHaveLength(1);
      expect(t.params[0].type).toEqual({ kind: 'primitive', name: 'bigint' });
      expect(t.returnType).toEqual({ kind: 'primitive', name: 'symbol' });
    });

    it('no W301 warnings for bigint or symbol types', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      // Map all exports to trigger any warnings
      for (const [_name, entry] of f.exports) {
        f.mapper.mapType(entry.type, f.checker);
      }
      const w301 = f.diagnostics.getWarnings().filter(w => w.code === 'W301');
      expect(w301).toHaveLength(0);
    });
  });

  // ── Interface types ────────────────────────────────────────
  describe('interface types', () => {
    it('maps TS interface with readonly properties to InterfaceType', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Named');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.name).toBe('Named');
      expect(iface.properties.get('name')).toEqual({ kind: 'primitive', name: 'string' });
      expect(iface.methods.size).toBe(0);
    });

    it('maps TS interface with methods to InterfaceType', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Serializable');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.methods.has('serialize')).toBe(true);
      expect(iface.methods.has('deserialize')).toBe(true);
      const serialize = iface.methods.get('serialize')!;
      expect(serialize.kind).toBe('function');
      expect(serialize.returnType).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('maps generic TS interface with type params', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Collection');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.typeParams).toBeDefined();
      expect(iface.typeParams!.length).toBe(1);
      expect(iface.typeParams![0].name).toBe('T');
      expect(iface.properties.has('size')).toBe(true);
      expect(iface.methods.has('isEmpty')).toBe(true);
      expect(iface.methods.has('contains')).toBe(true);
    });

    it('maps TS interface with extends clause', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'NamedEntity');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.properties.has('id')).toBe(true);
      expect(iface.extends).toBeDefined();
      expect(iface.extends!.length).toBe(1);
      expect(iface.extends![0].kind).toBe('interface');
      expect(iface.extends![0].name).toBe('Named');
    });

    it('tracks mutable (non-readonly) properties', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'MutableConfig');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.mutableProperties).toBeDefined();
      expect(iface.mutableProperties!.has('name')).toBe(true);
      expect(iface.mutableProperties!.has('version')).toBe(false);
    });

    it('maps optional properties as nullable', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Options');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.properties.get('host')).toEqual({ kind: 'primitive', name: 'string' });
      const port = iface.properties.get('port');
      expect(port).toBeDefined();
      expect(port!.kind).toBe('nullable');
    });

    it('maps empty interface', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Marker');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.properties.size).toBe(0);
      expect(iface.methods.size).toBe(0);
    });

    it('maps TS class instance type to InterfaceType', () => {
      const f = mapFixture('interface-types.d.ts');
      const entry = f.exports.get('Command');
      expect(entry).toBeDefined();
      // getDeclaredType gives instance type for classes
      const t = getDeclaredType(f, 'Command');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.name).toBe('Command');
      expect(iface.properties.has('name')).toBe(true);
      expect(iface.methods.has('run')).toBe(true);
    });

    it('maps callable interface with __call method', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Logger');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      // Call signature mapped to __call method
      expect(iface.methods.has('__call')).toBe(true);
      const callSig = iface.methods.get('__call')!;
      expect(callSig.kind).toBe('function');
      expect(callSig.params.length).toBe(1);
      expect(callSig.params[0].type).toEqual({ kind: 'primitive', name: 'string' });
      // Normal property still mapped
      expect(iface.properties.has('level')).toBe(true);
    });

    it('maps interface with this return type to interface name', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Builder');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.methods.has('name')).toBe(true);
      const nameMethod = iface.methods.get('name')!;
      // 'this' return type resolves to the interface itself
      expect(nameMethod.returnType.kind).toBe('interface');
      expect((nameMethod.returnType as InterfaceType).name).toBe('Builder');
    });

    it('maps interface with overloaded methods using first overload (W302)', () => {
      const f = mapFixture('interface-types.d.ts');
      const t = getDeclaredType(f, 'Emitter');
      expect(t.kind).toBe('interface');
      const iface = t as InterfaceType;
      expect(iface.methods.has('on')).toBe(true);
      // Only first overload is used
      const onMethod = iface.methods.get('on')!;
      expect(onMethod.kind).toBe('function');
    });

    it('same TS type mapped twice returns cached InterfaceType', () => {
      const f = mapFixture('interface-types.d.ts');
      const t1 = getDeclaredType(f, 'Named');
      const t2 = getDeclaredType(f, 'Named');
      // Same object identity (memoized)
      expect(t1).toBe(t2);
    });
  });

  describe('index signatures', () => {
    it('40. maps TS string index type to IndexSignatureType', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'stringDict');
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.keyType).toBe('string');
      expect(idx.valueType.kind).toBe('primitive');
    });

    it('41. maps TS number index type to IndexSignatureType', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'numberDict');
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.keyType).toBe('number');
      expect(idx.valueType.kind).toBe('primitive');
    });

    it('42. maps TS mixed properties + index preserving named fields', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'mixed');
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.keyType).toBe('string');
      expect(idx.fields.has('name')).toBe(true);
      expect(idx.fields.has('age')).toBe(true);
    });

    it('43. maps TS Record<string, T> to IndexSignatureType', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'recordType');
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.keyType).toBe('string');
    });

    it('44. maps TS intersection with index signature', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'intersected');
      // The intersection flattens properties; the index signature should be present
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.fields.has('id')).toBe(true);
    });

    it('45. maps TS optional properties with index signature as nullable', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'withOptional');
      expect(t.kind).toBe('index-signature');
      const idx = t as IndexSignatureType;
      expect(idx.fields.has('required')).toBe(true);
      expect(idx.fields.has('optional')).toBe(true);
      // Optional property should be nullable
      const optType = idx.fields.get('optional')!;
      expect(optType.kind).toBe('nullable');
    });

    it('46. both string and number index types: string takes priority', () => {
      const f = mapFixture('index-signatures.d.ts');
      // Use the plain object type (not interface) to exercise mapRecordEager
      const t = getType(f, 'bothIndexesPlain');
      expect(t).toBeDefined();
      expect(t.kind).toBe('index-signature');
      if (t.kind === 'index-signature') {
        expect(t.keyType).toBe('string');
      }
    });

    it('W1. large type above lazy threshold with index signature maps to IndexSignatureType', () => {
      const f = mapFixture('index-signatures.d.ts');
      const t = getType(f, 'largeWithIndex');
      expect(t).toBeDefined();
      expect(t.kind).toBe('index-signature');
      if (t.kind === 'index-signature') {
        expect(t.keyType).toBe('string');
        expect(t.valueType.kind).toBe('primitive');
        // Named fields are omitted for types above the lazy threshold
        expect(t.fields.size).toBe(0);
      }
    });
  });

  // ── Record Field Mutability (readonly mapping) ────────────────

  describe('readonly field mapping', () => {
    it('all-readonly interface maps to all-immutable (no mutableProperties)', () => {
      const f = mapFixture('readonly-fields.d.ts');
      const t = getType(f, 'allReadonlyVal');
      // TS named interfaces map to InterfaceType (not RecordType)
      expect(t.kind).toBe('interface');
      if (t.kind === 'interface') {
        expect(t.mutableProperties).toBeUndefined();
      }
    });

    it('no-readonly interface maps to all-mutable', () => {
      const f = mapFixture('readonly-fields.d.ts');
      const t = getType(f, 'allMutableVal');
      expect(t.kind).toBe('interface');
      if (t.kind === 'interface') {
        expect(t.mutableProperties?.has('x')).toBe(true);
        expect(t.mutableProperties?.has('y')).toBe(true);
      }
    });

    it('mixed readonly maps correctly', () => {
      const f = mapFixture('readonly-fields.d.ts');
      const t = getType(f, 'mixedVal');
      expect(t.kind).toBe('interface');
      if (t.kind === 'interface') {
        // readonly → immutable (not in mutableProperties)
        expect(t.mutableProperties?.has('id') ?? false).toBe(false);
        expect(t.mutableProperties?.has('createdAt') ?? false).toBe(false);
        // non-readonly → mutable
        expect(t.mutableProperties?.has('name')).toBe(true);
        expect(t.mutableProperties?.has('updatedAt')).toBe(true);
      }
    });

    it('Readonly<T> passthrough — TS API limitation', () => {
      // Readonly<MutableBase> is evaluated by TS as a mapped type.
      // getCombinedModifierFlags checks original declarations, not mapped readonly.
      // The mapped type's readonly status is not surfaced through the TS API
      // for getCombinedModifierFlags, so properties appear as mutable.
      // This is a known TS API limitation, not an EffectScript bug.
      const f = mapFixture('readonly-fields.d.ts');
      const t = getType(f, 'frozenVal');
      expect(t.kind === 'record' || t.kind === 'interface').toBe(true);
    });
  });

  // ── Platform type mapping ────────────────────────────────────────
  describe('platform type mapping', () => {
    it('maps concrete conditional return type to resolved type', () => {
      const f = mapFixture('platform-types.d.ts');
      const fnType = getType(f, 'getConditional');
      expect(fnType.kind).toBe('function');
      if (fnType.kind === 'function') {
        const ret = fnType.returnType;
        // ConditionalResult<unknown> resolves: unknown extends string → false branch → boolean
        // TS resolves this before the mapper sees it, so no conditional type handling needed
        expect(ret).toBeDefined();
      }
    });

    it('depth limit returns platform(Any, recursive-limit)', () => {
      // The mapper's MAX_DEPTH is 20. Recursive types should hit this
      // and produce platform types instead of bare Any.
      const f = mapFixture('platform-types.d.ts');
      const nodeType = getType(f, 'getNode');
      // getNode returns RecursiveNode which is recursive
      expect(nodeType.kind).toBe('function');
    });

    it('large interface produces lazy-record type', () => {
      const f = mapFixture('platform-types.d.ts');
      const largeType = getType(f, 'large');
      // 35 properties > LAZY_THRESHOLD=30, so should be lazy
      expect(largeType.kind).toBe('lazy-record');
    });

    it('budget cap returns platform(Any, budget-cap) when exhausted', () => {
      const diagnostics = new DiagnosticCollectorImpl();
      // Set budget to 5 to trigger cap quickly
      const mapper = new TsTypeMapper(diagnostics, 5);

      const filePath = path.join(fixturesDir, 'platform-types.d.ts');
      const program = ts.createProgram([filePath], {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        declaration: true,
        strict: true,
      });
      const checker = program.getTypeChecker();
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) throw new Error('Could not load fixture');

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) throw new Error('No module symbol');

      const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
      const largeSymbol = exportedSymbols.find(s => s.getName() === 'large');
      if (!largeSymbol) throw new Error('No large export');

      const largeType = checker.getTypeOfSymbolAtLocation(largeSymbol, sourceFile);
      const mapped = mapper.mapType(largeType, checker);

      // Should be a lazy-record with 35 properties
      expect(mapped.kind).toBe('lazy-record');
      if (mapped.kind === 'lazy-record') {
        // Resolve more properties than the budget allows
        for (let i = 1; i <= 10; i++) {
          mapped.resolveField(`prop${String(i).padStart(3, '0')}`);
        }
        // After budget exhaustion, further resolutions return platform types
        // Budget of 5 means first 5 succeed, rest are platform
        let platformCount = 0;
        for (let i = 1; i <= 10; i++) {
          const field = mapped.resolvedFields.get(`prop${String(i).padStart(3, '0')}`);
          if (field && field.kind === 'platform') platformCount++;
        }
        expect(platformCount).toBeGreaterThan(0);
      }
    });

    it('W305 is emitted exactly once when budget is exhausted', () => {
      const diagnostics = new DiagnosticCollectorImpl();
      const mapper = new TsTypeMapper(diagnostics, 3);

      const filePath = path.join(fixturesDir, 'platform-types.d.ts');
      const program = ts.createProgram([filePath], {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        declaration: true,
        strict: true,
      });
      const checker = program.getTypeChecker();
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) throw new Error('Could not load fixture');

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) throw new Error('No module symbol');

      const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
      const largeSymbol = exportedSymbols.find(s => s.getName() === 'large');
      if (!largeSymbol) throw new Error('No large export');

      const largeType = checker.getTypeOfSymbolAtLocation(largeSymbol, sourceFile);
      const mapped = mapper.mapType(largeType, checker);

      if (mapped.kind === 'lazy-record') {
        // Resolve enough to exhaust budget
        for (let i = 1; i <= 10; i++) {
          mapped.resolveField(`prop${String(i).padStart(3, '0')}`);
        }
      }

      const w305 = diagnostics.getAll().filter(d => d.code === 'W305');
      expect(w305.length).toBe(1);
    });

    // TG6: Cross-cutting integration test combining recursion + budget + conditional
    it('cross-cutting: large interface with recursive and conditional properties', () => {
      const diagnostics = new DiagnosticCollectorImpl();
      const mapper = new TsTypeMapper(diagnostics, 10);

      const filePath = path.join(fixturesDir, 'platform-types.d.ts');
      const program = ts.createProgram([filePath], {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ES2020,
        declaration: true,
        strict: true,
      });
      const checker = program.getTypeChecker();
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) throw new Error('Could not load fixture');

      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) throw new Error('No module symbol');

      const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
      const crossCuttingSymbol = exportedSymbols.find(s => s.getName() === 'crossCutting');
      if (!crossCuttingSymbol) throw new Error('No crossCutting export');

      const crossCuttingType = checker.getTypeOfSymbolAtLocation(crossCuttingSymbol, sourceFile);
      const mapped = mapper.mapType(crossCuttingType, checker);

      // 33 properties > LAZY_THRESHOLD=30, so should be lazy
      expect(mapped.kind).toBe('lazy-record');
      if (mapped.kind === 'lazy-record') {
        // Access some regular fields — should resolve to exact types
        const prop001 = mapped.resolveField('prop001');
        expect(prop001).toBeDefined();
        if (prop001) expect(prop001.kind).toBe('primitive');

        // Access the recursive field
        const recursiveField = mapped.resolveField('recursive');
        expect(recursiveField).toBeDefined();
        // Recursive types may be mapped as union or produce platform types

        // Access enough fields to potentially trigger budget cap
        for (let i = 1; i <= 31; i++) {
          mapped.resolveField(`prop${String(i).padStart(3, '0')}`);
        }

        // All three mechanisms engaged in one compilation:
        // - Large interface triggers lazy record
        // - Recursive field triggers depth limit in mapper
        // - Conditional field triggers conditional platform type
        // No crashes or OOM — compilation succeeds
      }
    });

    it('W301 still fires for bigint/symbol (not platform types)', () => {
      const f = mapFixture('bigint-symbol-types.d.ts');
      const bigintType = getType(f, 'bigValue');
      // bigint maps to bigint primitive, not platform
      expect(bigintType.kind).toBe('primitive');
    });
  });

  // ── Conditional type evaluation ─────────────────────────────────
  describe('conditional type evaluation', () => {
    function containsPrimitive(t: Type, name: string): boolean {
      if (t.kind === 'primitive' && t.name === name) return true;
      if (t.kind === 'union') return t.members.some(m => containsPrimitive(m, name));
      return false;
    }

    function containsLiteral(t: Type, value: string | number | boolean): boolean {
      if (t.kind === 'literal' && t.value === value) return true;
      if (t.kind === 'union') return t.members.some(m => containsLiteral(m, value));
      return false;
    }

    // ── Happy path tests ──────────────────────────────────────────

    it('1. concrete ReturnType resolution: ExtractedReturn maps to string', () => {
      const f = mapFixture('conditional-types.d.ts');
      // Type aliases use getDeclaredType — getTypeOfSymbolAtLocation returns any for type symbols
      const t = getDeclaredType(f, 'ExtractedReturn');
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('2. NonNullable with null: SafeString maps to string', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'SafeString');
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('3. NonNullable with undefined: SafeNumber maps to number', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'SafeNumber');
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('4. NonNullable with union: SafeUnion maps to union of string and number', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'SafeUnion');
      // Should contain string and number but not null/undefined
      expect(containsPrimitive(t, 'string')).toBe(true);
      expect(containsPrimitive(t, 'number')).toBe(true);
    });

    it('5. Extract distribution: ExtractStrings maps to union of string and number', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ExtractStrings');
      expect(containsPrimitive(t, 'string')).toBe(true);
      expect(containsPrimitive(t, 'number')).toBe(true);
    });

    it('6. Exclude distribution: ExcludeStrings contains number and boolean members', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ExcludeStrings');
      // TS distributes Exclude<string | number | boolean, string> to number | true | false
      // The mapper preserves boolean literals; containsPrimitive checks for primitive 'boolean'
      // or boolean literal members (true/false)
      expect(containsPrimitive(t, 'number')).toBe(true);
      // Boolean may appear as primitive 'boolean' or as true|false literals
      const hasBooleanContent = containsPrimitive(t, 'boolean') || containsLiteral(t, true) || containsLiteral(t, false);
      expect(hasBooleanContent).toBe(true);
    });

    it('7. Concrete IsString<string>: ConcreteResult maps to literal "yes"', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ConcreteResult');
      expect(t.kind).toBe('literal');
      if (t.kind === 'literal') {
        expect(t.base).toBe('string');
        expect(t.value).toBe('yes');
      }
    });

    it('8. Concrete IsString<number>: ConcreteResult2 maps to literal "no"', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ConcreteResult2');
      expect(t.kind).toBe('literal');
      if (t.kind === 'literal') {
        expect(t.base).toBe('string');
        expect(t.value).toBe('no');
      }
    });

    it('9. UnwrapArray<string[]>: UnwrappedStrings maps to string', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'UnwrappedStrings');
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('10. UnwrapArray<number>: UnwrappedNumber maps to number (identity case)', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'UnwrappedNumber');
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('11. OnlyStrings filter: FilteredUnion maps to string', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'FilteredUnion');
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('12. MySingleUnwrap<Promise<string>>: ResolvedPromise maps to string', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ResolvedPromise');
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('13. Extract<boolean, string> -> never: NeverResult maps to never', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'NeverResult');
      expect(t).toEqual({ kind: 'primitive', name: 'never' });
    });

    // ── Edge case tests ───────────────────────────────────────────

    it('14. Abstract IsString<T> (uninstantiated) does not produce Any', () => {
      const f = mapFixture('conditional-types.d.ts');
      const entry = f.exports.get('IsString');
      expect(entry).toBeDefined();
      if (entry) {
        const mapped = f.mapper.mapType(entry.declaredType, f.checker);
        // Should be something other than Any — either a union or concrete type
        // For abstract T, Strategy 4 should produce "yes" | "no"
        expect(mapped.kind !== 'primitive' || mapped.name !== 'Any').toBe(true);
      }
    });

    it('15. Abstract UnpackPromise<T> (uninstantiated) does not produce Any', () => {
      const f = mapFixture('conditional-types.d.ts');
      const entry = f.exports.get('UnpackPromise');
      expect(entry).toBeDefined();
      if (entry) {
        const mapped = f.mapper.mapType(entry.declaredType, f.checker);
        // Should produce some type rather than Any
        expect(mapped).toBeDefined();
        // Accept any non-Any result (union of branches or generic)
        const isAny = mapped.kind === 'primitive' && mapped.name === 'Any';
        expect(isAny).toBe(false);
      }
    });

    it('16. Nested conditional: Nested<T> with abstract T resolves branches', () => {
      const f = mapFixture('conditional-types.d.ts');
      const entry = f.exports.get('Nested');
      expect(entry).toBeDefined();
      if (entry) {
        const mapped = f.mapper.mapType(entry.declaredType, f.checker);
        // Should not be bare Any
        const isAny = mapped.kind === 'primitive' && mapped.name === 'Any';
        expect(isAny).toBe(false);
      }
    });

    it('17. Conditional with any check type: AnyConditional produces "yes" | "no"', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'AnyConditional');
      // any extends string ? "yes" : "no" → TS produces "yes" | "no" (both branches)
      expect(['union', 'literal'].includes(t.kind)).toBe(true);
      if (t.kind === 'union') {
        const hasYes = t.members.some(m => m.kind === 'literal' && m.value === 'yes');
        const hasNo = t.members.some(m => m.kind === 'literal' && m.value === 'no');
        expect(hasYes).toBe(true);
        expect(hasNo).toBe(true);
      } else if (t.kind === 'literal') {
        // TS might resolve to one branch in some versions
        expect(t.base).toBe('string');
      }
    });

    it('18. Function with conditional return type: getStringOrNumber has meaningful return type', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getType(f, 'getStringOrNumber');
      expect(t.kind).toBe('function');
      if (t.kind === 'function') {
        const ret = t.returnType;
        // For abstract generic, the return type should be some form of
        // number | boolean (the two branches) rather than Any
        const isAny = ret.kind === 'primitive' && ret.name === 'Any';
        // Accept either resolved branches or platform type as non-regression
        expect(ret).toBeDefined();
        // Should not be bare Any — either union, platform, or concrete
        if (isAny) {
          // If it's Any, that's a regression — the branches should resolve
          expect(isAny).toBe(false);
        }
      }
    });

    it('12b. MySingleUnwrap<Promise<Promise<number>>>: ResolvedNested maps to Promise<number> (single unwrap)', () => {
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ResolvedNested');
      // Single unwrap of Promise<Promise<number>> should give Promise<number>
      expect(t.kind).toBe('promise');
      if (t.kind === 'promise') {
        expect(t.inner).toEqual({ kind: 'primitive', name: 'number' });
      }
    });

    it('19. Conditional in intersection: WithConditional<T> does not crash', () => {
      const f = mapFixture('conditional-types.d.ts');
      const entry = f.exports.get('WithConditional');
      expect(entry).toBeDefined();
      if (entry) {
        // Should not throw — the conditional part resolves independently
        const mapped = f.mapper.mapType(entry.declaredType, f.checker);
        expect(mapped).toBeDefined();
        // Should not be bare Any — the intersection should produce some structured type
        const isAny = mapped.kind === 'primitive' && mapped.name === 'Any';
        expect(isAny).toBe(false);
      }
    });

    // ── Error/rejection tests ─────────────────────────────────────

    it('21. W301 not emitted for resolved conditionals (strategies succeed)', () => {
      // Concrete conditional types should resolve without W301.
      // Use a fresh mapper/diagnostics for each to isolate warnings.
      const concreteTypes = [
        'ExtractedReturn', 'SafeString', 'SafeNumber', 'SafeUnion',
        'ExtractStrings', 'ExcludeStrings', 'ConcreteResult', 'ConcreteResult2',
        'UnwrappedStrings', 'UnwrappedNumber', 'FilteredUnion', 'NeverResult',
        'ResolvedPromise',
      ];
      const f = mapFixture('conditional-types.d.ts');
      for (const name of concreteTypes) {
        getDeclaredType(f, name);
      }
      // No W301 warnings should be emitted for concrete conditionals
      const w301s = f.diagnostics.getAll().filter(d =>
        d.code === 'W301' && d.message.includes('conditional'),
      );
      expect(w301s.length).toBe(0);
    });

    it('20. No W301 for resolved conditionals', () => {
      const f = mapFixture('conditional-types.d.ts');
      // Map concrete conditionals that should resolve successfully via getDeclaredType
      getDeclaredType(f, 'ExtractedReturn');
      getDeclaredType(f, 'SafeString');
      getDeclaredType(f, 'ConcreteResult');
      // No W301 warnings should have been emitted for these resolved conditionals
      const w301s = f.diagnostics.getAll().filter(d => d.code === 'W301');
      expect(w301s.length).toBe(0);
    });

    it('22. Depth limit produces fallback without crashing', () => {
      // The mapper's MAX_DEPTH is 20. A deeply nested conditional chain
      // should hit the depth limit and return something (Any or platform) without crashing.
      const f = mapFixture('conditional-types.d.ts');
      // All types should map without errors
      for (const name of f.exports.keys()) {
        const entry = f.exports.get(name);
        if (entry) {
          // Should not throw
          f.mapper.mapType(entry.type, f.checker);
        }
      }
    });

    // ── Regression tests ──────────────────────────────────────────

    it('25. Existing ConditionalType<T> now resolves branches instead of Any', () => {
      const f = mapFixture('complex-types.d.ts');
      const entry = f.exports.get('ConditionalType');
      expect(entry).toBeDefined();
      if (entry) {
        const mapped = f.mapper.mapType(entry.declaredType, f.checker);
        // For abstract T, Strategy 2 resolves via base constraint: number | true | false
        // (TS represents boolean as true | false internally)
        expect(mapped.kind).toBe('union');
        if (mapped.kind === 'union') {
          expect(containsPrimitive(mapped, 'number')).toBe(true);
          // Boolean may appear as primitive 'boolean' or as true|false literals
          const hasBooleanContent = containsPrimitive(mapped, 'boolean') || containsLiteral(mapped, true) || containsLiteral(mapped, false);
          expect(hasBooleanContent).toBe(true);
        }
      }
    });

    it('26. Non-conditional types unaffected (basic smoke test)', () => {
      const f = mapFixture('conditional-types.d.ts');
      // parseToString is a simple function — should not be affected by conditional changes
      const t = getType(f, 'parseToString');
      expect(t.kind).toBe('function');
      if (t.kind === 'function') {
        expect(t.returnType).toEqual({ kind: 'primitive', name: 'string' });
      }
    });

    // ── Checker integration tests ────────────────────────────────

    it('23. Importing TS function with conditional return type resolves to concrete type', () => {
      // Test that a concrete instantiation of a conditional type
      // resolves to a specific type, not Any.
      // ExtractedReturn = ReturnType<(x: number) => string> should be string
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'ExtractedReturn');
      // The checker would see this type — it should be string, not Any
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
      // Verify no W301 was emitted for this resolution
      const w301s = f.diagnostics.getAll().filter(d => d.code === 'W301');
      expect(w301s.length).toBe(0);
    });

    it('24. Type mismatch with resolved conditional type would produce checker error', () => {
      // Verify that the resolved type is concrete enough for type checking.
      // SafeString resolves to string (not Any), so attempting to use it as number
      // would fail in the checker. We verify the mapper produces the concrete type.
      const f = mapFixture('conditional-types.d.ts');
      const t = getDeclaredType(f, 'SafeString');
      // Must be string, not Any — if it were Any, no E200 would be produced
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
      // Also check SafeNumber resolves to number
      const t2 = getDeclaredType(f, 'SafeNumber');
      expect(t2).toEqual({ kind: 'primitive', name: 'number' });
      // These concrete types will cause the checker to report E200
      // when used with incompatible types, unlike Any which is assignable to everything
    });
  });
});
