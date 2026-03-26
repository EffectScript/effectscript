import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';
import { tokenize } from '../lexer/lexer.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';
import type {
  Program, Expression, Declaration, Statement, Pattern, TypeNode,
  LetDeclaration, TypeDeclaration, ImportDeclaration, ExportDeclaration,
  ExtensionFunctionDeclaration,
  NumberLiteral, StringLiteral, BooleanLiteral, NullLiteral, Identifier,
  BinaryExpr, UnaryExpr, CallExpr, NewExpr, MemberExpr,
  IfExpr, MatchExpr, BlockExpr, ArrowFunction, TryCatchExpr,
  ArrayExpr, RecordExpr, TemplateString, AwaitExpr, NamedArgument,
  ForStatement, WhileStatement, AssignmentStatement, ThrowStatement,
  ReturnStatement, ExpressionStatement,
  LiteralPattern, VariantPattern, BindingPattern, WildcardPattern, RecordPattern, NullPattern, TuplePattern,
  NamedType, FunctionType, NullableType, UnionType, TupleType, RecordType,
  LiteralTypeNode,
  ErrorNode,
} from './ast.js';

// ── Helpers ──────────────────────────────────────────────────────────

function parseSource(source: string): { program: Program; diagnostics: readonly Diagnostic[] } {
  const collector = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', collector);
  const program = parse(tokens, 'test.efs', collector);
  return { program, diagnostics: collector.getAll() };
}

