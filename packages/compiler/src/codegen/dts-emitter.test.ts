import { describe, it, expect } from 'vitest';
import { emitDTS } from './dts-emitter.js';
import type {
  Program, LetDeclaration, TypeDeclaration, VariantDeclaration,
  ExportDeclaration, ExtensionFunctionDeclaration,
  InterfaceDeclaration,
  Identifier, NumberLiteral, StringLiteral,
  ArrowFunction, FunctionParam, ExpressionStatement,
  Expression, Declaration, Statement,
  RecordType as RecordTypeNode, RecordTypeField,
  NamedType, TypeParameter,
} from '../parser/ast.js';
import type { Span } from '../utils/span.js';
import type { Type, FunctionType as FT, ADTType, RecordType, InterfaceType, LiteralType, UnionType, PrimitiveType, NullableType } from '../checker/types.js';

// ── Helpers ─────────────────────────────────────────────────

const span: Span = {
  file: 'test.efs',
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 0, line: 1, column: 0 },
};

function id(name: string): Identifier {
  return { kind: 'Identifier', name, span };
}

function num(value: number): NumberLiteral {
  return { kind: 'NumberLiteral', value, span };
}

function str(value: string): StringLiteral {
  return { kind: 'StringLiteral', value, span };
}

function program(...body: (Declaration | Statement)[]): Program {
  return { kind: 'Program', body, span };
}

function param(name: string): FunctionParam {
  return { kind: 'FunctionParam', name: id(name), mutable: false, span };
}

function arrow(params: FunctionParam[], body: Expression, typeParams?: unknown[]): ArrowFunction {
  const node: Record<string, unknown> = { kind: 'ArrowFunction', params, body, span };
  if (typeParams !== undefined) node['typeParams'] = typeParams;
  return node as unknown as ArrowFunction;
}

function letDecl(name: string, init: Expression, opts?: { mutable?: boolean; exported?: boolean }): LetDeclaration {
  return {
    kind: 'LetDeclaration',
    name: id(name),
    mutable: opts?.mutable ?? false,
    initializer: init,
    exported: opts?.exported ?? false,
    span,
  };
}

function exprStmt(expression: Expression): ExpressionStatement {
  return { kind: 'ExpressionStatement', expression, span };
}

function typeDecl(name: string, variants: VariantDeclaration[], opts?: { exported?: boolean; typeParams?: unknown[] }): TypeDeclaration {
  const node: Record<string, unknown> = {
    kind: 'TypeDeclaration',
    name: id(name),
    variants,
    exported: opts?.exported ?? false,
    span,
  };
  if (opts?.typeParams !== undefined) node['typeParams'] = opts.typeParams;
  return node as unknown as TypeDeclaration;
}

function variant(name: string, fields: [string, string][] = []): VariantDeclaration {
  return {
    kind: 'VariantDeclaration',
    name: id(name),
    fields: fields.map(([n, typeName]) => ({
      name: id(n),
      type: { kind: 'NamedType', name: id(typeName), span },
    })),
    span,
  };
}

function exportDecl(opts: {
  declaration?: LetDeclaration | TypeDeclaration;
  specifiers?: { local: string; exported?: string }[];
  source?: string;
}): ExportDeclaration {
  const node: Record<string, unknown> = { kind: 'ExportDeclaration', span };
  if (opts.declaration !== undefined) node['declaration'] = opts.declaration;
  if (opts.specifiers !== undefined) {
    node['specifiers'] = opts.specifiers.map(s => {
      const spec: Record<string, unknown> = { kind: 'ExportSpecifier', local: id(s.local), span };
      if (s.exported !== undefined) spec['exported'] = id(s.exported);
      return spec;
    });
  }
  if (opts.source !== undefined) node['source'] = str(opts.source);
  return node as unknown as ExportDeclaration;
}

function withType<T>(node: T, type: Type): T {
  (node as Record<string, unknown>)['resolvedType'] = type;
  return node;
}

// ── Types ──────────────────────────────────────────────────

const numberType: Type = { kind: 'primitive', name: 'number' };
const stringType: Type = { kind: 'primitive', name: 'string' };
const boolType: Type = { kind: 'primitive', name: 'boolean' };
const voidType: Type = { kind: 'primitive', name: 'void' };

const addFnType: FT = {
  kind: 'function',
  params: [
    { name: 'x', type: numberType, optional: false, hasDefault: false },
    { name: 'y', type: numberType, optional: false, hasDefault: false },
  ],
  returnType: numberType,
};

const genericIdentityType: FT = {
  kind: 'function',
  params: [{ name: 'x', type: { kind: 'generic', name: 'T' }, optional: false, hasDefault: false }],
  returnType: { kind: 'generic', name: 'T' },
  typeParams: [{ name: 'T' }],
};

// ── Tests ───────────────────────────────────────────────────

