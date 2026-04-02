import { describe, it, expect } from 'vitest';
import type {
  Program, LetDeclaration, TypeDeclaration, ImportDeclaration, ExportDeclaration,
  VariantDeclaration, TypeParameter, ImportSpecifier, ExportSpecifier,
  NumberLiteral, StringLiteral, BooleanLiteral, NullLiteral, Identifier,
  BinaryExpr, UnaryExpr, CallExpr, NewExpr, MemberExpr,
  IfExpr, MatchExpr, MatchArm, BlockExpr, ArrowFunction, FunctionParam,
  TryCatchExpr, ArrayExpr, RecordExpr, RecordField, TemplateString,
  ForStatement, WhileStatement, AssignmentStatement, ThrowStatement,
  BreakStatement, ContinueStatement, ExpressionStatement,
  LiteralPattern, VariantPattern, RecordPattern, WildcardPattern, BindingPattern, NullPattern,
  NamedType, FunctionType, RecordType, NullableType, UnionType, TupleType,
  ErrorNode, ASTNode, Declaration, Expression, Statement, Pattern, TypeNode,
} from './ast.js';
import { isDeclaration, isStatement } from './ast.js';
import type { Span } from '../utils/span.js';

// ── Helpers ──────────────────────────────────────────────────────────

const span: Span = {
  file: 'test.efs',
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 1, line: 1, column: 1 },
};

function makeId(name: string): Identifier {
  return { kind: 'Identifier', name, span };
}

// ── AST Node Construction ────────────────────────────────────────────