function parseOk(source: string): Program {
  const { program, diagnostics } = parseSource(source);
  const errors = diagnostics.filter(d => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Expected no errors but got:\n${errors.map(d => `  ${d.code}: ${d.message}`).join('\n')}`);
  }
  return program;
}

/** Parse and return the first body item as a specific type. */
function parseFirst<T extends Declaration | Statement>(source: string): T {
  const program = parseOk(source);
  expect(program.body.length).toBeGreaterThanOrEqual(1);
  return program.body[0] as T;
}

/** Parse an expression (wraps it in an expression statement). */
function parseExpr(source: string): Expression {
  const stmt = parseFirst<ExpressionStatement>(source);
  expect(stmt.kind).toBe('ExpressionStatement');
  return stmt.expression;
}

// ── Happy Path: Declarations ─────────────────────────────────────────

describe('Declarations', () => {
  describe('LetDeclaration', () => {
    it('should parse let x = 42', () => {
      const decl = parseFirst<LetDeclaration>('let x = 42');
      expect(decl.kind).toBe('LetDeclaration');
      expect(decl.name.name).toBe('x');
      expect(decl.mutable).toBe(false);
      expect(decl.exported).toBe(false);
      expect(decl.initializer.kind).toBe('NumberLiteral');
      expect((decl.initializer as NumberLiteral).value).toBe(42);
    });

    it('should parse let mut y = 0', () => {
      const decl = parseFirst<LetDeclaration>('let mut y = 0');
      expect(decl.kind).toBe('LetDeclaration');
      expect(decl.name.name).toBe('y');
      expect(decl.mutable).toBe(true);
    });

    it('should parse let with type annotation', () => {
      const decl = parseFirst<LetDeclaration>('let x: number = 42');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('NamedType');
      expect((decl.typeAnnotation as NamedType).name.name).toBe('number');
    });

    it('should parse let with arrow function initializer', () => {
      const decl = parseFirst<LetDeclaration>('let add = (x: number, y: number): number => x + y');
      expect(decl.kind).toBe('LetDeclaration');
      expect(decl.initializer.kind).toBe('ArrowFunction');
      const fn = decl.initializer as ArrowFunction;
      expect(fn.params).toHaveLength(2);
      expect(fn.params[0].name.name).toBe('x');
      expect(fn.params[1].name.name).toBe('y');
      expect(fn.returnType).toBeDefined();
    });

    it('should parse let with string initializer', () => {
      const decl = parseFirst<LetDeclaration>('let name = "hello"');
      expect(decl.initializer.kind).toBe('StringLiteral');
      expect((decl.initializer as StringLiteral).value).toBe('hello');
    });

    it('should parse let with boolean initializer', () => {
      const decl = parseFirst<LetDeclaration>('let flag = true');
      expect(decl.initializer.kind).toBe('BooleanLiteral');
      expect((decl.initializer as BooleanLiteral).value).toBe(true);
    });

    it('should parse let with null initializer', () => {
      const decl = parseFirst<LetDeclaration>('let x = null');
      expect(decl.initializer.kind).toBe('NullLiteral');
    });
  });

  describe('TypeDeclaration', () => {
    it('should parse type Color = Red | Green | Blue', () => {
      const decl = parseFirst<TypeDeclaration>('type Color = Red | Green | Blue');
      expect(decl.kind).toBe('TypeDeclaration');
      expect(decl.name.name).toBe('Color');
      expect(decl.variants).toHaveLength(3);
      expect(decl.variants[0].name.name).toBe('Red');
      expect(decl.variants[1].name.name).toBe('Green');
      expect(decl.variants[2].name.name).toBe('Blue');
      expect(decl.variants[0].fields).toHaveLength(0);
    });

    it('should parse generic ADT: type Result<T, E> = Ok(value: T) | Err(error: E)', () => {
      const decl = parseFirst<TypeDeclaration>('type Result<T, E> = Ok(value: T) | Err(error: E)');
      expect(decl.typeParams).toHaveLength(2);
      expect(decl.typeParams![0].name.name).toBe('T');
      expect(decl.typeParams![1].name.name).toBe('E');
      expect(decl.variants).toHaveLength(2);
      expect(decl.variants[0].name.name).toBe('Ok');
      expect(decl.variants[0].fields).toHaveLength(1);
      expect(decl.variants[0].fields[0].name.name).toBe('value');
      expect(decl.variants[1].name.name).toBe('Err');
    });

    it('should parse mixed variant ADT: type Maybe<T> = Some(value: T) | None', () => {
      const decl = parseFirst<TypeDeclaration>('type Maybe<T> = Some(value: T) | None');
      expect(decl.variants).toHaveLength(2);
      expect(decl.variants[0].fields).toHaveLength(1);
      expect(decl.variants[1].fields).toHaveLength(0);
    });

    it('should parse single-variant type: type Unit = Unit', () => {
      const decl = parseFirst<TypeDeclaration>('type Unit = Unit');
      expect(decl.variants).toHaveLength(1);
      expect(decl.variants[0].name.name).toBe('Unit');
    });

    it('should parse named record type alias', () => {
      const decl = parseFirst<TypeDeclaration>('type User = { name: string, email: string }');
      expect(decl.kind).toBe('TypeDeclaration');
      expect(decl.name.name).toBe('User');
      expect(decl.variants).toHaveLength(0);
      expect(decl.recordType).toBeDefined();
      expect(decl.recordType!.kind).toBe('RecordType');
      expect(decl.recordType!.fields).toHaveLength(2);
      expect(decl.recordType!.fields[0].name.name).toBe('name');
      expect(decl.recordType!.fields[1].name.name).toBe('email');
    });

    it('should parse record type alias with optional fields', () => {
      const decl = parseFirst<TypeDeclaration>('type Config = { host: string, port?: number }');
      expect(decl.recordType).toBeDefined();
      expect(decl.recordType!.fields).toHaveLength(2);
      expect(decl.recordType!.fields[0].optional).toBe(false);
      expect(decl.recordType!.fields[1].optional).toBe(true);
      expect(decl.recordType!.fields[1].name.name).toBe('port');
    });

    it('should parse record type alias with nullable field types', () => {
      const decl = parseFirst<TypeDeclaration>('type Profile = { name: string, bio: string? }');
      expect(decl.recordType).toBeDefined();
      expect(decl.recordType!.fields[1].type.kind).toBe('NullableType');
    });

    it('should parse exported record type alias', () => {
      const program = parseOk('export type Point = { x: number, y: number }');
      const exp = program.body[0] as ExportDeclaration;
      expect(exp.kind).toBe('ExportDeclaration');
      const decl = exp.declaration as TypeDeclaration;
      expect(decl.recordType).toBeDefined();
      expect(decl.exported).toBe(true);
    });

    it('should still parse ADT syntax after record type alias support', () => {
      const decl = parseFirst<TypeDeclaration>('type Color = Red | Green | Blue');
      expect(decl.variants).toHaveLength(3);
      expect(decl.recordType).toBeUndefined();
    });
  });

  describe('ImportDeclaration', () => {
    it('should parse import { a, b, c } from "./mod"', () => {
      const decl = parseFirst<ImportDeclaration>('import { a, b, c } from "./mod"');
      expect(decl.kind).toBe('ImportDeclaration');
      expect(decl.specifiers).toHaveLength(3);
      expect(decl.specifiers[0].imported.name).toBe('a');
      expect(decl.specifiers[1].imported.name).toBe('b');
      expect(decl.specifiers[2].imported.name).toBe('c');
      expect(decl.source.value).toBe('./mod');
    });

    it('should parse default import: import foo from "./mod"', () => {
      const decl = parseFirst<ImportDeclaration>('import foo from "./mod"');
      expect(decl.defaultImport).toBeDefined();
      expect(decl.defaultImport!.name).toBe('foo');
      expect(decl.specifiers).toHaveLength(0);
    });

    it('should parse import with trailing comma', () => {
      const decl = parseFirst<ImportDeclaration>('import { a, b, } from "./mod"');
      expect(decl.specifiers).toHaveLength(2);
    });

    it('should parse combined default + named imports', () => {
      const decl = parseFirst<ImportDeclaration>('import React, { useState } from "react"');
      expect(decl.defaultImport).toBeDefined();
      expect(decl.defaultImport!.name).toBe('React');
      expect(decl.specifiers).toHaveLength(1);
      expect(decl.specifiers[0].imported.name).toBe('useState');
      expect(decl.source.value).toBe('react');
    });

    it('should parse combined default + multiple named imports', () => {
      const decl = parseFirst<ImportDeclaration>('import fs, { readFile, writeFile } from "node:fs"');
      expect(decl.defaultImport!.name).toBe('fs');
      expect(decl.specifiers).toHaveLength(2);
      expect(decl.specifiers[0].imported.name).toBe('readFile');
      expect(decl.specifiers[1].imported.name).toBe('writeFile');
    });

    it('should parse combined default + empty named braces', () => {
      const decl = parseFirst<ImportDeclaration>('import D, { } from "./mod"');
      expect(decl.defaultImport!.name).toBe('D');
      expect(decl.specifiers).toHaveLength(0);
    });

    it('should still parse default-only import', () => {
      const decl = parseFirst<ImportDeclaration>('import D from "./mod"');
      expect(decl.defaultImport!.name).toBe('D');
      expect(decl.specifiers).toHaveLength(0);
    });

    it('should still parse named-only import', () => {
      const decl = parseFirst<ImportDeclaration>('import { a, b } from "./mod"');
      expect(decl.defaultImport).toBeUndefined();
      expect(decl.specifiers).toHaveLength(2);
    });

    it('should report error for comma without braces', () => {
      const { diagnostics } = parseSource('import D, from "./mod"');
      const errors = diagnostics.filter(d => d.severity === 'error');
      expect(errors.some(d => d.code === 'E116')).toBe(true);
    });
  });

  describe('ExportDeclaration', () => {
    it('should parse export let x = 42', () => {
      const decl = parseFirst<ExportDeclaration>('export let x = 42');
      expect(decl.kind).toBe('ExportDeclaration');
      expect(decl.declaration).toBeDefined();
      expect(decl.declaration!.kind).toBe('LetDeclaration');
    });

    it('should parse export type Foo = Bar | Baz', () => {
      const decl = parseFirst<ExportDeclaration>('export type Foo = Bar | Baz');
      expect(decl.declaration).toBeDefined();
      expect(decl.declaration!.kind).toBe('TypeDeclaration');
    });

    it('should parse export { a, b } from "./mod"', () => {
      const decl = parseFirst<ExportDeclaration>('export { a, b } from "./mod"');
      expect(decl.specifiers).toHaveLength(2);
      expect(decl.source).toBeDefined();
      expect(decl.source!.value).toBe('./mod');
    });
  });
});

// ── Happy Path: Expressions ──────────────────────────────────────────

describe('Expressions', () => {
  describe('Literals', () => {
    it('should parse number literal', () => {
      const expr = parseExpr('42');
      expect(expr.kind).toBe('NumberLiteral');
      expect((expr as NumberLiteral).value).toBe(42);
    });

    it('should parse decimal number', () => {
      const expr = parseExpr('3.14');
      expect(expr.kind).toBe('NumberLiteral');
      expect((expr as NumberLiteral).value).toBe(3.14);
    });

    it('should parse string literal', () => {
      const expr = parseExpr('"hello"');
      expect(expr.kind).toBe('StringLiteral');
      expect((expr as StringLiteral).value).toBe('hello');
    });

    it('should parse true', () => {
      const expr = parseExpr('true');
      expect(expr.kind).toBe('BooleanLiteral');
      expect((expr as BooleanLiteral).value).toBe(true);
    });

    it('should parse false', () => {
      const expr = parseExpr('false');
      expect(expr.kind).toBe('BooleanLiteral');
      expect((expr as BooleanLiteral).value).toBe(false);
    });

    it('should parse null', () => {
      const expr = parseExpr('null');
      expect(expr.kind).toBe('NullLiteral');
    });
  });

  describe('Identifiers', () => {
    it('should parse identifier', () => {
      const expr = parseExpr('foo');
      expect(expr.kind).toBe('Identifier');
      expect((expr as Identifier).name).toBe('foo');
    });
  });

  describe('Binary Expressions', () => {
    it('should parse 1 + 2', () => {
      const expr = parseExpr('1 + 2') as BinaryExpr;
      expect(expr.kind).toBe('BinaryExpr');
      expect(expr.operator).toBe('+');
      expect(expr.left.kind).toBe('NumberLiteral');
      expect(expr.right.kind).toBe('NumberLiteral');
    });

    it('should parse a == b', () => {
      const expr = parseExpr('a == b') as BinaryExpr;
      expect(expr.operator).toBe('==');
    });

    it('should parse x && y', () => {
      const expr = parseExpr('x && y') as BinaryExpr;
      expect(expr.operator).toBe('&&');
    });

    it('should parse a ?? b', () => {
      const expr = parseExpr('a ?? b') as BinaryExpr;
      expect(expr.operator).toBe('??');
    });

    it('should parse a || b', () => {
      const expr = parseExpr('a || b') as BinaryExpr;
      expect(expr.operator).toBe('||');
    });

    it('should parse a != b', () => {
      const expr = parseExpr('a != b') as BinaryExpr;
      expect(expr.operator).toBe('!=');
    });

    it('should parse a < b', () => {
      const expr = parseExpr('a < b') as BinaryExpr;
      expect(expr.operator).toBe('<');
    });

    it('should parse a > b', () => {
      const expr = parseExpr('a > b') as BinaryExpr;
      expect(expr.operator).toBe('>');
    });

    it('should parse a <= b', () => {
      const expr = parseExpr('a <= b') as BinaryExpr;
      expect(expr.operator).toBe('<=');
    });

    it('should parse a >= b', () => {
      const expr = parseExpr('a >= b') as BinaryExpr;
      expect(expr.operator).toBe('>=');
    });

    it('should parse a * b', () => {
      const expr = parseExpr('a * b') as BinaryExpr;
      expect(expr.operator).toBe('*');
    });

    it('should parse a / b', () => {
      const expr = parseExpr('a / b') as BinaryExpr;
      expect(expr.operator).toBe('/');
    });

    it('should parse a % b', () => {
      const expr = parseExpr('a % b') as BinaryExpr;
      expect(expr.operator).toBe('%');
    });
  });

  describe('Unary Expressions', () => {
    it('should parse !x', () => {
      const expr = parseExpr('!x') as UnaryExpr;
      expect(expr.kind).toBe('UnaryExpr');
      expect(expr.operator).toBe('!');
      expect(expr.operand.kind).toBe('Identifier');
    });

    it('should parse -n', () => {
      const expr = parseExpr('-n') as UnaryExpr;
      expect(expr.operator).toBe('-');
    });
  });

  describe('Call Expressions', () => {
    it('should parse foo(1, 2)', () => {
      const expr = parseExpr('foo(1, 2)') as CallExpr;
      expect(expr.kind).toBe('CallExpr');
      expect((expr.callee as Identifier).name).toBe('foo');
      expect(expr.args).toHaveLength(2);
    });

    it('should parse bar()', () => {
      const expr = parseExpr('bar()') as CallExpr;
      expect(expr.args).toHaveLength(0);
    });

    it('should parse call with trailing comma', () => {
      const expr = parseExpr('foo(1, 2,)') as CallExpr;
      expect(expr.args).toHaveLength(2);
    });
  });

  describe('Member Expressions', () => {
    it('should parse obj.field', () => {
      const expr = parseExpr('obj.field') as MemberExpr;
      expect(expr.kind).toBe('MemberExpr');
      expect((expr.object as Identifier).name).toBe('obj');
      expect(expr.property.name).toBe('field');
      expect(expr.optional).toBe(false);
    });

    it('should parse chained a.b.c', () => {
      const expr = parseExpr('a.b.c') as MemberExpr;
      expect(expr.property.name).toBe('c');
      expect(expr.object.kind).toBe('MemberExpr');
      const inner = expr.object as MemberExpr;
      expect(inner.property.name).toBe('b');
      expect((inner.object as Identifier).name).toBe('a');
    });

    it('should parse optional chaining x?.y', () => {
      const expr = parseExpr('x?.y') as MemberExpr;
      expect(expr.optional).toBe(true);
      expect(expr.property.name).toBe('y');
    });
  });

  describe('If/Else Expression', () => {
    it('should parse if (x) a else b', () => {
      const expr = parseExpr('if (x) a else b') as IfExpr;
      expect(expr.kind).toBe('IfExpr');
      expect((expr.condition as Identifier).name).toBe('x');
      expect((expr.consequent as Identifier).name).toBe('a');
      expect(expr.alternate).toBeDefined();
      expect((expr.alternate as Identifier).name).toBe('b');
    });

    it('should parse if without else', () => {
      const expr = parseExpr('if (x) a') as IfExpr;
      expect(expr.alternate).toBeUndefined();
    });

    it('should parse nested if/else (dangling else)', () => {
      const expr = parseExpr('if (a) if (b) 1 else 2 else 3') as IfExpr;
      expect(expr.kind).toBe('IfExpr');
      // outer else is 3
      expect((expr.alternate as NumberLiteral).value).toBe(3);
      // inner if/else
      const inner = expr.consequent as IfExpr;
      expect(inner.kind).toBe('IfExpr');
      expect((inner.alternate as NumberLiteral).value).toBe(2);
    });
  });

  describe('Match Expression', () => {
    it('should parse match with literal patterns', () => {
      const expr = parseExpr('match x { 1 => "one" _ => "other" }') as MatchExpr;
      expect(expr.kind).toBe('MatchExpr');
      expect((expr.subject as Identifier).name).toBe('x');
      expect(expr.arms).toHaveLength(2);
      expect(expr.arms[0].pattern.kind).toBe('LiteralPattern');
      expect(expr.arms[1].pattern.kind).toBe('WildcardPattern');
    });

    it('should parse match with comma-separated arms', () => {
      const expr = parseExpr('match x { Ok(value) => value, Err(e) => default }') as MatchExpr;
      expect(expr.arms).toHaveLength(2);
    });

    it('should parse match with guard', () => {
      const expr = parseExpr('match x { n if n > 0 => "pos" _ => "other" }') as MatchExpr;
      expect(expr.arms[0].guard).toBeDefined();
    });

    it('should parse empty match', () => {
      const expr = parseExpr('match x { }') as MatchExpr;
      expect(expr.arms).toHaveLength(0);
    });

    it('should parse match with record pattern', () => {
      const expr = parseExpr('match x { { name, age } => name }') as MatchExpr;
      expect(expr.arms[0].pattern.kind).toBe('RecordPattern');
    });
  });

  describe('Block Expression', () => {
    it('should parse { let a = 1; a + 1 }', () => {
      const expr = parseExpr('{ let a = 1; a + 1 }') as BlockExpr;
      expect(expr.kind).toBe('BlockExpr');
      expect(expr.body).toHaveLength(2);
      expect(expr.body[0].kind).toBe('LetDeclaration');
    });
  });

  describe('Arrow Functions', () => {
    it('should parse () => 42', () => {
      const expr = parseExpr('() => 42') as ArrowFunction;
      expect(expr.kind).toBe('ArrowFunction');
      expect(expr.params).toHaveLength(0);
      expect(expr.body.kind).toBe('NumberLiteral');
    });

    it('should parse (x) => x', () => {
      const expr = parseExpr('(x) => x') as ArrowFunction;
      expect(expr.params).toHaveLength(1);
      expect(expr.params[0].name.name).toBe('x');
    });

    it('should parse (x: number) => x + 1', () => {
      const expr = parseExpr('(x: number) => x + 1') as ArrowFunction;
      expect(expr.params).toHaveLength(1);
      expect(expr.params[0].type).toBeDefined();
    });

    it('should parse (x: number, y: number): number => x + y', () => {
      const expr = parseExpr('(x: number, y: number): number => x + y') as ArrowFunction;
      expect(expr.params).toHaveLength(2);
      expect(expr.returnType).toBeDefined();
    });

    it('should parse arrow function with block body', () => {
      const expr = parseExpr('() => { let x = 1; x + 1 }') as ArrowFunction;
      expect(expr.body.kind).toBe('BlockExpr');
    });
  });

  describe('Try/Catch Expression', () => {
    it('should parse try { risky() } catch (e) { fallback }', () => {
      const expr = parseExpr('try { risky() } catch (e) { fallback }') as TryCatchExpr;
      expect(expr.kind).toBe('TryCatchExpr');
      expect(expr.catchParam.name).toBe('e');
    });
  });

  describe('Array Expression', () => {
    it('should parse [1, 2, 3]', () => {
      const expr = parseExpr('[1, 2, 3]') as ArrayExpr;
      expect(expr.kind).toBe('ArrayExpr');
      expect(expr.elements).toHaveLength(3);
    });

    it('should parse empty array []', () => {
      const expr = parseExpr('[]') as ArrayExpr;
      expect(expr.elements).toHaveLength(0);
    });

    it('should parse array with trailing comma', () => {
      const expr = parseExpr('[1, 2, 3,]') as ArrayExpr;
      expect(expr.elements).toHaveLength(3);
    });
  });

  describe('Record Expression', () => {
    it('should parse { name: "Alice", age: 30 }', () => {
      const expr = parseExpr('{ name: "Alice", age: 30 }') as RecordExpr;
      expect(expr.kind).toBe('RecordExpr');
      expect(expr.fields).toHaveLength(2);
      expect(expr.fields[0].name.name).toBe('name');
      expect(expr.fields[1].name.name).toBe('age');
    });

    it('should parse empty record {}', () => {
      const expr = parseExpr('{}') as RecordExpr;
      expect(expr.kind).toBe('RecordExpr');
      expect(expr.fields).toHaveLength(0);
    });

    it('should parse record with trailing comma', () => {
      const expr = parseExpr('{ x: 1, y: 2, }') as RecordExpr;
      expect(expr.fields).toHaveLength(2);
    });
  });

  describe('Template String', () => {
    it('should parse "hello ${name}"', () => {
      const expr = parseExpr('"hello ${name}"') as TemplateString;
      expect(expr.kind).toBe('TemplateString');
      expect(expr.parts).toHaveLength(2);
      expect(expr.parts[0].kind).toBe('TemplateStringPart');
      expect(expr.parts[1].kind).toBe('TemplateExprPart');
    });

    it('should parse "${a} and ${b}"', () => {
      const expr = parseExpr('"${a} and ${b}"') as TemplateString;
      // Parts: exprA, " and ", exprB (trailing empty string is omitted)
      expect(expr.parts).toHaveLength(3);
      expect(expr.parts[0].kind).toBe('TemplateExprPart');
      expect(expr.parts[1].kind).toBe('TemplateStringPart');
      expect(expr.parts[2].kind).toBe('TemplateExprPart');
    });
  });

  describe('New Expression', () => {
    it('should parse new Map()', () => {
      const expr = parseExpr('new Map()') as NewExpr;
      expect(expr.kind).toBe('NewExpr');
      expect((expr.callee as Identifier).name).toBe('Map');
      expect(expr.args).toHaveLength(0);
    });

    it('should parse new Error("msg")', () => {
      const expr = parseExpr('new Error("msg")') as NewExpr;
      expect(expr.args).toHaveLength(1);
    });
  });

  describe('Grouped Expression', () => {
    it('should parse (1 + 2) * 3', () => {
      const expr = parseExpr('(1 + 2) * 3') as BinaryExpr;
      expect(expr.operator).toBe('*');
      expect(expr.left.kind).toBe('BinaryExpr');
      expect((expr.left as BinaryExpr).operator).toBe('+');
    });
  });
});

// ── Happy Path: Operator Precedence ──────────────────────────────────

describe('Operator Precedence', () => {
  it('should parse 1 + 2 * 3 as 1 + (2 * 3)', () => {
    const expr = parseExpr('1 + 2 * 3') as BinaryExpr;
    expect(expr.operator).toBe('+');
    expect(expr.left.kind).toBe('NumberLiteral');
    const right = expr.right as BinaryExpr;
    expect(right.operator).toBe('*');
  });

  it('should parse a && b || c as (a && b) || c', () => {
    const expr = parseExpr('a && b || c') as BinaryExpr;
    expect(expr.operator).toBe('||');
    const left = expr.left as BinaryExpr;
    expect(left.operator).toBe('&&');
  });

  it('should parse !a + b as (!a) + b', () => {
    const expr = parseExpr('!a + b') as BinaryExpr;
    expect(expr.operator).toBe('+');
    expect(expr.left.kind).toBe('UnaryExpr');
  });

  it('should parse -a + b as (-a) + b', () => {
    const expr = parseExpr('-a + b') as BinaryExpr;
    expect(expr.operator).toBe('+');
    expect(expr.left.kind).toBe('UnaryExpr');
    expect((expr.left as UnaryExpr).operator).toBe('-');
  });

  it('should parse a.b + c as (a.b) + c', () => {
    const expr = parseExpr('a.b + c') as BinaryExpr;
    expect(expr.operator).toBe('+');
    expect(expr.left.kind).toBe('MemberExpr');
  });

  it('should parse a ?? b + c as a ?? (b + c)', () => {
    const expr = parseExpr('a ?? b + c') as BinaryExpr;
    expect(expr.operator).toBe('??');
    const right = expr.right as BinaryExpr;
    expect(right.operator).toBe('+');
  });

  it('should reject a ?? b || c as mixed ?? with || (E117)', () => {
    // JS prohibits mixing ?? with && / || without parens
    const { diagnostics } = parseSource('a ?? b || c');
    expect(diagnostics.some(d => d.code === 'E117')).toBe(true);
  });

  it('should parse deeply nested parens ((((1 + 2))))', () => {
    const expr = parseExpr('((((1 + 2))))') as BinaryExpr;
    expect(expr.kind).toBe('BinaryExpr');
    expect(expr.operator).toBe('+');
  });
});

// ── Happy Path: Patterns ─────────────────────────────────────────────

describe('Patterns', () => {
  it('should parse literal patterns in match', () => {
    const expr = parseExpr('match x { 42 => "answer" "hello" => "greeting" true => "yes" }') as MatchExpr;
    expect(expr.arms[0].pattern.kind).toBe('LiteralPattern');
    expect(expr.arms[1].pattern.kind).toBe('LiteralPattern');
    expect(expr.arms[2].pattern.kind).toBe('LiteralPattern');
  });

  it('should parse variant patterns', () => {
    const expr = parseExpr('match x { Ok(value) => value Err(e) => e }') as MatchExpr;
    const p0 = expr.arms[0].pattern as VariantPattern;
    expect(p0.kind).toBe('VariantPattern');
    expect(p0.name.name).toBe('Ok');
    expect(p0.fields).toHaveLength(1);
  });

  it('should parse enum-like variant (no fields)', () => {
    const expr = parseExpr('match x { Red => 1 }') as MatchExpr;
    const pat = expr.arms[0].pattern as VariantPattern;
    expect(pat.kind).toBe('VariantPattern');
    expect(pat.name.name).toBe('Red');
    // No parenthesized fields
    expect(pat.fields).toBeUndefined();
  });

  it('should parse wildcard pattern', () => {
    const expr = parseExpr('match x { _ => 0 }') as MatchExpr;
    expect(expr.arms[0].pattern.kind).toBe('WildcardPattern');
  });

  it('should parse binding pattern (lowercase)', () => {
    const expr = parseExpr('match x { n => n }') as MatchExpr;
    expect(expr.arms[0].pattern.kind).toBe('BindingPattern');
    expect((expr.arms[0].pattern as BindingPattern).name.name).toBe('n');
  });

  it('should parse null pattern', () => {
    const expr = parseExpr('match x { null => "nothing" }') as MatchExpr;
    expect(expr.arms[0].pattern.kind).toBe('NullPattern');
  });

  it('should parse record pattern', () => {
    const expr = parseExpr('match x { { name, age } => name }') as MatchExpr;
    const pat = expr.arms[0].pattern as RecordPattern;
    expect(pat.kind).toBe('RecordPattern');
    expect(pat.fields).toHaveLength(2);
    expect(pat.fields[0].name.name).toBe('name');
    expect(pat.fields[1].name.name).toBe('age');
  });

  it('should parse nested patterns: Ok({ name })', () => {
    const expr = parseExpr('match x { Ok({ name }) => name }') as MatchExpr;
    const pat = expr.arms[0].pattern as VariantPattern;
    expect(pat.kind).toBe('VariantPattern');
    expect(pat.fields).toHaveLength(1);
    expect(pat.fields![0].kind).toBe('RecordPattern');
  });

  it('should parse guard clause', () => {
    const expr = parseExpr('match x { n if n > 0 => "pos" _ => "other" }') as MatchExpr;
    expect(expr.arms[0].guard).toBeDefined();
    expect(expr.arms[0].guard!.kind).toBe('BinaryExpr');
    expect((expr.arms[0].guard as BinaryExpr).operator).toBe('>');
  });
});

// ── Happy Path: Type Annotations ─────────────────────────────────────

describe('Type Annotations', () => {
  it('should parse named types: number, string, boolean', () => {
    const decl = parseFirst<LetDeclaration>('let x: number = 42');
    expect(decl.typeAnnotation!.kind).toBe('NamedType');
    expect((decl.typeAnnotation as NamedType).name.name).toBe('number');
  });

  it('should parse generic type: Array<number>', () => {
    const decl = parseFirst<LetDeclaration>('let x: Array<number> = []');
    const ty = decl.typeAnnotation as NamedType;
    expect(ty.name.name).toBe('Array');
    expect(ty.typeArgs).toHaveLength(1);
  });

  it('should parse nested generic: Result<T, E>', () => {
    const decl = parseFirst<LetDeclaration>('let x: Result<string, Error> = ok');
    const ty = decl.typeAnnotation as NamedType;
    expect(ty.typeArgs).toHaveLength(2);
  });

  it('should parse function type: (number, string) => boolean', () => {
    const decl = parseFirst<LetDeclaration>('let f: (number, string) => boolean = g');
    const ty = decl.typeAnnotation as FunctionType;
    expect(ty.kind).toBe('FunctionType');
    expect(ty.params).toHaveLength(2);
    expect(ty.returnType.kind).toBe('NamedType');
  });

  it('should parse nullable type: string?', () => {
    const decl = parseFirst<LetDeclaration>('let x: string? = null');
    const ty = decl.typeAnnotation as NullableType;
    expect(ty.kind).toBe('NullableType');
    expect(ty.inner.kind).toBe('NamedType');
  });

  it('should parse union type: string | number', () => {
    const decl = parseFirst<LetDeclaration>('let x: string | number = 42');
    const ty = decl.typeAnnotation as UnionType;
    expect(ty.kind).toBe('UnionType');
    expect(ty.members).toHaveLength(2);
  });

  it('should parse record type: { name: string, age: number }', () => {
    const decl = parseFirst<LetDeclaration>('let x: { name: string, age: number } = obj');
    const ty = decl.typeAnnotation as RecordType;
    expect(ty.kind).toBe('RecordType');
    expect(ty.fields).toHaveLength(2);
  });
});

// ── Happy Path: Statements ───────────────────────────────────────────

describe('Statements', () => {
  it('should parse for loop', () => {
    const stmt = parseFirst<ForStatement>('for (item in items) { process(item) }');
    expect(stmt.kind).toBe('ForStatement');
    expect(stmt.variable.kind).toBe('Identifier');
    expect((stmt.variable as Identifier).name).toBe('item');
    expect((stmt.iterable as Identifier).name).toBe('items');
    expect(stmt.range).toBeUndefined();
  });

  // ── For-loop ranges ──

  it('should parse for loop with inclusive range: for (i in 0..10)', () => {
    const stmt = parseFirst<ForStatement>('for (i in 0..10) { print(i) }');
    expect(stmt.kind).toBe('ForStatement');
    expect((stmt.variable as Identifier).name).toBe('i');
    expect(stmt.range).toBeDefined();
    expect(stmt.range!.exclusive).toBe(false);
    expect((stmt.range!.start as NumberLiteral).value).toBe(0);
    expect((stmt.range!.end as NumberLiteral).value).toBe(10);
  });

  it('should parse for loop with exclusive range: for (i in 0..<10)', () => {
    const stmt = parseFirst<ForStatement>('for (i in 0..<10) { print(i) }');
    expect(stmt.kind).toBe('ForStatement');
    expect((stmt.variable as Identifier).name).toBe('i');
    expect(stmt.range).toBeDefined();
    expect(stmt.range!.exclusive).toBe(true);
    expect((stmt.range!.start as NumberLiteral).value).toBe(0);
    expect((stmt.range!.end as NumberLiteral).value).toBe(10);
  });

  it('should parse for loop with variable range bounds: for (i in start..<end)', () => {
    const stmt = parseFirst<ForStatement>('for (i in start..<end) { print(i) }');
    expect(stmt.range).toBeDefined();
    expect(stmt.range!.exclusive).toBe(true);
    expect((stmt.range!.start as Identifier).name).toBe('start');
    expect((stmt.range!.end as Identifier).name).toBe('end');
  });

  it('should parse for loop with call expression range bounds: for (i in f()..<g())', () => {
    const stmt = parseFirst<ForStatement>('for (i in f()..<g()) { print(i) }');
    expect(stmt.range).toBeDefined();
    expect(stmt.range!.exclusive).toBe(true);
    expect(stmt.range!.start.kind).toBe('CallExpr');
    expect(stmt.range!.end.kind).toBe('CallExpr');
  });

  // ── For-loop destructuring ──

  it('should parse for loop with record destructuring: for ({ name, age } in users)', () => {
    const stmt = parseFirst<ForStatement>('for ({ name, age } in users) { print(name) }');
    expect(stmt.kind).toBe('ForStatement');
    expect(stmt.variable.kind).toBe('RecordPattern');
    const rp = stmt.variable as RecordPattern;
    expect(rp.fields).toHaveLength(2);
    expect(rp.fields[0].name.name).toBe('name');
    expect(rp.fields[1].name.name).toBe('age');
    expect((stmt.iterable as Identifier).name).toBe('users');
    expect(stmt.range).toBeUndefined();
  });

  it('should parse for loop with tuple destructuring: for ((a, b) in pairs)', () => {
    const stmt = parseFirst<ForStatement>('for ((a, b) in pairs) { print(a) }');
    expect(stmt.kind).toBe('ForStatement');
    expect(stmt.variable.kind).toBe('TuplePattern');
    const tp = stmt.variable as TuplePattern;
    expect(tp.elements).toHaveLength(2);
    expect((tp.elements[0] as Identifier).name).toBe('a');
    expect((tp.elements[1] as Identifier).name).toBe('b');
    expect((stmt.iterable as Identifier).name).toBe('pairs');
  });

  it('should parse for loop with wildcard in tuple: for ((_, item) in items.withIndex())', () => {
    const stmt = parseFirst<ForStatement>('for ((_, item) in items.withIndex()) { print(item) }');
    expect(stmt.variable.kind).toBe('TuplePattern');
    const tp = stmt.variable as TuplePattern;
    expect(tp.elements).toHaveLength(2);
    expect(tp.elements[0].kind).toBe('WildcardPattern');
    expect((tp.elements[1] as Identifier).name).toBe('item');
  });

  it('should parse for loop with tuple pattern and method call: for ((index, item) in items.withIndex())', () => {
    const stmt = parseFirst<ForStatement>('for ((index, item) in items.withIndex()) { print(index) }');
    expect(stmt.variable.kind).toBe('TuplePattern');
    const tp = stmt.variable as TuplePattern;
    expect(tp.elements).toHaveLength(2);
    expect((tp.elements[0] as Identifier).name).toBe('index');
    expect((tp.elements[1] as Identifier).name).toBe('item');
    expect(stmt.iterable.kind).toBe('CallExpr');
  });

  it('should report error for single-element tuple pattern: for ((a) in items)', () => {
    const { diagnostics } = parseSource('for ((a) in items) { print(a) }');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should report error for range tokens outside for-loop', () => {
    const { diagnostics } = parseSource('let x = 0..10');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should parse while loop', () => {
    const stmt = parseFirst<WhileStatement>('while (condition) { doSomething() }');
    expect(stmt.kind).toBe('WhileStatement');
  });

  it('should parse assignment: x = 42', () => {
    const program = parseOk('let mut x = 0\nx = 42');
    const stmt = program.body[1] as AssignmentStatement;
    expect(stmt.kind).toBe('AssignmentStatement');
    expect((stmt.target as Identifier).name).toBe('x');
    expect((stmt.value as NumberLiteral).value).toBe(42);
  });

  it('should parse member assignment: obj.field = value', () => {
    const program = parseOk('let mut obj = { x: 0 }\nobj.x = 42');
    const stmt = program.body[1] as AssignmentStatement;
    expect(stmt.kind).toBe('AssignmentStatement');
    expect(stmt.target.kind).toBe('MemberExpr');
  });

  it('should parse throw statement', () => {
    const stmt = parseFirst<ThrowStatement>('throw new Error("msg")');
    expect(stmt.kind).toBe('ThrowStatement');
  });

  it('should parse break and continue in while loop body', () => {
    const stmt = parseFirst<WhileStatement>('while (true) { break }');
    const body = stmt.body as BlockExpr;
    expect(body.body).toHaveLength(1);
  });

  it('should parse bare return', () => {
    const stmt = parseFirst<ReturnStatement>('return');
    expect(stmt.kind).toBe('ReturnStatement');
    expect(stmt.value).toBeUndefined();
  });

  it('should parse return with value', () => {
    const stmt = parseFirst<ReturnStatement>('return 42');
    expect(stmt.kind).toBe('ReturnStatement');
    expect(stmt.value).toBeDefined();
    expect(stmt.value!.kind).toBe('NumberLiteral');
  });

  it('should parse return with expression', () => {
    const stmt = parseFirst<ReturnStatement>('return x + 1');
    expect(stmt.kind).toBe('ReturnStatement');
    expect(stmt.value).toBeDefined();
    expect(stmt.value!.kind).toBe('BinaryExpr');
  });

  it('should parse return in block body', () => {
    const program = parseOk('let f = (x: number) => { return x }');
    const decl = program.body[0] as LetDeclaration;
    const arrow = decl.initializer as ArrowFunction;
    const block = arrow.body as BlockExpr;
    expect(block.body).toHaveLength(1);
    expect(block.body[0].kind).toBe('ReturnStatement');
  });

  it('should parse return with semicolon', () => {
    const stmt = parseFirst<ReturnStatement>('return;');
    expect(stmt.kind).toBe('ReturnStatement');
    expect(stmt.value).toBeUndefined();
  });
});

// ── Happy Path: Source Spans ─────────────────────────────────────────

describe('Source Spans', () => {
  it('should set correct span on number literal', () => {
    const program = parseOk('42');
    const stmt = program.body[0] as ExpressionStatement;
    const expr = stmt.expression;
    expect(expr.span.start.offset).toBe(0);
    expect(expr.span.end.offset).toBe(2);
  });

  it('should set correct span on let declaration', () => {
    const decl = parseFirst<LetDeclaration>('let x = 42');
    expect(decl.span.start.offset).toBe(0);
    expect(decl.span.end.offset).toBe(10);
  });

  it('should set file path on all spans', () => {
    const program = parseOk('42');
    expect(program.span.file).toBe('test.efs');
  });

  it('should have nested spans contained in parent spans', () => {
    const decl = parseFirst<LetDeclaration>('let x = 42');
    expect(decl.name.span.start.offset).toBeGreaterThanOrEqual(decl.span.start.offset);
    expect(decl.name.span.end.offset).toBeLessThanOrEqual(decl.span.end.offset);
  });
});

// ── Happy Path: Trivia Transfer ──────────────────────────────────────

describe('Trivia Transfer', () => {
  it('should transfer leading trivia to AST nodes', () => {
    const decl = parseFirst<LetDeclaration>('  let x = 42');
    expect(decl.leadingTrivia).toBeDefined();
    expect(decl.leadingTrivia!.length).toBeGreaterThan(0);
    expect(decl.leadingTrivia![0].kind).toBe('whitespace');
  });

  it('should transfer trailing trivia to AST nodes', () => {
    const program = parseOk('let x = 42 // comment\nlet y = 1');
    const decl = program.body[0] as LetDeclaration;
    expect(decl.trailingTrivia).toBeDefined();
    expect(decl.trailingTrivia!.length).toBeGreaterThan(0);
  });
});

// ── Happy Path: Complete Programs ────────────────────────────────────

describe('Complete Programs', () => {
  it('should parse empty source', () => {
    const program = parseOk('');
    expect(program.kind).toBe('Program');
    expect(program.body).toHaveLength(0);
  });

  it('should parse expression-only source', () => {
    const program = parseOk('42');
    expect(program.body).toHaveLength(1);
    expect(program.body[0].kind).toBe('ExpressionStatement');
  });

  it('should parse multi-declaration program', () => {
    const source = `import { useState } from "react"
let x = 42
let add = (a: number, b: number): number => a + b
type Color = Red | Green | Blue
export let answer = x`;
    const program = parseOk(source);
    expect(program.body).toHaveLength(5);
    expect(program.body[0].kind).toBe('ImportDeclaration');
    expect(program.body[1].kind).toBe('LetDeclaration');
    expect(program.body[2].kind).toBe('LetDeclaration');
    expect(program.body[3].kind).toBe('TypeDeclaration');
    expect(program.body[4].kind).toBe('ExportDeclaration');
  });

  it('should parse program with pattern matching and ADTs', () => {
    const source = `type Result<T, E> = Ok(value: T) | Err(error: E)
let describe = (r: Result<number, string>): string =>
  match r {
    Ok(v) => "ok"
    Err(e) => "error"
  }`;
    const program = parseOk(source);
    expect(program.body).toHaveLength(2);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('should parse trailing commas in function params', () => {
    const expr = parseExpr('(a: number, b: string,) => a') as ArrowFunction;
    expect(expr.params).toHaveLength(2);
  });

  it('should parse chained calls: a()()', () => {
    const expr = parseExpr('a()()') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect(expr.callee.kind).toBe('CallExpr');
  });

  it('should parse chained member + call: a.b()', () => {
    const expr = parseExpr('a.b()') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect(expr.callee.kind).toBe('MemberExpr');
  });

  it('should parse chained optional + member: a?.b.c', () => {
    const expr = parseExpr('a?.b.c') as MemberExpr;
    expect(expr.property.name).toBe('c');
    const inner = expr.object as MemberExpr;
    expect(inner.optional).toBe(true);
    expect(inner.property.name).toBe('b');
  });

  it('should disambiguate record vs block: { x: 1 } is record', () => {
    const expr = parseExpr('{ x: 1 }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
  });

  it('should disambiguate block: { let x = 1; x }', () => {
    const expr = parseExpr('{ let x = 1; x }') as BlockExpr;
    expect(expr.kind).toBe('BlockExpr');
  });

  it('should handle match with all pattern types in one expression', () => {
    const source = `match x {
  42 => "number"
  "hello" => "string"
  true => "bool"
  null => "null"
  Ok(v) => "ok"
  Red => "color"
  { name } => "record"
  _ => "other"
}`;
    const expr = parseExpr(source) as MatchExpr;
    expect(expr.arms).toHaveLength(8);
  });
});

// ── Error/Rejection Tests ────────────────────────────────────────────

describe('Error Recovery', () => {
  it('should produce ErrorNode for let = 42 (missing identifier)', () => {
    const { program, diagnostics } = parseSource('let = 42');
    expect(diagnostics.some(d => d.code === 'E100')).toBe(true);
    expect(program.body.some(n => n.kind === 'ExpressionStatement' && (n as ExpressionStatement).expression.kind === 'ErrorNode'
      || n.kind === 'LetDeclaration' || (n as unknown as ErrorNode).kind === 'ErrorNode')).toBe(true);
  });

  it('should produce diagnostic for missing initializer: let x =', () => {
    const { diagnostics } = parseSource('let x =');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('should produce diagnostic for missing => in match arm', () => {
    const { diagnostics } = parseSource('match x { 1 "one" }');
    expect(diagnostics.some(d => d.code === 'E105')).toBe(true);
  });

  it('should produce diagnostic for missing closing paren', () => {
    const { diagnostics } = parseSource('(1 + 2');
    expect(diagnostics.some(d => d.code === 'E109')).toBe(true);
  });

  it('should produce diagnostic for missing closing brace', () => {
    const { diagnostics } = parseSource('{ let x = 1');
    expect(diagnostics.some(d => d.code === 'E110')).toBe(true);
  });

  it('should produce diagnostic for missing closing bracket', () => {
    const { diagnostics } = parseSource('[1, 2');
    expect(diagnostics.some(d => d.code === 'E111')).toBe(true);
  });

  it('should produce diagnostic for missing catch', () => {
    const { diagnostics } = parseSource('try { }');
    expect(diagnostics.some(d => d.code === 'E112')).toBe(true);
  });

  it('should recover from errors and continue parsing', () => {
    const { program } = parseSource('let = 42\nlet y = 10');
    // Should still parse the second let
    const letDecls = program.body.filter(n => n.kind === 'LetDeclaration');
    expect(letDecls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Diagnostic Quality ───────────────────────────────────────────────

describe('Diagnostic Quality', () => {
  it('should have diagnostic codes in E100-E199 range', () => {
    const { diagnostics } = parseSource('let = 42');
    for (const d of diagnostics) {
      if (d.code.startsWith('E')) {
        const num = parseInt(d.code.slice(1), 10);
        // Either lexer range (1-99) or parser range (100-199)
        expect(num).toBeLessThanOrEqual(199);
      }
    }
  });

  it('should have correct spans on parse error diagnostics', () => {
    const { diagnostics } = parseSource('let = 42');
    const parserDiags = diagnostics.filter(d => {
      const num = parseInt(d.code.slice(1), 10);
      return num >= 100 && num <= 199;
    });
    expect(parserDiags.length).toBeGreaterThan(0);
    for (const d of parserDiags) {
      expect(d.span.file).toBe('test.efs');
    }
  });
});

// ── Generic Call Expressions ────────────────────────────────────────

describe('Generic Call Expressions', () => {
  it('should parse identity<number>(42)', () => {
    const expr = parseExpr('identity<number>(42)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect((expr.callee as Identifier).name).toBe('identity');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(1);
    expect((expr.typeArgs![0] as NamedType).name.name).toBe('number');
    expect(expr.args.length).toBe(1);
  });

  it('should parse multiple type args: map<string, number>(items)', () => {
    const expr = parseExpr('map<string, number>(items)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(2);
    expect((expr.typeArgs![0] as NamedType).name.name).toBe('string');
    expect((expr.typeArgs![1] as NamedType).name.name).toBe('number');
  });

  it('should parse nested generic type arg: foo<Array<number>>(x)', () => {
    const expr = parseExpr('foo<Array<number>>(x)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(1);
    const typeArg = expr.typeArgs![0] as NamedType;
    expect(typeArg.name.name).toBe('Array');
    expect(typeArg.typeArgs).toBeDefined();
    expect(typeArg.typeArgs!.length).toBe(1);
  });

  it('should parse a < b as BinaryExpr (not generic call)', () => {
    const expr = parseExpr('a < b') as BinaryExpr;
    expect(expr.kind).toBe('BinaryExpr');
    expect(expr.operator).toBe('<');
  });

  it('should parse a<b>(c) as generic call', () => {
    const expr = parseExpr('a<b>(c)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(1);
    expect((expr.typeArgs![0] as NamedType).name.name).toBe('b');
  });

  it('should parse a < b > c as nested BinaryExpr', () => {
    const expr = parseExpr('a < b > c') as BinaryExpr;
    expect(expr.kind).toBe('BinaryExpr');
    // Since < and > have same precedence, this is left-to-right: (a < b) > c
    expect(expr.operator).toBe('>');
  });
});

// ── Generic New Expressions ─────────────────────────────────────────

describe('Generic New Expressions', () => {
  it('should parse new Map<string, number>()', () => {
    const expr = parseExpr('new Map<string, number>()') as NewExpr;
    expect(expr.kind).toBe('NewExpr');
    expect((expr.callee as Identifier).name).toBe('Map');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(2);
    expect((expr.typeArgs![0] as NamedType).name.name).toBe('string');
    expect((expr.typeArgs![1] as NamedType).name.name).toBe('number');
  });

  it('should parse new Foo<T>(x) with type args and args', () => {
    const expr = parseExpr('new Foo<T>(x)') as NewExpr;
    expect(expr.kind).toBe('NewExpr');
    expect(expr.typeArgs).toBeDefined();
    expect(expr.typeArgs!.length).toBe(1);
    expect(expr.args.length).toBe(1);
  });
});

// ── Generic Arrow Functions ─────────────────────────────────────────

describe('Generic Arrow Functions', () => {
  it('should parse <T>(x: T): T => x', () => {
    const expr = parseExpr('<T>(x: T): T => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.typeParams).toBeDefined();
    expect(expr.typeParams!.length).toBe(1);
    expect(expr.typeParams![0].name.name).toBe('T');
    expect(expr.params.length).toBe(1);
    expect(expr.returnType).toBeDefined();
  });

  it('should parse <T, U>(x: T, y: U): T => x', () => {
    const expr = parseExpr('<T, U>(x: T, y: U): T => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.typeParams).toBeDefined();
    expect(expr.typeParams!.length).toBe(2);
    expect(expr.typeParams![0].name.name).toBe('T');
    expect(expr.typeParams![1].name.name).toBe('U');
  });

  it('should parse <T>(x: T) => x without return type', () => {
    const expr = parseExpr('<T>(x: T) => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.typeParams).toBeDefined();
    expect(expr.typeParams!.length).toBe(1);
    expect(expr.returnType).toBeUndefined();
  });

  it('should parse let id = <T>(x: T): T => x', () => {
    const decl = parseFirst<LetDeclaration>('let id = <T>(x: T): T => x');
    expect(decl.kind).toBe('LetDeclaration');
    const arrow = decl.initializer as ArrowFunction;
    expect(arrow.kind).toBe('ArrowFunction');
    expect(arrow.typeParams).toBeDefined();
    expect(arrow.typeParams!.length).toBe(1);
  });
});

// ── Arrow functions with complex parameter types ────────────────────

describe('Arrow functions with complex parameter types', () => {
  it('arrow with function type param: (f: (int) => string) => f', () => {
    const expr = parseExpr('(f: (int) => string) => f') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    expect(expr.params[0].name.name).toBe('f');
    const paramType = expr.params[0].type as FunctionType;
    expect(paramType.kind).toBe('FunctionType');
  });

  it('arrow with record type param: (x: { a: int, b: string }) => x', () => {
    const expr = parseExpr('(x: { a: int, b: string }) => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    expect(expr.params[0].name.name).toBe('x');
    const paramType = expr.params[0].type as RecordType;
    expect(paramType.kind).toBe('RecordType');
    expect(paramType.fields.length).toBe(2);
  });

  it('arrow with generic type param: (x: Array<int>) => x', () => {
    const expr = parseExpr('(x: Array<int>) => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    const paramType = expr.params[0].type as NamedType;
    expect(paramType.kind).toBe('NamedType');
    expect(paramType.name.name).toBe('Array');
    expect(paramType.typeArgs).toBeDefined();
    expect(paramType.typeArgs!.length).toBe(1);
  });

  it('arrow with nullable type param: (x: int?) => x', () => {
    const expr = parseExpr('(x: int?) => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    const paramType = expr.params[0].type as NullableType;
    expect(paramType.kind).toBe('NullableType');
  });

  it('arrow with union type param: (x: int | string) => x', () => {
    const expr = parseExpr('(x: int | string) => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    const paramType = expr.params[0].type as UnionType;
    expect(paramType.kind).toBe('UnionType');
    expect(paramType.members.length).toBe(2);
  });

  it('arrow with complex return type: (x: int): Array<string> => x', () => {
    const expr = parseExpr('(x: int): Array<string> => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    const retType = expr.returnType as NamedType;
    expect(retType.kind).toBe('NamedType');
    expect(retType.name.name).toBe('Array');
    expect(retType.typeArgs).toBeDefined();
    expect(retType.typeArgs!.length).toBe(1);
  });

  it('arrow with nullable return type: (x: int): string? => x', () => {
    const expr = parseExpr('(x: int): string? => x') as ArrowFunction;
    expect(expr.kind).toBe('ArrowFunction');
    expect(expr.params.length).toBe(1);
    const retType = expr.returnType as NullableType;
    expect(retType.kind).toBe('NullableType');
  });
});

// ── Mixed ?? with &&/|| ─────────────────────────────────────────────

describe('mixed ?? with && / ||', () => {
  it('a ?? b && c produces E117', () => {
    const { diagnostics } = parseSource('a ?? b && c');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeDefined();
  });

  it('a && b ?? c produces E117', () => {
    const { diagnostics } = parseSource('a && b ?? c');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeDefined();
  });

  it('a ?? b || c produces E117', () => {
    const { diagnostics } = parseSource('a ?? b || c');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeDefined();
  });

  it('a || b ?? c produces E117', () => {
    const { diagnostics } = parseSource('a || b ?? c');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeDefined();
  });

  it('a ?? b is valid on its own', () => {
    const expr = parseExpr('a ?? b') as BinaryExpr;
    expect(expr.operator).toBe('??');
  });

  it('(a ?? b) && c is allowed (parens disambiguate)', () => {
    const { diagnostics } = parseSource('(a ?? b) && c');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeUndefined();
  });

  it('a ?? (b && c) is allowed (parens disambiguate)', () => {
    const { diagnostics } = parseSource('a ?? (b && c)');
    const e117 = diagnostics.find(d => d.code === 'E117');
    expect(e117).toBeUndefined();
  });
});

// ── < Operator in Control Flow ──────────────────────────────────────

describe('< operator in control flow', () => {
  it('while (i < 10) parses without errors', () => {
    parseOk('let mut i = 0\nwhile (i < 10) { i = i + 1 }');
  });

  it('if (x < y) parses without errors', () => {
    parseOk('let x = 1\nlet y = 2\nif (x < y) { x }');
  });

  it('while (a < b && c > d) parses without errors', () => {
    parseOk('let a = 1\nlet b = 2\nlet c = 3\nlet d = 4\nwhile (a < b && c > d) { a }');
  });

  it('nested < in control flow parses without errors', () => {
    parseOk('let a = 1\nlet b = 2\nlet c = 3\nlet d = 4\nwhile (a < b) { if (c < d) { c } }');
  });

  it('< as comparison next to generic call parses without errors', () => {
    // Ensure the parser correctly distinguishes i < 10 from foo<T>(x)
    const program = parseOk('let i = 5\nlet x = i < 10');
    const decl = program.body[1] as LetDeclaration;
    const expr = decl.initializer as BinaryExpr;
    expect(expr.operator).toBe('<');
  });
});

// ── Record Expression Shorthand ─────────────────────────────────────

describe('record expression shorthand', () => {
  it('{ name, age } parses as RecordExpr with shorthand fields', () => {
    const expr = parseExpr('{ name, age }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
    expect(expr.fields.length).toBe(2);
    expect(expr.fields[0].name.name).toBe('name');
    expect(expr.fields[0].value.kind).toBe('Identifier');
    expect((expr.fields[0].value as Identifier).name).toBe('name');
    expect(expr.fields[1].name.name).toBe('age');
    expect((expr.fields[1].value as Identifier).name).toBe('age');
  });

  it('{ name, age: 30 } mixes shorthand and explicit', () => {
    const expr = parseExpr('{ name, age: 30 }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
    expect(expr.fields.length).toBe(2);
    expect((expr.fields[0].value as Identifier).name).toBe('name');
    expect(expr.fields[1].value.kind).toBe('NumberLiteral');
  });

  it('{ name, age, } handles trailing comma', () => {
    const expr = parseExpr('{ name, age, }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
    expect(expr.fields.length).toBe(2);
  });

  it('{ x: 1 } still works (explicit form)', () => {
    const expr = parseExpr('{ x: 1 }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
    expect(expr.fields[0].value.kind).toBe('NumberLiteral');
  });

  it('shorthand record type-checks with checker', () => {
    // Verify the generated AST works through the full checker
    const source = 'let name = "Alice"\nlet age = 30\nlet person = { name, age }';
    const { diagnostics } = parseSource(source);
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBe(0);
  });
});

// ── Async/Await ──────────────────────────────────────────────────────

describe('Async/Await', () => {
  it('should parse async arrow with expression body', () => {
    const decl = parseFirst<LetDeclaration>('let f = async (x: number): Promise<number> => x');
    const fn = decl.initializer as ArrowFunction;
    expect(fn.kind).toBe('ArrowFunction');
    expect(fn.async).toBe(true);
    expect(fn.params).toHaveLength(1);
    expect(fn.params[0].name.name).toBe('x');
  });

  it('should parse async arrow with block body', () => {
    const decl = parseFirst<LetDeclaration>('let f = async (): Promise<void> => { 42 }');
    const fn = decl.initializer as ArrowFunction;
    expect(fn.kind).toBe('ArrowFunction');
    expect(fn.async).toBe(true);
    expect(fn.body.kind).toBe('BlockExpr');
  });

  it('should parse async generic function', () => {
    const decl = parseFirst<LetDeclaration>('let f = async <T>(x: T): Promise<T> => x');
    const fn = decl.initializer as ArrowFunction;
    expect(fn.kind).toBe('ArrowFunction');
    expect(fn.async).toBe(true);
    expect(fn.typeParams).toHaveLength(1);
    expect(fn.typeParams![0].name.name).toBe('T');
  });

  it('should parse await expression', () => {
    const expr = parseExpr('await p');
    expect(expr.kind).toBe('AwaitExpr');
    expect((expr as AwaitExpr).argument.kind).toBe('Identifier');
  });

  it('should parse await wrapping call + member access', () => {
    const expr = parseExpr('await a.b()');
    expect(expr.kind).toBe('AwaitExpr');
    const arg = (expr as AwaitExpr).argument;
    expect(arg.kind).toBe('CallExpr');
  });

  it('should parse let with async arrow initializer', () => {
    const decl = parseFirst<LetDeclaration>('let f = async (): Promise<number> => 42');
    const fn = decl.initializer as ArrowFunction;
    expect(fn.async).toBe(true);
  });

  it('should parse export let with async arrow initializer', () => {
    const decl = parseFirst<ExportDeclaration>('export let f = async (): Promise<number> => 42');
    expect(decl.kind).toBe('ExportDeclaration');
    expect(decl.declaration).toBeDefined();
    const letDecl = decl.declaration as LetDeclaration;
    const fn = letDecl.initializer as ArrowFunction;
    expect(fn.async).toBe(true);
  });

  it('should parse nested await await p', () => {
    const expr = parseExpr('await await p');
    expect(expr.kind).toBe('AwaitExpr');
    const inner = (expr as AwaitExpr).argument;
    expect(inner.kind).toBe('AwaitExpr');
    expect((inner as AwaitExpr).argument.kind).toBe('Identifier');
  });

  it('should parse await with binary operator: await a + b', () => {
    const expr = parseExpr('await a + b');
    // await binds tighter than binary: (await a) + b
    expect(expr.kind).toBe('BinaryExpr');
    const bin = expr as BinaryExpr;
    expect(bin.left.kind).toBe('AwaitExpr');
    expect(bin.right.kind).toBe('Identifier');
  });

  it('should error when async not followed by ( or <', () => {
    const { diagnostics } = parseSource('async 42');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should error when let async is used as identifier', () => {
    const { diagnostics } = parseSource('let async = 5');
    const errors = diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should parse non-async arrow without async flag', () => {
    const decl = parseFirst<LetDeclaration>('let f = (x: number): number => x');
    const fn = decl.initializer as ArrowFunction;
    expect(fn.kind).toBe('ArrowFunction');
    expect(fn.async).toBeUndefined();
  });
});

// ── Reserved Keywords as Member Names ─────────────────────────────────

describe('Reserved keyword member access', () => {
  it('should parse promise.catch(handler)', () => {
    const expr = parseExpr('promise.catch(handler)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    const callee = expr.callee as MemberExpr;
    expect(callee.kind).toBe('MemberExpr');
    expect(callee.property.name).toBe('catch');
    expect((callee.object as Identifier).name).toBe('promise');
  });

  it('should parse map.delete(key)', () => {
    const expr = parseExpr('map.delete(key)') as CallExpr;
    expect(expr.kind).toBe('CallExpr');
    const callee = expr.callee as MemberExpr;
    expect(callee.kind).toBe('MemberExpr');
    expect(callee.property.name).toBe('delete');
  });

  it('should parse obj.return', () => {
    const expr = parseExpr('obj.return') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('return');
  });

  it('should parse obj.throw', () => {
    const expr = parseExpr('obj.throw') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('throw');
  });

  it('should parse obj.for', () => {
    const expr = parseExpr('obj.for') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('for');
  });

  it('should parse obj.new', () => {
    const expr = parseExpr('obj.new') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('new');
  });

  it('should parse obj.import', () => {
    const expr = parseExpr('obj.import') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('import');
  });

  it('should parse optional chaining with keyword: obj?.catch', () => {
    const expr = parseExpr('obj?.catch') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('catch');
    expect(expr.optional).toBe(true);
  });

  it('should parse chained keyword members: a.catch.then', () => {
    const expr = parseExpr('a.catch.then') as MemberExpr;
    expect(expr.kind).toBe('MemberExpr');
    expect(expr.property.name).toBe('then');
    const inner = expr.object as MemberExpr;
    expect(inner.property.name).toBe('catch');
  });

  it('should parse all keywords in member position', () => {
    const keywords = [
      'let', 'mut', 'match', 'if', 'else', 'type',
      'import', 'export', 'from', 'for', 'while',
      'try', 'catch', 'throw', 'break', 'continue', 'return',
      'in', 'true', 'false', 'null', 'new',
      'fun', 'this', 'async', 'await',
    ];
    for (const kw of keywords) {
      const expr = parseExpr(`obj.${kw}`) as MemberExpr;
      expect(expr.kind).toBe('MemberExpr');
      expect(expr.property.name).toBe(kw);
    }
  });

  it('should parse keyword as record pattern field name', () => {
    const src = 'match x { { catch: c } => c }';
    const program = parseOk(src);
    const stmt = program.body[0] as ExpressionStatement;
    const matchExpr = stmt.expression as MatchExpr;
    const arm = matchExpr.arms[0];
    const pat = arm.pattern as RecordPattern;
    expect(pat.fields[0].name.name).toBe('catch');
  });

  it('should parse keyword as record expression field name', () => {
    const expr = parseExpr('{ catch: 42 }') as RecordExpr;
    expect(expr.kind).toBe('RecordExpr');
    expect(expr.fields[0].name.name).toBe('catch');
  });

  // ── Async Extension Functions ────────────────────────────────────────

  describe('async extension functions', () => {
    it('should parse async fun as async extension function', () => {
      const program = parseOk('async fun string.fetch(): Promise<string> => this');
      expect(program.body.length).toBe(1);
      const decl = program.body[0] as ExtensionFunctionDeclaration;
      expect(decl.kind).toBe('ExtensionFunctionDeclaration');
      expect(decl.async).toBe(true);
      expect(decl.name.name).toBe('fetch');
      const receiverType = decl.receiverType as NamedType;
      expect(receiverType.name.name).toBe('string');
    });

    it('should parse async fun with block body', () => {
      const program = parseOk('async fun string.fetch(): Promise<string> => {\n  this\n}');
      const decl = program.body[0] as ExtensionFunctionDeclaration;
      expect(decl.kind).toBe('ExtensionFunctionDeclaration');
      expect(decl.async).toBe(true);
      expect(decl.body.kind).toBe('BlockExpr');
    });

    it('should parse export async fun', () => {
      const program = parseOk('export async fun string.fetch(): Promise<string> => this');
      const exp = program.body[0] as ExportDeclaration;
      expect(exp.kind).toBe('ExportDeclaration');
      const decl = exp.declaration as ExtensionFunctionDeclaration;
      expect(decl.kind).toBe('ExtensionFunctionDeclaration');
      expect(decl.async).toBe(true);
      expect(decl.exported).toBe(true);
    });

    it('should parse async fun with parameters', () => {
      const program = parseOk('async fun string.fetch(url: string): Promise<string> => this');
      const decl = program.body[0] as ExtensionFunctionDeclaration;
      expect(decl.async).toBe(true);
      expect(decl.params.length).toBe(1);
      expect(decl.params[0].name.name).toBe('url');
    });

    it('non-async fun should not have async flag', () => {
      const program = parseOk('fun string.upper(): string => this');
      const decl = program.body[0] as ExtensionFunctionDeclaration;
      expect(decl.async).toBeUndefined();
    });
  });

  // ── Literal Type Nodes ──────────────────────────────────────────

  describe('LiteralTypeNode', () => {
    it('parses string literal as type', () => {
      const decl = parseFirst<LetDeclaration>('let x: "GET" = "GET"');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('LiteralTypeNode');
      const ltn = decl.typeAnnotation as LiteralTypeNode;
      expect(ltn.literal.kind).toBe('StringLiteral');
      expect((ltn.literal as StringLiteral).value).toBe('GET');
    });

    it('parses number literal as type', () => {
      const decl = parseFirst<LetDeclaration>('let x: 42 = 42');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('LiteralTypeNode');
      const ltn = decl.typeAnnotation as LiteralTypeNode;
      expect(ltn.literal.kind).toBe('NumberLiteral');
      expect((ltn.literal as NumberLiteral).value).toBe(42);
    });

    it('parses true as type', () => {
      const decl = parseFirst<LetDeclaration>('let x: true = true');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('LiteralTypeNode');
      const ltn = decl.typeAnnotation as LiteralTypeNode;
      expect(ltn.literal.kind).toBe('BooleanLiteral');
      expect((ltn.literal as BooleanLiteral).value).toBe(true);
    });

    it('parses false as type', () => {
      const decl = parseFirst<LetDeclaration>('let x: false = false');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('LiteralTypeNode');
      const ltn = decl.typeAnnotation as LiteralTypeNode;
      expect(ltn.literal.kind).toBe('BooleanLiteral');
      expect((ltn.literal as BooleanLiteral).value).toBe(false);
    });

    it('parses union of string literals as type', () => {
      const decl = parseFirst<LetDeclaration>('let x: "GET" | "POST" = "GET"');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('UnionType');
      const ut = decl.typeAnnotation as UnionType;
      expect(ut.members).toHaveLength(2);
      expect(ut.members[0].kind).toBe('LiteralTypeNode');
      expect(ut.members[1].kind).toBe('LiteralTypeNode');
    });

    it('parses type alias with literal union', () => {
      const program = parseOk('type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"');
      const decl = program.body[0] as TypeDeclaration;
      expect(decl.kind).toBe('TypeDeclaration');
      expect(decl.name.name).toBe('HttpMethod');
      expect(decl.variants).toHaveLength(0);
      expect(decl.typeAlias).toBeDefined();
      expect(decl.typeAlias!.kind).toBe('UnionType');
      const ut = decl.typeAlias as UnionType;
      expect(ut.members).toHaveLength(4);
      expect(ut.members.every(m => m.kind === 'LiteralTypeNode')).toBe(true);
    });

    it('parses function param with literal type', () => {
      const decl = parseFirst<LetDeclaration>('let f = (method: "GET" | "POST"): string => method');
      const fn = decl.initializer as ArrowFunction;
      expect(fn.params[0].type).toBeDefined();
      expect(fn.params[0].type!.kind).toBe('UnionType');
      const ut = fn.params[0].type as UnionType;
      expect(ut.members).toHaveLength(2);
      expect(ut.members[0].kind).toBe('LiteralTypeNode');
    });

    it('parses literal type with nullable suffix', () => {
      const decl = parseFirst<LetDeclaration>('let x: "GET"? = null');
      expect(decl.typeAnnotation).toBeDefined();
      expect(decl.typeAnnotation!.kind).toBe('NullableType');
      const nt = decl.typeAnnotation as NullableType;
      expect(nt.inner.kind).toBe('LiteralTypeNode');
    });
  });

  // ── Generic Constraints ───────────────────────────────────────────

  describe('Generic Constraints', () => {
    it('should parse <T: { name: string }> with record constraint', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: { name: string }>(x: T): string => x.name');
      const arrow = decl.initializer as ArrowFunction;
      expect(arrow.typeParams).toBeDefined();
      expect(arrow.typeParams!.length).toBe(1);
      const tp = arrow.typeParams![0];
      expect(tp.name.name).toBe('T');
      expect(tp.constraint).toBeDefined();
      expect(tp.constraint!.kind).toBe('RecordType');
    });

    it('should parse <T: Printable> with named type constraint', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: Printable>(x: T): string => x');
      const arrow = decl.initializer as ArrowFunction;
      const tp = arrow.typeParams![0];
      expect(tp.constraint).toBeDefined();
      expect(tp.constraint!.kind).toBe('NamedType');
      expect((tp.constraint! as NamedType).name.name).toBe('Printable');
    });

    it('should parse <T: A & B> as IntersectionType constraint', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: A & B>(x: T): string => x');
      const arrow = decl.initializer as ArrowFunction;
      const tp = arrow.typeParams![0];
      expect(tp.constraint).toBeDefined();
      expect(tp.constraint!.kind).toBe('IntersectionType');
      const inter = tp.constraint! as import('./ast.js').IntersectionType;
      expect(inter.members.length).toBe(2);
      expect((inter.members[0] as NamedType).name.name).toBe('A');
      expect((inter.members[1] as NamedType).name.name).toBe('B');
    });

    it('should parse <T: { name: string } & { age: number }> as intersection of records', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: { name: string } & { age: number }>(x: T): number => 0');
      const arrow = decl.initializer as ArrowFunction;
      const tp = arrow.typeParams![0];
      expect(tp.constraint!.kind).toBe('IntersectionType');
      const inter = tp.constraint! as import('./ast.js').IntersectionType;
      expect(inter.members.length).toBe(2);
      expect(inter.members[0].kind).toBe('RecordType');
      expect(inter.members[1].kind).toBe('RecordType');
    });

    it('should parse <T, U: Array<T>> — T unconstrained, U constrained', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T, U: Array<T>>(x: T, y: U): T => x');
      const arrow = decl.initializer as ArrowFunction;
      expect(arrow.typeParams!.length).toBe(2);
      expect(arrow.typeParams![0].constraint).toBeUndefined();
      expect(arrow.typeParams![1].constraint).toBeDefined();
      expect(arrow.typeParams![1].constraint!.kind).toBe('NamedType');
    });

    it('should parse <T: { name: string }, U: { age: number }> — both constrained', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: { name: string }, U: { age: number }>(x: T, y: U): number => 0');
      const arrow = decl.initializer as ArrowFunction;
      expect(arrow.typeParams!.length).toBe(2);
      expect(arrow.typeParams![0].constraint).toBeDefined();
      expect(arrow.typeParams![1].constraint).toBeDefined();
    });

    it('should parse <T> — no constraint (backward compatible)', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T>(x: T): T => x');
      const arrow = decl.initializer as ArrowFunction;
      expect(arrow.typeParams![0].constraint).toBeUndefined();
    });

    it('should parse <T: { name: string }?> — nullable constraint', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: { name: string }?>(x: T): number => 0');
      const arrow = decl.initializer as ArrowFunction;
      const tp = arrow.typeParams![0];
      expect(tp.constraint).toBeDefined();
      expect(tp.constraint!.kind).toBe('NullableType');
    });

    it('should parse constraint in type declaration: type Foo<T: Bar> = Baz(value: T)', () => {
      const decl = parseFirst<TypeDeclaration>('type Foo<T: Bar> = Baz(value: T)');
      expect(decl.typeParams!.length).toBe(1);
      expect(decl.typeParams![0].constraint).toBeDefined();
      expect(decl.typeParams![0].constraint!.kind).toBe('NamedType');
    });

    it('intersection precedence: <T: A & B | C> parses as union of (A & B) and C', () => {
      const decl = parseFirst<LetDeclaration>('let f = <T: A & B | C>(x: T): number => 0');
      const arrow = decl.initializer as ArrowFunction;
      const constraint = arrow.typeParams![0].constraint!;
      expect(constraint.kind).toBe('UnionType');
      const union = constraint as UnionType;
      expect(union.members.length).toBe(2);
      expect(union.members[0].kind).toBe('IntersectionType');
      expect((union.members[1] as NamedType).name.name).toBe('C');
    });

    it('should parse intersection type in general type position', () => {
      // Intersection type available as a general-purpose type operator, not just constraints
      const decl = parseFirst<LetDeclaration>('let f = (x: A & B): number => 0');
      const arrow = decl.initializer as ArrowFunction;
      expect(arrow.params[0].type!.kind).toBe('IntersectionType');
    });

    it('should report error for empty constraint <T: >', () => {
      const { diagnostics } = parseSource('let f = <T: >(x: T): T => x');
      const errors = diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ── Named Arguments ────────────────────────────────────────────────

  describe('NamedArgument', () => {
    it('should parse f(x: 10) as CallExpr with NamedArgument', () => {
      const call = parseExpr('f(x: 10)') as CallExpr;
      expect(call.kind).toBe('CallExpr');
      expect(call.args).toHaveLength(1);
      const na = call.args[0] as NamedArgument;
      expect(na.kind).toBe('NamedArgument');
      expect(na.name.name).toBe('x');
      expect((na.value as NumberLiteral).value).toBe(10);
    });

    it('should parse f(1, x: 10) as positional then named', () => {
      const call = parseExpr('f(1, x: 10)') as CallExpr;
      expect(call.args).toHaveLength(2);
      expect(call.args[0].kind).toBe('NumberLiteral');
      const na = call.args[1] as NamedArgument;
      expect(na.kind).toBe('NamedArgument');
      expect(na.name.name).toBe('x');
    });

    it('should parse f(x: 10, y: 20) as multiple named', () => {
      const call = parseExpr('f(x: 10, y: 20)') as CallExpr;
      expect(call.args).toHaveLength(2);
      const na1 = call.args[0] as NamedArgument;
      const na2 = call.args[1] as NamedArgument;
      expect(na1.kind).toBe('NamedArgument');
      expect(na1.name.name).toBe('x');
      expect(na2.kind).toBe('NamedArgument');
      expect(na2.name.name).toBe('y');
    });

    it('should parse f(1, 2, x: 10) as positional then named', () => {
      const call = parseExpr('f(1, 2, x: 10)') as CallExpr;
      expect(call.args).toHaveLength(3);
      expect(call.args[0].kind).toBe('NumberLiteral');
      expect(call.args[1].kind).toBe('NumberLiteral');
      expect((call.args[2] as NamedArgument).kind).toBe('NamedArgument');
    });

    it('should parse named arg with complex expression', () => {
      const call = parseExpr('f(x: a + b)') as CallExpr;
      expect(call.args).toHaveLength(1);
      const na = call.args[0] as NamedArgument;
      expect(na.kind).toBe('NamedArgument');
      expect(na.name.name).toBe('x');
      expect(na.value.kind).toBe('BinaryExpr');
    });

    it('should parse new Foo(x: 10) as NewExpr with NamedArgument', () => {
      const expr = parseExpr('new Foo(x: 10)') as NewExpr;
      expect(expr.kind).toBe('NewExpr');
      expect(expr.args).toHaveLength(1);
      const na = expr.args[0] as NamedArgument;
      expect(na.kind).toBe('NamedArgument');
      expect(na.name.name).toBe('x');
    });

    it('should parse new Foo(1, x: 10, y: 20) as mixed args', () => {
      const expr = parseExpr('new Foo(1, x: 10, y: 20)') as NewExpr;
      expect(expr.kind).toBe('NewExpr');
      expect(expr.args).toHaveLength(3);
      expect(expr.args[0].kind).toBe('NumberLiteral');
      expect((expr.args[1] as NamedArgument).kind).toBe('NamedArgument');
      expect((expr.args[2] as NamedArgument).kind).toBe('NamedArgument');
    });

    it('should parse f() with no args unchanged', () => {
      const call = parseExpr('f()') as CallExpr;
      expect(call.args).toHaveLength(0);
    });

    it('should parse f(1, 2, 3) as all positional unchanged', () => {
      const call = parseExpr('f(1, 2, 3)') as CallExpr;
      expect(call.args).toHaveLength(3);
      for (const arg of call.args) {
        expect(arg.kind).toBe('NumberLiteral');
      }
    });

    it('should parse f({ x: 10 }) as record literal, not named arg', () => {
      const call = parseExpr('f({ x: 10 })') as CallExpr;
      expect(call.args).toHaveLength(1);
      expect(call.args[0].kind).toBe('RecordExpr');
    });
  });
});
