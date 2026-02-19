import { describe, it, expect } from 'vitest';
import { emitDTS } from './dts-emitter.js';
import type {
  Program, LetDeclaration, TypeDeclaration, VariantDeclaration,
  ExportDeclaration, Identifier, NumberLiteral, StringLiteral,
  ArrowFunction, FunctionParam, ExpressionStatement,
  Expression, Declaration, Statement,
  RecordType as RecordTypeNode, RecordTypeField,
} from '../parser/ast.js';
import type { Span } from '../utils/span.js';
import type { Type, FunctionType as FT, ADTType, RecordType } from '../checker/types.js';

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
  return { kind: 'FunctionParam', name: id(name), span };
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
        { name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as unknown as RecordTypeField['type'], optional: false },
        { name: id('age'), type: { kind: 'NamedType', name: id('number'), span } as unknown as RecordTypeField['type'], optional: false },
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
});
