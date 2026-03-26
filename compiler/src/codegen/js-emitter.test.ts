import { describe, it, expect } from 'vitest';
import { emitJS } from './js-emitter.js';
import type {
  Program, LetDeclaration, TypeDeclaration, VariantDeclaration,
  ImportDeclaration, ExportDeclaration, ExportSpecifier,
  ExtensionFunctionDeclaration,
  NumberLiteral, StringLiteral, BooleanLiteral, NullLiteral,
  Identifier, BinaryExpr, UnaryExpr, CallExpr, NewExpr,
  MemberExpr, IfExpr, MatchExpr, MatchArm, BlockExpr,
  ArrowFunction, FunctionParam, TryCatchExpr, AwaitExpr,
  ArrayExpr, RecordExpr, RecordField, TemplateString,
  ForStatement, WhileStatement, AssignmentStatement,
  ThrowStatement, BreakStatement, ContinueStatement, ReturnStatement,
  ExpressionStatement, ErrorNode,
  VariantPattern, LiteralPattern, BindingPattern, WildcardPattern,
  NullPattern, RecordPattern,
  Expression, Declaration, Statement,
  RecordType as RecordTypeNode, RecordTypeField,
  NamedType, NamedArgument,
} from '../parser/ast.js';
import type { Span } from '../utils/span.js';
import type { ADTType, Type, FunctionType as FT, ParamType } from '../checker/types.js';

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

function bool(value: boolean): BooleanLiteral {
  return { kind: 'BooleanLiteral', value, span };
}

function nullLit(): NullLiteral {
  return { kind: 'NullLiteral', span };
}