describe('AST Node Construction', () => {
  describe('Program', () => {
    it('should construct an empty program', () => {
      const prog: Program = { kind: 'Program', body: [], span };
      expect(prog.kind).toBe('Program');
      expect(prog.body).toHaveLength(0);
    });

    it('should construct a program with body', () => {
      const stmt: ExpressionStatement = {
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      };
      const prog: Program = { kind: 'Program', body: [stmt], span };
      expect(prog.body).toHaveLength(1);
    });
  });

  describe('Declarations', () => {
    it('should construct LetDeclaration', () => {
      const node: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('x'),
        mutable: false,
        initializer: { kind: 'NumberLiteral', value: 42, span },
        exported: false,
        span,
      };
      expect(node.kind).toBe('LetDeclaration');
      expect(node.name.name).toBe('x');
      expect(node.mutable).toBe(false);
      expect(node.typeAnnotation).toBeUndefined();
      expect(node.exported).toBe(false);
    });

    it('should construct mutable LetDeclaration with type annotation', () => {
      const node: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('y'),
        mutable: true,
        typeAnnotation: { kind: 'NamedType', name: makeId('number'), span },
        initializer: { kind: 'NumberLiteral', value: 0, span },
        exported: true,
        span,
      };
      expect(node.mutable).toBe(true);
      expect(node.typeAnnotation).toBeDefined();
      expect(node.exported).toBe(true);
    });

    it('should construct TypeDeclaration', () => {
      const variant: VariantDeclaration = {
        kind: 'VariantDeclaration',
        name: makeId('Red'),
        fields: [],
        span,
      };
      const node: TypeDeclaration = {
        kind: 'TypeDeclaration',
        name: makeId('Color'),
        variants: [variant],
        exported: false,
        span,
      };
      expect(node.kind).toBe('TypeDeclaration');
      expect(node.variants).toHaveLength(1);
      expect(node.typeParams).toBeUndefined();
    });

    it('should construct generic TypeDeclaration', () => {
      const tp: TypeParameter = { kind: 'TypeParameter', name: makeId('T'), span };
      const variant: VariantDeclaration = {
        kind: 'VariantDeclaration',
        name: makeId('Ok'),
        fields: [{ name: makeId('value'), type: { kind: 'NamedType', name: makeId('T'), span } }],
        span,
      };
      const node: TypeDeclaration = {
        kind: 'TypeDeclaration',
        name: makeId('Result'),
        typeParams: [tp],
        variants: [variant],
        exported: false,
        span,
      };
      expect(node.typeParams).toHaveLength(1);
      expect(node.variants[0].fields).toHaveLength(1);
    });

    it('should construct ImportDeclaration', () => {
      const spec: ImportSpecifier = {
        kind: 'ImportSpecifier',
        imported: makeId('useState'),
        span,
      };
      const node: ImportDeclaration = {
        kind: 'ImportDeclaration',
        specifiers: [spec],
        source: { kind: 'StringLiteral', value: 'react', span },
        span,
      };
      expect(node.kind).toBe('ImportDeclaration');
      expect(node.specifiers).toHaveLength(1);
      expect(node.defaultImport).toBeUndefined();
    });

    it('should construct ImportDeclaration with default import', () => {
      const node: ImportDeclaration = {
        kind: 'ImportDeclaration',
        specifiers: [],
        source: { kind: 'StringLiteral', value: 'express', span },
        defaultImport: makeId('express'),
        span,
      };
      expect(node.defaultImport).toBeDefined();
      expect(node.defaultImport!.name).toBe('express');
    });

    it('should construct ExportDeclaration with declaration', () => {
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('x'),
        mutable: false,
        initializer: { kind: 'NumberLiteral', value: 42, span },
        exported: true,
        span,
      };
      const node: ExportDeclaration = {
        kind: 'ExportDeclaration',
        declaration: letDecl,
        span,
      };
      expect(node.kind).toBe('ExportDeclaration');
      expect(node.declaration).toBeDefined();
    });

    it('should construct ExportDeclaration with specifiers', () => {
      const spec: ExportSpecifier = {
        kind: 'ExportSpecifier',
        local: makeId('a'),
        span,
      };
      const node: ExportDeclaration = {
        kind: 'ExportDeclaration',
        specifiers: [spec],
        source: { kind: 'StringLiteral', value: './mod', span },
        span,
      };
      expect(node.specifiers).toHaveLength(1);
      expect(node.source).toBeDefined();
    });
  });

  describe('Expressions', () => {
    it('should construct NumberLiteral', () => {
      const node: NumberLiteral = { kind: 'NumberLiteral', value: 42, span };
      expect(node.kind).toBe('NumberLiteral');
      expect(node.value).toBe(42);
    });

    it('should construct StringLiteral', () => {
      const node: StringLiteral = { kind: 'StringLiteral', value: 'hello', span };
      expect(node.kind).toBe('StringLiteral');
      expect(node.value).toBe('hello');
    });

    it('should construct BooleanLiteral', () => {
      const t: BooleanLiteral = { kind: 'BooleanLiteral', value: true, span };
      const f: BooleanLiteral = { kind: 'BooleanLiteral', value: false, span };
      expect(t.value).toBe(true);
      expect(f.value).toBe(false);
    });

    it('should construct NullLiteral', () => {
      const node: NullLiteral = { kind: 'NullLiteral', span };
      expect(node.kind).toBe('NullLiteral');
    });

    it('should construct Identifier', () => {
      const node = makeId('foo');
      expect(node.kind).toBe('Identifier');
      expect(node.name).toBe('foo');
    });

    it('should construct BinaryExpr', () => {
      const node: BinaryExpr = {
        kind: 'BinaryExpr',
        operator: '+',
        left: { kind: 'NumberLiteral', value: 1, span },
        right: { kind: 'NumberLiteral', value: 2, span },
        span,
      };
      expect(node.operator).toBe('+');
    });

    it('should construct UnaryExpr', () => {
      const node: UnaryExpr = {
        kind: 'UnaryExpr',
        operator: '!',
        operand: { kind: 'BooleanLiteral', value: true, span },
        span,
      };
      expect(node.operator).toBe('!');
    });

    it('should construct CallExpr', () => {
      const node: CallExpr = {
        kind: 'CallExpr',
        callee: makeId('foo'),
        args: [{ kind: 'NumberLiteral', value: 1, span }],
        span,
      };
      expect(node.kind).toBe('CallExpr');
      expect(node.args).toHaveLength(1);
      expect(node.typeArgs).toBeUndefined();
    });

    it('should construct NewExpr', () => {
      const node: NewExpr = {
        kind: 'NewExpr',
        callee: makeId('Map'),
        args: [],
        span,
      };
      expect(node.kind).toBe('NewExpr');
    });

    it('should construct MemberExpr', () => {
      const node: MemberExpr = {
        kind: 'MemberExpr',
        object: makeId('obj'),
        property: makeId('field'),
        optional: false,
        span,
      };
      expect(node.optional).toBe(false);
    });

    it('should construct optional MemberExpr', () => {
      const node: MemberExpr = {
        kind: 'MemberExpr',
        object: makeId('obj'),
        property: makeId('field'),
        optional: true,
        span,
      };
      expect(node.optional).toBe(true);
    });

    it('should construct IfExpr', () => {
      const node: IfExpr = {
        kind: 'IfExpr',
        condition: { kind: 'BooleanLiteral', value: true, span },
        consequent: { kind: 'NumberLiteral', value: 1, span },
        alternate: { kind: 'NumberLiteral', value: 2, span },
        span,
      };
      expect(node.kind).toBe('IfExpr');
      expect(node.alternate).toBeDefined();
    });

    it('should construct IfExpr without else', () => {
      const node: IfExpr = {
        kind: 'IfExpr',
        condition: { kind: 'BooleanLiteral', value: true, span },
        consequent: { kind: 'NumberLiteral', value: 1, span },
        span,
      };
      expect(node.alternate).toBeUndefined();
    });

    it('should construct MatchExpr', () => {
      const arm: MatchArm = {
        kind: 'MatchArm',
        pattern: { kind: 'WildcardPattern', span },
        body: { kind: 'NumberLiteral', value: 0, span },
        span,
      };
      const node: MatchExpr = {
        kind: 'MatchExpr',
        subject: makeId('x'),
        arms: [arm],
        span,
      };
      expect(node.arms).toHaveLength(1);
    });

    it('should construct MatchArm with guard', () => {
      const arm: MatchArm = {
        kind: 'MatchArm',
        pattern: { kind: 'BindingPattern', name: makeId('n'), span },
        guard: {
          kind: 'BinaryExpr',
          operator: '>',
          left: makeId('n'),
          right: { kind: 'NumberLiteral', value: 0, span },
          span,
        },
        body: { kind: 'StringLiteral', value: 'positive', span },
        span,
      };
      expect(arm.guard).toBeDefined();
    });

    it('should construct BlockExpr', () => {
      const node: BlockExpr = {
        kind: 'BlockExpr',
        body: [
          {
            kind: 'LetDeclaration',
            name: makeId('a'),
            mutable: false,
            initializer: { kind: 'NumberLiteral', value: 1, span },
            exported: false,
            span,
          },
          { kind: 'NumberLiteral', value: 1, span },
        ],
        span,
      };
      expect(node.body).toHaveLength(2);
    });

    it('should construct ArrowFunction', () => {
      const param: FunctionParam = {
        kind: 'FunctionParam',
        name: makeId('x'),
        type: { kind: 'NamedType', name: makeId('number'), span },
        mutable: false,
        span,
      };
      const node: ArrowFunction = {
        kind: 'ArrowFunction',
        params: [param],
        body: makeId('x'),
        span,
      };
      expect(node.kind).toBe('ArrowFunction');
      expect(node.params).toHaveLength(1);
      expect(node.returnType).toBeUndefined();
      expect(node.typeParams).toBeUndefined();
    });

    it('should construct ArrowFunction with return type and type params', () => {
      const node: ArrowFunction = {
        kind: 'ArrowFunction',
        typeParams: [{ kind: 'TypeParameter', name: makeId('T'), span }],
        params: [{ kind: 'FunctionParam', name: makeId('x'), type: { kind: 'NamedType', name: makeId('T'), span }, mutable: false, span }],
        returnType: { kind: 'NamedType', name: makeId('T'), span },
        body: makeId('x'),
        span,
      };
      expect(node.typeParams).toHaveLength(1);
      expect(node.returnType).toBeDefined();
    });

    it('should construct FunctionParam with default value', () => {
      const param: FunctionParam = {
        kind: 'FunctionParam',
        name: makeId('name'),
        type: { kind: 'NamedType', name: makeId('string'), span },
        defaultValue: { kind: 'StringLiteral', value: 'world', span },
        mutable: false,
        span,
      };
      expect(param.defaultValue).toBeDefined();
    });

    it('should construct TryCatchExpr', () => {
      const node: TryCatchExpr = {
        kind: 'TryCatchExpr',
        tryBody: { kind: 'BlockExpr', body: [], span },
        catchParam: makeId('e'),
        catchBody: { kind: 'BlockExpr', body: [], span },
        span,
      };
      expect(node.kind).toBe('TryCatchExpr');
    });

    it('should construct ArrayExpr', () => {
      const node: ArrayExpr = {
        kind: 'ArrayExpr',
        elements: [
          { kind: 'NumberLiteral', value: 1, span },
          { kind: 'NumberLiteral', value: 2, span },
        ],
        span,
      };
      expect(node.elements).toHaveLength(2);
    });

    it('should construct RecordExpr', () => {
      const field: RecordField = {
        kind: 'RecordField',
        name: makeId('x'),
        value: { kind: 'NumberLiteral', value: 1, span },
        span,
      };
      const node: RecordExpr = {
        kind: 'RecordExpr',
        fields: [field],
        span,
      };
      expect(node.fields).toHaveLength(1);
    });

    it('should construct TemplateString', () => {
      const node: TemplateString = {
        kind: 'TemplateString',
        parts: [
          { kind: 'TemplateStringPart', value: 'hello ', span },
          { kind: 'TemplateExprPart', expression: makeId('name'), span },
        ],
        span,
      };
      expect(node.parts).toHaveLength(2);
    });
  });

  describe('Patterns', () => {
    it('should construct LiteralPattern', () => {
      const node: LiteralPattern = {
        kind: 'LiteralPattern',
        literal: { kind: 'NumberLiteral', value: 42, span },
        span,
      };
      expect(node.kind).toBe('LiteralPattern');
    });

    it('should construct VariantPattern', () => {
      const node: VariantPattern = {
        kind: 'VariantPattern',
        name: makeId('Ok'),
        fields: [{ kind: 'BindingPattern', name: makeId('x'), span }],
        span,
      };
      expect(node.fields).toHaveLength(1);
    });

    it('should construct VariantPattern without fields (enum-like)', () => {
      const node: VariantPattern = {
        kind: 'VariantPattern',
        name: makeId('Red'),
        span,
      };
      expect(node.fields).toBeUndefined();
    });

    it('should construct RecordPattern', () => {
      const node: RecordPattern = {
        kind: 'RecordPattern',
        fields: [{ name: makeId('name') }, { name: makeId('age') }],
        span,
      };
      expect(node.fields).toHaveLength(2);
    });

    it('should construct WildcardPattern', () => {
      const node: WildcardPattern = { kind: 'WildcardPattern', span };
      expect(node.kind).toBe('WildcardPattern');
    });

    it('should construct BindingPattern', () => {
      const node: BindingPattern = {
        kind: 'BindingPattern',
        name: makeId('n'),
        span,
      };
      expect(node.name.name).toBe('n');
    });

    it('should construct NullPattern', () => {
      const node: NullPattern = { kind: 'NullPattern', span };
      expect(node.kind).toBe('NullPattern');
    });
  });

  describe('Type Nodes', () => {
    it('should construct NamedType', () => {
      const node: NamedType = { kind: 'NamedType', name: makeId('number'), span };
      expect(node.kind).toBe('NamedType');
      expect(node.typeArgs).toBeUndefined();
    });

    it('should construct NamedType with type args', () => {
      const node: NamedType = {
        kind: 'NamedType',
        name: makeId('Array'),
        typeArgs: [{ kind: 'NamedType', name: makeId('number'), span }],
        span,
      };
      expect(node.typeArgs).toHaveLength(1);
    });

    it('should construct FunctionType', () => {
      const node: FunctionType = {
        kind: 'FunctionType',
        params: [{ kind: 'NamedType', name: makeId('number'), span }],
        returnType: { kind: 'NamedType', name: makeId('string'), span },
        span,
      };
      expect(node.kind).toBe('FunctionType');
    });

    it('should construct RecordType', () => {
      const node: RecordType = {
        kind: 'RecordType',
        fields: [{
          name: makeId('name'),
          type: { kind: 'NamedType', name: makeId('string'), span },
          optional: false,
        }],
        span,
      };
      expect(node.fields).toHaveLength(1);
      expect(node.fields[0].optional).toBe(false);
    });

    it('should construct NullableType', () => {
      const node: NullableType = {
        kind: 'NullableType',
        inner: { kind: 'NamedType', name: makeId('string'), span },
        span,
      };
      expect(node.kind).toBe('NullableType');
    });

    it('should construct UnionType', () => {
      const node: UnionType = {
        kind: 'UnionType',
        members: [
          { kind: 'NamedType', name: makeId('string'), span },
          { kind: 'NamedType', name: makeId('number'), span },
        ],
        span,
      };
      expect(node.members).toHaveLength(2);
    });

    it('should construct TupleType', () => {
      const node: TupleType = {
        kind: 'TupleType',
        elements: [
          { kind: 'NamedType', name: makeId('string'), span },
          { kind: 'NamedType', name: makeId('number'), span },
        ],
        span,
      };
      expect(node.elements).toHaveLength(2);
    });
  });

  describe('Statements', () => {
    it('should construct ForStatement', () => {
      const node: ForStatement = {
        kind: 'ForStatement',
        variable: makeId('item'),
        iterable: makeId('items'),
        body: { kind: 'BlockExpr', body: [], span },
        span,
      };
      expect(node.kind).toBe('ForStatement');
    });

    it('should construct WhileStatement', () => {
      const node: WhileStatement = {
        kind: 'WhileStatement',
        condition: { kind: 'BooleanLiteral', value: true, span },
        body: { kind: 'BlockExpr', body: [], span },
        span,
      };
      expect(node.kind).toBe('WhileStatement');
    });

    it('should construct AssignmentStatement', () => {
      const node: AssignmentStatement = {
        kind: 'AssignmentStatement',
        target: makeId('x'),
        value: { kind: 'NumberLiteral', value: 42, span },
        span,
      };
      expect(node.kind).toBe('AssignmentStatement');
    });

    it('should construct ThrowStatement', () => {
      const node: ThrowStatement = {
        kind: 'ThrowStatement',
        value: { kind: 'StringLiteral', value: 'error', span },
        span,
      };
      expect(node.kind).toBe('ThrowStatement');
    });

    it('should construct BreakStatement', () => {
      const node: BreakStatement = { kind: 'BreakStatement', span };
      expect(node.kind).toBe('BreakStatement');
    });

    it('should construct ContinueStatement', () => {
      const node: ContinueStatement = { kind: 'ContinueStatement', span };
      expect(node.kind).toBe('ContinueStatement');
    });

    it('should construct ExpressionStatement', () => {
      const node: ExpressionStatement = {
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      };
      expect(node.kind).toBe('ExpressionStatement');
    });
  });

  describe('ErrorNode', () => {
    it('should construct ErrorNode', () => {
      const node: ErrorNode = { kind: 'ErrorNode', text: 'invalid', span };
      expect(node.kind).toBe('ErrorNode');
      expect(node.text).toBe('invalid');
    });
  });
});

