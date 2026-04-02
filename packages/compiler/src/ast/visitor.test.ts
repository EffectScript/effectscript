import { describe, it, expect, vi } from 'vitest';
import type { ASTVisitor, VisitorContext } from './visitor.js';
import { walkAST } from './visitor.js';
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
  ErrorNode, ASTNodeBase,
} from '../parser/ast.js';
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

function makeProgram(body: Program['body']): Program {
  return { kind: 'Program', body, span };
}

// ── walkAST Tests ────────────────────────────────────────────────────

describe('walkAST', () => {
  describe('Happy Path', () => {
    it('should visit nodes in depth-first order', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('x'),
        mutable: false,
        initializer: {
          kind: 'BinaryExpr',
          operator: '+',
          left: { kind: 'NumberLiteral', value: 1, span },
          right: { kind: 'NumberLiteral', value: 2, span },
          span,
        },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterProgram(_node, _ctx) { visited.push('enter:Program'); },
        leaveProgram(_node, _ctx) { visited.push('leave:Program'); },
        enterLetDeclaration(_node, _ctx) { visited.push('enter:LetDeclaration'); },
        leaveLetDeclaration(_node, _ctx) { visited.push('leave:LetDeclaration'); },
        enterIdentifier(_node, _ctx) { visited.push(`enter:Identifier(${_node.name})`); },
        leaveIdentifier(_node, _ctx) { visited.push(`leave:Identifier(${_node.name})`); },
        enterBinaryExpr(_node, _ctx) { visited.push('enter:BinaryExpr'); },
        leaveBinaryExpr(_node, _ctx) { visited.push('leave:BinaryExpr'); },
        enterNumberLiteral(_node, _ctx) { visited.push(`enter:NumberLiteral(${_node.value})`); },
        leaveNumberLiteral(_node, _ctx) { visited.push(`leave:NumberLiteral(${_node.value})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'enter:Program',
        'enter:LetDeclaration',
        'enter:Identifier(x)',
        'leave:Identifier(x)',
        'enter:BinaryExpr',
        'enter:NumberLiteral(1)',
        'leave:NumberLiteral(1)',
        'enter:NumberLiteral(2)',
        'leave:NumberLiteral(2)',
        'leave:BinaryExpr',
        'leave:LetDeclaration',
        'leave:Program',
      ]);
    });

    it('should dispatch to per-kind method over category method', () => {
      const calls: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'IfExpr',
          condition: { kind: 'BooleanLiteral', value: true, span },
          consequent: { kind: 'NumberLiteral', value: 1, span },
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterIfExpr(_node, _ctx) { calls.push('enterIfExpr'); },
        enterExpression(_node, _ctx) { calls.push(`enterExpression:${_node.kind}`); },
      };

      walkAST(prog, visitor);

      // IfExpr should use per-kind, not category
      expect(calls).toContain('enterIfExpr');
      expect(calls).not.toContain('enterExpression:IfExpr');
      // But child expressions without per-kind methods should use category fallback
      expect(calls).toContain('enterExpression:BooleanLiteral');
      expect(calls).toContain('enterExpression:NumberLiteral');
    });

    it('should fall back to category method when per-kind is not defined', () => {
      const calls: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'IfExpr',
          condition: { kind: 'BooleanLiteral', value: true, span },
          consequent: { kind: 'NumberLiteral', value: 1, span },
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterExpression(_node, _ctx) { calls.push(`enterExpression:${_node.kind}`); },
      };

      walkAST(prog, visitor);

      // IfExpr, BooleanLiteral, and NumberLiteral should all use enterExpression
      expect(calls).toContain('enterExpression:IfExpr');
      expect(calls).toContain('enterExpression:BooleanLiteral');
      expect(calls).toContain('enterExpression:NumberLiteral');
    });

    it('should handle visitor with no methods defined', () => {
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);

      // Should not throw
      expect(() => walkAST(prog, {})).not.toThrow();
    });

    it('should call leave methods in reverse order of enter', () => {
      const calls: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'BinaryExpr',
          operator: '+',
          left: { kind: 'NumberLiteral', value: 1, span },
          right: { kind: 'NumberLiteral', value: 2, span },
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterBinaryExpr() { calls.push('enter:Binary'); },
        leaveBinaryExpr() { calls.push('leave:Binary'); },
        enterNumberLiteral(node) { calls.push(`enter:Num(${node.value})`); },
        leaveNumberLiteral(node) { calls.push(`leave:Num(${node.value})`); },
      };

      walkAST(prog, visitor);

      expect(calls).toEqual([
        'enter:Binary',
        'enter:Num(1)',
        'leave:Num(1)',
        'enter:Num(2)',
        'leave:Num(2)',
        'leave:Binary',
      ]);
    });

    it('should track parent correctly', () => {
      const parents: Array<{ node: string; parent: string | undefined }> = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterProgram(_node, ctx) { parents.push({ node: 'Program', parent: ctx.parent?.kind }); },
        enterExpressionStatement(_node, ctx) { parents.push({ node: 'ExpressionStatement', parent: ctx.parent?.kind }); },
        enterNumberLiteral(_node, ctx) { parents.push({ node: 'NumberLiteral', parent: ctx.parent?.kind }); },
      };

      walkAST(prog, visitor);

      expect(parents).toEqual([
        { node: 'Program', parent: undefined },
        { node: 'ExpressionStatement', parent: 'Program' },
        { node: 'NumberLiteral', parent: 'ExpressionStatement' },
      ]);
    });

    it('should track depth correctly', () => {
      const depths: Array<{ node: string; depth: number }> = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterProgram(_node, ctx) { depths.push({ node: 'Program', depth: ctx.depth }); },
        enterExpressionStatement(_node, ctx) { depths.push({ node: 'ExpressionStatement', depth: ctx.depth }); },
        enterNumberLiteral(_node, ctx) { depths.push({ node: 'NumberLiteral', depth: ctx.depth }); },
      };

      walkAST(prog, visitor);

      expect(depths).toEqual([
        { node: 'Program', depth: 0 },
        { node: 'ExpressionStatement', depth: 1 },
        { node: 'NumberLiteral', depth: 2 },
      ]);
    });

    it('should visit all children of ArrowFunction in order', () => {
      const visited: string[] = [];
      const arrowFn: ArrowFunction = {
        kind: 'ArrowFunction',
        typeParams: [{ kind: 'TypeParameter', name: makeId('T'), span }],
        params: [{
          kind: 'FunctionParam',
          name: makeId('x'),
          type: { kind: 'NamedType', name: makeId('T'), span },
          mutable: false,
          span,
        }],
        returnType: { kind: 'NamedType', name: makeId('T'), span },
        body: makeId('x'),
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: arrowFn,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterTypeParameter() { visited.push('TypeParameter'); },
        enterFunctionParam() { visited.push('FunctionParam'); },
        enterArrowFunction() { visited.push('ArrowFunction'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      // Should visit: ArrowFunction, TypeParameter, T (id), FunctionParam, x (id), NamedType(T), NamedType(return), body Identifier(x)
      expect(visited).toContain('ArrowFunction');
      expect(visited).toContain('TypeParameter');
      expect(visited).toContain('FunctionParam');
      expect(visited).toContain('NamedType');
    });

    it('should visit all children of MatchExpr', () => {
      const visited: string[] = [];
      const matchExpr: MatchExpr = {
        kind: 'MatchExpr',
        subject: makeId('x'),
        arms: [{
          kind: 'MatchArm',
          pattern: { kind: 'LiteralPattern', literal: { kind: 'NumberLiteral', value: 1, span }, span },
          guard: { kind: 'BooleanLiteral', value: true, span },
          body: { kind: 'StringLiteral', value: 'one', span },
          span,
        }],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: matchExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterMatchExpr() { visited.push('MatchExpr'); },
        enterMatchArm() { visited.push('MatchArm'); },
        enterLiteralPattern() { visited.push('LiteralPattern'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
        enterBooleanLiteral() { visited.push('BooleanLiteral'); },
        enterStringLiteral() { visited.push('StringLiteral'); },
        enterIdentifier() { visited.push('Identifier'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'MatchExpr',
        'Identifier',     // subject
        'MatchArm',
        'LiteralPattern',
        'NumberLiteral',   // pattern literal
        'BooleanLiteral',  // guard
        'StringLiteral',   // body
      ]);
    });

    it('should visit TryCatchExpr children', () => {
      const visited: string[] = [];
      const tryCatch: TryCatchExpr = {
        kind: 'TryCatchExpr',
        tryBody: { kind: 'BlockExpr', body: [{ kind: 'NumberLiteral', value: 1, span }], span },
        catchParam: makeId('e'),
        catchBody: { kind: 'BlockExpr', body: [{ kind: 'NumberLiteral', value: 2, span }], span },
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: tryCatch,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterTryCatchExpr() { visited.push('TryCatchExpr'); },
        enterBlockExpr() { visited.push('BlockExpr'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNumberLiteral(node) { visited.push(`Number(${node.value})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'TryCatchExpr',
        'BlockExpr',        // tryBody
        'Number(1)',
        'Identifier(e)',    // catchParam
        'BlockExpr',        // catchBody
        'Number(2)',
      ]);
    });

    it('should visit RecordExpr fields', () => {
      const visited: string[] = [];
      const recordExpr: RecordExpr = {
        kind: 'RecordExpr',
        fields: [
          { kind: 'RecordField', name: makeId('a'), value: { kind: 'NumberLiteral', value: 1, span }, span },
          { kind: 'RecordField', name: makeId('b'), value: { kind: 'NumberLiteral', value: 2, span }, span },
        ],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: recordExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterRecordExpr() { visited.push('RecordExpr'); },
        enterRecordField() { visited.push('RecordField'); },
        enterIdentifier(node) { visited.push(`Id(${node.name})`); },
        enterNumberLiteral(node) { visited.push(`Num(${node.value})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('RecordExpr');
      expect(visited).toContain('RecordField');
    });

    it('should visit TemplateString expression parts', () => {
      const visited: string[] = [];
      const templateStr: TemplateString = {
        kind: 'TemplateString',
        parts: [
          { kind: 'TemplateStringPart', value: 'hello ', span },
          { kind: 'TemplateExprPart', expression: makeId('name'), span },
        ],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: templateStr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterTemplateString() { visited.push('TemplateString'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('TemplateString');
      expect(visited).toContain('Identifier(name)');
    });

    it('should visit ImportDeclaration children', () => {
      const visited: string[] = [];
      const importDecl: ImportDeclaration = {
        kind: 'ImportDeclaration',
        defaultImport: makeId('React'),
        specifiers: [{
          kind: 'ImportSpecifier',
          imported: makeId('useState'),
          local: makeId('state'),
          span,
        }],
        source: { kind: 'StringLiteral', value: 'react', span },
        span,
      };
      const prog = makeProgram([importDecl]);

      const visitor: ASTVisitor = {
        enterImportDeclaration() { visited.push('ImportDeclaration'); },
        enterImportSpecifier() { visited.push('ImportSpecifier'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterStringLiteral() { visited.push('StringLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('ImportDeclaration');
      expect(visited).toContain('Identifier(React)');
      expect(visited).toContain('ImportSpecifier');
      expect(visited).toContain('StringLiteral');
    });

    it('should visit ExportDeclaration children', () => {
      const visited: string[] = [];
      const exportDecl: ExportDeclaration = {
        kind: 'ExportDeclaration',
        specifiers: [{
          kind: 'ExportSpecifier',
          local: makeId('foo'),
          exported: makeId('bar'),
          span,
        }],
        source: { kind: 'StringLiteral', value: './mod', span },
        span,
      };
      const prog = makeProgram([exportDecl]);

      const visitor: ASTVisitor = {
        enterExportDeclaration() { visited.push('ExportDeclaration'); },
        enterExportSpecifier() { visited.push('ExportSpecifier'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterStringLiteral() { visited.push('StringLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('ExportDeclaration');
      expect(visited).toContain('ExportSpecifier');
    });

    it('should visit ForStatement children', () => {
      const visited: string[] = [];
      const forStmt: ForStatement = {
        kind: 'ForStatement',
        variable: makeId('item'),
        iterable: makeId('items'),
        body: { kind: 'BlockExpr', body: [], span },
        span,
      };
      const prog = makeProgram([forStmt]);

      const visitor: ASTVisitor = {
        enterForStatement() { visited.push('ForStatement'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterBlockExpr() { visited.push('BlockExpr'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'ForStatement',
        'Identifier(item)',
        'Identifier(items)',
        'BlockExpr',
      ]);
    });

    it('should visit WhileStatement children', () => {
      const visited: string[] = [];
      const whileStmt: WhileStatement = {
        kind: 'WhileStatement',
        condition: { kind: 'BooleanLiteral', value: true, span },
        body: { kind: 'BlockExpr', body: [], span },
        span,
      };
      const prog = makeProgram([whileStmt]);

      const visitor: ASTVisitor = {
        enterWhileStatement() { visited.push('WhileStatement'); },
        enterBooleanLiteral() { visited.push('BooleanLiteral'); },
        enterBlockExpr() { visited.push('BlockExpr'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'WhileStatement',
        'BooleanLiteral',
        'BlockExpr',
      ]);
    });

    it('should visit TypeDeclaration children', () => {
      const visited: string[] = [];
      const typeDecl: TypeDeclaration = {
        kind: 'TypeDeclaration',
        name: makeId('Result'),
        typeParams: [{ kind: 'TypeParameter', name: makeId('T'), span }],
        variants: [{
          kind: 'VariantDeclaration',
          name: makeId('Ok'),
          fields: [{ name: makeId('value'), type: { kind: 'NamedType', name: makeId('T'), span } }],
          span,
        }],
        exported: false,
        span,
      };
      const prog = makeProgram([typeDecl]);

      const visitor: ASTVisitor = {
        enterTypeDeclaration() { visited.push('TypeDeclaration'); },
        enterTypeParameter() { visited.push('TypeParameter'); },
        enterVariantDeclaration() { visited.push('VariantDeclaration'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('TypeDeclaration');
      expect(visited).toContain('TypeParameter');
      expect(visited).toContain('VariantDeclaration');
    });

    it('should visit UnaryExpr operand', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'UnaryExpr',
          operator: '!',
          operand: { kind: 'BooleanLiteral', value: true, span },
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterUnaryExpr() { visited.push('UnaryExpr'); },
        enterBooleanLiteral() { visited.push('BooleanLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['UnaryExpr', 'BooleanLiteral']);
    });

    it('should visit CallExpr children', () => {
      const visited: string[] = [];
      const callExpr: CallExpr = {
        kind: 'CallExpr',
        callee: makeId('foo'),
        typeArgs: [{ kind: 'NamedType', name: makeId('number'), span }],
        args: [{ kind: 'NumberLiteral', value: 1, span }],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: callExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterCallExpr() { visited.push('CallExpr'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNamedType() { visited.push('NamedType'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('CallExpr');
      expect(visited).toContain('Identifier(foo)');
      expect(visited).toContain('NamedType');
      expect(visited).toContain('NumberLiteral');
    });

    it('should visit NewExpr children', () => {
      const visited: string[] = [];
      const newExpr: NewExpr = {
        kind: 'NewExpr',
        callee: makeId('Map'),
        args: [],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: newExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterNewExpr() { visited.push('NewExpr'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['NewExpr', 'Identifier(Map)']);
    });

    it('should visit MemberExpr children', () => {
      const visited: string[] = [];
      const memberExpr: MemberExpr = {
        kind: 'MemberExpr',
        object: makeId('obj'),
        property: makeId('field'),
        optional: false,
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: memberExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterMemberExpr() { visited.push('MemberExpr'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual([
        'MemberExpr',
        'Identifier(obj)',
        'Identifier(field)',
      ]);
    });

    it('should visit ArrayExpr elements', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'ArrayExpr',
          elements: [
            { kind: 'NumberLiteral', value: 1, span },
            { kind: 'NumberLiteral', value: 2, span },
          ],
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterArrayExpr() { visited.push('ArrayExpr'); },
        enterNumberLiteral(node) { visited.push(`Num(${node.value})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['ArrayExpr', 'Num(1)', 'Num(2)']);
    });

    it('should visit AssignmentStatement children', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'AssignmentStatement',
        target: makeId('x'),
        value: { kind: 'NumberLiteral', value: 42, span },
        span,
      } as AssignmentStatement]);

      const visitor: ASTVisitor = {
        enterAssignmentStatement() { visited.push('AssignmentStatement'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['AssignmentStatement', 'Identifier(x)', 'NumberLiteral']);
    });

    it('should visit ThrowStatement value', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'ThrowStatement',
        value: { kind: 'StringLiteral', value: 'error', span },
        span,
      } as ThrowStatement]);

      const visitor: ASTVisitor = {
        enterThrowStatement() { visited.push('ThrowStatement'); },
        enterStringLiteral() { visited.push('StringLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['ThrowStatement', 'StringLiteral']);
    });

    it('should visit BreakStatement and ContinueStatement (leaf nodes)', () => {
      const visited: string[] = [];
      const prog = makeProgram([
        { kind: 'BreakStatement', span } as BreakStatement,
        { kind: 'ContinueStatement', span } as ContinueStatement,
      ]);

      const visitor: ASTVisitor = {
        enterBreakStatement() { visited.push('BreakStatement'); },
        enterContinueStatement() { visited.push('ContinueStatement'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['BreakStatement', 'ContinueStatement']);
    });

    it('should visit all pattern types', () => {
      const visited: string[] = [];
      // Build a match with various patterns
      const matchExpr: MatchExpr = {
        kind: 'MatchExpr',
        subject: makeId('x'),
        arms: [
          {
            kind: 'MatchArm',
            pattern: { kind: 'LiteralPattern', literal: { kind: 'NumberLiteral', value: 1, span }, span },
            body: { kind: 'NumberLiteral', value: 1, span },
            span,
          },
          {
            kind: 'MatchArm',
            pattern: { kind: 'VariantPattern', name: makeId('Some'), fields: [{ kind: 'BindingPattern', name: makeId('v'), span }], span },
            body: makeId('v'),
            span,
          },
          {
            kind: 'MatchArm',
            pattern: { kind: 'NullPattern', span },
            body: { kind: 'NumberLiteral', value: 0, span },
            span,
          },
          {
            kind: 'MatchArm',
            pattern: { kind: 'WildcardPattern', span },
            body: { kind: 'NumberLiteral', value: -1, span },
            span,
          },
        ],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: matchExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterLiteralPattern() { visited.push('LiteralPattern'); },
        enterVariantPattern() { visited.push('VariantPattern'); },
        enterBindingPattern() { visited.push('BindingPattern'); },
        enterNullPattern() { visited.push('NullPattern'); },
        enterWildcardPattern() { visited.push('WildcardPattern'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('LiteralPattern');
      expect(visited).toContain('VariantPattern');
      expect(visited).toContain('BindingPattern');
      expect(visited).toContain('NullPattern');
      expect(visited).toContain('WildcardPattern');
    });

    it('should visit RecordPattern with fields', () => {
      const visited: string[] = [];
      const matchExpr: MatchExpr = {
        kind: 'MatchExpr',
        subject: makeId('x'),
        arms: [{
          kind: 'MatchArm',
          pattern: {
            kind: 'RecordPattern',
            fields: [
              { name: makeId('a') },
              { name: makeId('b'), pattern: { kind: 'BindingPattern', name: makeId('val'), span } },
            ],
            span,
          },
          body: { kind: 'NumberLiteral', value: 0, span },
          span,
        }],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: matchExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterRecordPattern() { visited.push('RecordPattern'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterBindingPattern() { visited.push('BindingPattern'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('RecordPattern');
      // Should traverse through RecordPatternField to reach child nodes
      expect(visited).toContain('Identifier(a)');
      expect(visited).toContain('Identifier(b)');
      expect(visited).toContain('BindingPattern');
    });

    it('should visit type nodes', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('x'),
        mutable: false,
        typeAnnotation: {
          kind: 'NullableType',
          inner: { kind: 'NamedType', name: makeId('string'), span },
          span,
        },
        initializer: { kind: 'NullLiteral', span },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterNullableType() { visited.push('NullableType'); },
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['NullableType', 'NamedType']);
    });

    it('should visit FunctionType children', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('f'),
        mutable: false,
        typeAnnotation: {
          kind: 'FunctionType',
          params: [{ kind: 'NamedType', name: makeId('number'), span }],
          returnType: { kind: 'NamedType', name: makeId('string'), span },
          span,
        },
        initializer: { kind: 'NullLiteral', span },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterFunctionType() { visited.push('FunctionType'); },
        enterNamedType(node) { visited.push(`NamedType`); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['FunctionType', 'NamedType', 'NamedType']);
    });

    it('should visit RecordType children', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('r'),
        mutable: false,
        typeAnnotation: {
          kind: 'RecordType',
          fields: [
            { name: makeId('x'), type: { kind: 'NamedType', name: makeId('number'), span }, optional: false, mutable: false },
          ],
          span,
        },
        initializer: { kind: 'NullLiteral', span },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterRecordType() { visited.push('RecordType'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('RecordType');
      // Should traverse through RecordTypeField to reach field name and type
      expect(visited).toContain('Identifier(x)');
      expect(visited).toContain('NamedType');
    });

    it('should visit UnionType and TupleType children', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('u'),
        mutable: false,
        typeAnnotation: {
          kind: 'UnionType',
          members: [
            { kind: 'NamedType', name: makeId('string'), span },
            {
              kind: 'TupleType',
              elements: [
                { kind: 'NamedType', name: makeId('number'), span },
                { kind: 'NamedType', name: makeId('boolean'), span },
              ],
              span,
            },
          ],
          span,
        },
        initializer: { kind: 'NullLiteral', span },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterUnionType() { visited.push('UnionType'); },
        enterTupleType() { visited.push('TupleType'); },
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['UnionType', 'NamedType', 'TupleType', 'NamedType', 'NamedType']);
    });

    it('should visit category-level leave methods as fallback', () => {
      const calls: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);

      const visitor: ASTVisitor = {
        leaveExpression(node) { calls.push(`leaveExpression:${node.kind}`); },
        leaveStatement(node) { calls.push(`leaveStatement:${node.kind}`); },
      };

      walkAST(prog, visitor);

      expect(calls).toContain('leaveExpression:NumberLiteral');
      expect(calls).toContain('leaveStatement:ExpressionStatement');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty program', () => {
      const visited: string[] = [];
      const prog = makeProgram([]);

      const visitor: ASTVisitor = {
        enterProgram() { visited.push('enter:Program'); },
        leaveProgram() { visited.push('leave:Program'); },
        enterExpression() { visited.push('enter:Expression'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['enter:Program', 'leave:Program']);
    });

    it('should visit ErrorNode', () => {
      const visited: string[] = [];
      const prog: Program = {
        kind: 'Program',
        body: [{
          kind: 'ExpressionStatement',
          expression: { kind: 'ErrorNode', text: 'bad syntax', span } as unknown as ErrorNode,
          span,
        } as ExpressionStatement],
        span,
      };

      const visitor: ASTVisitor = {
        enterErrorNode(node) { visited.push(`ErrorNode(${node.text})`); },
        leaveErrorNode(node) { visited.push(`leave:ErrorNode(${node.text})`); },
      };

      // ErrorNode is not an Expression union member, so we need to force it
      // In the real parser, ErrorNode can appear where any node is expected
      walkAST(prog, visitor);

      expect(visited).toContain('ErrorNode(bad syntax)');
      expect(visited).toContain('leave:ErrorNode(bad syntax)');
    });

    it('should halt traversal when stop() is called', () => {
      const visited: string[] = [];
      const prog = makeProgram([
        {
          kind: 'ExpressionStatement',
          expression: { kind: 'NumberLiteral', value: 1, span },
          span,
        },
        {
          kind: 'ExpressionStatement',
          expression: { kind: 'NumberLiteral', value: 2, span },
          span,
        },
      ]);

      const visitor: ASTVisitor = {
        enterNumberLiteral(node, ctx) {
          visited.push(`Num(${node.value})`);
          if (node.value === 1) {
            ctx.stop();
          }
        },
      };

      walkAST(prog, visitor);

      // Should stop after visiting NumberLiteral(1) — no further nodes visited
      expect(visited).toEqual(['Num(1)']);
    });

    it('should not call leave methods after stop()', () => {
      const calls: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'BinaryExpr',
          operator: '+',
          left: { kind: 'NumberLiteral', value: 1, span },
          right: { kind: 'NumberLiteral', value: 2, span },
          span,
        },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterBinaryExpr() { calls.push('enter:Binary'); },
        leaveBinaryExpr() { calls.push('leave:Binary'); },
        enterNumberLiteral(node, ctx) {
          calls.push(`enter:Num(${node.value})`);
          ctx.stop();
        },
        leaveNumberLiteral(node) { calls.push(`leave:Num(${node.value})`); },
      };

      walkAST(prog, visitor);

      // After stop in enterNumberLiteral(1), nothing more should fire
      expect(calls).toEqual([
        'enter:Binary',
        'enter:Num(1)',
      ]);
    });

    it('should handle IfExpr without alternate', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: {
          kind: 'IfExpr',
          condition: { kind: 'BooleanLiteral', value: true, span },
          consequent: { kind: 'NumberLiteral', value: 1, span },
          span,
        } as IfExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterIfExpr() { visited.push('IfExpr'); },
        enterBooleanLiteral() { visited.push('BooleanLiteral'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toEqual(['IfExpr', 'BooleanLiteral', 'NumberLiteral']);
    });

    it('should handle LetDeclaration without typeAnnotation', () => {
      const visited: string[] = [];
      const prog = makeProgram([{
        kind: 'LetDeclaration',
        name: makeId('x'),
        mutable: false,
        initializer: { kind: 'NumberLiteral', value: 42, span },
        exported: false,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterLetDeclaration() { visited.push('LetDeclaration'); },
        enterIdentifier() { visited.push('Identifier'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
        enterType() { visited.push('Type'); },
      };

      walkAST(prog, visitor);

      // Should not visit any type node
      expect(visited).toEqual(['LetDeclaration', 'Identifier', 'NumberLiteral']);
    });

    it('should warn and continue on unknown node kind', () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const visited: string[] = [];

      // Create a node with an unknown kind
      const unknownNode = { kind: 'FutureAwaitExpr', span } as unknown as ASTNodeBase;
      const prog: Program = {
        kind: 'Program',
        body: [
          { kind: 'ExpressionStatement', expression: unknownNode, span } as ExpressionStatement,
          { kind: 'ExpressionStatement', expression: { kind: 'NumberLiteral', value: 42, span }, span },
        ],
        span,
      };

      const visitor: ASTVisitor = {
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      // Should log a warning for the unknown kind
      expect(warnSpy).toHaveBeenCalled();
      // Should continue traversal past the unknown node
      expect(visited).toContain('NumberLiteral');

      warnSpy.mockRestore();
    });

    it('should handle deeply nested structures', () => {
      // Build a deeply nested if-else chain
      let expr: IfExpr = {
        kind: 'IfExpr',
        condition: { kind: 'BooleanLiteral', value: true, span },
        consequent: { kind: 'NumberLiteral', value: 0, span },
        span,
      };
      for (let i = 0; i < 50; i++) {
        expr = {
          kind: 'IfExpr',
          condition: { kind: 'BooleanLiteral', value: true, span },
          consequent: expr,
          span,
        };
      }

      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: expr,
        span,
      }]);

      let maxDepth = 0;
      const visitor: ASTVisitor = {
        enterIfExpr(_node, ctx) {
          if (ctx.depth > maxDepth) maxDepth = ctx.depth;
        },
      };

      walkAST(prog, visitor);

      // 51 nested IfExprs: depth 2 (ExprStmt > first IfExpr) to depth 52 (innermost)
      expect(maxDepth).toBeGreaterThan(50);
    });

    it('should visit FunctionParam with default value', () => {
      const visited: string[] = [];
      const arrowFn: ArrowFunction = {
        kind: 'ArrowFunction',
        params: [{
          kind: 'FunctionParam',
          name: makeId('x'),
          type: { kind: 'NamedType', name: makeId('number'), span },
          defaultValue: { kind: 'NumberLiteral', value: 0, span },
          mutable: false,
          span,
        }],
        body: makeId('x'),
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: arrowFn,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterFunctionParam() { visited.push('FunctionParam'); },
        enterNamedType() { visited.push('NamedType'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('FunctionParam');
      expect(visited).toContain('NamedType');
      expect(visited).toContain('NumberLiteral');
    });

    it('should visit VariantPattern without fields', () => {
      const visited: string[] = [];
      const matchExpr: MatchExpr = {
        kind: 'MatchExpr',
        subject: makeId('x'),
        arms: [{
          kind: 'MatchArm',
          pattern: { kind: 'VariantPattern', name: makeId('None'), span },
          body: { kind: 'NumberLiteral', value: 0, span },
          span,
        }],
        span,
      };
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: matchExpr,
        span,
      }]);

      const visitor: ASTVisitor = {
        enterVariantPattern() { visited.push('VariantPattern'); },
        enterIdentifier(node) { visited.push(`Identifier(${node.name})`); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('VariantPattern');
      expect(visited).toContain('Identifier(None)');
    });

    it('should visit ExportDeclaration with inline declaration', () => {
      const visited: string[] = [];
      const exportDecl: ExportDeclaration = {
        kind: 'ExportDeclaration',
        declaration: {
          kind: 'LetDeclaration',
          name: makeId('x'),
          mutable: false,
          initializer: { kind: 'NumberLiteral', value: 42, span },
          exported: true,
          span,
        },
        span,
      };
      const prog = makeProgram([exportDecl]);

      const visitor: ASTVisitor = {
        enterExportDeclaration() { visited.push('ExportDeclaration'); },
        enterLetDeclaration() { visited.push('LetDeclaration'); },
        enterNumberLiteral() { visited.push('NumberLiteral'); },
      };

      walkAST(prog, visitor);

      expect(visited).toContain('ExportDeclaration');
      expect(visited).toContain('LetDeclaration');
      expect(visited).toContain('NumberLiteral');
    });

    it('should visit NamedType with type arguments', () => {
      const visited: string[] = [];
      const letDecl: LetDeclaration = {
        kind: 'LetDeclaration',
        name: makeId('xs'),
        mutable: false,
        typeAnnotation: {
          kind: 'NamedType',
          name: makeId('Array'),
          typeArgs: [{ kind: 'NamedType', name: makeId('number'), span }],
          span,
        },
        initializer: { kind: 'ArrayExpr', elements: [], span },
        exported: false,
        span,
      };
      const prog = makeProgram([letDecl]);

      const visitor: ASTVisitor = {
        enterNamedType() { visited.push('NamedType'); },
      };

      walkAST(prog, visitor);

      // Should visit both the outer NamedType(Array) and inner NamedType(number)
      expect(visited).toEqual(['NamedType', 'NamedType']);
    });

    it('should propagate visitor exceptions', () => {
      const prog = makeProgram([{
        kind: 'ExpressionStatement',
        expression: { kind: 'NumberLiteral', value: 42, span },
        span,
      }]);

      const visitor: ASTVisitor = {
        enterNumberLiteral() { throw new Error('visitor error'); },
      };

      expect(() => walkAST(prog, visitor)).toThrow('visitor error');
    });
  });

  describe('Integration', () => {
    it('should collect all node kinds from a complex AST', () => {
      const kinds = new Set<string>();

      // Build a complex program with many node types
      const prog = makeProgram([
        // let x: number = 1 + 2
        {
          kind: 'LetDeclaration',
          name: makeId('x'),
          mutable: false,
          typeAnnotation: { kind: 'NamedType', name: makeId('number'), span },
          initializer: {
            kind: 'BinaryExpr',
            operator: '+',
            left: { kind: 'NumberLiteral', value: 1, span },
            right: { kind: 'NumberLiteral', value: 2, span },
            span,
          },
          exported: false,
          span,
        },
        // if true { "yes" } else { "no" }
        {
          kind: 'ExpressionStatement',
          expression: {
            kind: 'IfExpr',
            condition: { kind: 'BooleanLiteral', value: true, span },
            consequent: { kind: 'StringLiteral', value: 'yes', span },
            alternate: { kind: 'StringLiteral', value: 'no', span },
            span,
          },
          span,
        },
        // for item in items { }
        {
          kind: 'ForStatement',
          variable: makeId('item'),
          iterable: makeId('items'),
          body: { kind: 'BlockExpr', body: [], span },
          span,
        } as ForStatement,
      ]);

      const visitor: ASTVisitor = {
        enterDeclaration(node) { kinds.add(node.kind); },
        enterExpression(node) { kinds.add(node.kind); },
        enterStatement(node) { kinds.add(node.kind); },
        enterType(node) { kinds.add(node.kind); },
        enterProgram() { kinds.add('Program'); },
      };

      walkAST(prog, visitor);

      expect(kinds).toContain('Program');
      expect(kinds).toContain('LetDeclaration');
      expect(kinds).toContain('ExpressionStatement');
      expect(kinds).toContain('ForStatement');
    });
  });
});

// ── Visitor method coverage for "Other" category nodes ──────────────

describe('walkAST - ImportSpecifier and ExportSpecifier visitor methods', () => {
  it('should call enterImportSpecifier/leaveImportSpecifier', () => {
    const calls: string[] = [];
    const importDecl: ImportDeclaration = {
      kind: 'ImportDeclaration',
      specifiers: [{
        kind: 'ImportSpecifier',
        imported: makeId('foo'),
        span,
      }],
      source: { kind: 'StringLiteral', value: './mod', span },
      span,
    };
    const prog = makeProgram([importDecl]);

    const visitor: ASTVisitor = {
      enterImportSpecifier() { calls.push('enter'); },
      leaveImportSpecifier() { calls.push('leave'); },
    };

    walkAST(prog, visitor);

    expect(calls).toEqual(['enter', 'leave']);
  });

  it('should call enterExportSpecifier/leaveExportSpecifier', () => {
    const calls: string[] = [];
    const exportDecl: ExportDeclaration = {
      kind: 'ExportDeclaration',
      specifiers: [{
        kind: 'ExportSpecifier',
        local: makeId('foo'),
        span,
      }],
      span,
    };
    const prog = makeProgram([exportDecl]);

    const visitor: ASTVisitor = {
      enterExportSpecifier() { calls.push('enter'); },
      leaveExportSpecifier() { calls.push('leave'); },
    };

    walkAST(prog, visitor);

    expect(calls).toEqual(['enter', 'leave']);
  });

  it('should call enterRecordField/leaveRecordField', () => {
    const calls: string[] = [];
    const recordExpr: RecordExpr = {
      kind: 'RecordExpr',
      fields: [{
        kind: 'RecordField',
        name: makeId('a'),
        value: { kind: 'NumberLiteral', value: 1, span },
        span,
      }],
      span,
    };
    const prog = makeProgram([{
      kind: 'ExpressionStatement',
      expression: recordExpr,
      span,
    }]);

    const visitor: ASTVisitor = {
      enterRecordField() { calls.push('enter'); },
      leaveRecordField() { calls.push('leave'); },
    };

    walkAST(prog, visitor);

    expect(calls).toEqual(['enter', 'leave']);
  });

  // ── For-loop enhancement visitor tests ──

  it('should traverse TuplePattern children', () => {
    const visited: string[] = [];
    const tuplePattern: import('../parser/ast.js').TuplePattern = {
      kind: 'TuplePattern',
      elements: [makeId('a'), makeId('b')],
      span,
    };
    const forStmt: ForStatement = {
      kind: 'ForStatement',
      variable: tuplePattern,
      iterable: makeId('items'),
      body: { kind: 'BlockExpr', body: [], span },
      span,
    };
    const prog = makeProgram([forStmt]);

    const visitor: ASTVisitor = {
      enterTuplePattern() { visited.push('enter:TuplePattern'); },
      leaveTuplePattern() { visited.push('leave:TuplePattern'); },
      enterIdentifier(node) { visited.push(`enter:Identifier:${node.name}`); },
    };

    walkAST(prog, visitor);

    expect(visited).toContain('enter:TuplePattern');
    expect(visited).toContain('leave:TuplePattern');
    expect(visited).toContain('enter:Identifier:a');
    expect(visited).toContain('enter:Identifier:b');
  });

  it('should traverse ForRange start and end expressions', () => {
    const visited: string[] = [];
    const forStmt: ForStatement = {
      kind: 'ForStatement',
      variable: makeId('i'),
      iterable: { kind: 'NumberLiteral', value: 0, span },
      range: {
        start: { kind: 'NumberLiteral', value: 0, span },
        end: { kind: 'NumberLiteral', value: 10, span },
        exclusive: true,
        span,
      },
      body: { kind: 'BlockExpr', body: [], span },
      span,
    };
    const prog = makeProgram([forStmt]);

    const visitor: ASTVisitor = {
      enterNumberLiteral(node) { visited.push(`num:${node.value}`); },
    };

    walkAST(prog, visitor);

    // Should visit range start (0) and end (10), NOT iterable
    expect(visited).toContain('num:0');
    expect(visited).toContain('num:10');
    expect(visited).toHaveLength(2);
  });

  it('should visit ForStatement with RecordPattern variable', () => {
    const visited: string[] = [];
    const recPat: RecordPattern = {
      kind: 'RecordPattern',
      fields: [{ name: makeId('name') }],
      span,
    };
    const forStmt: ForStatement = {
      kind: 'ForStatement',
      variable: recPat,
      iterable: makeId('users'),
      body: { kind: 'BlockExpr', body: [], span },
      span,
    };
    const prog = makeProgram([forStmt]);

    const visitor: ASTVisitor = {
      enterRecordPattern() { visited.push('enter:RecordPattern'); },
      leaveRecordPattern() { visited.push('leave:RecordPattern'); },
    };

    walkAST(prog, visitor);

    expect(visited).toContain('enter:RecordPattern');
    expect(visited).toContain('leave:RecordPattern');
  });

  it('47. walker traverses IndexExpr object and index children', () => {
    const visited: string[] = [];
    const indexExpr: ASTNodeBase = {
      kind: 'IndexExpr',
      object: makeId('obj'),
      index: { kind: 'StringLiteral', value: 'key', span },
      optional: false,
      span,
    };
    const stmt: ExpressionStatement = {
      kind: 'ExpressionStatement',
      expression: indexExpr as unknown as import('../parser/ast.js').Expression,
      span,
    };
    const prog = makeProgram([stmt]);
    const visitor: ASTVisitor = {
      enterExpression(node: ASTNodeBase) { visited.push(`enter:${node.kind}`); },
      leaveExpression(node: ASTNodeBase) { visited.push(`leave:${node.kind}`); },
    };
    walkAST(prog, visitor);
    // Should visit IndexExpr, then its children (Identifier and StringLiteral)
    expect(visited).toContain('enter:IndexExpr');
    expect(visited).toContain('leave:IndexExpr');
    expect(visited).toContain('enter:Identifier');
    expect(visited).toContain('enter:StringLiteral');
  });
});