describe('DTS Emitter', () => {
  // ── 1. Exported function binding ──
  it('emits exported function binding', () => {
    const decl = withType(
      letDecl('add', arrow([param('x'), param('y')], id('x')), { exported: true }),
      addFnType,
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const add: (x: number, y: number) => number;');
  });

  // ── 2. Exported non-function binding ──
  it('emits exported non-function binding', () => {
    const decl = withType(
      letDecl('PI', num(3.14), { exported: true }),
      numberType,
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const PI: number;');
  });

  // ── 3. Exported mutable binding ──
  it('emits exported mutable binding as declare let', () => {
    const decl = withType(
      letDecl('counter', num(0), { exported: true, mutable: true }),
      numberType,
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare let counter: number;');
  });

  // ── 4. Exported ADT → interfaces + discriminated union + constructors ──
  it('emits exported ADT as interfaces, type union, and constructors', () => {
    const td = typeDecl('Result', [
      variant('Ok', [['value', 'T']]),
      variant('Err', [['error', 'E']]),
    ], {
      exported: true,
      typeParams: [{ kind: 'TypeParameter', name: id('T'), span }, { kind: 'TypeParameter', name: id('E'), span }],
    });

    // Set resolved types on variant fields for DTS emission
    const okType: FT = {
      kind: 'function',
      params: [{ name: 'value', type: { kind: 'generic', name: 'T' }, optional: false, hasDefault: false }],
      returnType: {
        kind: 'adt', name: 'Result',
        typeArgs: [{ kind: 'generic', name: 'T' }, { kind: 'generic', name: 'E' }],
        variants: [],
      } as ADTType,
      typeParams: [{ name: 'T' }, { name: 'E' }],
    };
    const errType: FT = {
      kind: 'function',
      params: [{ name: 'error', type: { kind: 'generic', name: 'E' }, optional: false, hasDefault: false }],
      returnType: {
        kind: 'adt', name: 'Result',
        typeArgs: [{ kind: 'generic', name: 'T' }, { kind: 'generic', name: 'E' }],
        variants: [],
      } as ADTType,
      typeParams: [{ name: 'T' }, { name: 'E' }],
    };
    withType(td.variants[0], okType);
    withType(td.variants[1], errType);

    const ast = program(td);
    const result = emitDTS(ast);
    expect(result).toContain('export interface Ok<T>');
    expect(result).toContain('readonly _tag: "Ok"');
    expect(result).toContain('readonly value: T');
    expect(result).toContain('export interface Err<E>');
    expect(result).toContain('readonly _tag: "Err"');
    expect(result).toContain('readonly error: E');
    expect(result).toContain('export type Result<T, E> = Ok<T> | Err<E>;');
    expect(result).toContain('export declare const Ok: <T>(value: T) => Ok<T>;');
    expect(result).toContain('export declare const Err: <E>(error: E) => Err<E>;');
  });

  // ── 5. Exported fieldless ADT ──
  it('emits exported fieldless ADT', () => {
    const td = typeDecl('Color', [
      variant('Red'),
      variant('Green'),
      variant('Blue'),
    ], { exported: true });
    const ast = program(td);
    const result = emitDTS(ast);
    expect(result).toContain('export interface Red');
    expect(result).toContain('readonly _tag: "Red"');
    expect(result).toContain('export interface Green');
    expect(result).toContain('export interface Blue');
    expect(result).toContain('export type Color = Red | Green | Blue;');
    expect(result).toContain('export declare const Red: Red;');
    expect(result).toContain('export declare const Green: Green;');
    expect(result).toContain('export declare const Blue: Blue;');
  });

  // ── 6. Exported generic ADT ──
  it('emits exported generic ADT with generic interfaces', () => {
    const td = typeDecl('Option', [
      variant('Some', [['value', 'T']]),
      variant('None'),
    ], {
      exported: true,
      typeParams: [{ kind: 'TypeParameter', name: id('T'), span }],
    });
    const ast = program(td);
    const result = emitDTS(ast);
    expect(result).toContain('export interface Some<T>');
    expect(result).toContain('export interface None');
    expect(result).toContain('export type Option<T> = Some<T> | None;');
  });

  // ── 6b. Named record type alias → export type ──
  it('emits named record type alias as export type', () => {
    const recordType: RecordTypeNode = {
      kind: 'RecordType',
      fields: [
        { name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as unknown as RecordTypeField['type'], optional: false, mutable: false },
        { name: id('age'), type: { kind: 'NamedType', name: id('number'), span } as unknown as RecordTypeField['type'], optional: false, mutable: false },
      ],
      span,
    };
    const resolvedType: RecordType = {
      kind: 'record',
      fields: new Map<string, Type>([
        ['name', { kind: 'primitive', name: 'string' }],
        ['age', { kind: 'primitive', name: 'number' }],
      ]),
    };
    const node: Record<string, unknown> = {
      kind: 'TypeDeclaration',
      name: id('User'),
      variants: [],
      exported: true,
      span,
      recordType,
      resolvedType,
    };
    const td = node as unknown as TypeDeclaration;
    const ast = program(td);
    const result = emitDTS(ast);
    expect(result).toContain('export type User = { readonly name: string; readonly age: number };');
  });

  // ── 7. Re-export ──
  it('emits re-export', () => {
    const ast = program(exportDecl({ specifiers: [{ local: 'add' }], source: './math' }));
    const result = emitDTS(ast);
    expect(result).toContain('export { add } from "./math.js";');
  });

  // ── 8. Named export ──
  it('emits named export', () => {
    const ast = program(exportDecl({ specifiers: [{ local: 'a' }, { local: 'b' }] }));
    const result = emitDTS(ast);
    expect(result).toContain('export { a, b };');
  });

  // ── 9. Nullable type → T | null ──
  it('emits nullable type as T | null', () => {
    const decl = withType(
      letDecl('x', num(0), { exported: true }),
      { kind: 'nullable', inner: numberType },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('number | null');
  });

  // ── 10. Any type → any ──
  it('emits any type', () => {
    const decl = withType(
      letDecl('x', num(0), { exported: true }),
      { kind: 'any' },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain(': any;');
  });

  // ── 11. Array type ──
  it('emits array type', () => {
    const decl = withType(
      letDecl('xs', num(0), { exported: true }),
      { kind: 'array', element: numberType },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('Array<number>');
  });

  // ── 12. Tuple type ──
  it('emits tuple type', () => {
    const decl = withType(
      letDecl('pair', num(0), { exported: true }),
      { kind: 'tuple', elements: [numberType, stringType] },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('[number, string]');
  });

  // ── 13. Record type ──
  it('emits record type with readonly fields', () => {
    const decl = withType(
      letDecl('obj', num(0), { exported: true }),
      { kind: 'record', fields: new Map([['name', stringType], ['age', numberType]]) },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('readonly name: string');
    expect(result).toContain('readonly age: number');
  });

  // ── 14. Function type ──
  it('emits function type', () => {
    const decl = withType(
      letDecl('fn', num(0), { exported: true }),
      addFnType,
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('(x: number, y: number) => number');
  });

  // ── 15. Union type ──
  it('emits union type', () => {
    const decl = withType(
      letDecl('x', num(0), { exported: true }),
      { kind: 'union', members: [numberType, stringType] },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('number | string');
  });

  // ── 16. Promise type ──
  it('emits promise type', () => {
    const decl = withType(
      letDecl('p', num(0), { exported: true }),
      { kind: 'promise', inner: numberType },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('Promise<number>');
  });

  // ── 17. Generic type parameter preservation ──
  it('preserves generic type parameters in function type', () => {
    const decl = withType(
      letDecl('identity', arrow([param('x')], id('x')), { exported: true }),
      genericIdentityType,
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('<T>');
    expect(result).toContain('(x: T) => T');
  });

  // ── 18. Non-exported declarations → not emitted ──
  it('does not emit non-exported declarations', () => {
    const decl = withType(letDecl('x', num(42)), numberType);
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toBe('');
  });

  // ── 19. Mixed exported/non-exported ──
  it('only emits exported declarations', () => {
    const decl1 = withType(letDecl('x', num(42)), numberType);
    const decl2 = withType(letDecl('y', num(10), { exported: true }), numberType);
    const ast = program(decl1, decl2);
    const result = emitDTS(ast);
    expect(result).not.toContain('x:');
    expect(result).toContain('export declare const y: number;');
  });

  // ── 20. Empty program → empty .d.ts ──
  it('emits empty string for empty program', () => {
    const ast = program();
    expect(emitDTS(ast)).toBe('');
  });

  // ── 21. Nested types ──
  it('emits nested types correctly', () => {
    const nestedType: Type = {
      kind: 'array',
      element: {
        kind: 'adt',
        name: 'Result',
        typeArgs: [numberType, stringType],
        variants: [],
      },
    };
    const decl = withType(letDecl('xs', num(0), { exported: true }), nestedType);
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('Array<Result<number, string>>');
  });

  // ── 22. Import path rewriting in re-exports ──
  it('rewrites import paths in re-exports', () => {
    const ast = program(exportDecl({ specifiers: [{ local: 'x' }], source: './utils' }));
    const result = emitDTS(ast);
    expect(result).toContain('from "./utils.js"');
  });

  // ── Additional: ExportDeclaration wrapper ──
  it('emits exported let via ExportDeclaration wrapper', () => {
    const inner = withType(letDecl('x', num(0), { exported: true }), numberType);
    const ast = program(exportDecl({ declaration: inner }));
    const result = emitDTS(ast);
    expect(result).toContain('export declare const x: number;');
  });

  // ── Additional: Error type → any ──
  it('emits error type as any', () => {
    const decl = withType(
      letDecl('x', num(0), { exported: true }),
      { kind: 'error' },
    );
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain(': any;');
  });

  // ── Extension function declarations ────────────────────────

  it('emits exported extension function as declare const', () => {
    const ext = extensionDecl('string', 'words', [], stringType, {
      kind: 'array', element: stringType,
    }, { exported: true });
    const ast = program(ext);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const string_words: (__this: string) => Array<string>;');
  });

  it('emits extension with params', () => {
    const ext = extensionDecl('string', 'startsWith', [
      { name: 'prefix', type: stringType, optional: false, hasDefault: false },
    ], stringType, boolType, { exported: true });
    const ast = program(ext);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const string_startsWith: (__this: string, prefix: string) => boolean;');
  });

  it('emits generic extension function', () => {
    const elementType: Type = { kind: 'generic', name: 'T' };
    const ext = extensionDecl('Array', 'first', [], {
      kind: 'array', element: elementType,
    }, { kind: 'nullable', inner: elementType }, {
      exported: true,
      typeParams: [{ name: 'T' }],
    });
    const ast = program(ext);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const Array_first: <T>(__this: Array<T>) => T | null;');
  });

  it('does not emit non-exported extension function', () => {
    const ext = extensionDecl('string', 'words', [], stringType, {
      kind: 'array', element: stringType,
    }, { exported: false });
    const ast = program(ext);
    const result = emitDTS(ast);
    expect(result).toBe('');
  });

  it('emits extension via ExportDeclaration wrapper', () => {
    const ext = extensionDecl('number', 'double', [], numberType, numberType, { exported: true });
    const node: Record<string, unknown> = {
      kind: 'ExportDeclaration',
      declaration: ext,
      span,
    };
    const ast = program(node as unknown as ExportDeclaration);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const number_double: (__this: number) => number;');
  });

  // ── Collection Types in DTS ────────────────────────────────

  describe('Set and Map DTS emission', () => {
    it('emits exported Set<string> constant', () => {
      const setType: Type = { kind: 'set', element: { kind: 'primitive', name: 'string' } };
      const init = id('x');
      (init as unknown as Record<string, unknown>)['resolvedType'] = setType;
      const decl = letDecl('names', init, { exported: true });
      (decl as unknown as Record<string, unknown>)['resolvedType'] = setType;
      const ast = program(decl);
      const result = emitDTS(ast);
      expect(result).toContain('export declare const names: Set<string>;');
    });

    it('emits exported Map<string, number> constant', () => {
      const mapType: Type = {
        kind: 'map',
        key: { kind: 'primitive', name: 'string' },
        value: { kind: 'primitive', name: 'number' },
      };
      const init = id('x');
      (init as unknown as Record<string, unknown>)['resolvedType'] = mapType;
      const decl = letDecl('scores', init, { exported: true });
      (decl as unknown as Record<string, unknown>)['resolvedType'] = mapType;
      const ast = program(decl);
      const result = emitDTS(ast);
      expect(result).toContain('export declare const scores: Map<string, number>;');
    });

    it('emits exported function returning Set<string>', () => {
      const fnType: FT = {
        kind: 'function',
        params: [],
        returnType: { kind: 'set', element: { kind: 'primitive', name: 'string' } },
      };
      const body = id('x');
      const fn = arrow([], body);
      (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
      const decl = letDecl('getNames', fn, { exported: true });
      (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
      const ast = program(decl);
      const result = emitDTS(ast);
      expect(result).toContain('export declare const getNames: () => Set<string>;');
    });

    it('emits exported function returning Map<K, V>', () => {
      const fnType: FT = {
        kind: 'function',
        params: [],
        returnType: {
          kind: 'map',
          key: { kind: 'primitive', name: 'string' },
          value: { kind: 'primitive', name: 'number' },
        },
      };
      const body = id('x');
      const fn = arrow([], body);
      (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
      const decl = letDecl('getScores', fn, { exported: true });
      (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
      const ast = program(decl);
      const result = emitDTS(ast);
      expect(result).toContain('export declare const getScores: () => Map<string, number>;');
    });

    it('emits nested Set<Map<K,V>> correctly', () => {
      const innerMap: Type = {
        kind: 'map',
        key: { kind: 'primitive', name: 'string' },
        value: { kind: 'primitive', name: 'number' },
      };
      const setOfMaps: Type = { kind: 'set', element: innerMap };
      const init = id('x');
      (init as unknown as Record<string, unknown>)['resolvedType'] = setOfMaps;
      const decl = letDecl('data', init, { exported: true });
      (decl as unknown as Record<string, unknown>)['resolvedType'] = setOfMaps;
      const ast = program(decl);
      const result = emitDTS(ast);
      expect(result).toContain('export declare const data: Set<Map<string, number>>;');
    });

    it('ADT variant with Set<T> field detects generic T', () => {
      const td = typeDecl('Container', [
        variant('Items', [['items', 'T']]),
      ], {
        exported: true,
        typeParams: [{ kind: 'TypeParameter', name: id('T'), span }],
      });
      const setOfT: Type = { kind: 'set', element: { kind: 'generic', name: 'T' } };
      const ctorType: FT = {
        kind: 'function',
        params: [{ name: 'items', type: setOfT, optional: false, hasDefault: false }],
        returnType: {
          kind: 'adt', name: 'Container',
          typeArgs: [{ kind: 'generic', name: 'T' }],
          variants: [],
        } as ADTType,
        typeParams: [{ name: 'T' }],
      };
      withType(td.variants[0], ctorType);
      // Also set resolvedType on the field's type expression
      const itemsField = td.variants[0].fields[0];
      (itemsField as unknown as Record<string, unknown>)['resolvedType'] = setOfT;
      const ast = program(td);
      const result = emitDTS(ast);
      expect(result).toContain('export interface Items<T>');
      expect(result).toContain('readonly items: Set<T>');
      expect(result).toContain('export declare const Items: <T>(items: Set<T>) => Items<T>;');
    });

    it('ADT variant with Map<K, V> field detects both K and V generics', () => {
      const td = typeDecl('Cache', [
        variant('Loaded', [['data', 'K']]),
      ], {
        exported: true,
        typeParams: [
          { kind: 'TypeParameter', name: id('K'), span },
          { kind: 'TypeParameter', name: id('V'), span },
        ],
      });
      const mapOfKV: Type = {
        kind: 'map',
        key: { kind: 'generic', name: 'K' },
        value: { kind: 'generic', name: 'V' },
      };
      const ctorType: FT = {
        kind: 'function',
        params: [{ name: 'data', type: mapOfKV, optional: false, hasDefault: false }],
        returnType: {
          kind: 'adt', name: 'Cache',
          typeArgs: [{ kind: 'generic', name: 'K' }, { kind: 'generic', name: 'V' }],
          variants: [],
        } as ADTType,
        typeParams: [{ name: 'K' }, { name: 'V' }],
      };
      withType(td.variants[0], ctorType);
      const dataField = td.variants[0].fields[0];
      (dataField as unknown as Record<string, unknown>)['resolvedType'] = mapOfKV;
      const ast = program(td);
      const result = emitDTS(ast);
      expect(result).toContain('export interface Loaded<K, V>');
      expect(result).toContain('readonly data: Map<K, V>');
      expect(result).toContain('export declare const Loaded: <K, V>(data: Map<K, V>) => Loaded<K, V>;');
    });
  });
});

// ── Extension Declaration Helper ────────────────────────────

function extensionDecl(
  receiverName: string,
  methodName: string,
  params: Array<{ name: string; type: Type; optional: boolean; hasDefault: boolean }>,
  receiverType: Type,
  returnType: Type,
  opts?: { exported?: boolean; typeParams?: Array<{ name: string }> },
): ExtensionFunctionDeclaration {
  const span: Span = {
    file: 'test.efs',
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: 0, line: 1, column: 0 },
  };
  const fnType: FT = opts?.typeParams
    ? { kind: 'function', params, returnType, typeParams: opts.typeParams }
    : { kind: 'function', params, returnType };
  const node: Record<string, unknown> = {
    kind: 'ExtensionFunctionDeclaration',
    receiverType: { kind: 'NamedType', name: { kind: 'Identifier', name: receiverName, span }, span },
    name: { kind: 'Identifier', name: methodName, span },
    params: [],
    returnType: { kind: 'NamedType', name: { kind: 'Identifier', name: 'void', span }, span },
    body: { kind: 'Identifier', name: 'this', span },
    exported: opts?.exported ?? false,
    span,
    resolvedType: fnType,
    resolvedReceiverType: receiverType,
  };
  return node as unknown as ExtensionFunctionDeclaration;
}

// ── Async/Await DTS ────────────────────────────────────────────

describe('Async function DTS emission', () => {
  it('emits async function without async keyword (just Promise<T> return)', () => {
    const fnType: FT = {
      kind: 'function',
      params: [{ name: 's', type: { kind: 'primitive', name: 'string' } }],
      returnType: { kind: 'promise', inner: { kind: 'primitive', name: 'number' } },
    };
    const fn = arrow([param('s')], num(42));
    (fn as unknown as Record<string, unknown>)['async'] = true;
    (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const decl = letDecl('fetchNum', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const fetchNum: (s: string) => Promise<number>;');
    expect(result).not.toContain('async');
  });


  // ── Generic Constraints in DTS ─────────────────────────────

  it('should emit <T extends { name: string }> for constrained type param', () => {
    const constraintType: RecordType = {
      kind: 'record',
      fields: new Map([['name', { kind: 'primitive', name: 'string' } as Type]]),
    };
    const fnType: FT = {
      kind: 'function',
      typeParams: [{ name: 'T', constraint: constraintType }],
      params: [{ name: 'item', type: { kind: 'generic', name: 'T' } as Type, optional: false, hasDefault: false }],
      returnType: { kind: 'primitive', name: 'string' } as Type,
    };
    const fn = arrow([param('item')], id('x'));
    (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const decl = letDecl('getName', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('<T extends { readonly name: string }>');
  });

  it('should emit <T> for unconstrained type param (no extends)', () => {
    const fnType: FT = {
      kind: 'function',
      typeParams: [{ name: 'T' }],
      params: [{ name: 'x', type: { kind: 'generic', name: 'T' } as Type, optional: false, hasDefault: false }],
      returnType: { kind: 'generic', name: 'T' } as Type,
    };
    const fn = arrow([param('x')], id('x'));
    (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const decl = letDecl('identity', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('<T>(');
    expect(result).not.toContain('extends');
  });

  it('should emit <T, U extends Array<T>> for mixed constraint', () => {
    const fnType: FT = {
      kind: 'function',
      typeParams: [
        { name: 'T' },
        { name: 'U', constraint: { kind: 'array', element: { kind: 'generic', name: 'T' } as Type } as Type },
      ],
      params: [
        { name: 'x', type: { kind: 'generic', name: 'T' } as Type, optional: false, hasDefault: false },
        { name: 'y', type: { kind: 'generic', name: 'U' } as Type, optional: false, hasDefault: false },
      ],
      returnType: { kind: 'generic', name: 'T' } as Type,
    };
    const fn = arrow([param('x'), param('y')], id('x'));
    (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const decl = letDecl('zip', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('<T, U extends Array<T>>');
  });
});

// ── Literal Type DTS Emission ──────────────────────────────────────

describe('literal type DTS emission', () => {
  it('emits string literal type for const binding', () => {
    const litType: LiteralType = { kind: 'literal', base: 'string', value: 'hello' };
    const decl = letDecl('msg', str('hello'), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = litType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const msg: "hello";');
  });

  it('emits number literal type for const binding', () => {
    const litType: LiteralType = { kind: 'literal', base: 'number', value: 42 };
    const decl = letDecl('count', num(42), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = litType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const count: 42;');
  });

  it('emits boolean literal type for const binding', () => {
    const litType: LiteralType = { kind: 'literal', base: 'boolean', value: true };
    const init: Expression = { kind: 'BooleanLiteral', value: true, span } as Expression;
    const decl = letDecl('flag', init, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = litType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const flag: true;');
  });

  it('emits union of string literals for function param', () => {
    const unionType: UnionType = {
      kind: 'union',
      members: [
        { kind: 'literal', base: 'string', value: 'GET' } as LiteralType,
        { kind: 'literal', base: 'string', value: 'POST' } as LiteralType,
      ],
    };
    const fnType: FT = {
      kind: 'function',
      params: [{ name: 'method', type: unionType, optional: false, hasDefault: false }],
      returnType: { kind: 'primitive', name: 'string' },
    };
    const fn = arrow([param('method')], id('method'));
    (fn as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const decl = letDecl('f', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('"GET" | "POST"');
  });

  it('emits literal type alias', () => {
    const unionType: UnionType = {
      kind: 'union',
      members: [
        { kind: 'literal', base: 'string', value: 'GET' } as LiteralType,
        { kind: 'literal', base: 'string', value: 'POST' } as LiteralType,
      ],
    };
    const typeDecl: TypeDeclaration = {
      kind: 'TypeDeclaration',
      name: id('HttpMethod'),
      exported: true,
      variants: [],
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['typeAlias'] = {
      kind: 'UnionType',
      members: [],
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['resolvedType'] = unionType;
    const ast = program(typeDecl);
    const result = emitDTS(ast);
    expect(result).toContain('export type HttpMethod = "GET" | "POST";');
  });

  it('escapes special characters in string literal DTS', () => {
    const litType: LiteralType = { kind: 'literal', base: 'string', value: 'say "hi"' };
    const decl = letDecl('msg', str('say "hi"'), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = litType;
    const ast = program(decl);
    const result = emitDTS(ast);
    expect(result).toContain('export declare const msg: "say \\"hi\\"";');
  });

  // ── BigInt and Symbol DTS ──────────────────────────────────────

  it('bigint type emits bigint in .d.ts', () => {
    const bigintType: PrimitiveType = { kind: 'primitive', name: 'bigint' };
    const decl = letDecl('x', num(0), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = bigintType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const x: bigint;');
  });

  it('symbol type emits symbol in .d.ts', () => {
    const symbolType: PrimitiveType = { kind: 'primitive', name: 'symbol' };
    const decl = letDecl('s', num(0), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = symbolType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const s: symbol;');
  });

  it('bigint? emits bigint | null in .d.ts', () => {
    const nullableBigint: NullableType = { kind: 'nullable', inner: { kind: 'primitive', name: 'bigint' } };
    const decl = letDecl('x', num(0), { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = nullableBigint;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const x: bigint | null;');
  });

  it('function with bigint param emits correct .d.ts signature', () => {
    const fnType: FT = {
      kind: 'function',
      params: [{ name: 'x', type: { kind: 'primitive', name: 'bigint' }, optional: false, hasDefault: false }],
      returnType: { kind: 'primitive', name: 'symbol' },
    };
    const fn = arrow([param('x')], num(0));
    const decl = letDecl('convert', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const convert: (x: bigint) => symbol;');
  });

  it('function with rest param emits ...name: Type[] in .d.ts', () => {
    const fnType: FT = {
      kind: 'function',
      params: [{ name: 'msg', type: stringType, optional: false, hasDefault: false }],
      returnType: voidType,
      rest: { name: 'args', elementType: stringType },
    };
    const fn = arrow([param('msg')], num(0));
    const decl = letDecl('log', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const log: (msg: string, ...args: string[]) => void;');
  });

  it('rest-only function emits ...name: Type[] in .d.ts', () => {
    const fnType: FT = {
      kind: 'function',
      params: [],
      returnType: numberType,
      rest: { name: 'nums', elementType: numberType },
    };
    const fn = arrow([], num(0));
    const decl = letDecl('sum', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = fnType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const sum: (...nums: number[]) => number;');
  });

  // ── Interface Declaration DTS ────────────────────────────

  it('interface declaration emits export interface in .d.ts', () => {
    const strType: NamedType = { kind: 'NamedType', name: id('string'), span };
    const iface: InterfaceDeclaration = {
      kind: 'InterfaceDeclaration',
      name: id('Serializable'),
      methods: [{
        name: id('serialize'),
        params: [],
        returnType: strType,
        span,
      }],
      properties: [],
      exported: true,
      span,
    };
    const result = emitDTS(program(iface));
    expect(result).toContain('export interface Serializable {');
    expect(result).toContain('  serialize(): string;');
    expect(result).toContain('}');
  });

  it('generic interface emits with type parameters in .d.ts', () => {
    const tType: NamedType = { kind: 'NamedType', name: id('T'), span };
    const numType: NamedType = { kind: 'NamedType', name: id('number'), span };
    const boolType: NamedType = { kind: 'NamedType', name: id('boolean'), span };
    const typeParam: TypeParameter = { kind: 'TypeParameter', name: id('T'), span };
    const iface: InterfaceDeclaration = {
      kind: 'InterfaceDeclaration',
      name: id('Collection'),
      typeParams: [typeParam],
      methods: [
        { name: id('isEmpty'), params: [], returnType: boolType, span },
        {
          name: id('contains'),
          params: [{ kind: 'FunctionParam', name: id('item'), type: tType, mutable: false, span }],
          returnType: boolType,
          span,
        },
      ],
      properties: [{ name: id('size'), typeAnnotation: numType, mutable: false, span }],
      exported: true,
      span,
    };
    const result = emitDTS(program(iface));
    expect(result).toContain('export interface Collection<T> {');
    expect(result).toContain('  readonly size: number;');
    expect(result).toContain('  isEmpty(): boolean;');
    expect(result).toContain('  contains(item: T): boolean;');
    expect(result).toContain('}');
  });

  it('interface with extends emits extends clause in .d.ts', () => {
    const numType: NamedType = { kind: 'NamedType', name: id('number'), span };
    const parentType: NamedType = { kind: 'NamedType', name: id('Named'), span };
    const iface: InterfaceDeclaration = {
      kind: 'InterfaceDeclaration',
      name: id('NamedEntity'),
      extends: [parentType],
      methods: [],
      properties: [{ name: id('id'), typeAnnotation: numType, mutable: false, span }],
      exported: true,
      span,
    };
    const result = emitDTS(program(iface));
    expect(result).toContain('export interface NamedEntity extends Named {');
    expect(result).toContain('  readonly id: number;');
  });

  it('interface properties emit as readonly (let) or mutable (var) in .d.ts', () => {
    const strType: NamedType = { kind: 'NamedType', name: id('string'), span };
    const numType: NamedType = { kind: 'NamedType', name: id('number'), span };
    const iface: InterfaceDeclaration = {
      kind: 'InterfaceDeclaration',
      name: id('Config'),
      methods: [],
      properties: [
        { name: id('name'), typeAnnotation: strType, mutable: true, span },
        { name: id('version'), typeAnnotation: numType, mutable: false, span },
      ],
      exported: true,
      span,
    };
    const result = emitDTS(program(iface));
    expect(result).toContain('  name: string;');
    expect(result).toContain('  readonly version: number;');
    // Mutable property should NOT have readonly prefix
    expect(result).not.toContain('readonly name');
  });

  it('export interface via ExportDeclaration emits in .d.ts', () => {
    const strType: NamedType = { kind: 'NamedType', name: id('string'), span };
    const iface: InterfaceDeclaration = {
      kind: 'InterfaceDeclaration',
      name: id('Foo'),
      methods: [{ name: id('bar'), params: [], returnType: strType, span }],
      properties: [],
      exported: true,
      span,
    };
    const exportDecl: ExportDeclaration = {
      kind: 'ExportDeclaration',
      declaration: iface,
      exported: true,
      span,
    };
    const result = emitDTS(program(exportDecl));
    expect(result).toContain('export interface Foo {');
    expect(result).toContain('  bar(): string;');
  });

  it('typeToTsString handles InterfaceType (emits name, no typeof)', () => {
    const ifaceType: InterfaceType = {
      kind: 'interface',
      name: 'Command',
      methods: new Map(),
      properties: new Map(),
      typeArgs: [],
    };
    // Test via a let declaration with InterfaceType
    const fn = arrow([], num(0));
    const decl = letDecl('cmd', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = ifaceType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const cmd: Command;');
    // Should NOT contain 'typeof'
    expect(result).not.toContain('typeof');
  });

  it('typeToTsString handles generic InterfaceType with type args', () => {
    const innerType: InterfaceType = {
      kind: 'interface',
      name: 'Collection',
      methods: new Map(),
      properties: new Map(),
      typeArgs: [{ kind: 'primitive', name: 'number' }],
    };
    const fn = arrow([], num(0));
    const decl = letDecl('items', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = innerType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const items: Collection<number>;');
  });

  // ── Index Signatures (DTS) ────────────────────────────────

  it('37. DTS emitter: index signature type', () => {
    const idxType: import('../checker/types.js').IndexSignatureType = {
      kind: 'index-signature',
      keyType: 'string',
      valueType: { kind: 'primitive', name: 'string' },
      fields: new Map(),
    };
    const fn = arrow([], str(''));
    const decl = letDecl('config', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = idxType;
    const result = emitDTS(program(decl));
    expect(result).toContain('export declare const config: { [key: string]: string }');
  });

  it('38. DTS emitter: mixed named + index', () => {
    const idxType: import('../checker/types.js').IndexSignatureType = {
      kind: 'index-signature',
      keyType: 'string',
      valueType: { kind: 'any' },
      fields: new Map<string, Type>([
        ['status', { kind: 'primitive', name: 'number' }],
        ['message', { kind: 'primitive', name: 'string' }],
      ]),
    };
    const fn = arrow([], str(''));
    const decl = letDecl('response', fn, { exported: true });
    (decl as unknown as Record<string, unknown>)['resolvedType'] = idxType;
    const result = emitDTS(program(decl));
    expect(result).toContain('readonly status: number');
    expect(result).toContain('readonly message: string');
    expect(result).toContain('[key: string]: any');
  });

  it('39. DTS emitter: index signature in exported type alias', () => {
    const idxType: import('../checker/types.js').IndexSignatureType = {
      kind: 'index-signature',
      keyType: 'string',
      valueType: { kind: 'primitive', name: 'string' },
      fields: new Map(),
    };
    // DTS emitter only emits record/typeAlias type declarations via resolvedType
    const recordTypeNode: RecordTypeNode = {
      kind: 'RecordType',
      fields: [],
      span,
    };
    const typeDecl: TypeDeclaration = {
      kind: 'TypeDeclaration',
      name: id('Config'),
      variants: [],
      exported: true,
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['recordType'] = recordTypeNode;
    (typeDecl as unknown as Record<string, unknown>)['resolvedType'] = idxType;
    const result = emitDTS(program(typeDecl));
    expect(result).toContain('export type Config = { [key: string]: string }');
  });

  // ── Record Field Mutability DTS Tests ────────────────────────

  it('immutable fields emit readonly prefix', () => {
    const recType: RecordType = {
      kind: 'record',
      fields: new Map([['name', { kind: 'primitive', name: 'string' } as PrimitiveType]]),
    };
    const recordTypeNode: RecordTypeNode = {
      kind: 'RecordType',
      fields: [{ name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as NamedType, optional: false, mutable: false }],
      span,
    };
    const typeDecl: TypeDeclaration = {
      kind: 'TypeDeclaration',
      name: id('User'),
      variants: [],
      exported: true,
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['recordType'] = recordTypeNode;
    (typeDecl as unknown as Record<string, unknown>)['resolvedType'] = recType;
    const result = emitDTS(program(typeDecl));
    expect(result).toContain('readonly name: string');
  });

  it('mutable fields emit without readonly prefix', () => {
    const recType: RecordType = {
      kind: 'record',
      fields: new Map([['name', { kind: 'primitive', name: 'string' } as PrimitiveType]]),
      mutableFields: new Set(['name']),
    };
    const recordTypeNode: RecordTypeNode = {
      kind: 'RecordType',
      fields: [{ name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as NamedType, optional: false, mutable: true }],
      span,
    };
    const typeDecl: TypeDeclaration = {
      kind: 'TypeDeclaration',
      name: id('User'),
      variants: [],
      exported: true,
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['recordType'] = recordTypeNode;
    (typeDecl as unknown as Record<string, unknown>)['resolvedType'] = recType;
    const result = emitDTS(program(typeDecl));
    expect(result).not.toContain('readonly name');
    expect(result).toContain('name: string');
  });

  it('mixed mutability fields emit correct prefixes', () => {
    const recType: RecordType = {
      kind: 'record',
      fields: new Map<string, PrimitiveType>([
        ['name', { kind: 'primitive', name: 'string' }],
        ['score', { kind: 'primitive', name: 'number' }],
      ]),
      mutableFields: new Set(['score']),
    };
    const recordTypeNode: RecordTypeNode = {
      kind: 'RecordType',
      fields: [
        { name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as NamedType, optional: false, mutable: false },
        { name: id('score'), type: { kind: 'NamedType', name: id('number'), span } as NamedType, optional: false, mutable: true },
      ],
      span,
    };
    const typeDecl: TypeDeclaration = {
      kind: 'TypeDeclaration',
      name: id('User'),
      variants: [],
      exported: true,
      span,
    };
    (typeDecl as unknown as Record<string, unknown>)['recordType'] = recordTypeNode;
    (typeDecl as unknown as Record<string, unknown>)['resolvedType'] = recType;
    const result = emitDTS(program(typeDecl));
    expect(result).toContain('readonly name: string');
    expect(result).toContain('score: number');
    expect(result).not.toContain('readonly score');
  });
});