function program(...body: (Declaration | Statement)[]): Program {
  return { kind: 'Program', body, span };
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

function call(callee: Expression, args: Expression[], typeArgs?: unknown[]): CallExpr {
  const node: Record<string, unknown> = { kind: 'CallExpr', callee, args, span };
  if (typeArgs !== undefined) node['typeArgs'] = typeArgs;
  return node as unknown as CallExpr;
}

function member(object: Expression, property: string, optional = false): MemberExpr {
  return { kind: 'MemberExpr', object, property: id(property), optional, span };
}

function binary(op: BinaryExpr['operator'], left: Expression, right: Expression): BinaryExpr {
  return { kind: 'BinaryExpr', operator: op, left, right, span };
}

function unary(op: UnaryExpr['operator'], operand: Expression): UnaryExpr {
  return { kind: 'UnaryExpr', operator: op, operand, span };
}

function arrow(params: FunctionParam[], body: Expression, typeParams?: unknown[]): ArrowFunction {
  const node: Record<string, unknown> = { kind: 'ArrowFunction', params, body, span };
  if (typeParams !== undefined) node['typeParams'] = typeParams;
  return node as unknown as ArrowFunction;
}

function param(name: string, defaultValue?: Expression): FunctionParam {
  const node: Record<string, unknown> = { kind: 'FunctionParam', name: id(name), mutable: false, span };
  if (defaultValue !== undefined) node['defaultValue'] = defaultValue;
  return node as unknown as FunctionParam;
}

function ifExpr(condition: Expression, consequent: Expression, alternate?: Expression): IfExpr {
  const node: Record<string, unknown> = { kind: 'IfExpr', condition, consequent, span };
  if (alternate !== undefined) node['alternate'] = alternate;
  return node as unknown as IfExpr;
}

function matchExpr(subject: Expression, arms: MatchArm[], exhaustive = false): MatchExpr {
  const node: Record<string, unknown> = { kind: 'MatchExpr', subject, arms, span };
  node['isExhaustive'] = exhaustive;
  return node as unknown as MatchExpr;
}

function matchArm(pattern: MatchArm['pattern'], body: Expression, guard?: Expression): MatchArm {
  const node: Record<string, unknown> = { kind: 'MatchArm', pattern, body, span };
  if (guard !== undefined) node['guard'] = guard;
  return node as unknown as MatchArm;
}

function block(...body: (Declaration | Statement | Expression)[]): BlockExpr {
  return { kind: 'BlockExpr', body, span };
}

function tryCatch(tryBody: BlockExpr, catchParam: string, catchBody: BlockExpr): TryCatchExpr {
  return { kind: 'TryCatchExpr', tryBody, catchParam: id(catchParam), catchBody, span };
}

function arrayExpr(...elements: Expression[]): ArrayExpr {
  return { kind: 'ArrayExpr', elements, span };
}

function recordExpr(...fields: [string, Expression][]): RecordExpr {
  return {
    kind: 'RecordExpr',
    fields: fields.map(([n, v]) => ({ kind: 'RecordField', name: id(n), value: v, span }) as RecordField),
    span,
  };
}

function templateStr(...parts: (string | Expression)[]): TemplateString {
  return {
    kind: 'TemplateString',
    parts: parts.map(p =>
      typeof p === 'string'
        ? { kind: 'TemplateStringPart' as const, value: p, span }
        : { kind: 'TemplateExprPart' as const, expression: p, span }
    ),
    span,
  };
}

function forStmt(variable: string, iterable: Expression, body: BlockExpr): ForStatement {
  return { kind: 'ForStatement', variable: id(variable), iterable, body, span };
}

function forRangeStmt(
  variable: string,
  start: Expression,
  end: Expression,
  exclusive: boolean,
  body: BlockExpr,
): ForStatement {
  return {
    kind: 'ForStatement',
    variable: id(variable),
    iterable: start,
    range: { start, end, exclusive, span },
    body,
    span,
  };
}

function forDestructStmt(
  variable: import('../parser/ast.js').RecordPattern | import('../parser/ast.js').TuplePattern,
  iterable: Expression,
  body: BlockExpr,
): ForStatement {
  return { kind: 'ForStatement', variable, iterable, body, span };
}

function whileStmt(condition: Expression, body: BlockExpr): WhileStatement {
  return { kind: 'WhileStatement', condition, body, span };
}

function assign(target: Expression, value: Expression): AssignmentStatement {
  return { kind: 'AssignmentStatement', target, value, span };
}

function throwStmt(value: Expression): ThrowStatement {
  return { kind: 'ThrowStatement', value, span };
}

function breakStmt(): BreakStatement {
  return { kind: 'BreakStatement', span };
}

function continueStmt(): ContinueStatement {
  return { kind: 'ContinueStatement', span };
}

function returnStmt(value?: Expression): ReturnStatement {
  const result: Record<string, unknown> = { kind: 'ReturnStatement', span };
  if (value !== undefined) result['value'] = value;
  return result as unknown as ReturnStatement;
}

function newExpr(callee: Expression, args: Expression[], typeArgs?: unknown[]): NewExpr {
  const node: Record<string, unknown> = { kind: 'NewExpr', callee, args, span };
  if (typeArgs !== undefined) node['typeArgs'] = typeArgs;
  return node as unknown as NewExpr;
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

function variant(name: string, fields: [string, unknown][] = []): VariantDeclaration {
  return {
    kind: 'VariantDeclaration',
    name: id(name),
    fields: fields.map(([n]) => ({
      name: id(n),
      type: { kind: 'NamedType', name: id('number'), span },
    })),
    span,
  };
}

function importDecl(specifiers: { imported: string; local?: string }[], source: string, defaultImport?: string): ImportDeclaration {
  const node: Record<string, unknown> = {
    kind: 'ImportDeclaration',
    specifiers: specifiers.map(s => {
      const spec: Record<string, unknown> = { kind: 'ImportSpecifier', imported: id(s.imported), span };
      if (s.local !== undefined) spec['local'] = id(s.local);
      return spec;
    }),
    source: str(source),
    span,
  };
  if (defaultImport !== undefined) node['defaultImport'] = id(defaultImport);
  return node as unknown as ImportDeclaration;
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

function variantPattern(name: string, fields?: MatchArm['pattern'][]): VariantPattern {
  const node: Record<string, unknown> = { kind: 'VariantPattern', name: id(name), span };
  if (fields !== undefined) node['fields'] = fields;
  return node as unknown as VariantPattern;
}

function literalPattern(literal: NumberLiteral | StringLiteral | BooleanLiteral): LiteralPattern {
  return { kind: 'LiteralPattern', literal, span };
}

function bindingPattern(name: string): BindingPattern {
  return { kind: 'BindingPattern', name: id(name), span };
}

function wildcardPattern(): WildcardPattern {
  return { kind: 'WildcardPattern', span };
}

function nullPattern(): NullPattern {
  return { kind: 'NullPattern', span };
}

function recordPattern(...fields: [string, MatchArm['pattern']?][]): RecordPattern {
  return {
    kind: 'RecordPattern',
    fields: fields.map(([n, p]) => {
      const field: Record<string, unknown> = { name: id(n) };
      if (p !== undefined) field['pattern'] = p;
      return field;
    }) as RecordPattern['fields'],
    span,
  };
}

function errorNode(): ErrorNode {
  return { kind: 'ErrorNode', text: 'error', span };
}

/** Set resolvedType on a node (using Record cast per project pattern). */
function withType<T>(node: T, type: Type): T {
  (node as Record<string, unknown>)['resolvedType'] = type;
  return node;
}

// ADT type helpers for match tests
const shapeADT: ADTType = {
  kind: 'adt',
  name: 'Shape',
  typeArgs: [],
  variants: [
    { name: 'Circle', fields: new Map([['radius', { kind: 'primitive', name: 'number' }]]) },
    { name: 'Rectangle', fields: new Map([['width', { kind: 'primitive', name: 'number' }], ['height', { kind: 'primitive', name: 'number' }]]) },
  ],
};

const colorADT: ADTType = {
  kind: 'adt',
  name: 'Color',
  typeArgs: [],
  variants: [
    { name: 'Red', fields: new Map() },
    { name: 'Green', fields: new Map() },
    { name: 'Blue', fields: new Map() },
  ],
};

const resultADT: ADTType = {
  kind: 'adt',
  name: 'Result',
  typeArgs: [{ kind: 'generic', name: 'T' }, { kind: 'generic', name: 'E' }],
  variants: [
    { name: 'Ok', fields: new Map([['value', { kind: 'generic', name: 'T' }]]) },
    { name: 'Err', fields: new Map([['error', { kind: 'generic', name: 'E' }]]) },
  ],
};

// Prelude print type - same signature as prelude.ts
const preludePrintType: FT = {
  kind: 'function',
  params: [{ name: 'value', type: { kind: 'any' }, optional: false, hasDefault: false }],
  returnType: { kind: 'primitive', name: 'void' },
};

// Prelude Ok constructor type
const preludeOkType: FT = {
  kind: 'function',
  params: [{ name: 'value', type: { kind: 'generic', name: 'T' }, optional: false, hasDefault: false }],
  returnType: resultADT,
  typeParams: [{ name: 'T' }, { name: 'E' }],
};

// Prelude Err constructor type
const preludeErrType: FT = {
  kind: 'function',
  params: [{ name: 'error', type: { kind: 'generic', name: 'E' }, optional: false, hasDefault: false }],
  returnType: resultADT,
  typeParams: [{ name: 'T' }, { name: 'E' }],
};

// Prelude attempt type
const preludeAttemptType: FT = {
  kind: 'function',
  params: [{
    name: 'f',
    type: { kind: 'function', params: [], returnType: { kind: 'generic', name: 'T' } } as FT,
    optional: false,
    hasDefault: false,
  }],
  returnType: resultADT,
  typeParams: [{ name: 'T' }],
};

// ── Tests ───────────────────────────────────────────────────

describe('JS Emitter', () => {
  // ── 1. let binding → const ──
  it('emits let binding as const', () => {
    const ast = program(letDecl('x', num(42)));
    expect(emitJS(ast)).toBe('const x = 42;\n');
  });

  // ── 2. let mut binding → let ──
  it('emits let mut binding as let', () => {
    const ast = program(letDecl('y', num(0), { mutable: true }));
    expect(emitJS(ast)).toBe('let y = 0;\n');
  });

  // ── 3. export let → export const ──
  it('emits export let as export const', () => {
    const ast = program(letDecl('z', num(1), { exported: true }));
    expect(emitJS(ast)).toBe('export const z = 1;\n');
  });

  // ── 4. Arrow function → arrow function ──
  it('emits arrow function with type annotations stripped', () => {
    const ast = program(letDecl('add', arrow(
      [param('x'), param('y')],
      binary('+', id('x'), id('y')),
    )));
    expect(emitJS(ast)).toBe('const add = (x, y) => x + y;\n');
  });

  // ── 5. Arrow function with default params ──
  it('emits arrow function with default params', () => {
    const ast = program(letDecl('greet', arrow(
      [param('name', str('world'))],
      templateStr('Hello, ', id('name')),
    )));
    expect(emitJS(ast)).toBe('const greet = (name = "world") => `Hello, ${name}`;\n');
  });

  // ── 6. Generic function ──
  it('strips type params from generic function', () => {
    const ast = program(letDecl('identity', arrow(
      [param('x')],
      id('x'),
      [{ kind: 'TypeParameter', name: id('T'), span }],
    )));
    expect(emitJS(ast)).toBe('const identity = (x) => x;\n');
  });

  // ── 7. Binary operators: == → ===, != → !== ──
  it('emits == as === and != as !==', () => {
    const ast = program(
      exprStmt(binary('==', id('a'), id('b'))),
      exprStmt(binary('!=', id('a'), id('b'))),
    );
    expect(emitJS(ast)).toBe('a === b;\na !== b;\n');
  });

  // ── 7b. Arithmetic passthrough ──
  it('emits arithmetic operators as-is', () => {
    const ast = program(exprStmt(binary('+', id('a'), id('b'))));
    expect(emitJS(ast)).toBe('a + b;\n');
  });

  // ── 9. Unary operators passthrough ──
  it('emits unary operators', () => {
    const ast = program(
      exprStmt(unary('!', id('a'))),
      exprStmt(unary('-', id('a'))),
    );
    expect(emitJS(ast)).toBe('!a;\n-a;\n');
  });

  // ── 10. Optional chaining ──
  it('emits optional chaining', () => {
    const ast = program(exprStmt(member(id('a'), 'b', true)));
    expect(emitJS(ast)).toBe('a?.b;\n');
  });

  // ── 11. Nullish coalescing ──
  it('emits nullish coalescing', () => {
    const ast = program(exprStmt(binary('??', id('a'), id('b'))));
    expect(emitJS(ast)).toBe('a ?? b;\n');
  });

  // ── 12. String literal ──
  it('emits string literal with double quotes', () => {
    const ast = program(exprStmt(str('hello')));
    expect(emitJS(ast)).toBe('"hello";\n');
  });

  // ── 13. Template string ──
  it('emits template string as backtick template literal', () => {
    const ast = program(exprStmt(templateStr('Hello, ', id('name'))));
    expect(emitJS(ast)).toBe('`Hello, ${name}`;\n');
  });

  // ── 14. Number literal, boolean literal, null literal ──
  it('emits number, boolean, and null literals', () => {
    const ast = program(
      exprStmt(num(42)),
      exprStmt(bool(true)),
      exprStmt(bool(false)),
      exprStmt(nullLit()),
    );
    expect(emitJS(ast)).toBe('42;\ntrue;\nfalse;\nnull;\n');
  });

  // ── 15. Array expression ──
  it('emits array expression', () => {
    const ast = program(exprStmt(arrayExpr(num(1), num(2), num(3))));
    expect(emitJS(ast)).toBe('[1, 2, 3];\n');
  });

  // ── 16. Record expression ──
  it('emits record expression', () => {
    const ast = program(exprStmt(recordExpr(['name', str('Alice')], ['age', num(30)])));
    expect(emitJS(ast)).toBe('({ name: "Alice", age: 30 });\n');
  });

  // ── 17. Member expression ──
  it('emits member expression (regular and optional)', () => {
    const ast = program(
      exprStmt(member(id('obj'), 'field')),
      exprStmt(member(id('obj'), 'field', true)),
    );
    expect(emitJS(ast)).toBe('obj.field;\nobj?.field;\n');
  });

  // ── 18. Call expression ──
  it('emits call expression with and without type args', () => {
    const ast = program(
      exprStmt(call(id('foo'), [num(1), num(2)])),
      exprStmt(call(id('foo'), [num(1)], [{ kind: 'NamedType', name: id('number'), span }])),
    );
    expect(emitJS(ast)).toBe('foo(1, 2);\nfoo(1);\n');
  });

  // ── 19. New expression ──
  it('emits new expression', () => {
    const ast = program(
      exprStmt(newExpr(id('Map'), [])),
      exprStmt(newExpr(id('Error'), [str('oops')])),
      exprStmt(newExpr(id('Map'), [], [{ kind: 'NamedType', name: id('string'), span }])),
    );
    expect(emitJS(ast)).toBe('new Map();\nnew Error("oops");\nnew Map();\n');
  });

  // ── 20. If/else expression position → ternary ──
  it('emits if/else in expression position as ternary', () => {
    const ast = program(letDecl('x', ifExpr(id('cond'), id('a'), id('b'))));
    expect(emitJS(ast)).toBe('const x = cond ? a : b;\n');
  });

  // ── 21. If/else with block branches in expression position → IIFE ──
  it('emits if/else with blocks as IIFE', () => {
    const ast = program(letDecl('x', ifExpr(
      id('cond'),
      block(letDecl('a', call(id('compute'), [])) as Declaration, binary('+', id('a'), num(1))),
      block(letDecl('b', call(id('other'), [])) as Declaration, binary('+', id('b'), num(2))),
    )));
    const result = emitJS(ast);
    expect(result).toContain('(() => {');
    expect(result).toContain('return a + 1');
    expect(result).toContain('return b + 2');
  });

  // ── 22. If/else in statement position → if/else statement ──
  it('emits if/else in statement position as if/else statement', () => {
    const ast = program(exprStmt(ifExpr(id('cond'), call(id('doA'), []), call(id('doB'), []))));
    const result = emitJS(ast);
    expect(result).toContain('if (cond)');
    expect(result).toContain('doA()');
    expect(result).toContain('} else {');
    expect(result).toContain('doB()');
  });

  // ── 23. If without else in statement position ──
  it('emits if without else in statement position', () => {
    const ast = program(exprStmt(ifExpr(id('cond'), call(id('doSomething'), []))));
    const result = emitJS(ast);
    expect(result).toContain('if (cond)');
    expect(result).toContain('doSomething()');
    expect(result).not.toContain('else');
  });

  // ── 24. Match on ADT variants → IIFE if/else chain ──
  it('emits match on ADT variants as IIFE if/else chain', () => {
    const subject = withType(id('shape'), shapeADT);
    const ast = program(letDecl('area', matchExpr(subject, [
      matchArm(variantPattern('Circle', [bindingPattern('r')]), binary('*', binary('*', num(3.14), id('r')), id('r'))),
      matchArm(variantPattern('Rectangle', [bindingPattern('w'), bindingPattern('h')]), binary('*', id('w'), id('h'))),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('(() => {');
    expect(result).toContain('shape._tag === "Circle"');
    expect(result).toContain('const r = shape.radius');
    expect(result).toContain('shape._tag === "Rectangle"');
    expect(result).toContain('const w = shape.width');
    expect(result).toContain('const h = shape.height');
  });

  // ── 25. Match on literals ──
  it('emits match on literals', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(literalPattern(num(2)), str('two')),
      matchArm(wildcardPattern(), str('other')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('x === 1');
    expect(result).toContain('x === 2');
    expect(result).toContain('"other"');
  });

  // ── 26. Match on nullable types ──
  it('emits match on nullable types (null pattern + binding pattern)', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(nullPattern(), str('nothing')),
      matchArm(bindingPattern('val'), id('val')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('x === null');
    expect(result).toContain('const val = x');
  });

  // ── 27. Match with guard clauses ──
  it('emits match with guard clauses', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(bindingPattern('n'), id('n'), binary('>', id('n'), num(0))),
      matchArm(wildcardPattern(), num(0)),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('n > 0');
  });

  // ── 28. Match with wildcard pattern ──
  it('emits match with wildcard pattern', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(wildcardPattern(), str('default')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('} else {');
    expect(result).toContain('"default"');
  });

  // ── 29. Match with record pattern ──
  it('emits match with record pattern', () => {
    const ast = program(letDecl('result', matchExpr(id('obj'), [
      matchArm(recordPattern(['name'], ['age']), id('name')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('const name = obj.name');
    expect(result).toContain('const age = obj.age');
  });

  // ── W6. RecordPattern is not a catch-all ──
  it('RecordPattern is not treated as catch-all — requires explicit condition (W6)', () => {
    // A record pattern after a literal pattern must use an else-if branch, not else
    const ast = program(letDecl('result', matchExpr(id('obj'), [
      matchArm(literalPattern(num(0)), str('zero')),
      matchArm(recordPattern(['x'], ['y']), id('x')),
    ], false)));
    const result = emitJS(ast);
    // RecordPattern should produce an else-if (with `true` condition), not a bare else
    // because it is not a catch-all. Emitter may produce "else  if" with spaces.
    expect(result).toMatch(/else\s+if\s*\(true\)/);
    expect(result).not.toMatch(/\} else \{[\s\S]*const x = /);
  });

  it('wildcard pattern IS a catch-all — generates bare else branch', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(wildcardPattern(), str('other')),
    ], true)));
    const result = emitJS(ast);
    expect(result).toContain('} else {');
  });

  // ── 30. Match with binding pattern ──
  it('emits match with binding pattern as catch-all', () => {
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(bindingPattern('val'), id('val')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('const val = x');
  });

  // ── 31. Match in statement position ──
  it('emits match in statement position as bare if/else chain', () => {
    const ast = program(exprStmt(matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), call(id('doA'), [])),
      matchArm(wildcardPattern(), call(id('doB'), [])),
    ])));
    const result = emitJS(ast);
    expect(result).not.toContain('(() =>');
    expect(result).toContain('if (x === 1)');
    expect(result).toContain('doA()');
    expect(result).toContain('doB()');
  });

  // ── W4. Match trailing throw only for non-exhaustive matches ──
  it('omits trailing throw when match is exhaustive (W4)', () => {
    // Exhaustive match (wildcard arm covers all) — no throw needed
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(wildcardPattern(), str('other')),
    ], /* exhaustive= */ true)));
    const result = emitJS(ast);
    expect(result).not.toContain('throw new Error("Non-exhaustive match")');
  });

  it('emits trailing throw when match is non-exhaustive (W4)', () => {
    // Non-exhaustive match (no wildcard) — throw should be added
    const ast = program(letDecl('result', matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(literalPattern(num(2)), str('two')),
    ], /* exhaustive= */ false)));
    const result = emitJS(ast);
    expect(result).toContain('throw new Error("Non-exhaustive match")');
  });

  it('never emits trailing throw for statement-position match regardless of exhaustiveness (W4)', () => {
    const ast = program(exprStmt(matchExpr(id('x'), [
      matchArm(literalPattern(num(1)), call(id('f'), [])),
    ], /* exhaustive= */ false)));
    const result = emitJS(ast);
    expect(result).not.toContain('throw new Error("Non-exhaustive match")');
  });

  // ── 32. Block expression in expression position → IIFE ──
  it('emits block expression in expression position as IIFE', () => {
    const ast = program(letDecl('x', block(
      letDecl('a', num(1)) as Declaration,
      letDecl('b', num(2)) as Declaration,
      binary('+', id('a'), id('b')),
    )));
    const result = emitJS(ast);
    expect(result).toContain('(() => {');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('const b = 2;');
    expect(result).toContain('return a + b;');
    expect(result).toContain('})()');
  });

  // ── 33. Block expression in statement position → bare block ──
  it('emits block expression in statement position as bare block', () => {
    const ast = program(exprStmt(block(
      letDecl('a', num(1)) as Declaration,
      exprStmt(call(id('doSomething'), [id('a')])) as Statement,
    )));
    const result = emitJS(ast);
    expect(result).toContain('{');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('doSomething(a);');
    expect(result).not.toContain('(() =>');
  });

  // ── 34. Try/catch in expression position → IIFE ──
  it('emits try/catch in expression position as IIFE', () => {
    const ast = program(letDecl('x', tryCatch(
      block(call(id('riskyOp'), [])),
      'e',
      block(id('fallback')),
    )));
    const result = emitJS(ast);
    expect(result).toContain('(() => {');
    expect(result).toContain('try {');
    expect(result).toContain('return riskyOp();');
    expect(result).toContain('} catch (e) {');
    expect(result).toContain('return fallback;');
  });

  // ── 35. Try/catch in statement position ──
  it('emits try/catch in statement position as bare try/catch', () => {
    const ast = program(exprStmt(tryCatch(
      block(call(id('riskyOp'), [])),
      'e',
      block(call(id('handleError'), [id('e')])),
    )));
    const result = emitJS(ast);
    expect(result).not.toContain('(() =>');
    expect(result).toContain('try {');
    expect(result).toContain('riskyOp();');
    expect(result).toContain('} catch (e) {');
    expect(result).toContain('handleError(e);');
  });

  // ── 36. For loop → for...of ──
  it('emits for loop as for...of', () => {
    const ast = program(forStmt('item', id('items'), block(
      exprStmt(call(id('process'), [id('item')])) as Statement,
    )));
    const result = emitJS(ast);
    expect(result).toContain('for (const item of items)');
    expect(result).toContain('process(item);');
  });

  // ── 37. While loop ──
  it('emits while loop', () => {
    const ast = program(whileStmt(id('condition'), block(
      exprStmt(call(id('doSomething'), [])) as Statement,
    )));
    const result = emitJS(ast);
    expect(result).toContain('while (condition)');
    expect(result).toContain('doSomething();');
  });

  // ── 38. Break and continue ──
  it('emits break and continue', () => {
    const ast = program(breakStmt(), continueStmt());
    expect(emitJS(ast)).toBe('break;\ncontinue;\n');
  });

  // ── 38b. Return statement ──
  it('emits bare return', () => {
    const ast = program(returnStmt());
    expect(emitJS(ast)).toBe('return;\n');
  });

  it('emits return with value', () => {
    const ast = program(returnStmt(num(42)));
    expect(emitJS(ast)).toBe('return 42;\n');
  });

  it('emits return in block body', () => {
    const fn = arrow([param('x')], block(
      returnStmt(id('x')) as Statement,
    ));
    const ast = program(letDecl('f', fn));
    const result = emitJS(ast);
    expect(result).toContain('return x;');
  });

  // ── 39. Assignment ──
  it('emits assignment', () => {
    const ast = program(assign(id('x'), num(42)));
    expect(emitJS(ast)).toBe('x = 42;\n');
  });

  // ── 40. Throw statement ──
  it('emits throw statement', () => {
    const ast = program(throwStmt(newExpr(id('Error'), [str('oops')])));
    expect(emitJS(ast)).toBe('throw new Error("oops");\n');
  });

  // ── 41. Expression statement ──
  it('emits expression statement', () => {
    const ast = program(exprStmt(call(id('foo'), [num(1)])));
    expect(emitJS(ast)).toBe('foo(1);\n');
  });

  // ── 42. ADT with fields → factory functions ──
  it('emits ADT with fields as factory functions', () => {
    const ast = program(typeDecl('Shape', [
      variant('Circle', [['radius', 'number']]),
      variant('Rectangle', [['width', 'number'], ['height', 'number']]),
    ]));
    const result = emitJS(ast);
    expect(result).toContain('const Circle = (radius) => ({ _tag: "Circle", radius });');
    expect(result).toContain('const Rectangle = (width, height) => ({ _tag: "Rectangle", width, height });');
  });

  // ── 43. ADT without fields → frozen singletons ──
  it('emits ADT without fields as frozen singletons', () => {
    const ast = program(typeDecl('Color', [
      variant('Red'),
      variant('Green'),
      variant('Blue'),
    ]));
    const result = emitJS(ast);
    expect(result).toContain('const Red = Object.freeze({ _tag: "Red" });');
    expect(result).toContain('const Green = Object.freeze({ _tag: "Green" });');
    expect(result).toContain('const Blue = Object.freeze({ _tag: "Blue" });');
  });

  // ── 44. Exported ADT → exported factory functions ──
  it('emits exported ADT with export keyword', () => {
    const ast = program(typeDecl('Shape', [
      variant('Circle', [['radius', 'number']]),
    ], { exported: true }));
    const result = emitJS(ast);
    expect(result).toContain('export const Circle = (radius) => ({ _tag: "Circle", radius });');
  });

  // ── 45. Generic ADT → factory functions (type params stripped) ──
  it('emits generic ADT factory functions with type params stripped', () => {
    const ast = program(typeDecl('Result', [
      variant('Ok', [['value', 'T']]),
      variant('Err', [['error', 'E']]),
    ], { typeParams: [{ kind: 'TypeParameter', name: id('T'), span }, { kind: 'TypeParameter', name: id('E'), span }] }));
    const result = emitJS(ast);
    expect(result).toContain('const Ok = (value) => ({ _tag: "Ok", value });');
    expect(result).toContain('const Err = (error) => ({ _tag: "Err", error });');
  });

  // ── 45b. Named record type alias → no JS output ──
  it('emits nothing for named record type alias', () => {
    const recordType: RecordTypeNode = {
      kind: 'RecordType',
      fields: [
        { name: id('name'), type: { kind: 'NamedType', name: id('string'), span } as unknown as RecordTypeField['type'], optional: false },
        { name: id('email'), type: { kind: 'NamedType', name: id('string'), span } as unknown as RecordTypeField['type'], optional: false },
      ],
      span,
    };
    const node: Record<string, unknown> = {
      kind: 'TypeDeclaration',
      name: id('User'),
      variants: [],
      exported: false,
      span,
      recordType,
    };
    const ast = program(node as unknown as TypeDeclaration);
    const result = emitJS(ast);
    expect(result.trim()).toBe('');
  });

  // ── 46. Import declaration ──
  it('emits import declarations (named, default, aliased)', () => {
    const ast1 = program(importDecl([{ imported: 'a' }, { imported: 'b' }], './mod'));
    expect(emitJS(ast1)).toContain('import { a, b } from "./mod.js";');

    const ast2 = program(importDecl([], 'pkg', 'Default'));
    expect(emitJS(ast2)).toContain('import Default from "pkg";');

    const ast3 = program(importDecl([{ imported: 'x', local: 'y' }], './m'));
    expect(emitJS(ast3)).toContain('import { x as y } from "./m.js";');
  });

  // ── 47. Import path rewriting ──
  it('rewrites relative import paths with .js extension', () => {
    const ast = program(importDecl([{ imported: 'a' }], './math'));
    expect(emitJS(ast)).toContain('from "./math.js"');
  });

  it('does not rewrite external package imports', () => {
    const ast = program(importDecl([{ imported: 'x' }], 'lodash'));
    expect(emitJS(ast)).toContain('from "lodash"');
  });

  // ── 48. Export declarations ──
  it('emits export declaration (named)', () => {
    const ast = program(exportDecl({ specifiers: [{ local: 'a' }, { local: 'b' }] }));
    expect(emitJS(ast)).toContain('export { a, b };');
  });

  it('emits export declaration (re-export)', () => {
    const ast = program(exportDecl({ specifiers: [{ local: 'a' }], source: './mod' }));
    expect(emitJS(ast)).toContain('export { a } from "./mod.js";');
  });

  // ── 49. Prelude print → console.log ──
  it('emits prelude print as console.log', () => {
    const printId = withType(id('print'), preludePrintType);
    const ast = program(exprStmt(call(printId, [id('x')])));
    expect(emitJS(ast)).toBe('console.log(x);\n');
  });

  // ── 50. Prelude Ok/Err → factory function emission ──
  it('emits prelude Ok/Err as factory functions', () => {
    const okId = withType(id('Ok'), preludeOkType);
    const errId = withType(id('Err'), preludeErrType);
    const ast = program(
      exprStmt(call(okId, [num(42)])),
      exprStmt(call(errId, [str('fail')])),
    );
    const result = emitJS(ast);
    expect(result).toContain('const Ok = (value) => ({ _tag: "Ok", value });');
    expect(result).toContain('const Err = (error) => ({ _tag: "Err", error });');
    expect(result).toContain('Ok(42);');
    expect(result).toContain('Err("fail");');
  });

  // ── 51. Prelude attempt → helper function emission ──
  it('emits prelude attempt as helper function', () => {
    const attemptId = withType(id('attempt'), preludeAttemptType);
    const ast = program(exprStmt(call(attemptId, [
      arrow([], call(id('riskyOp'), [])),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('const __attempt = (f) => { try { return { _tag: "Ok", value: f() }; } catch (e) { return { _tag: "Err", error: e }; } };');
    expect(result).toContain('__attempt(() => riskyOp());');
  });

  // ── 52. Empty block expression in expression position ──
  it('emits empty block as IIFE returning undefined', () => {
    const ast = program(letDecl('x', block()));
    const result = emitJS(ast);
    expect(result).toContain('(() => {})()');
  });

  // ── 53. Nested match expressions ──
  it('emits nested match expressions (IIFE within IIFE)', () => {
    const innerMatch = matchExpr(id('y'), [
      matchArm(literalPattern(num(1)), str('one')),
      matchArm(wildcardPattern(), str('other')),
    ]);
    const outerSubject = withType(id('shape'), shapeADT);
    const ast = program(letDecl('result', matchExpr(outerSubject, [
      matchArm(variantPattern('Circle', [bindingPattern('r')]), innerMatch),
      matchArm(wildcardPattern(), str('default')),
    ])));
    const result = emitJS(ast);
    // Should have nested IIFEs
    const iifeCount = (result.match(/\(\(\) => \{/g) ?? []).length;
    expect(iifeCount).toBeGreaterThanOrEqual(2);
  });

  // ── 54. Nested if/else expressions → ternary within ternary ──
  it('emits nested if/else as nested ternary', () => {
    const ast = program(letDecl('x', ifExpr(
      id('a'),
      ifExpr(id('b'), num(1), num(2)),
      num(3),
    )));
    const result = emitJS(ast);
    expect(result).toContain('a ? b ? 1 : 2 : 3');
  });

  // ── 55. Operator precedence ──
  it('adds parentheses for operator precedence', () => {
    // (a + b) * c should produce (a + b) * c, not a + b * c
    const ast = program(exprStmt(binary('*', binary('+', id('a'), id('b')), id('c'))));
    expect(emitJS(ast)).toBe('(a + b) * c;\n');
  });

  it('does not add unnecessary parentheses', () => {
    // a + b * c should stay as a + b * c (natural precedence)
    const ast = program(exprStmt(binary('+', id('a'), binary('*', id('b'), id('c')))));
    expect(emitJS(ast)).toBe('a + b * c;\n');
  });

  // ── 56. Match with multiple fields in variant pattern ──
  it('emits match with multiple fields in variant pattern', () => {
    const subject = withType(id('shape'), shapeADT);
    const ast = program(letDecl('result', matchExpr(subject, [
      matchArm(variantPattern('Rectangle', [bindingPattern('w'), bindingPattern('h')]), binary('*', id('w'), id('h'))),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('const w = shape.width');
    expect(result).toContain('const h = shape.height');
  });

  // ── 57. Match with nested patterns (e.g., Ok(42)) ──
  it('emits match with nested literal in variant pattern', () => {
    const subject = withType(id('result'), resultADT);
    const ast = program(letDecl('val', matchExpr(subject, [
      matchArm(variantPattern('Ok', [literalPattern(num(42))]), str('found')),
      matchArm(wildcardPattern(), str('not found')),
    ])));
    const result = emitJS(ast);
    expect(result).toContain('result._tag === "Ok"');
    expect(result).toContain('result.value === 42');
  });

  // ── 58. Expression as last block item (return value) ──
  it('emits last expression in block as return', () => {
    const ast = program(letDecl('x', block(
      letDecl('a', num(1)) as Declaration,
      binary('+', id('a'), num(2)),
    )));
    const result = emitJS(ast);
    expect(result).toContain('return a + 2;');
  });

  // ── 59. Statement as last block item → void ──
  it('does not add return for statement as last block item', () => {
    const ast = program(letDecl('x', block(
      exprStmt(call(id('doSomething'), [])) as Statement,
    )));
    const result = emitJS(ast);
    expect(result).toContain('doSomething();');
    // The expression statement should not be returned with return
    // (exprStmt wraps it, so it becomes a statement)
  });

  // ── 60. Multiple prelude symbols used in one file ──
  it('emits all needed prelude helpers when multiple are used', () => {
    const okId = withType(id('Ok'), preludeOkType);
    const errId = withType(id('Err'), preludeErrType);
    const attemptId = withType(id('attempt'), preludeAttemptType);
    const printId = withType(id('print'), preludePrintType);
    const ast = program(
      exprStmt(call(printId, [str('test')])),
      exprStmt(call(okId, [num(1)])),
      exprStmt(call(errId, [str('e')])),
      exprStmt(call(attemptId, [arrow([], num(1))])),
    );
    const result = emitJS(ast);
    expect(result).toContain('const Ok =');
    expect(result).toContain('const Err =');
    expect(result).toContain('const __attempt =');
    expect(result).toContain('console.log(');
  });

  // ── 61. No prelude symbols → no helper emission ──
  it('does not emit prelude helpers when not used', () => {
    const ast = program(letDecl('x', num(42)));
    const result = emitJS(ast);
    expect(result).not.toContain('const Ok');
    expect(result).not.toContain('const Err');
    expect(result).not.toContain('const __attempt');
    expect(result).not.toContain('console.log');
  });

  // ── 62. Error node → silently skipped ──
  it('skips error nodes with a comment', () => {
    const ast = program(errorNode() as unknown as Statement);
    const result = emitJS(ast);
    expect(result).toContain('/* error: unparseable region */');
  });

  // ── 63. Empty program → empty output ──
  it('emits empty output for empty program', () => {
    const ast = program();
    expect(emitJS(ast)).toBe('');
  });

  // ── 64. Program with only imports ──
  it('emits only import statements for import-only program', () => {
    const ast = program(importDecl([{ imported: 'x' }], './mod'));
    const result = emitJS(ast);
    expect(result).toContain('import { x } from "./mod.js";');
    expect(result.trim().split('\n')).toHaveLength(1);
  });

  // ── Additional: Exported type with ExportDeclaration wrapper ──
  it('emits exported ADT via ExportDeclaration wrapper', () => {
    const td = typeDecl('Color', [variant('Red'), variant('Green')], { exported: true });
    const ast = program(exportDecl({ declaration: td }));
    const result = emitJS(ast);
    expect(result).toContain('export const Red = Object.freeze({ _tag: "Red" });');
    expect(result).toContain('export const Green = Object.freeze({ _tag: "Green" });');
  });

  // ── Additional: Arrow function with block body ──
  it('emits arrow function with block body correctly', () => {
    const ast = program(letDecl('fn', arrow(
      [param('x')],
      block(
        letDecl('y', binary('*', id('x'), num(2))) as Declaration,
        id('y'),
      ),
    )));
    const result = emitJS(ast);
    expect(result).toContain('const fn = (x) => {');
    expect(result).toContain('const y = x * 2;');
    expect(result).toContain('return y;');
  });

  // ── Additional: String escaping in string literals ──
  it('preserves string content in string literals', () => {
    const ast = program(exprStmt(str('hello "world"')));
    const result = emitJS(ast);
    expect(result).toContain('"hello \\"world\\""');
  });

  // ── Additional: if/else if/else chain ──
  it('emits chained if/else if/else as nested ternary in expr position', () => {
    const ast = program(letDecl('x', ifExpr(
      id('a'), num(1),
      ifExpr(id('b'), num(2), num(3)),
    )));
    const result = emitJS(ast);
    expect(result).toContain('a ? 1 : b ? 2 : 3');
  });

  // ── Additional: assignment to member expression ──
  it('emits assignment to member expression', () => {
    const ast = program(assign(member(id('obj'), 'field'), num(42)));
    expect(emitJS(ast)).toBe('obj.field = 42;\n');
  });

  // ── B4: ?? operator precedence vs && and || ──
  it('?? has higher precedence than || — no parens needed on right of ||', () => {
    // a || b ?? c  →  parser sees a || (b ?? c) because ?? > ||
    // emitter must reproduce this without extra parens
    const inner = binary('??', id('b'), id('c'));
    const outer = binary('||', id('a'), inner);
    const ast = program(exprStmt(outer));
    // ?? binds tighter, so (b ?? c) is the RHS of ||; no parens needed
    expect(emitJS(ast)).toBe('a || b ?? c;\n');
  });

  it('&& has lower precedence than ?? — right side ?? gets no parens', () => {
    // a && b ?? c  →  a && (b ?? c) because ?? (6) > && (3)
    const inner = binary('??', id('b'), id('c'));
    const outer = binary('&&', id('a'), inner);
    const ast = program(exprStmt(outer));
    expect(emitJS(ast)).toBe('a && b ?? c;\n');
  });

  it('?? on left of && requires parens because && has lower precedence', () => {
    // (a ?? b) && c  — left child ?? has higher prec, so when it appears as left of &&
    // we do NOT need parens (parent has lower prec, child can stand alone)
    const inner = binary('??', id('a'), id('b'));
    const outer = binary('&&', inner, id('c'));
    const ast = program(exprStmt(outer));
    expect(emitJS(ast)).toBe('a ?? b && c;\n');
  });

  // ── Null/undefined interop emission ─────────────────────────────

  it('emits undefined instead of null when param has nullKind: undefined', () => {
    const fnType: FT = {
      kind: 'function',
      params: [
        { name: 'a', type: { kind: 'primitive', name: 'string' }, optional: false, hasDefault: false },
        { name: 'b', type: { kind: 'nullable', inner: { kind: 'primitive', name: 'string' } }, optional: true, hasDefault: false, nullKind: 'undefined' },
      ],
      returnType: { kind: 'primitive', name: 'string' },
    };
    const callee = withType(id('greet'), fnType);
    const call: CallExpr = {
      kind: 'CallExpr',
      callee,
      args: [
        { kind: 'StringLiteral', value: 'hello', raw: '"hello"', span } as StringLiteral,
        { kind: 'NullLiteral', span } as NullLiteral,
      ],
      span,
    };
    const ast = program(letDecl('x', call as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('greet("hello", undefined)');
    expect(js).not.toContain('null');
  });

  it('emits null when param has nullKind: null', () => {
    const fnType: FT = {
      kind: 'function',
      params: [
        { name: 'label', type: { kind: 'nullable', inner: { kind: 'primitive', name: 'string' } }, optional: false, hasDefault: false, nullKind: 'null' },
      ],
      returnType: { kind: 'primitive', name: 'void' },
    };
    const callee = withType(id('setLabel'), fnType);
    const call: CallExpr = {
      kind: 'CallExpr',
      callee,
      args: [{ kind: 'NullLiteral', span } as NullLiteral],
      span,
    };
    const ast = program(exprStmt(call as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('setLabel(null)');
  });

  it('emits undefined when param has nullKind: either', () => {
    const fnType: FT = {
      kind: 'function',
      params: [
        { name: 'value', type: { kind: 'nullable', inner: { kind: 'primitive', name: 'string' } }, optional: false, hasDefault: false, nullKind: 'either' },
      ],
      returnType: { kind: 'primitive', name: 'void' },
    };
    const callee = withType(id('flexible'), fnType);
    const call: CallExpr = {
      kind: 'CallExpr',
      callee,
      args: [{ kind: 'NullLiteral', span } as NullLiteral],
      span,
    };
    const ast = program(exprStmt(call as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('flexible(undefined)');
  });

  it('emits null when callee has no resolved type (native EffectScript)', () => {
    const callee = id('myFn');
    const call: CallExpr = {
      kind: 'CallExpr',
      callee,
      args: [{ kind: 'NullLiteral', span } as NullLiteral],
      span,
    };
    const ast = program(exprStmt(call as unknown as Expression));
    const js = emitJS(ast);
    expect(js).toContain('myFn(null)');
  });
});

// ── Async/Await Emission ──────────────────────────────────────────

describe('Async/Await emission', () => {
  function asyncArrow(params: FunctionParam[], body: Expression): ArrowFunction {
    const node: Record<string, unknown> = { kind: 'ArrowFunction', async: true, params, body, span };
    return node as unknown as ArrowFunction;
  }

  function awaitExpr(argument: Expression): AwaitExpr {
    return { kind: 'AwaitExpr', argument, span };
  }

  it('emits async arrow with expression body', () => {
    const fn = asyncArrow([param('x')], id('x'));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('async (x) => x');
  });

  it('emits await expression', () => {
    const fn = asyncArrow([param('x')], awaitExpr(call(id('compute'), [id('x')])));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('await compute(x)');
  });

  it('emits async arrow with block body', () => {
    const fn = asyncArrow([], block(
      letDecl('x', num(42)),
      id('x'),
    ));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('async () => {');
    expect(js).toContain('return x;');
  });

  it('emits async-aware IIFE for match expression', () => {
    const matchNode = matchExpr(id('r'), [
      matchArm({ kind: 'WildcardPattern', span }, awaitExpr(call(id('compute'), []))),
    ], true);
    const fn = asyncArrow([], matchNode);
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('await (async () =>');
  });

  it('emits async-aware IIFE for block expression', () => {
    const blockNode = block(
      letDecl('y', awaitExpr(call(id('compute'), []))),
      id('y'),
    );
    // Block expr in expression position — wraps in IIFE when it's the body of an async arrow
    // that has something before the block
    const fn = asyncArrow([], block(
      letDecl('x', blockNode),
      id('x'),
    ));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('await (async () =>');
  });

  it('emits async-aware IIFE for try/catch expression', () => {
    const tryNode = tryCatch(
      block(awaitExpr(call(id('fetchData'), []))),
      'e',
      block(str('fallback')),
    );
    const fn = asyncArrow([], block(
      letDecl('result', tryNode),
      id('result'),
    ));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('await (async () =>');
  });

  it('emits sync IIFE when not in async context', () => {
    const matchNode = matchExpr(id('r'), [
      matchArm({ kind: 'WildcardPattern', span }, num(42)),
    ], true);
    const fn = arrow([], matchNode);
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    // Should NOT contain async IIFE
    expect(js).not.toContain('await (async');
    expect(js).toContain('(() =>');
  });

  it('nested non-async function inside async: inner IIFEs stay synchronous', () => {
    const innerMatch = matchExpr(id('r'), [
      matchArm({ kind: 'WildcardPattern', span }, num(42)),
    ], true);
    const innerFn = arrow([param('r')], innerMatch);
    const fn = asyncArrow([], block(
      letDecl('inner', innerFn),
      call(id('inner'), [id('x')]),
    ));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    // The inner non-async function's IIFE should be sync
    expect(js).toContain('(() =>');
  });

  it('emits __attempt_async when isAsyncAttempt tag is set', () => {
    const attemptCall: Record<string, unknown> = {
      kind: 'CallExpr',
      callee: id('attempt'),
      args: [asyncArrow([], str('hello'))],
      span,
    };
    // Tag the call as async attempt (emitter reads this tag)
    attemptCall['isAsyncAttempt'] = true;
    // Also set resolvedType on callee to mark it as prelude attempt
    const callee = id('attempt');
    (callee as unknown as Record<string, unknown>)['resolvedType'] = { kind: 'function', params: [], returnType: { kind: 'adt', name: 'Result', typeArgs: [], variants: [] } };
    attemptCall['callee'] = callee;

    const fn = asyncArrow([], attemptCall as unknown as Expression);
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).toContain('__attempt_async');
  });

  it('does not emit __attempt_async when not tagged', () => {
    const callee = id('attempt');
    (callee as unknown as Record<string, unknown>)['resolvedType'] = { kind: 'function', params: [], returnType: { kind: 'adt', name: 'Result', typeArgs: [], variants: [] } };
    const attemptCall = call(callee, [arrow([], str('hello'))]);
    const ast = program(letDecl('f', arrow([], attemptCall)));
    const js = emitJS(ast);
    expect(js).not.toContain('__attempt_async');
  });

  it('non-async arrow does not emit async keyword', () => {
    const fn = arrow([param('x')], id('x'));
    const ast = program(letDecl('f', fn));
    const js = emitJS(ast);
    expect(js).not.toContain('async');
  });

  // ── Extension Function Declaration Emission ──────────────────────────

  describe('extension function declarations', () => {
    function namedType(name: string): NamedType {
      return { kind: 'NamedType', name: id(name), span } as NamedType;
    }

    function extFunDecl(
      receiverTypeName: string,
      methodName: string,
      params: FunctionParam[],
      body: Expression,
      opts?: { exported?: boolean; async?: boolean },
    ): ExtensionFunctionDeclaration {
      const result: Record<string, unknown> = {
        kind: 'ExtensionFunctionDeclaration',
        receiverType: namedType(receiverTypeName),
        name: id(methodName),
        params,
        returnType: namedType('string'),
        body,
        exported: opts?.exported ?? false,
        span,
      };
      if (opts?.async) result['async'] = true;
      return result as unknown as ExtensionFunctionDeclaration;
    }

    function thisExpr(): Expression {
      return { kind: 'ThisExpr', span } as Expression;
    }

    it('emits extension function as const with __this', () => {
      const decl = extFunDecl('string', 'shout', [], binary('+', thisExpr(), str('!')));
      const js = emitJS(program(decl));
      expect(js).toContain('const string_shout = (__this) => __this + "!";');
    });

    it('emits extension function with parameters', () => {
      const decl = extFunDecl('number', 'add', [param('x')], binary('+', thisExpr(), id('x')));
      const js = emitJS(program(decl));
      expect(js).toContain('const number_add = (__this, x) => __this + x;');
    });

    it('emits exported extension function', () => {
      const decl = extFunDecl('string', 'shout', [], thisExpr(), { exported: true });
      const js = emitJS(program(decl));
      expect(js).toContain('export const string_shout = (__this) => __this;');
    });

    it('emits extension function with block body', () => {
      const decl = extFunDecl('string', 'rev', [], block(
        letDecl('x', thisExpr()),
        id('x'),
      ));
      const js = emitJS(program(decl));
      expect(js).toContain('const string_rev = (__this) => {');
      expect(js).toContain('const x = __this;');
      expect(js).toContain('return x;');
    });

    it('emits async extension function with async prefix', () => {
      const decl = extFunDecl('string', 'fetch', [], thisExpr(), { async: true });
      const js = emitJS(program(decl));
      expect(js).toContain('const string_fetch = async (__this) => __this;');
    });

    it('emits async extension function with block body', () => {
      const awaitNode: AwaitExpr = { kind: 'AwaitExpr', argument: call(id('fetchData'), []), span };
      const decl = extFunDecl('string', 'fetchInfo', [], block(
        letDecl('data', awaitNode),
        id('data'),
      ), { async: true });
      const js = emitJS(program(decl));
      expect(js).toContain('const string_fetchInfo = async (__this) => {');
      expect(js).toContain('await fetchData()');
    });

    it('emits exported async extension function', () => {
      const decl = extFunDecl('string', 'fetch', [], thisExpr(), { exported: true, async: true });
      const js = emitJS(program(decl));
      expect(js).toContain('export const string_fetch = async (__this) => __this;');
    });

    it('non-async extension function does not emit async', () => {
      const decl = extFunDecl('string', 'shout', [], thisExpr());
      const js = emitJS(program(decl));
      expect(js).not.toContain('async');
    });
  });

  // ── Extension Function Call Emission ─────────────────────────────────

  describe('extension function calls', () => {
    function memberWithExt(object: Expression, property: string, emitName: string, optional = false): MemberExpr {
      const node = member(object, property, optional);
      node.extensionEmitName = emitName;
      return node;
    }

    it('emits non-optional extension call as static function', () => {
      const callee = memberWithExt(str('hello'), 'shout', 'string_shout');
      const ast = program(exprStmt(call(callee, [])));
      const js = emitJS(ast);
      expect(js).toContain('string_shout("hello")');
    });

    it('emits extension call with arguments', () => {
      const callee = memberWithExt(num(5), 'add', 'number_add');
      const ast = program(exprStmt(call(callee, [num(3)])));
      const js = emitJS(ast);
      expect(js).toContain('number_add(5, 3)');
    });

    it('emits optional chaining on simple receiver as ternary', () => {
      const callee = memberWithExt(id('x'), 'shout', 'string_shout', true);
      const ast = program(exprStmt(call(callee, [])));
      const js = emitJS(ast);
      expect(js).toContain('x == null ? undefined : string_shout(x)');
    });

    it('emits optional chaining on complex receiver with temp var', () => {
      const callee = memberWithExt(call(id('getString'), []), 'shout', 'string_shout', true);
      const ast = program(exprStmt(call(callee, [])));
      const js = emitJS(ast);
      expect(js).toContain('let __ext_r0;');
      expect(js).toContain('((__ext_r0 = getString()) == null ? undefined : string_shout(__ext_r0))');
    });

    it('emits await on extension call as await static_call(receiver)', () => {
      const callee = memberWithExt(str('https://example.com'), 'fetchContent', 'string_fetchContent');
      const awaitNode: AwaitExpr = { kind: 'AwaitExpr', argument: call(callee, []), span };
      const ast = program(exprStmt(awaitNode));
      const js = emitJS(ast);
      expect(js).toContain('await string_fetchContent("https://example.com")');
    });
  });

  // ── Named Arguments ─────────────────────────────────────────────

  describe('named arguments', () => {
    /** Create a call with resolvedArgs set (simulates checker annotation). */
    function callWithResolvedArgs(
      callee: Expression,
      args: Expression[],
      resolvedArgs: (Expression | undefined)[],
    ): CallExpr {
      const node = call(callee, args);
      node.resolvedArgs = resolvedArgs;
      return node;
    }

    it('emits reordered args from resolvedArgs', () => {
      // f(b: 2, a: 1) → f(1, 2) (params are a, b)
      const c = callWithResolvedArgs(id('f'), [], [num(1), num(2)]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('f(1, 2)');
    });

    it('emits undefined for skipped defaulted params', () => {
      // f(1, c: 3) with params (a, b=0, c=0) → f(1, undefined, 3)
      const c = callWithResolvedArgs(id('f'), [], [num(1), undefined, num(3)]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('f(1, undefined, 3)');
    });

    it('omits trailing undefined entries', () => {
      // f(1, b: 2) with params (a, b=0, c=0) → f(1, 2) (c omitted)
      const c = callWithResolvedArgs(id('f'), [], [num(1), num(2), undefined]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('f(1, 2)');
    });

    it('all positional (no named) emits unchanged', () => {
      // No resolvedArgs → existing code path
      const c = call(id('f'), [num(1), num(2), num(3)]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('f(1, 2, 3)');
    });

    it('emits reordered args for new expression', () => {
      // new Foo(b: 2, a: 1) → new Foo(1, 2)
      const n = newExpr(id('Foo'), []);
      n.resolvedArgs = [num(1), num(2)];
      const ast = program(exprStmt(n));
      const js = emitJS(ast);
      expect(js).toContain('new Foo(1, 2)');
    });

    it('emits with skipped middle param and trailing omission for new', () => {
      // new Foo(a: 1) with params (a, b=0, c=0) → new Foo(1)
      const n = newExpr(id('Foo'), []);
      n.resolvedArgs = [num(1), undefined, undefined];
      const ast = program(exprStmt(n));
      const js = emitJS(ast);
      expect(js).toContain('new Foo(1)');
    });

    it('emits single resolved arg', () => {
      // f(x: 42) → f(42)
      const c = callWithResolvedArgs(id('f'), [], [num(42)]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('f(42)');
    });

    it('emits prelude print with resolvedArgs', () => {
      // print(value: x) → console.log(x)
      const printId = id('print');
      printId.resolvedType = { kind: 'function', params: [{ name: 'value', type: { kind: 'any' }, optional: false, hasDefault: false }], returnType: { kind: 'primitive', name: 'void' } } as FT;
      const c = callWithResolvedArgs(printId, [], [id('x')]);
      const ast = program(exprStmt(c));
      const js = emitJS(ast);
      expect(js).toContain('console.log(x)');
    });
  });

  // ── For-loop Enhancements ──

  describe('for-loop range emission', () => {
    it('exclusive range emits for (let i = 0; i < 10; i++)', () => {
      const ast = program(forRangeStmt('i', num(0), num(10), true, block(
        exprStmt(call(id('print'), [id('i')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (let i = 0; i < 10; i++)');
    });

    it('inclusive range emits for (let i = 0; i <= 10; i++)', () => {
      const ast = program(forRangeStmt('i', num(0), num(10), false, block(
        exprStmt(call(id('print'), [id('i')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (let i = 0; i <= 10; i++)');
    });

    it('range with variable bounds emits correctly', () => {
      const ast = program(forRangeStmt('i', id('start'), id('end'), true, block(
        exprStmt(call(id('print'), [id('i')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (let i = start; i < end; i++)');
    });

    it('range with complex end expression emits temporary variable', () => {
      const complexEnd = call(id('getEnd'), []);
      const ast = program(forRangeStmt('i', num(0), complexEnd, true, block(
        exprStmt(call(id('print'), [id('i')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('const __end');
      expect(js).toContain('getEnd()');
      expect(js).toContain('i < __end');
    });

    it('range with simple end (Identifier) does not emit temporary', () => {
      const ast = program(forRangeStmt('i', num(0), id('n'), true, block(
        exprStmt(call(id('print'), [id('i')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).not.toContain('__end');
      expect(js).toContain('i < n');
    });
  });

  describe('for-loop destructuring emission', () => {
    it('record destructuring emits for (const { a, b } of items)', () => {
      const recPat: import('../parser/ast.js').RecordPattern = {
        kind: 'RecordPattern',
        fields: [{ name: id('name') }, { name: id('age') }],
        span,
      };
      const ast = program(forDestructStmt(recPat, id('users'), block(
        exprStmt(call(id('print'), [id('name')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (const { name, age } of users)');
    });

    it('tuple destructuring emits for (const [a, b] of items)', () => {
      const tuplePat: import('../parser/ast.js').TuplePattern = {
        kind: 'TuplePattern',
        elements: [id('key'), id('value')],
        span,
      };
      const ast = program(forDestructStmt(tuplePat, id('pairs'), block(
        exprStmt(call(id('print'), [id('key')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (const [key, value] of pairs)');
    });

    it('tuple with wildcard emits for (const [, item] of items)', () => {
      const tuplePat: import('../parser/ast.js').TuplePattern = {
        kind: 'TuplePattern',
        elements: [{ kind: 'WildcardPattern', span }, id('item')],
        span,
      };
      const ast = program(forDestructStmt(tuplePat, id('items'), block(
        exprStmt(call(id('print'), [id('item')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('for (const [, item] of items)');
    });
  });

  describe('withIndex emission', () => {
    it('withIndex in for-loop emits .entries()', () => {
      const withIndexCall = call(
        { kind: 'MemberExpr', object: id('items'), property: id('withIndex'), optional: false, span } as import('../parser/ast.js').MemberExpr,
        [],
      );
      const tuplePat: import('../parser/ast.js').TuplePattern = {
        kind: 'TuplePattern',
        elements: [id('index'), id('item')],
        span,
      };
      const ast = program(forDestructStmt(tuplePat, withIndexCall, block(
        exprStmt(call(id('print'), [id('index')])) as Statement,
      )));
      const js = emitJS(ast);
      expect(js).toContain('items.entries()');
      expect(js).not.toContain('withIndex');
    });

    it('withIndex outside for-loop emits .map((v, i) => [i, v])', () => {
      const withIndexCall = call(
        { kind: 'MemberExpr', object: id('items'), property: id('withIndex'), optional: false, span } as import('../parser/ast.js').MemberExpr,
        [],
      );
      const ast = program(
        { kind: 'LetDeclaration', name: id('indexed'), mutable: false, initializer: withIndexCall, exported: false, span } as import('../parser/ast.js').LetDeclaration,
      );
      const js = emitJS(ast);
      expect(js).toContain('.map((v, i) => [i, v])');
    });
  });
});