// ── Trivia Fields ────────────────────────────────────────────────────

describe('Trivia Fields', () => {
  it('should allow nodes without trivia (optional)', () => {
    const node: NumberLiteral = { kind: 'NumberLiteral', value: 42, span };
    expect(node.leadingTrivia).toBeUndefined();
    expect(node.trailingTrivia).toBeUndefined();
  });

  it('should allow nodes with trivia', () => {
    const triviaSpan: Span = { file: 'test.efs', start: { offset: 0, line: 1, column: 0 }, end: { offset: 2, line: 1, column: 2 } };
    const node: NumberLiteral = {
      kind: 'NumberLiteral',
      value: 42,
      span,
      leadingTrivia: [{ kind: 'whitespace', text: '  ', span: triviaSpan }],
      trailingTrivia: [],
    };
    expect(node.leadingTrivia).toHaveLength(1);
    expect(node.trailingTrivia).toHaveLength(0);
  });
});

// ── Discriminated Union Narrowing ────────────────────────────────────

describe('Discriminated Union Narrowing', () => {
  it('should narrow Expression by kind', () => {
    const expr: Expression = { kind: 'NumberLiteral', value: 42, span };
    switch (expr.kind) {
      case 'NumberLiteral':
        expect(expr.value).toBe(42);
        break;
      default:
        expect.unreachable('Should have matched NumberLiteral');
    }
  });

  it('should narrow Declaration by kind', () => {
    const decl: Declaration = {
      kind: 'LetDeclaration',
      name: makeId('x'),
      mutable: false,
      initializer: { kind: 'NumberLiteral', value: 1, span },
      exported: false,
      span,
    };
    if (decl.kind === 'LetDeclaration') {
      expect(decl.name.name).toBe('x');
    } else {
      expect.unreachable('Should have narrowed to LetDeclaration');
    }
  });

  it('should narrow Statement by kind', () => {
    const stmt: Statement = { kind: 'BreakStatement', span };
    if (stmt.kind === 'BreakStatement') {
      expect(stmt.kind).toBe('BreakStatement');
    } else {
      expect.unreachable('Should have narrowed to BreakStatement');
    }
  });

  it('should narrow Pattern by kind', () => {
    const pat: Pattern = { kind: 'WildcardPattern', span };
    if (pat.kind === 'WildcardPattern') {
      expect(pat.kind).toBe('WildcardPattern');
    } else {
      expect.unreachable('Should have narrowed to WildcardPattern');
    }
  });

  it('should narrow TypeNode by kind', () => {
    const ty: TypeNode = { kind: 'NamedType', name: makeId('number'), span };
    if (ty.kind === 'NamedType') {
      expect(ty.name.name).toBe('number');
    } else {
      expect.unreachable('Should have narrowed to NamedType');
    }
  });

  it('should narrow ASTNode by kind', () => {
    const node: ASTNode = { kind: 'ErrorNode', text: 'bad', span };
    if (node.kind === 'ErrorNode') {
      expect(node.text).toBe('bad');
    } else {
      expect.unreachable('Should have narrowed to ErrorNode');
    }
  });
});

// ── AST Predicate Functions (W2+W3) ─────────────────────────────────

describe('isDeclaration predicate (W2+W3)', () => {
  it('returns true for LetDeclaration', () => {
    const node: LetDeclaration = {
      kind: 'LetDeclaration', name: makeId('x'), mutable: false,
      initializer: { kind: 'NumberLiteral', value: 1, span }, exported: false, span,
    };
    expect(isDeclaration(node)).toBe(true);
  });

  it('returns true for TypeDeclaration', () => {
    const node: TypeDeclaration = {
      kind: 'TypeDeclaration', name: makeId('T'), variants: [], exported: false, span,
    };
    expect(isDeclaration(node)).toBe(true);
  });

  it('returns true for ImportDeclaration', () => {
    const node: ImportDeclaration = {
      kind: 'ImportDeclaration', specifiers: [],
      source: { kind: 'StringLiteral', value: 'mod', span }, span,
    };
    expect(isDeclaration(node)).toBe(true);
  });

  it('returns true for ExportDeclaration', () => {
    const node: ExportDeclaration = {
      kind: 'ExportDeclaration', specifiers: [], span,
    };
    expect(isDeclaration(node)).toBe(true);
  });

  it('returns false for statements', () => {
    const node: ForStatement = {
      kind: 'ForStatement', variable: makeId('x'), iterable: makeId('xs'),
      body: { kind: 'BlockExpr', body: [], span }, span,
    };
    expect(isDeclaration(node)).toBe(false);
  });

  it('returns false for expressions', () => {
    expect(isDeclaration({ kind: 'NumberLiteral' })).toBe(false);
  });

  it('narrows type: after isDeclaration check, node is Declaration', () => {
    const node: Declaration | Statement | Expression = {
      kind: 'LetDeclaration', name: makeId('x'), mutable: false,
      initializer: { kind: 'NumberLiteral', value: 1, span }, exported: false, span,
    };
    if (isDeclaration(node)) {
      // TypeScript should allow accessing Declaration-specific properties
      expect(node.kind).toBe('LetDeclaration');
    } else {
      expect.unreachable();
    }
  });
});

describe('isStatement predicate (W2+W3)', () => {
  it('returns true for ForStatement', () => {
    expect(isStatement({ kind: 'ForStatement' })).toBe(true);
  });

  it('returns true for WhileStatement', () => {
    expect(isStatement({ kind: 'WhileStatement' })).toBe(true);
  });

  it('returns true for AssignmentStatement', () => {
    expect(isStatement({ kind: 'AssignmentStatement' })).toBe(true);
  });

  it('returns true for ThrowStatement', () => {
    expect(isStatement({ kind: 'ThrowStatement' })).toBe(true);
  });

  it('returns true for BreakStatement', () => {
    expect(isStatement({ kind: 'BreakStatement' })).toBe(true);
  });

  it('returns true for ContinueStatement', () => {
    expect(isStatement({ kind: 'ContinueStatement' })).toBe(true);
  });

  it('returns true for ExpressionStatement', () => {
    expect(isStatement({ kind: 'ExpressionStatement' })).toBe(true);
  });

  it('returns false for declarations', () => {
    expect(isStatement({ kind: 'LetDeclaration' })).toBe(false);
  });

  it('returns false for expressions', () => {
    expect(isStatement({ kind: 'NumberLiteral' })).toBe(false);
  });

  it('narrows type: after isStatement check, node is Statement', () => {
    const node: Declaration | Statement | Expression = {
      kind: 'BreakStatement', span,
    };
    if (isStatement(node)) {
      // TypeScript should narrow to Statement
      expect(node.kind).toBe('BreakStatement');
    } else {
      expect.unreachable();
    }
  });
});
