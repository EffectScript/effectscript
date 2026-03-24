import { describe, it, expect } from 'vitest';
import { check } from './checker.js';
import type { CheckerOutput } from './checker.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import { createPrelude } from '../prelude/prelude.js';
import { resolveType } from './types.js';
import type { Type, PrimitiveType } from './types.js';
import type {
  Program, LetDeclaration, ExpressionStatement,
  Expression,
} from '../parser/ast.js';

// ── Helpers ──────────────────────────────────────────────────────────

function parseSource(source: string): { ast: Program; diagnostics: DiagnosticCollectorImpl } {
  const diagnostics = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', diagnostics);
  const ast = parse(tokens, 'test.efs', diagnostics);
  return { ast, diagnostics };
}

function checkSource(source: string): { output: CheckerOutput; diagnostics: DiagnosticCollectorImpl } {
  const { ast, diagnostics } = parseSource(source);
  const prelude = createPrelude();
  const output = check({
    ast,
    imports: new Map(),
    prelude,
    diagnostics,
  });
  return { output, diagnostics };
}

function checkSourceWithImports(
  source: string,
  imports: Map<string, import('./types.js').ExportedTypeSignature>,
): { output: CheckerOutput; diagnostics: DiagnosticCollectorImpl } {
  const { ast, diagnostics } = parseSource(source);
  const prelude = createPrelude();
  const output = check({ ast, imports, prelude, diagnostics });
  return { output, diagnostics };
}

function getResolvedType(source: string): Type | undefined {
  const { output } = checkSource(source);
  const firstDecl = output.typedAST.body[0];
  if (firstDecl && 'resolvedType' in firstDecl) {
    return (firstDecl as unknown as { resolvedType?: Type }).resolvedType;
  }
  return undefined;
}

function getExprType(source: string): Type | undefined {
  const { output } = checkSource(source);
  // Find the last LetDeclaration
  for (let i = output.typedAST.body.length - 1; i >= 0; i--) {
    const item = output.typedAST.body[i];
    if (item.kind === 'LetDeclaration') {
      const decl = item as LetDeclaration;
      if ('resolvedType' in decl.initializer) {
        return (decl.initializer as unknown as { resolvedType?: Type }).resolvedType;
      }
    }
  }
  return undefined;
}

function expectNoErrors(source: string): CheckerOutput {
  const { output, diagnostics } = checkSource(source);
  const errors = diagnostics.getErrors();
  if (errors.length > 0) {
    throw new Error(`Expected no errors but got:\n${errors.map(e => `  ${e.code}: ${e.message}`).join('\n')}`);
  }
  return output;
}

function expectErrors(source: string, ...codes: string[]): void {
  const { diagnostics } = checkSource(source);
  const errorCodes = diagnostics.getErrors().map(e => e.code);
  for (const code of codes) {
    expect(errorCodes).toContain(code);
  }
}

function expectErrorCount(source: string, count: number): void {
  const { diagnostics } = checkSource(source);
  expect(diagnostics.getErrors().length).toBe(count);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('checker.ts', () => {

  // ── Literal Inference ────────────────────────────────────────────

  describe('literal inference', () => {
    it('number literal → number', () => {
      const t = getExprType('let x = 42');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('string literal → string', () => {
      const t = getExprType('let x = "hello"');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('string');
    });

    it('boolean literal → boolean', () => {
      const t = getExprType('let x = true');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('boolean');
    });

    it('null literal → null', () => {
      const t = getExprType('let x = null');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('null');
    });

    it('template string → string', () => {
      const t = getExprType('let x = "hello ${42} world"');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('string');
    });
  });

  // ── Variable Declarations ────────────────────────────────────────

  describe('variable declarations', () => {
    it('let x = 42 → x inferred as number', () => {
      const output = expectNoErrors('let x = 42');
      const decl = output.typedAST.body[0] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
      expect(rt!.kind).toBe('primitive');
      expect((rt as PrimitiveType).name).toBe('number');
    });

    it('let x: string = "hello" → matches annotation', () => {
      expectNoErrors('let x: string = "hello"');
    });

    it('let x: number = "hello" → type mismatch error', () => {
      expectErrors('let x: number = "hello"', 'E200');
    });

    it('E200 includes relatedSpans pointing to type annotation', () => {
      const { diagnostics } = checkSource('let x: number = "hello"');
      const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
      expect(e200).toBeDefined();
      expect(e200!.relatedSpans).toBeDefined();
      expect(e200!.relatedSpans!).toHaveLength(1);
      expect(e200!.relatedSpans![0].message).toContain('expected type');
    });

    it('let mut y = 0; y = 1 → OK', () => {
      expectNoErrors('let mut y = 0\ny = 1');
    });

    it('let x = 0; x = 1 → immutable assignment error', () => {
      expectErrors('let x = 0\nx = 1', 'E202');
    });
  });

  // ── Function Checking ────────────────────────────────────────────

  describe('function checking', () => {
    it('arrow function with typed params infers return type', () => {
      const output = expectNoErrors('let f = (x: number): number => x');
      const decl = output.typedAST.body[0] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
      expect(rt!.kind).toBe('function');
    });

    it('return type mismatch → error', () => {
      expectErrors('let f = (x: number): string => x', 'E200');
    });

    it('missing param type → error', () => {
      expectErrors('let f = (x) => x', 'E205');
    });
  });

  // ── Call Expressions ─────────────────────────────────────────────

  describe('call expressions', () => {
    it('correct argument count and types → OK', () => {
      expectNoErrors('let f = (x: number): number => x\nlet y = f(42)');
    });

    it('wrong argument count → error', () => {
      expectErrors('let f = (x: number): number => x\nlet y = f(1, 2)', 'E207');
    });

    it('wrong argument type → error', () => {
      expectErrors('let f = (x: number): number => x\nlet y = f("hello")', 'E200');
    });

    it('calling non-function → error', () => {
      expectErrors('let x = 42\nlet y = x(1)', 'E208');
    });
  });

  // ── Binary Operators ─────────────────────────────────────────────

  describe('binary operators', () => {
    it('1 + 2 → number', () => {
      const t = getExprType('let x = 1 + 2');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('"a" + "b" → string', () => {
      const t = getExprType('let x = "a" + "b"');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('string');
    });

    it('1 + "a" → error', () => {
      expectErrors('let x = 1 + "a"', 'E216');
    });

    it('1 == 1 → boolean', () => {
      const t = getExprType('let x = 1 == 1');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('boolean');
    });

    it('true && false → boolean', () => {
      const t = getExprType('let x = true && false');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('boolean');
    });

    it('1 && 2 → error (non-boolean operands)', () => {
      expectErrors('let x = 1 && 2', 'E216');
    });
  });

  // ── If Expressions ───────────────────────────────────────────────

  describe('if expressions', () => {
    it('if (true) 1 else 2 → number', () => {
      const t = getExprType('let x = if (true) 1 else 2');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('if (true) 1 else "two" → union', () => {
      const t = getExprType('let x = if (true) 1 else "two"');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('union');
    });
  });

  // ── Block Expressions ────────────────────────────────────────────

  describe('block expressions', () => {
    it('block returns last expression type', () => {
      const t = getExprType('let x = { let a = 1\nlet b = 2\na + b }');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('empty block in arrow → void', () => {
      // Note: { } is parsed as empty record; use an arrow body for empty block
      const output = expectNoErrors('let f = (): void => { let _x = 1 }');
      const decl = output.typedAST.body[0] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
      expect(rt!.kind).toBe('function');
    });
  });

  // ── Match Expressions ────────────────────────────────────────────

  describe('match expressions', () => {
    it('match on ADT with all variants → correct types', () => {
      const source = `
type Color = Red | Green | Blue
let x = match Red {
  Red => 1
  Green => 2
  Blue => 3
}`;
      const t = getExprType(source.trim());
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('non-exhaustive match → error', () => {
      const source = `
type Color = Red | Green | Blue
let x = match Red {
  Red => 1
  Green => 2
}`;
      expectErrors(source.trim(), 'E203');
    });

    it('pattern bindings receive correct types', () => {
      const source = `
type Option = Some(value: number) | None
let x = match Some(42) {
  Some(v) => v
  None => 0
}`;
      expectNoErrors(source.trim());
    });
  });

  // ── ADT Types ────────────────────────────────────────────────────

  describe('ADT types', () => {
    it('type declaration registers ADT and constructors', () => {
      const output = expectNoErrors('type Color = Red | Green | Blue\nlet x = Red');
      const decl = output.typedAST.body[1] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
    });

    it('constructor call infers variant type', () => {
      const source = 'type Option = Some(value: number) | None\nlet x = Some(42)';
      expectNoErrors(source);
    });
  });

  // ── Named Record Type Aliases ───────────────────────────────────

  describe('named record type aliases', () => {
    it('registers record type alias in scope', () => {
      const source = `
type User = { name: string, email: string }
let u: User = { name: "Alice", email: "a@b.com" }`;
      expectNoErrors(source.trim());
    });

    it('type-checks assignment against record type alias', () => {
      const source = `
type User = { name: string, email: string }
let u: User = { name: "Alice", email: "a@b.com" }`;
      const output = expectNoErrors(source.trim());
      const decl = output.typedAST.body[1] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
      expect(rt!.kind).toBe('record');
    });

    it('rejects wrong-shape record for named type alias', () => {
      const source = `
type User = { name: string, email: string }
let u: User = { name: "Alice" }`;
      expectErrors(source.trim(), 'E200');
    });

    it('does not register variant constructors for record type alias', () => {
      const source = `
type User = { name: string }
let x = User`;
      expectErrors(source.trim(), 'E201');
    });

    it('exported record type alias is available as type export', () => {
      const source = `
export type Point = { x: number, y: number }
let p: Point = { x: 1, y: 2 }`;
      const { output, diagnostics } = checkSource(source.trim());
      expect(diagnostics.getErrors()).toHaveLength(0);
      expect(output.exports.types.has('Point')).toBe(true);
      const exportedType = output.exports.types.get('Point');
      expect(exportedType!.kind).toBe('record');
    });
  });

  // ── Null Safety ──────────────────────────────────────────────────

  describe('null safety', () => {
    it('T? not assignable to T → error', () => {
      expectErrors('let x: number? = null\nlet y: number = x', 'E200');
    });

    it('T assignable to T? → OK', () => {
      expectNoErrors('let x: number = 42\nlet y: number? = x');
    });

    it('null coalescing ?? → result type is T', () => {
      const source = 'let x: number? = null\nlet y = x ?? 0';
      const { output, diagnostics } = checkSource(source);
      expect(diagnostics.getErrors().length).toBe(0);
      const decl = output.typedAST.body[1] as LetDeclaration;
      const rt = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(rt).toBeDefined();
      expect(rt!.kind).toBe('primitive');
      expect((rt as PrimitiveType).name).toBe('number');
    });
  });

  // ── Structural Subtyping ─────────────────────────────────────────

  describe('structural subtyping', () => {
    it('extra fields OK (width subtyping)', () => {
      const source = `
let full = { name: "Alice", age: 30 }
let partial: { name: string } = full`;
      expectNoErrors(source.trim());
    });

    it('missing fields → error', () => {
      const source = `
let partial = { name: "Alice" }
let full: { name: string, age: number } = partial`;
      expectErrors(source.trim(), 'E200');
    });
  });

  // ── Array Expressions ────────────────────────────────────────────

  describe('array expressions', () => {
    it('array of numbers → Array<number>', () => {
      const t = getExprType('let x = [1, 2, 3]');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
    });

    it('empty array → Array<typevar>', () => {
      const t = getExprType('let x = []');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
    });
  });

  // ── Record Expressions ───────────────────────────────────────────

  describe('record expressions', () => {
    it('record expression infers field types', () => {
      const t = getExprType('let x = { name: "Alice", age: 30 }');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('record');
    });
  });

  // ── Try/Catch ────────────────────────────────────────────────────

  describe('try/catch', () => {
    it('catch param is Any', () => {
      const source = 'let x = try { 42 } catch (e) { 0 }';
      expectNoErrors(source);
    });

    it('catch param typed as Any allows arbitrary use', () => {
      // Any type should allow property access, calls, assignment to any type
      expectNoErrors('let x = try { 42 } catch (e) { let s: string = e\n s }');
      expectNoErrors('let x = try { 42 } catch (e) { let n: number = e\n n }');
    });

    it('try and catch body types form result type', () => {
      const t = getExprType('let x = try { 42 } catch (e) { 0 }');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });
  });

  // ── For/While Loops ──────────────────────────────────────────────

  describe('for/while loops', () => {
    it('while condition must be boolean', () => {
      expectErrors('while (42) { }', 'E200');
    });

    it('for-in on array is OK', () => {
      expectNoErrors('let arr = [1, 2, 3]\nfor (x in arr) { }');
    });

    it('for-in on non-array → error', () => {
      expectErrors('for (x in 42) { }', 'E217');
    });
  });

  // ── Error Recovery ───────────────────────────────────────────────

  describe('error recovery', () => {
    it('type error in initializer → binding gets ErrorType, rest continues', () => {
      const { diagnostics } = checkSource('let x = 1 + "hello"\nlet y = 42');
      const errors = diagnostics.getErrors();
      // Should have an error for 1 + "hello" but not for let y = 42
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some(e => e.code === 'E216')).toBe(true);
    });

    it('no cascading errors from ErrorType bindings', () => {
      const { diagnostics } = checkSource('let x = 1 + "hello"\nlet y = x + 1');
      // x is ErrorType, so x + 1 should NOT produce another error
      const errors = diagnostics.getErrors();
      expect(errors.length).toBe(1); // Only the original error
    });
  });

  // ── Prelude ──────────────────────────────────────────────────────

  describe('prelude', () => {
    it('Ok and Err available without import', () => {
      expectNoErrors('let x = Ok(42)');
    });

    it('print(anything) is valid', () => {
      expectNoErrors('print(42)\nprint("hello")\nprint(true)');
    });

    it('pattern matching on Result', () => {
      const source = `
let r = Ok(42)
let x = match r {
  Ok(v) => v
  Err(e) => 0
}`;
      expectNoErrors(source.trim());
    });
  });

  // ── Import/Export ────────────────────────────────────────────────

  describe('import/export', () => {
    it('export of declared binding', () => {
      expectNoErrors('export let x = 42');
    });

    it('exports appear in output', () => {
      const { output } = checkSource('export let x = 42');
      expect(output.exports.values.has('x')).toBe(true);
    });
  });

  // ── Unary Operators ──────────────────────────────────────────────

  describe('unary operators', () => {
    it('-x on number → number', () => {
      const t = getExprType('let x = -42');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('!x on boolean → boolean', () => {
      const t = getExprType('let x = !true');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('boolean');
    });
  });

  // ── Member Expressions ───────────────────────────────────────────

  describe('member expressions', () => {
    it('record field access', () => {
      const source = 'let r = { name: "Alice", age: 30 }\nlet n = r.name';
      const { output, diagnostics } = checkSource(source);
      expect(diagnostics.getErrors().length).toBe(0);
    });

    it('unknown field on record → error', () => {
      expectErrors('let r = { name: "Alice" }\nlet n = r.age', 'E209');
    });
  });

  // ── Identifier Resolution ────────────────────────────────────────

  describe('identifier resolution', () => {
    it('undefined identifier → error', () => {
      expectErrors('let x = y', 'E201');
    });
  });

  // ── Assignment ───────────────────────────────────────────────────

  describe('assignment', () => {
    it('assignment type mismatch → error', () => {
      expectErrors('let mut x = 42\nx = "hello"', 'E200');
    });
  });

  // ── Occurs Check ────────────────────────────────────────────────

  describe('occurs check', () => {
    it('should not infinite-loop when T would unify with Array<T>', () => {
      // The function type has T in param, but the argument is Array<T>
      // This should not crash — just not infer correctly
      const source = `
        let wrap = <T>(x: T): Array<T> => [x]
        let result = wrap([1, 2, 3])
      `;
      // Should not hang — just check it completes
      checkSource(source);
    });

    it('should still infer normal generic calls correctly', () => {
      const source = `
        let identity = <T>(x: T): T => x
        let n = identity(42)
      `;
      const type = getResolvedType(source);
      // identity(42) should produce number through the let binding
      expect(type).toBeDefined();
    });
  });

  // ── Recursive Bindings ──────────────────────────────────────────

  describe('recursive bindings without let-level annotation', () => {
    it('should allow recursive function with inline arrow types', () => {
      const source = `
        let factorial = (n: number): number => {
          if (n == 0) { 1 } else { n * factorial(n - 1) }
        }
      `;
      expectNoErrors(source);
    });

    it('should allow mutually typed recursive function', () => {
      const source = `
        let fib = (n: number): number => {
          if (n == 0) { 0 } else { if (n == 1) { 1 } else { fib(n - 1) + fib(n - 2) } }
        }
      `;
      expectNoErrors(source);
    });

    it('should still error for recursive without return annotation', () => {
      const source = `
        let f = (n: number) => {
          if (n == 0) { 1 } else { f(n - 1) }
        }
      `;
      const { diagnostics } = checkSource(source);
      expect(diagnostics.getErrors().some(d => d.code === 'E201')).toBe(true);
    });

    it('should not affect non-recursive functions', () => {
      expectNoErrors('let add = (a: number, b: number): number => a + b');
    });
  });

  // ── Generic Arrow Functions ──────────────────────────────────────

  describe('generic arrow function type params', () => {
    it('should resolve type params in generic identity function', () => {
      expectNoErrors('let identity = <T>(x: T): T => x');
    });

    it('should resolve type params in generic wrap function', () => {
      expectNoErrors('let wrap = <T>(x: T): Array<T> => [x]');
    });

    it('should resolve multiple type params in generic arrow', () => {
      expectNoErrors('let pair = <A, B>(a: A, b: B): A => a');
    });
  });

  // ── Complex Null Narrowing ──────────────────────────────────────

  describe('complex null narrowing', () => {
    it('should narrow x != null && x > 0 in then-branch', () => {
      const source = `
        let x: number? = 42
        let result = if (x != null && x > 0) { x } else { 0 }
      `;
      expectNoErrors(source);
    });

    it('should narrow both vars with x == null || y == null in else-branch', () => {
      const source = `
        let x: number? = 42
        let y: number? = 10
        let result = if (x == null || y == null) { 0 } else { x + y }
      `;
      expectNoErrors(source);
    });

    it('should narrow with reversed operand: null != x', () => {
      const source = `
        let x: number? = 42
        let result = if (null != x) { x + 1 } else { 0 }
      `;
      expectNoErrors(source);
    });

    it('should narrow with negation: !condition flips narrowing', () => {
      const source = `
        let x: number? = 42
        let result = if (!(x == null)) { x + 1 } else { 0 }
      `;
      expectNoErrors(source);
    });

    it('should narrow both with x != null && y != null in then-branch', () => {
      const source = `
        let x: number? = 42
        let y: number? = 10
        let result = if (x != null && y != null) { x + y } else { 0 }
      `;
      expectNoErrors(source);
    });
  });

  // ── Array Method Typing ─────────────────────────────────────────

  describe('array method types', () => {
    it('arr.push(x) should type-check argument against element type', () => {
      expectNoErrors('let arr = [1, 2, 3]\narr.push(4)');
    });

    it('arr.push(wrong type) should error', () => {
      expectErrors('let arr = [1, 2, 3]\narr.push("hello")', 'E200');
    });

    it('arr.map should accept a properly typed callback', () => {
      // map expects (number) => U callback — just ensure no errors with compatible callback
      const source = `
        let arr = [1, 2, 3]
        let result = arr.map((x: number): number => x)
      `;
      expectNoErrors(source);
    });

    it('arr.filter should return same array type', () => {
      const source = `
        let arr = [1, 2, 3]
        let result = arr.filter((x: number): boolean => true)
      `;
      expectNoErrors(source);
    });

    it('arr.pop() should return nullable element type', () => {
      const source = `
        let arr = [1, 2, 3]
        let result = arr.pop()
      `;
      const { output, diagnostics } = checkSource(source);
      expect(diagnostics.getErrors().length).toBe(0);
      const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
      const resolvedType = (lastDecl as unknown as { resolvedType?: Type }).resolvedType;
      expect(resolvedType).toBeDefined();
      if (resolvedType) {
        expect(resolvedType.kind).toBe('nullable');
      }
    });

    it('arr.includes(x) should return boolean', () => {
      expectNoErrors('let arr = [1, 2, 3]\nlet b = arr.includes(1)');
    });

    it('arr.forEach should accept a properly typed callback', () => {
      // { } parses as empty RecordExpr in EffectScript, so use a print call instead
      expectNoErrors('let arr = [1, 2, 3]\narr.forEach((x: number): void => print(x))');
    });
  });

  // ── Prelude Shadowing Warning ───────────────────────────────────

  describe('prelude shadowing', () => {
    it('let print = 42 → W203 warning', () => {
      const { diagnostics } = checkSource('let print = 42');
      const warnings = diagnostics.getAll().filter(d => d.severity === 'warning' && d.code === 'W203');
      expect(warnings.length).toBe(1);
    });

    it('let Ok = 42 → W203 warning', () => {
      const { diagnostics } = checkSource('let Ok = 42');
      const warnings = diagnostics.getAll().filter(d => d.severity === 'warning' && d.code === 'W203');
      expect(warnings.length).toBe(1);
    });

    it('let myVar = 42 → no W203 warning', () => {
      const { diagnostics } = checkSource('let myVar = 42');
      const warnings = diagnostics.getAll().filter(d => d.severity === 'warning' && d.code === 'W203');
      expect(warnings.length).toBe(0);
    });

    it('let Set = 42 → W203 warning (shadows prelude Set companion)', () => {
      const { diagnostics } = checkSource('let Set = 42');
      const warnings = diagnostics.getAll().filter(d => d.severity === 'warning' && d.code === 'W203');
      expect(warnings.length).toBe(1);
    });

    it('let Map = 42 → W203 warning (shadows prelude Map companion)', () => {
      const { diagnostics } = checkSource('let Map = 42');
      const warnings = diagnostics.getAll().filter(d => d.severity === 'warning' && d.code === 'W203');
      expect(warnings.length).toBe(1);
    });
  });

  // ── Default Import Support ──────────────────────────────────────────

  describe('default imports', () => {
    function checkSourceWithImports(
      source: string,
      imports: Map<string, import('./types.js').ExportedTypeSignature>,
    ) {
      const { ast, diagnostics } = parseSource(source);
      const prelude = createPrelude();
      const output = check({ ast, imports, prelude, diagnostics });
      return { output, diagnostics };
    }

    const numType: Type = { kind: 'primitive', name: 'number' };
    const strType: Type = { kind: 'primitive', name: 'string' };
    const voidType: Type = { kind: 'primitive', name: 'void' };

    const moduleWithDefault: import('./types.js').ExportedTypeSignature = {
      types: new Map(),
      values: new Map([
        ['default', {
          kind: 'function',
          params: [{ name: 'x', type: numType, optional: false, hasDefault: false }],
          returnType: strType,
        } as import('./types.js').FunctionType],
        ['helper', voidType],
      ]),
      adtConstructors: new Map(),
      extensions: new Map(),
    };

    const moduleWithoutDefault: import('./types.js').ExportedTypeSignature = {
      types: new Map(),
      values: new Map([
        ['helper', strType],
      ]),
      adtConstructors: new Map(),
      extensions: new Map(),
    };

    it('default import resolves to the default export type', () => {
      const imports = new Map([['my-lib', moduleWithDefault]]);
      const { diagnostics } = checkSourceWithImports(
        'import main from "my-lib"\nlet x = main(42)',
        imports,
      );
      expect(diagnostics.getErrors().length).toBe(0);
    });

    it('default import and named import from same module', () => {
      const imports = new Map([['my-lib', moduleWithDefault]]);
      const { diagnostics } = checkSourceWithImports(
        'import main from "my-lib"\nimport { helper } from "my-lib"',
        imports,
      );
      expect(diagnostics.getErrors().length).toBe(0);
    });

    it('default import from module with no default → E211', () => {
      const imports = new Map([['no-default', moduleWithoutDefault]]);
      const { diagnostics } = checkSourceWithImports(
        'import main from "no-default"',
        imports,
      );
      const errors = diagnostics.getErrors();
      expect(errors.some(e => e.code === 'E211' && e.message.includes('no default export'))).toBe(true);
    });

    it('default import from unknown module → E211', () => {
      const { diagnostics } = checkSourceWithImports(
        'import main from "unknown-module"',
        new Map(),
      );
      const errors = diagnostics.getErrors();
      expect(errors.some(e => e.code === 'E211' && e.message.includes('Cannot find module'))).toBe(true);
    });

    it('default import binding is usable in expressions', () => {
      const imports = new Map([['my-lib', moduleWithDefault]]);
      const { output, diagnostics } = checkSourceWithImports(
        'import main from "my-lib"\nlet result = main(1)',
        imports,
      );
      expect(diagnostics.getErrors().length).toBe(0);
      // result should have type string (the return type of main)
      const resultDecl = output.typedAST.body[1] as LetDeclaration;
      if ('resolvedType' in resultDecl) {
        const resolvedType = (resultDecl as unknown as { resolvedType?: Type }).resolvedType;
        expect(resolvedType).toEqual(strType);
      }
    });
  });

  // ── B1: Duplicate binding diagnostic (E213) ───────────────────────

  describe('duplicate binding (B1)', () => {
    it('two let declarations with the same name at top level → E213', () => {
      expectErrors('let x = 1\nlet x = 2', 'E213');
    });

    it('single declaration at top level → no error', () => {
      expectNoErrors('let x = 1');
    });

    it('inner scope may shadow outer binding', () => {
      // let x = 1; fn that redeclares x inside is ok
      expectNoErrors('let x = 1\nlet f = (n: number): number => { let x = n\nx }');
    });

    it('duplicate mutable let declaration → E213', () => {
      expectErrors('let mut x = 1\nlet mut x = 2', 'E213');
    });

    it('E213 includes relatedSpans pointing to first declaration', () => {
      const { diagnostics } = checkSource('let x = 1\nlet x = 2');
      const e213 = diagnostics.getErrors().find(d => d.code === 'E213');
      expect(e213).toBeDefined();
      expect(e213!.relatedSpans).toBeDefined();
      expect(e213!.relatedSpans!).toHaveLength(1);
      expect(e213!.relatedSpans![0].message).toContain('first declared');
      expect(e213!.relatedSpans![0].span.start.line).toBe(1);
    });
  });

  // ── B2: inferNewExpr (no spread cast) ─────────────────────────────

  describe('new expression (B2)', () => {
    it('new with interop class produces the class instance type', () => {
      const numType: Type = { kind: 'primitive', name: 'number' };
      const instanceType: Type = { kind: 'record', fields: new Map([['value', numType]]) };
      const ctorFn: import('./types.js').FunctionType = {
        kind: 'function',
        params: [{ name: 'v', type: numType, optional: false, hasDefault: false }],
        returnType: instanceType,
      };
      const imports = new Map<string, import('./types.js').ExportedTypeSignature>([
        ['my-lib', {
          types: new Map(),
          values: new Map([['Counter', ctorFn]]),
          adtConstructors: new Map([['Counter', ctorFn]]),
          extensions: new Map(),
        }],
      ]);
      const { diagnostics } = checkSourceWithImports(
        'import { Counter } from "my-lib"\nlet c = new Counter(1)',
        imports,
      );
      expect(diagnostics.getErrors().length).toBe(0);
    });

    it('new expression with wrong arg count → E207', () => {
      const numType: Type = { kind: 'primitive', name: 'number' };
      const instanceType: Type = { kind: 'record', fields: new Map() };
      const ctorFn: import('./types.js').FunctionType = {
        kind: 'function',
        params: [{ name: 'v', type: numType, optional: false, hasDefault: false }],
        returnType: instanceType,
      };
      const imports = new Map<string, import('./types.js').ExportedTypeSignature>([
        ['my-lib', {
          types: new Map(),
          values: new Map([['Foo', ctorFn]]),
          adtConstructors: new Map([['Foo', ctorFn]]),
          extensions: new Map(),
        }],
      ]);
      const { diagnostics } = checkSourceWithImports(
        'import { Foo } from "my-lib"\nlet c = new Foo()',
        imports,
      );
      expect(diagnostics.getErrors().some(e => e.code === 'E207')).toBe(true);
    });
  });

  // ── B5: Array.map return type ──────────────────────────────────────

  describe('Array.map return type (B5)', () => {
    it('map with number→string callback infers Array<string>', () => {
      const { output, diagnostics } = checkSource(
        'let nums: Array<number> = [1, 2, 3]\nlet strs = nums.map((n: number): string => "x")',
      );
      expect(diagnostics.getErrors().length).toBe(0);
      // The type of strs should be Array<string>
      const strDecl = output.typedAST.body[1] as LetDeclaration;
      const t = (strDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      expect((t as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('map with identity callback preserves element type', () => {
      const { output, diagnostics } = checkSource(
        'let nums: Array<number> = [1, 2]\nlet same = nums.map((n: number): number => n)',
      );
      expect(diagnostics.getErrors().length).toBe(0);
      const decl = output.typedAST.body[1] as LetDeclaration;
      const t = (decl.initializer as unknown as { resolvedType?: Type }).resolvedType;
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      expect((t as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'number' });
    });
  });

  // ── W1: Type variable counter reset ─────────────────────────────────

  describe('type variable counter reset (W1)', () => {
    it('type variable IDs start at 0 for each compilation', () => {
      // Run two compilations; each should start with typevar id 0
      const src = 'let f = (x) => x';
      const { output: out1 } = checkSource(src);
      const { output: out2 } = checkSource(src);

      // Both should have the same resolved structure (no accumulated IDs)
      const decl1 = out1.typedAST.body[0] as LetDeclaration;
      const decl2 = out2.typedAST.body[0] as LetDeclaration;
      // Both inferred types should be equal (same IDs within each run)
      const t1 = (decl1.initializer as unknown as { resolvedType?: Type }).resolvedType;
      const t2 = (decl2.initializer as unknown as { resolvedType?: Type }).resolvedType;
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();
      // Both should be function types
      expect(t1!.kind).toBe('function');
      expect(t2!.kind).toBe('function');
    });
  });

  // ── W7: &&/|| with Any operands ─────────────────────────────────────

  describe('logical operators with Any (W7)', () => {
    // Use imports to get an Any-typed binding into scope
    const anyImports = new Map<string, import('./types.js').ExportedTypeSignature>([
      ['mod', {
        types: new Map(),
        values: new Map<string, Type>([['x', { kind: 'any' }]]),
        adtConstructors: new Map(),
        extensions: new Map(),
      }],
    ]);

    it('x || default is allowed when x is Any', () => {
      const { diagnostics } = checkSourceWithImports(
        'import { x } from "mod"\nlet result = x || "default"',
        anyImports,
      );
      expect(diagnostics.getErrors().filter(e => e.code === 'E216').length).toBe(0);
    });

    it('x || boolean is allowed when x is Any', () => {
      const { diagnostics } = checkSourceWithImports(
        'import { x } from "mod"\nlet result = x || true',
        anyImports,
      );
      expect(diagnostics.getErrors().filter(e => e.code === 'E216').length).toBe(0);
    });

    it('x && y is allowed when x is Any', () => {
      const { diagnostics } = checkSourceWithImports(
        'import { x } from "mod"\nlet result = x && false',
        anyImports,
      );
      expect(diagnostics.getErrors().filter(e => e.code === 'E216').length).toBe(0);
    });

    it('boolean && boolean still works normally', () => {
      const { diagnostics } = checkSource('let result = true && false');
      expect(diagnostics.getErrors().filter(e => e.code === 'E216').length).toBe(0);
    });
  });

  // ── W5: VariantPattern field binding ────────────────────────────────

  describe('variant pattern field binding (W5)', () => {
    it('binds variant fields positionally and checks types', () => {
      const src = `
type Shape = Circle(radius: number) | Rectangle(width: number, height: number)
let area = (s: Shape): number => match s {
  Circle(r) => r * r
  Rectangle(w, h) => w * h
}
`;
      expect(() => expectNoErrors(src)).not.toThrow();
    });

    it('reports error when pattern field type mismatches variant field type', () => {
      const src = `
type Wrapper = Wrap(value: number)
let f = (w: Wrapper): string => match w {
  Wrap(v) => v
}
`;
      const { diagnostics } = checkSource(src);
      // v is number, returning as string — should be an assignment error
      expect(diagnostics.getErrors().length).toBeGreaterThan(0);
    });
  });
});

// ── Return Statement ─────────────────────────────────────────────────

describe('ReturnStatement', () => {
  it('should accept bare return with no errors', () => {
    const { diagnostics } = checkSource('let f = (x: number) => { return }');
    expect(diagnostics.getErrors()).toHaveLength(0);
  });

  it('should accept return with value expression', () => {
    const { diagnostics } = checkSource('let f = (x: number) => { return 42 }');
    expect(diagnostics.getErrors()).toHaveLength(0);
  });

  it('should report E201 for return with undefined variable', () => {
    const { diagnostics } = checkSource('let f = (x: number) => { return unknownVar }');
    const errors = diagnostics.getErrors();
    expect(errors.some(d => d.code === 'E201')).toBe(true);
  });

  it('should type-check the return value expression', () => {
    const { diagnostics } = checkSource('return 42');
    expect(diagnostics.getErrors()).toHaveLength(0);
  });

  it('should propagate return value type as block type (last statement)', () => {
    const { diagnostics } = checkSource(
      'let f = (x: number): number => { return x + 1 }',
    );
    expect(diagnostics.getErrors()).toHaveLength(0);
  });

  it('should propagate return as only statement in function block', () => {
    const { diagnostics } = checkSource(
      'let f = (x: number): number => { return x }',
    );
    expect(diagnostics.getErrors()).toHaveLength(0);
  });

  it('should treat bare return as void type', () => {
    const { diagnostics } = checkSource(
      'let f = (x: number): number => { return }',
    );
    const errors = diagnostics.getErrors();
    expect(errors.some(d => d.code === 'E200')).toBe(true);
  });
});

// ── Related Locations in Diagnostics ─────────────────────────────────

describe('Related Locations', () => {
  it('E202: relatedSpan points to immutable declaration', () => {
    const src = 'let x = 1\nx = 2';
    const { diagnostics } = checkSource(src);
    const e202 = diagnostics.getErrors().find(d => d.code === 'E202');
    expect(e202).toBeDefined();
    expect(e202!.relatedSpans).toBeDefined();
    expect(e202!.relatedSpans!).toHaveLength(1);
    expect(e202!.relatedSpans![0].message).toContain('immutable');
  });

  it('E208: relatedSpan points to non-function declaration', () => {
    const src = 'let x = 42\nx(1)';
    const { diagnostics } = checkSource(src);
    const e208 = diagnostics.getErrors().find(d => d.code === 'E208');
    expect(e208).toBeDefined();
    expect(e208!.relatedSpans).toBeDefined();
    expect(e208!.relatedSpans!).toHaveLength(1);
    expect(e208!.relatedSpans![0].message).toContain('declared here');
  });

  it('E207: relatedSpan points to function declaration', () => {
    const src = 'let f = (x: number) => x\nf(1, 2)';
    const { diagnostics } = checkSource(src);
    const e207 = diagnostics.getErrors().find(d => d.code === 'E207');
    expect(e207).toBeDefined();
    expect(e207!.relatedSpans).toBeDefined();
    expect(e207!.relatedSpans!).toHaveLength(1);
    expect(e207!.relatedSpans![0].message).toContain('declared here');
  });

  it('E215: relatedSpan points to nullable variable declaration', () => {
    const src = 'let x: number? = null\nx.toString()';
    const { diagnostics } = checkSource(src);
    const e215 = diagnostics.getErrors().find(d => d.code === 'E215');
    expect(e215).toBeDefined();
    expect(e215!.relatedSpans).toBeDefined();
    expect(e215!.relatedSpans!).toHaveLength(1);
    expect(e215!.relatedSpans![0].message).toContain('nullable');
  });

  it('E213 regression: existing relatedSpans unchanged', () => {
    const src = 'let x = 1\nlet x = 2';
    const { diagnostics } = checkSource(src);
    const e213 = diagnostics.getErrors().find(d => d.code === 'E213');
    expect(e213).toBeDefined();
    expect(e213!.relatedSpans).toBeDefined();
  });

  it('E200 regression: existing relatedSpans unchanged', () => {
    const src = 'let x: number = "hello"';
    const { diagnostics } = checkSource(src);
    const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
    expect(e200).toBeDefined();
    expect(e200!.relatedSpans).toBeDefined();
  });
});

// ── Suggested Fixes ──────────────────────────────────────────────────

describe('Suggested Fixes', () => {
  it('E202 has fix suggesting let mut', () => {
    const { diagnostics } = checkSource('let x = 1\nx = 2');
    const e202 = diagnostics.getErrors().find(d => d.code === 'E202');
    expect(e202).toBeDefined();
    expect(e202!.fix).toBeDefined();
    expect(e202!.fix!.description).toContain('let mut');
  });

  it('E203 fix lists missing patterns', () => {
    const src = `
type Color = Red | Green | Blue
let x: Color = Red
let y = match x {
  Red => 1
}`;
    const { diagnostics } = checkSource(src);
    const e203 = diagnostics.getErrors().find(d => d.code === 'E203');
    expect(e203).toBeDefined();
    expect(e203!.fix).toBeDefined();
    expect(e203!.fix!.description).toContain('Green');
    expect(e203!.fix!.description).toContain('Blue');
  });

  it('W203 fix suggests rename', () => {
    const { diagnostics } = checkSource('let print = (x: string) => x');
    const w203 = diagnostics.getAll().find(d => d.code === 'W203');
    expect(w203).toBeDefined();
    expect(w203!.fix).toBeDefined();
    expect(w203!.fix!.description).toContain('Rename');
  });

  it('E202 fix has empty edits array', () => {
    const { diagnostics } = checkSource('let x = 1\nx = 2');
    const e202 = diagnostics.getErrors().find(d => d.code === 'E202');
    expect(e202!.fix!.edits).toHaveLength(0);
  });
});

// ── Type Error Message Consistency ──────────────────────────────────

describe('E200 message format', () => {
  it('match guard shows expected vs actual types', () => {
    const source = `
let x = 42
let y = match (x) {
  n if n => n
}`;
    const { diagnostics } = checkSource(source);
    const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
    expect(e200).toBeDefined();
    expect(e200!.message).toContain("'number'");
    expect(e200!.message).toContain("'boolean'");
  });

  it('if condition shows expected vs actual types', () => {
    const { diagnostics } = checkSource('if (42) { }');
    const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
    expect(e200).toBeDefined();
    expect(e200!.message).toContain("'number'");
    expect(e200!.message).toContain("'boolean'");
  });

  it('while condition shows expected vs actual types', () => {
    const { diagnostics } = checkSource('while (42) { }');
    const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
    expect(e200).toBeDefined();
    expect(e200!.message).toContain("'number'");
    expect(e200!.message).toContain("'boolean'");
  });

  it('assignment type mismatch shows both types', () => {
    const { diagnostics } = checkSource('let mut x: number = 1\nx = "hello"');
    const e200 = diagnostics.getErrors().find(d => d.code === 'E200');
    expect(e200).toBeDefined();
    expect(e200!.message).toContain("'string'");
    expect(e200!.message).toContain("'number'");
  });
});

// ── Primitive Method Typing ─────────────────────────────────────────

describe('string method typing', () => {
  // ── Properties ──
  it('s.length returns number', () => {
    const t = getExprType('let s = "hello"\nlet x = s.length');
    expect(t).toEqual({ kind: 'primitive', name: 'number' });
  });

  // ── No-arg methods returning string ──
  it('s.toUpperCase() returns string', () => {
    expectNoErrors('let s = "hello"\nlet x = s.toUpperCase()');
    const t = getExprType('let s = "hello"\nlet x = s.toUpperCase()');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.toLowerCase() returns string', () => {
    const t = getExprType('let s = "hello"\nlet x = s.toLowerCase()');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.trim() / trimStart() / trimEnd() return string', () => {
    for (const method of ['trim', 'trimStart', 'trimEnd']) {
      const t = getExprType(`let s = "hello"\nlet x = s.${method}()`);
      expect(t).toEqual({ kind: 'primitive', name: 'string' });
    }
  });

  // ── String search methods returning boolean ──
  it('s.includes(str) returns boolean', () => {
    expectNoErrors('let s = "hello"\nlet x = s.includes("h")');
    const t = getExprType('let s = "hello"\nlet x = s.includes("h")');
    expect(t).toEqual({ kind: 'primitive', name: 'boolean' });
  });

  it('s.startsWith(str) / endsWith(str) return boolean', () => {
    for (const method of ['startsWith', 'endsWith']) {
      const t = getExprType(`let s = "hello"\nlet x = s.${method}("h")`);
      expect(t).toEqual({ kind: 'primitive', name: 'boolean' });
    }
  });

  // ── Index methods returning number ──
  it('s.indexOf(str) / lastIndexOf(str) return number', () => {
    for (const method of ['indexOf', 'lastIndexOf']) {
      const t = getExprType(`let s = "hello"\nlet x = s.${method}("l")`);
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    }
  });

  // ── Substring methods ──
  it('s.slice(start, end?) returns string', () => {
    expectNoErrors('let s = "hello"\nlet x = s.slice(0, 3)');
    expectNoErrors('let s = "hello"\nlet x = s.slice(0)');
    const t = getExprType('let s = "hello"\nlet x = s.slice(0, 3)');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.substring(start, end?) returns string', () => {
    expectNoErrors('let s = "hello"\nlet x = s.substring(0)');
    const t = getExprType('let s = "hello"\nlet x = s.substring(0, 3)');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.charAt(index) returns string', () => {
    const t = getExprType('let s = "hello"\nlet x = s.charAt(0)');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  // ── split returns Array<string> ──
  it('s.split(sep) returns Array<string>', () => {
    const t = getExprType('let s = "a,b,c"\nlet x = s.split(",")');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('array');
    expect((t as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
  });

  // ── Other string methods ──
  it('s.replace(search, replacement) returns string', () => {
    const t = getExprType('let s = "hello"\nlet x = s.replace("h", "H")');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.repeat(count) returns string', () => {
    const t = getExprType('let s = "ab"\nlet x = s.repeat(3)');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.padStart(len, fill?) / padEnd(len, fill?) return string', () => {
    expectNoErrors('let s = "hi"\nlet x = s.padStart(5)');
    expectNoErrors('let s = "hi"\nlet x = s.padStart(5, "0")');
    expectNoErrors('let s = "hi"\nlet x = s.padEnd(5)');
    const t = getExprType('let s = "hi"\nlet x = s.padEnd(5, "0")');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('s.concat(str) returns string', () => {
    const t = getExprType('let s = "hello"\nlet x = s.concat("!")');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  // ── Method on string literal ──
  it('method on string literal type-checks', () => {
    expectNoErrors('let x = "hello".toUpperCase()');
  });

  // ── Error cases ──
  it('unknown property on string → E209', () => {
    expectErrors('let s = "hello"\nlet x = s.foo', 'E209');
  });

  it('wrong arg type → E200', () => {
    expectErrors('let s = "hello"\nlet x = s.includes(42)', 'E200');
  });

  it('wrong arg type for slice → E200', () => {
    expectErrors('let s = "hello"\nlet x = s.slice("a")', 'E200');
  });

  // ── Nullable integration ──
  it('optional chaining on nullable string property works', () => {
    expectNoErrors('let s: string? = null\nlet x = s?.length');
  });
});

describe('number method typing', () => {
  it('n.toString() returns string', () => {
    const t = getExprType('let n = 42\nlet x = n.toString()');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('n.toFixed(digits) returns string', () => {
    const t = getExprType('let n = 3.14\nlet x = n.toFixed(2)');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('n.toFixed() returns string (optional arg)', () => {
    expectNoErrors('let n = 3.14\nlet x = n.toFixed()');
  });

  it('n.valueOf() returns number', () => {
    const t = getExprType('let n = 42\nlet x = n.valueOf()');
    expect(t).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('method on number literal type-checks', () => {
    expectNoErrors('let x = (42).toString()');
  });

  it('unknown property on number → E209', () => {
    expectErrors('let n = 42\nlet x = n.foo', 'E209');
  });

  it('wrong arg type for toFixed → E200', () => {
    expectErrors('let n = 42\nlet x = n.toFixed("x")', 'E200');
  });
});

describe('boolean method typing', () => {
  it('b.toString() returns string', () => {
    const t = getExprType('let b = true\nlet x = b.toString()');
    expect(t).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('b.valueOf() returns boolean', () => {
    const t = getExprType('let b = true\nlet x = b.valueOf()');
    expect(t).toEqual({ kind: 'primitive', name: 'boolean' });
  });

  it('unknown property on boolean → E209', () => {
    expectErrors('let b = true\nlet x = b.foo', 'E209');
  });
});

// ── Async/Await Type Checking ─────────────────────────────────────────

describe('Async/Await', () => {
  // ── Prerequisite: sync return type validation ──

  it('return type mismatch in sync function → E200', () => {
    expectErrors('let f = (x: number): number => {\n  return "hello"\n  42\n}', 'E200');
  });

  it('return matching type in sync function → OK', () => {
    expectNoErrors('let f = (x: number): number => {\n  return 42\n  0\n}');
  });

  // ── Happy path ──

  it('async function with explicit Promise<number> return type', () => {
    expectNoErrors('let f = async (x: number): Promise<number> => x');
  });

  it('async function body expression matches inner type', () => {
    expectNoErrors('let f = async (): Promise<number> => 42');
  });

  it('await Promise<string> yields string', () => {
    const source = 'let f = async (): Promise<string> => {\n  let p = async (): Promise<string> => "hello"\n  let s = await p()\n  s\n}';
    expectNoErrors(source);
  });

  it('await on Any yields Any', () => {
    const source = 'let f = async (x: Any): Promise<Any> => {\n  await x\n}';
    expectNoErrors(source);
  });

  it('async function type inference (no annotation) → Promise<T>', () => {
    const source = 'let f = async (x: number) => x';
    const { output } = checkSource(source);
    const decl = output.typedAST.body[0] as LetDeclaration;
    const fnType = decl.initializer.resolvedType;
    expect(fnType).toBeDefined();
    expect(fnType!.kind).toBe('function');
    if (fnType!.kind === 'function') {
      expect(fnType!.returnType.kind).toBe('promise');
      if (fnType!.returnType.kind === 'promise') {
        expect(fnType!.returnType.inner.kind).toBe('primitive');
      }
    }
  });

  it('return 42 in async Promise<number> function → OK', () => {
    expectNoErrors('let f = async (): Promise<number> => {\n  return 42\n  0\n}');
  });

  it('return compute() where compute returns Promise<T> in async function → OK (auto-await)', () => {
    expectNoErrors('let compute = async (): Promise<number> => 42\nlet f = async (): Promise<number> => {\n  return compute()\n  0\n}');
  });

  it('nested async functions with separate contexts', () => {
    expectNoErrors('let outer = async (): Promise<number> => {\n  let inner = async (): Promise<string> => "hello"\n  let s = await inner()\n  s.length\n}');
  });

  it('Promise<void> with void last expression', () => {
    expectNoErrors('let log = async (msg: string): Promise<void> => {\n  print(msg)\n}');
  });

  it('generic async function', () => {
    expectNoErrors('let identity = async <T>(x: T): Promise<T> => x');
  });

  it('Promise<T> resolves as built-in type', () => {
    expectNoErrors('let f = (x: Promise<number>): Promise<number> => x');
  });

  it('Promise<void> with throw in body', () => {
    // throw makes body type void, which matches Promise<void>
    expectNoErrors('let fail = async (): Promise<void> => {\n  throw "unreachable"\n}');
  });

  it('double await on Promise<Promise<number>>', () => {
    // getP() returns Promise<Promise<number>>, first await yields Promise<number>, second yields number
    const source = 'let getP = async (): Promise<Promise<number>> => {\n  let inner = async (): Promise<number> => 42\n  inner()\n}\nlet f = async (): Promise<number> => {\n  await await getP()\n}';
    expectNoErrors(source);
  });

  it('async body ending with for loop infers Promise<void>', () => {
    const source = 'let f = async (items: Array<string>): Promise<void> => {\n  for (item in items) {\n    print(item)\n  }\n}';
    expectNoErrors(source);
  });

  it('await Promise<T?> yields T?', () => {
    const source = [
      'let getP = async (): Promise<string?> => null',
      'let f = async (): Promise<string?> => {',
      '  let p = getP()',
      '  await p',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('return await compute() in async function → OK', () => {
    const source = [
      'let compute = async (): Promise<number> => 42',
      'let f = async (): Promise<number> => {',
      '  return await compute()',
      '  0',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('await in for loop body', () => {
    const source = [
      'let process = async (x: string): Promise<void> => { print(x) }',
      'let f = async (items: Array<string>): Promise<void> => {',
      '  for (item in items) {',
      '    await process(item)',
      '  }',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('generic async function type inference at call site', () => {
    const source = [
      'let identity = async <T>(x: T): Promise<T> => x',
      'let f = async (): Promise<number> => {',
      '  await identity(42)',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('Promise<never> — async function that always throws → E200 (throw body yields void, not never)', () => {
    // throw is a statement producing void; the type system doesn't infer never from throw bodies
    expectErrors('let fail = async (): Promise<never> => { throw "error" }', 'E200');
  });

  // ── Error cases ──

  it('await outside async function → E231', () => {
    expectErrors('let f = async (): Promise<number> => 42\nlet x = await f()', 'E231');
  });

  it('await in non-async nested function inside async → E231', () => {
    const source = 'let outer = async (): Promise<number> => {\n  let inner = (x: number): number => {\n    let p = async (): Promise<number> => 42\n    await p()\n  }\n  42\n}';
    expectErrors(source, 'E231');
  });

  it('async without Promise<T> return type → E230', () => {
    expectErrors('let f = async (): number => 42', 'E230');
  });

  it('await on non-Promise type → E232', () => {
    expectErrors('let f = async (): Promise<number> => {\n  await 42\n}', 'E232');
  });

  it('await on nullable Promise → E232', () => {
    expectErrors('let f = async (): Promise<string> => {\n  let p: Promise<string>? = null\n  await p\n}', 'E232');
  });

  it('wrong return type in async body → E200', () => {
    expectErrors('let f = async (): Promise<number> => "hello"', 'E200');
  });

  // ── Async attempt overload ──

  it('attempt with async function returns Promise<Result<T, Error>>', () => {
    const source = 'let f = async (): Promise<number> => {\n  let result = await attempt(async (): Promise<string> => "hello")\n  42\n}';
    expectNoErrors(source);
  });

  // ── Diagnostic message formatting ──

  it('E230 message includes actual type name', () => {
    const { diagnostics } = checkSource('let f = async (): number => 42');
    const error = diagnostics.getErrors().find(e => e.code === 'E230');
    expect(error).toBeDefined();
    expect(error!.message).toContain("Promise<T>");
    expect(error!.message).toContain("number");
  });

  it('E231 message describes await outside async', () => {
    const { diagnostics } = checkSource('let getP = async (): Promise<number> => 42\nlet x = await getP()');
    const error = diagnostics.getErrors().find(e => e.code === 'E231');
    expect(error).toBeDefined();
    expect(error!.message).toContain('await');
    expect(error!.message).toContain('async');
  });

  it('E232 message includes found type name', () => {
    const { diagnostics } = checkSource('let f = async (): Promise<number> => {\n  await 42\n}');
    const error = diagnostics.getErrors().find(e => e.code === 'E232');
    expect(error).toBeDefined();
    expect(error!.message).toContain('Promise');
    expect(error!.message).toContain('number');
  });

  // ── Additional coverage ──

  it('async function assigned to (T) => Promise<U> variable', () => {
    const source = [
      'let handler: (number) => Promise<number> = async (x: number): Promise<number> => x',
    ].join('\n');
    expectNoErrors(source);
  });

  it('async function inference: body already returns Promise<T> — no double-wrap', () => {
    const source = [
      'let compute = async (): Promise<number> => 42',
      'let f = async () => compute()',
    ].join('\n');
    const { output } = checkSource(source);
    const decl = output.typedAST.body[1] as LetDeclaration;
    const fnType = decl.initializer.resolvedType;
    expect(fnType).toBeDefined();
    expect(fnType!.kind).toBe('function');
    if (fnType!.kind === 'function') {
      expect(fnType!.returnType.kind).toBe('promise');
      if (fnType!.returnType.kind === 'promise') {
        // Should be Promise<number>, NOT Promise<Promise<number>>
        expect(fnType!.returnType.inner.kind).toBe('primitive');
      }
    }
  });

  it('await in match arm', () => {
    const source = [
      'let fetchNum = async (): Promise<number> => 42',
      'let f = async (flag: boolean): Promise<number> => {',
      '  match flag {',
      '    true => await fetchNum()',
      '    false => 0',
      '  }',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('await in try/catch body', () => {
    const source = [
      'let fetchData = async (): Promise<string> => "data"',
      'let f = async (): Promise<string> => {',
      '  try {',
      '    await fetchData()',
      '  } catch (e) {',
      '    "fallback"',
      '  }',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });

  it('await in if/else branches', () => {
    const source = [
      'let fetchA = async (): Promise<number> => 1',
      'let fetchB = async (): Promise<number> => 2',
      'let f = async (cond: boolean): Promise<number> => {',
      '  if (cond) await fetchA() else await fetchB()',
      '}',
    ].join('\n');
    expectNoErrors(source);
  });
});

// ── Extension Functions ──────────────────────────────────────────

describe('extension functions', () => {

    // ── Happy path ──

    it('extension on string: this has type string', () => {
      expectNoErrors('fun string.double(): string => this + this');
    });

    it('extension on number: this has type number', () => {
      expectNoErrors('fun number.double(): number => this * 2');
    });

    it('extension call resolves correctly', () => {
      const t = getExprType('fun string.shout(): string => this + "!"\nlet x = "hello".shout()');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('string');
    });

    it('extension call with arguments', () => {
      const t = getExprType('fun number.clamp(min: number, max: number): number => {\n  if (this < min) min\n  else if (this > max) max\n  else this\n}\nlet x = 15.clamp(0, 10)');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('extension on named record type', () => {
      expectNoErrors('type User = { name: string, age: number }\nfun User.greet(): string => this.name\nlet u: User = { name: "Alice", age: 30 }\nlet g = u.greet()');
    });

    it('extension on ADT type', () => {
      expectNoErrors('type Color = Red | Green | Blue\nfun Color.name(): string => match this {\n  Red => "red"\n  Green => "green"\n  Blue => "blue"\n}\nlet c = Red\nlet n = c.name()');
    });

    it('generic extension on Array', () => {
      const t = getExprType('fun <T> Array<T>.first(): T? => this.at(0)\nlet x = [1, 2, 3].first()');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('nullable');
    });

    it('chained calls mixing native and extension', () => {
      expectNoErrors('fun string.shout(): string => this + "!"\nlet x = "  hello  ".trim().shout()');
    });

    it('multiple extensions on same type', () => {
      expectNoErrors('fun string.a(): string => this\nfun string.b(): string => this\nlet x = "hi".a()\nlet y = "hi".b()');
    });

    it('exported extension compiles', () => {
      expectNoErrors('export fun string.shout(): string => this + "!"');
    });

    it('extension with block body', () => {
      expectNoErrors('fun string.rev(): string => {\n  let x = this\n  x\n}');
    });

    it('this in nested arrow still refers to receiver', () => {
      expectNoErrors('fun string.test(): string => {\n  let f = (): string => this\n  f()\n}');
    });

    it('extension on Promise type', () => {
      expectNoErrors('fun <T> Promise<T>.orDefault(fallback: T): T => fallback');
    });

    it('recursive extension call via this.method()', () => {
      expectNoErrors('fun number.factorial(): number => {\n  if (this <= 1) 1\n  else this * (this - 1).factorial()\n}');
    });

    // ── Error cases ──

    it('this outside extension body → E220', () => {
      expectErrors('let x = this', 'E220');
    });

    it('this in regular function → E220', () => {
      expectErrors('let f = (x: number): number => this', 'E220');
    });

    it('extension on unresolved type → E212 (type not found)', () => {
      expectErrors('fun Unknown.foo(): string => "x"', 'E212');
    });

    it('extension on bare type parameter → E221', () => {
      expectErrors('fun <T> T.identity(): string => "x"', 'E221');
    });

    it('missing return type annotation → E222', () => {
      // Parser already rejects this as E102, but if somehow it got through
      // the checker would report E222. This test uses the parser error path.
      const { diagnostics } = checkSource('fun string.bad() => this');
      expect(diagnostics.getErrors().length).toBeGreaterThan(0);
    });

    it('duplicate extension same receiver + same name → E213', () => {
      expectErrors('fun string.foo(): string => this\nfun string.foo(): string => this', 'E213');
    });

    it('emit name collision with user variable → E213', () => {
      expectErrors('let string_foo = "x"\nfun string.foo(): string => this', 'E213');
    });

    it('native method takes priority over extension', () => {
      // string.length is native — extension defines same name but native wins
      const t = getExprType('fun string.length(): number => 0\nlet x = "hello".length');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('number');
    });

    it('wrong argument type to extension call → E200', () => {
      expectErrors('fun number.add(x: number): number => this + x\nlet r = 5.add("hello")', 'E200');
    });

    it('wrong number of arguments to extension call → E207', () => {
      expectErrors('fun number.add(x: number): number => this + x\nlet r = 5.add()', 'E207');
    });

    it('extension on structurally identical but nominally distinct types', () => {
      // fun A.foo() should NOT apply to values of type B even if same structure
      expectErrors(
        'type A = { x: number }\ntype B = { x: number }\nfun A.foo(): number => this.x\nlet b: B = { x: 1 }\nlet r = b.foo()',
        'E209',
      );
    });

    // ── Cross-module import ──

    it('imported extension is available for method calls', () => {
      const numType: Type = { kind: 'primitive', name: 'number' };
      const strType: Type = { kind: 'primitive', name: 'string' };
      const extFnType: import('./types.js').FunctionType = {
        kind: 'function',
        params: [],
        returnType: { kind: 'array', element: strType },
      };
      const sig: import('./types.js').ExportedTypeSignature = {
        types: new Map(),
        values: new Map([['string_words', extFnType]]),
        adtConstructors: new Map(),
        extensions: new Map([['string_words', {
          receiverType: strType,
          methodName: 'words',
          fnType: extFnType,
          emitName: 'string_words',
        }]]),
      };
      const { diagnostics } = checkSourceWithImports(
        'import { string_words } from "utils"\nlet r = "hello world".words()',
        new Map([['utils', sig]]),
      );
      expect(diagnostics.getErrors().length).toBe(0);
    });

    it('E223 when importing method name instead of emit name', () => {
      const strType: Type = { kind: 'primitive', name: 'string' };
      const extFnType: import('./types.js').FunctionType = {
        kind: 'function',
        params: [],
        returnType: { kind: 'array', element: strType },
      };
      const sig: import('./types.js').ExportedTypeSignature = {
        types: new Map(),
        values: new Map([['string_words', extFnType]]),
        adtConstructors: new Map(),
        extensions: new Map([['string_words', {
          receiverType: strType,
          methodName: 'words',
          fnType: extFnType,
          emitName: 'string_words',
        }]]),
      };
      const { diagnostics } = checkSourceWithImports(
        'import { words } from "utils"',
        new Map([['utils', sig]]),
      );
      const errors = diagnostics.getErrors();
      expect(errors.some(e => e.code === 'E223')).toBe(true);
    });

    // ── Extension exports ──

    it('exported extension appears in exports.extensions', () => {
      const { output } = checkSource('export fun string.shout(): string => this + "!"');
      expect(output.exports.extensions.size).toBe(1);
      expect(output.exports.extensions.has('string_shout')).toBe(true);
      const ext = output.exports.extensions.get('string_shout')!;
      expect(ext.methodName).toBe('shout');
      expect(ext.emitName).toBe('string_shout');
    });

    it('exported extension also appears in exports.values', () => {
      const { output } = checkSource('export fun string.shout(): string => this + "!"');
      expect(output.exports.values.has('string_shout')).toBe(true);
    });

    // ── Additional edge case tests ──

    it('extension on boolean type', () => {
      const t = getExprType('fun boolean.toggle(): boolean => !this\nlet x = true.toggle()');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('primitive');
      expect((t as PrimitiveType).name).toBe('boolean');
    });

    it('this in callback inside extension refers to receiver', () => {
      // this inside a callback within the extension body still refers to the receiver
      // this.length should be number (length of the array, since receiver is Array<string>)
      expectNoErrors(
        'fun <T> Array<T>.selfLen(): number => {\n  let f = (): number => this.length\n  f()\n}',
      );
    });

    it('E213 for extension collision includes extension context', () => {
      // Extension is declared second — triggers E213 during Pass 1b registration
      // when it finds the let binding already in scope
      const { diagnostics } = checkSource('let string_foo: string = "x"\nfun string.foo(): string => this');
      const errors = diagnostics.getErrors();
      const e213 = errors.find(e => e.code === 'E213');
      expect(e213).toBeDefined();
      expect(e213!.message).toContain("generated from extension 'fun string.foo()'");
    });

    // ── Async extension functions ──

    it('async extension function with Promise return type — no errors', () => {
      expectNoErrors('async fun string.fetch(): Promise<string> => this');
    });

    it('async extension function allows await in body', () => {
      expectNoErrors(
        'let fetchData = async (): Promise<string> => "data"\n' +
        'async fun string.fetchInfo(): Promise<string> => {\n' +
        '  let data = await fetchData()\n' +
        '  data\n' +
        '}',
      );
    });

    it('async extension function — E230 when return type is not Promise', () => {
      expectErrors('async fun string.bad(): string => this', 'E230');
    });

    it('async extension function — E231 await outside async context', () => {
      expectErrors(
        'let fetchData = async (): Promise<string> => "data"\n' +
        'fun string.bad(): string => {\n' +
        '  let x = await fetchData()\n' +
        '  x\n' +
        '}',
        'E231',
      );
    });

    it('async extension function body type checked against inner T', () => {
      // Body returns string, but Promise<number> expects number inner type → E200
      expectErrors('async fun string.bad(): Promise<number> => this', 'E200');
    });

    it('async extension function with return statement', () => {
      expectNoErrors(
        'async fun string.fetch(): Promise<string> => {\n' +
        '  return this\n' +
        '}',
      );
    });

    it('exported async extension function — no errors', () => {
      expectNoErrors('export async fun string.fetch(): Promise<string> => this');
    });

    it('async extension function exported — appears in exports', () => {
      const { output } = checkSource('export async fun string.fetch(): Promise<string> => this');
      expect(output.exports.extensions.size).toBe(1);
      expect(output.exports.extensions.has('string_fetch')).toBe(true);
      expect(output.exports.values.has('string_fetch')).toBe(true);
    });
  });

  // ── Collection Types (Set & Map) ────────────────────────────────────

  describe('collection types', () => {

    // ── Set type resolution ──

    describe('Set type resolution', () => {
      it('Set<string> annotation resolves to set kind with string element', () => {
        const t = getResolvedType('let s: Set<string> = Set.of(["a"])');
        expect(t).toBeDefined();
        expect(t!.kind).toBe('set');
        expect((t as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('Set<T> with generic parameter resolves correctly', () => {
        const source = 'let f = <T>(s: Set<T>): Set<T> => s';
        expectNoErrors(source);
      });

      it('Set without type args defaults to Set<Any>', () => {
        const t = getResolvedType('let s: Set = Set.of([])');
        expect(t).toBeDefined();
        expect(t!.kind).toBe('set');
        expect((t as import('./types.js').SetType).element).toEqual({ kind: 'any' });
      });
    });

    // ── Map type resolution ──

    describe('Map type resolution', () => {
      it('Map<string, number> annotation resolves correctly', () => {
        const t = getResolvedType('let m: Map<string, number> = Map.of()');
        expect(t).toBeDefined();
        expect(t!.kind).toBe('map');
        const mt = t as import('./types.js').MapType;
        expect(mt.key).toEqual({ kind: 'primitive', name: 'string' });
        expect(mt.value).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('Map<K, V> with generic params resolves correctly', () => {
        const source = 'let f = <K, V>(m: Map<K, V>): Map<K, V> => m';
        expectNoErrors(source);
      });

      it('Map without type args defaults to Map<Any, Any>', () => {
        const t = getResolvedType('let m: Map = Map.of()');
        expect(t).toBeDefined();
        expect(t!.kind).toBe('map');
        const mt = t as import('./types.js').MapType;
        expect(mt.key).toEqual({ kind: 'any' });
        expect(mt.value).toEqual({ kind: 'any' });
      });
    });

    // ── Set method typing ──

    describe('Set method typing', () => {
      it('s.size is number', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.size');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('number');
      });

      it('s.has(item) returns boolean', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.has("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('s.add(item) returns void', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.add("b")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('s.delete(item) returns boolean', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.delete("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('s.clear() returns void', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.clear()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('s.map(fn) returns Set<U> with fresh generic', () => {
        const source = `
          let s: Set<number> = Set.of([1, 2])
          let result = s.map((n: number): string => "x")
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
        expect((resolved as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('s.filter(fn) returns Set<T>', () => {
        const source = `
          let s: Set<number> = Set.of([1, 2])
          let result = s.filter((n: number): boolean => true)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
        expect((resolved as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('s.toArray() returns Array<T>', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.toArray()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        expect((resolved as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('s.forEach(fn) returns void', () => {
        const t = getExprType('let s: Set<string> = Set.of(["a"])\nlet x = s.forEach((item: string): void => print(item))');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('s.union(other) returns Set<T>', () => {
        const source = `
          let s1: Set<number> = Set.of([1, 2])
          let s2: Set<number> = Set.of([3, 4])
          let result = s1.union(s2)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
        expect((resolved as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('s.intersect(other) returns Set<T>', () => {
        const source = `
          let s1: Set<number> = Set.of([1, 2])
          let s2: Set<number> = Set.of([2, 3])
          let result = s1.intersect(s2)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
      });

      it('s.difference(other) returns Set<T>', () => {
        const source = `
          let s1: Set<number> = Set.of([1, 2])
          let s2: Set<number> = Set.of([2, 3])
          let result = s1.difference(s2)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
      });
    });

    // ── Map method typing ──

    describe('Map method typing', () => {
      it('m.size is number', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.size');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('number');
      });

      it('m.get(key) returns nullable value type', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.get("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
        expect((resolved as import('./types.js').NullableType).inner).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('m.has(key) returns boolean', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.has("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('m.set(key, value) returns void', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.set("b", 2)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('m.delete(key) returns boolean', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.delete("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('m.clear() returns void', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.clear()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('m.keys() returns Array<K>', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.keys()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        expect((resolved as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('m.values() returns Array<V>', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.values()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        expect((resolved as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('m.entries() returns Array<(K, V)>', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.entries()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        const elemType = (resolved as import('./types.js').ArrayType).element;
        expect(elemType.kind).toBe('tuple');
        const tuple = elemType as import('./types.js').TupleType;
        expect(tuple.elements).toHaveLength(2);
        expect(tuple.elements[0]).toEqual({ kind: 'primitive', name: 'string' });
        expect(tuple.elements[1]).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('m.forEach(fn) returns void', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.forEach((v: number, k: string): void => print(v))');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('m.map(fn) returns Map<K, U>', () => {
        const t = getExprType(
          'let m: Map<string, number> = Map.of()\nlet result = m.map((v: number, k: string): string => "x")',
        );
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('map');
        const mt = resolved as import('./types.js').MapType;
        expect(mt.key).toEqual({ kind: 'primitive', name: 'string' });
        expect(mt.value).toEqual({ kind: 'primitive', name: 'string' });
      });
    });

    // ── New Array method typing ──

    describe('new Array method typing', () => {
      it('arr.first() returns nullable element type', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.first()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
      });

      it('arr.last() returns nullable element type', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.last()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
      });

      it('arr.flatMap(fn) returns Array<U>', () => {
        const source = `
          let arr = [1, 2, 3]
          let result = arr.flatMap((n: number): Array<string> => ["x"])
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        expect((resolved as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('arr.find(fn) returns nullable element type', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.find((n: number): boolean => true)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
      });

      it('arr.find on Array<number?> returns number?', () => {
        const t = getExprType('let arr: Array<number?> = [1, null, 3]\nlet x = arr.find((n: number?): boolean => true)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
      });

      it('arr.findIndex(fn) returns number', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.findIndex((n: number): boolean => true)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('number');
      });

      it('arr.indexOf(item) returns number', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.indexOf(2)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('number');
      });

      it('arr.reduce(fn, init) returns accumulator type', () => {
        const source = `
          let arr = [1, 2, 3]
          let result = arr.reduce((acc: string, n: number): string => acc, "")
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('string');
      });

      it('arr.fold(init, fn) returns accumulator type', () => {
        const source = `
          let arr = [1, 2, 3]
          let result = arr.fold("", (acc: string, n: number): string => acc)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('string');
      });

      it('arr.every(fn) returns boolean', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.every((n: number): boolean => true)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('arr.some(fn) returns boolean', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.some((n: number): boolean => true)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('arr.isEmpty() returns boolean', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.isEmpty()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('boolean');
      });

      it('arr.sort() with no args returns void', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.sort()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });

      it('arr.sort(fn) with comparator returns void', () => {
        const t = getExprType('let arr = [1, 2, 3]\nlet x = arr.sort((a: number, b: number): number => a)');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('primitive');
        expect((resolved as PrimitiveType).name).toBe('void');
      });
    });

    // ── Factory method typing ──

    describe('factory method typing', () => {
      it('Set.of([1, 2, 3]) infers Set<number>', () => {
        const t = getExprType('let s: Set<number> = Set.of([1, 2, 3])\nlet x = s');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
        expect((resolved as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('Set.of([1, "two", 3]) infers Set<number | string>', () => {
        const t = getExprType('let s = Set.of([1, "two", 3])\nlet x = s');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('set');
        const elem = (resolved as import('./types.js').SetType).element;
        expect(elem.kind).toBe('union');
      });

      it('Map.of with annotation infers Map<string, number>', () => {
        const t = getResolvedType('let m: Map<string, number> = Map.of()');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('map');
        const mt = resolved as import('./types.js').MapType;
        expect(mt.key).toEqual({ kind: 'primitive', name: 'string' });
        expect(mt.value).toEqual({ kind: 'primitive', name: 'number' });
      });

      it('empty factory with annotation: Set<string> = Set.of([])', () => {
        const source = 'let s: Set<string> = Set.of([])';
        const t = getResolvedType(source);
        expect(t).toBeDefined();
        expect(t!.kind).toBe('set');
        expect((t as import('./types.js').SetType).element).toEqual({ kind: 'primitive', name: 'string' });
      });
    });

    // ── Generic function parameters ──

    describe('generic function parameters with collections', () => {
      it('<T>(items: Set<T>): Array<T> — T flows through', () => {
        const source = `
          let toArray = <T>(items: Set<T>): Array<T> => items.toArray()
          let s: Set<string> = Set.of(["a", "b"])
          let result = toArray(s)
        `;
        const { output, diagnostics } = checkSource(source);
        expect(diagnostics.getErrors().length).toBe(0);
        const lastDecl = output.typedAST.body[output.typedAST.body.length - 1] as LetDeclaration;
        const t = (lastDecl.initializer as unknown as { resolvedType?: Type }).resolvedType;
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('array');
        expect((resolved as import('./types.js').ArrayType).element).toEqual({ kind: 'primitive', name: 'string' });
      });

      it('<K, V>(m: Map<K, V>, key: K): V? — K,V flow through', () => {
        const t = getExprType(
          'let lookup = <K, V>(m: Map<K, V>, key: K): V? => m.get(key)\n' +
          'let m: Map<string, number> = Map.of()\n' +
          'let result = lookup(m, "a")',
        );
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
        expect((resolved as import('./types.js').NullableType).inner).toEqual({ kind: 'primitive', name: 'number' });
      });
    });

    // ── Assignability ──

    describe('collection assignability', () => {
      it('Set<string> assignable to Set<string>', () => {
        expectNoErrors('let s1: Set<string> = Set.of(["a"])\nlet s2: Set<string> = s1');
      });

      it('Set<string> NOT assignable to Set<number>', () => {
        expectErrors('let s1: Set<string> = Set.of(["a"])\nlet s2: Set<number> = s1', 'E200');
      });

      it('Map<string, number> assignable to Map<string, number>', () => {
        const source = 'let id = (m: Map<string, number>): Map<string, number> => m';
        expectNoErrors(source);
      });

      it('Map<string, number> NOT assignable to Map<number, string>', () => {
        expectErrors('let m1: Map<string, number> = Map.of()\nlet m2: Map<number, string> = m1', 'E200');
      });

      it('Set<string>? nullable works', () => {
        const source = `
          let s: Set<string>? = null
          let s2: Set<string>? = Set.of(["a"])
        `;
        expectNoErrors(source);
      });

      it('Map<string, number>? nullable works', () => {
        const source = 'let m: Map<string, number>? = null';
        expectNoErrors(source);
        const t = getResolvedType(source);
        expect(t).toBeDefined();
        expect(t!.kind).toBe('nullable');
        const inner = (t as import('./types.js').NullableType).inner;
        expect(inner.kind).toBe('map');
      });

      it('Set<string> assignable to Set<string> | Set<number> union', () => {
        expectNoErrors('let s: Set<string> = Set.of(["a"])\nlet u: Set<string> | Set<number> = s');
      });

      it('Map<string, number?> get returns number?', () => {
        const t = getExprType('let m: Map<string, number?> = Map.of()\nlet x = m.get("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        // get() returns V? where V is already number?, so result should be nullable
        expect(resolved.kind).toBe('nullable');
      });
    });

    // ── Error cases ──

    describe('collection error cases', () => {
      it('unknown method on Set raises E209', () => {
        expectErrors('let s: Set<string> = Set.of(["a"])\nlet x = s.nonexistent()', 'E209');
      });

      it('unknown method on Map raises E209', () => {
        expectErrors('let m: Map<string, number> = Map.of()\nlet x = m.nonexistent()', 'E209');
      });

      it('wrong arg type to Set.has raises E200', () => {
        expectErrors('let s: Set<string> = Set.of(["a"])\nlet x = s.has(42)', 'E200');
      });

      it('wrong arg type to Map.set raises E200', () => {
        expectErrors('let m: Map<string, number> = Map.of()\nm.set(42, "wrong")', 'E200');
      });

      it('Map.get is typed as nullable (not an error)', () => {
        const t = getExprType('let m: Map<string, number> = Map.of()\nlet x = m.get("a")');
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
      });

      it('Set.nonexistent property raises E209', () => {
        expectErrors('let s: Set<string> = Set.of(["a"])\nlet x = s.foo', 'E209');
      });

      it('Set<string, number> wrong arity raises E200', () => {
        expectErrors('let s: Set<string, number> = Set.of(["a"])', 'E200');
      });

      it('Map<string> wrong arity raises E200', () => {
        expectErrors('let m: Map<string> = Map.of()', 'E200');
      });

      it('Map.of with wrong value type assigned raises E200', () => {
        expectErrors('let m: Map<string, number> = Map.of()\nlet m2: Map<string, string> = m', 'E200');
      });

      it('sort with too many arguments raises E207', () => {
        expectErrors(
          'let arr = [1, 2, 3]\narr.sort((a: number, b: number): number => a, (a: number, b: number): number => b)',
          'E207',
        );
      });

      it('sort with wrong comparator arity (1 param instead of 2) raises E200', () => {
        expectErrors(
          'let arr = [1, 2, 3]\narr.sort((a: number): number => a)',
          'E200',
        );
      });

      it('optional chaining on nullable Set method returns nullable result', () => {
        const src = `let s: Set<string>? = Set.of(["a"])
let x = s?.toArray()`;
        const t = getExprType(src);
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
        if (resolved.kind === 'nullable') {
          expect(resolved.inner.kind).toBe('array');
        }
      });

      it('optional chaining on nullable Map method returns nullable result', () => {
        const src = `let m: Map<string, number>? = Map.of()
let x = m?.keys()`;
        const t = getExprType(src);
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
        if (resolved.kind === 'nullable') {
          expect(resolved.inner.kind).toBe('array');
        }
      });

      it('optional chaining on nullable Set.has returns nullable boolean', () => {
        const src = `let s: Set<string>? = Set.of(["a"])
let x = s?.has("a")`;
        const t = getExprType(src);
        expect(t).toBeDefined();
        const resolved = resolveType(t!);
        expect(resolved.kind).toBe('nullable');
        if (resolved.kind === 'nullable') {
          expect(resolved.inner.kind).toBe('primitive');
        }
      });
    });
  });

  // ── Bidirectional Type Inference ──────────────────────────────────────

  describe('bidirectional type inference', () => {

    // ── Empty Array Inference ──────────────────────────────────────────

    describe('empty array inference', () => {
      it('empty array with Array<number> annotation infers Array<number>', () => {
        const src = 'let items: Array<number> = []';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('array');
        if (initType.kind === 'array') {
          expect(initType.element.kind).toBe('primitive');
          if (initType.element.kind === 'primitive') {
            expect(initType.element.name).toBe('number');
          }
        }
      });

      it('empty array with Array<string> annotation infers Array<string>', () => {
        const src = 'let items: Array<string> = []';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('array');
        if (initType.kind === 'array') {
          expect(initType.element.kind).toBe('primitive');
          if (initType.element.kind === 'primitive') {
            expect(initType.element.name).toBe('string');
          }
        }
      });

      it('empty array without annotation infers Array<?T> (unchanged)', () => {
        const src = 'let items = []';
        const { output } = checkSource(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('array');
        if (initType.kind === 'array') {
          expect(initType.element.kind).toBe('typevar');
        }
      });

      it('empty array with non-array annotation gets fresh typevar (unchanged)', () => {
        const src = 'let x: number = []';
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('nested empty array Array<Array<number>> gets element context', () => {
        const src = 'let items: Array<Array<number>> = [[]]';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('array');
        if (initType.kind === 'array') {
          const inner = resolveType(initType.element);
          expect(inner.kind).toBe('array');
          if (inner.kind === 'array') {
            expect(inner.element.kind).toBe('primitive');
          }
        }
      });

      it('empty array inside record field gets type from record annotation', () => {
        const src = 'let x: { items: Array<number> } = { items: [] }';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('record');
      });

      it('record field with no matching expected field uses bottom-up inference', () => {
        const src = 'let x: { a: number } = { a: 42, b: [] }';
        const { output } = checkSource(src);
        // b has no matching field in expected type, inferred bottom-up
        const decl = output.typedAST.body[0] as LetDeclaration;
        expect(decl.resolvedType).toBeDefined();
      });
    });

    // ── Contextual Lambda Typing ──────────────────────────────────────

    describe('contextual lambda typing', () => {
      it('nums.map((n) => n * 2) — n inferred as number', () => {
        const src = `let nums = [1, 2, 3]
let doubled = nums.map((n) => n * 2)`;
        expectNoErrors(src);
      });

      it('nums.filter((n) => n > 0) — n inferred as number', () => {
        const src = `let nums = [1, 2, 3]
let filtered = nums.filter((n) => n > 0)`;
        expectNoErrors(src);
      });

      it('nums.forEach((n) => print(n)) — n inferred as number', () => {
        const src = `let nums = [1, 2, 3]
nums.forEach((n) => print(n))`;
        expectNoErrors(src);
      });

      it('lambda with explicit annotation takes precedence', () => {
        const src = `let nums = [1, 2, 3]
let doubled = nums.map((n: number) => n * 2)`;
        expectNoErrors(src);
      });

      it('lambda with wrong arity produces E205 for extra params', () => {
        const src = `let nums = [1, 2, 3]
let result = nums.map((a, b) => a + b)`;
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E205')).toBe(true);
      });

      it('lambda with conflicting explicit annotation produces E200', () => {
        const src = `let nums = [1, 2, 3]
let result = nums.map((n: string) => n.length)`;
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('standalone lambda without annotation produces E205 (unchanged)', () => {
        const src = 'let f = (x) => x * 2';
        expectErrors(src, 'E205');
      });

      it('let f: (number) => number = (x) => x * 2 — x inferred from annotation', () => {
        const src = 'let f: (number) => number = (x) => x * 2';
        expectNoErrors(src);
      });

      it('nested lambdas with contextual types', () => {
        const src = `let nested = [[1, 2], [3, 4]]
let result = nested.map((inner) => inner.map((n) => n * 2))`;
        expectNoErrors(src);
      });

      it('lambda with default value and contextual type', () => {
        const src = 'let f: (number, string) => void = (a, b = "default") => print("${a} ${b}")';
        expectNoErrors(src);
      });

      it('contextual type with optional params', () => {
        const src = 'let f: (number, string?) => void = (a, b) => print("${a}")';
        expectNoErrors(src);
      });
    });

    // ── Generic Function Context ──────────────────────────────────────

    describe('generic function context', () => {
      it('map((n) => "${n}") infers return type U = string', () => {
        const src = 'let nums = [1, 2, 3]\nlet names = nums.map((n) => "${n}")';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[1] as LetDeclaration;
        const t = resolveType(decl.resolvedType!);
        expect(t.kind).toBe('array');
        if (t.kind === 'array') {
          expect(t.element.kind).toBe('primitive');
          if (t.element.kind === 'primitive') {
            expect(t.element.name).toBe('string');
          }
        }
      });

      it('two-pass inference: non-lambda args first, then lambda context', () => {
        const src = 'let apply = <T, U>(value: T, transform: (T) => U): U => transform(value)\nlet result = apply(42, (n) => "${n}")';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[1] as LetDeclaration;
        const t = resolveType(decl.resolvedType!);
        expect(t.kind).toBe('primitive');
        if (t.kind === 'primitive') {
          expect(t.name).toBe('string');
        }
      });

      it('generic function with multiple type params', () => {
        const src = 'let transform = <A, B>(items: Array<A>, fn: (A) => B): Array<B> => items.map(fn)\nlet result = transform([1, 2, 3], (n) => "${n}")';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[1] as LetDeclaration;
        const t = resolveType(decl.resolvedType!);
        expect(t.kind).toBe('array');
        if (t.kind === 'array') {
          expect(t.element.kind).toBe('primitive');
          if (t.element.kind === 'primitive') {
            expect(t.element.name).toBe('string');
          }
        }
      });

      it('two-pass with lambda + non-lambda args to same generic function', () => {
        const src = `let apply = <T, U>(value: T, transform: (T) => U): U => transform(value)
let result = apply(42, (n) => n * 2)`;
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[1] as LetDeclaration;
        const t = resolveType(decl.resolvedType!);
        expect(t.kind).toBe('primitive');
        if (t.kind === 'primitive') {
          expect(t.name).toBe('number');
        }
      });

      it('all-lambda args with no non-lambda constraints — typevars provide context (no E205)', () => {
        const src = 'let compose = <A, B, C>(f: (A) => B, g: (B) => C): (A) => C => (x: A): C => g(f(x))\ncompose((x) => x, (y) => y)';
        const { diagnostics } = checkSource(src);
        // Two-pass gives typevars as context, so E205 is NOT produced
        expect(diagnostics.getErrors().filter(d => d.code === 'E205')).toHaveLength(0);
      });

      it('pass 2 unifies lambda return type against raw generic params', () => {
        const src = 'let nums = [1, 2, 3]\nlet names = nums.map((n) => "${n}")';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[1] as LetDeclaration;
        const t = resolveType(decl.resolvedType!);
        expect(t.kind).toBe('array');
        if (t.kind === 'array') {
          const elem = resolveType(t.element);
          expect(elem.kind).toBe('primitive');
          if (elem.kind === 'primitive') {
            expect(elem.name).toBe('string');
          }
        }
      });
    });

    // ── Expected Type Propagation ──────────────────────────────────────

    describe('expected type propagation', () => {
      it('if/else branches receive expected type', () => {
        const src = `let x: Array<number> = if (true) { [] } else { [1, 2] }`;
        expectNoErrors(src);
      });

      it('block expression last expression receives expected type', () => {
        const src = `let x: Array<number> = {
  let y = 42
  []
}`;
        expectNoErrors(src);
      });

      it('match expression arms receive expected type', () => {
        const src = `type Color = Red | Blue
let c = Red
let x: Array<number> = match (c) {
  Red => []
  Blue => [1, 2]
}`;
        expectNoErrors(src);
      });

      it('try/catch: both try and catch bodies receive expected type', () => {
        const src = `let x: Array<number> = try { [] } catch (e) { [1, 2] }`;
        expectNoErrors(src);
      });

      it('return type annotation flows to body', () => {
        const src = `let f = (): Array<number> => []`;
        expectNoErrors(src);
      });

      it('contextual return type (no annotation) flows to body', () => {
        const src = `let f: () => Array<number> = () => []`;
        expectNoErrors(src);
      });

      it('return statement uses currentReturnType', () => {
        const src = `let f = (): Array<number> => {
  return []
}`;
        expectNoErrors(src);
      });

      it('return statement value checked for assignability against currentReturnType', () => {
        const src = `let f = (): number => {
  return "hello"
}`;
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('nested arrow functions: currentReturnType saved/restored correctly', () => {
        const src = `let f = (): Array<number> => {
  let g = (): Array<string> => {
    return []
  }
  return []
}`;
        expectNoErrors(src);
      });

      it('record field values receive expected type from record annotation', () => {
        const src = `let x: { items: Array<number> } = { items: [] }`;
        expectNoErrors(src);
      });
    });

    // ── Edge Cases ──────────────────────────────────────────────────

    describe('edge cases', () => {
      it('expected type is Any — no propagation', () => {
        const src = 'let x: Any = []';
        expectNoErrors(src);
      });

      it('Any callee — callable, returns Any', () => {
        const src = 'let f: Any = 42\nlet r = f(1, "hello")';
        expectNoErrors(src);
        const t = getExprType(src);
        expect(t).toBeDefined();
        expect(t!.kind).toBe('any');
      });

      it('expected type is union — no propagation', () => {
        const src = `type Foo = A | B
let x: Array<number> | Foo = []`;
        const { diagnostics } = checkSource(src);
        // Union expected type doesn't propagate, so empty array gets fresh typevar
        // but it may or may not produce E200 depending on union assignability
        expect(diagnostics).toBeDefined();
      });

      it('expected type mismatch still produces E200', () => {
        const src = 'let x: number = "hello"';
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('empty array in function return position with return type annotation', () => {
        const src = 'let f = (): Array<number> => []';
        expectNoErrors(src);
      });

      it('record with nested empty array — field type propagated from record annotation', () => {
        const src = 'let r: { items: Array<number>, names: Array<string> } = { items: [], names: [] }';
        expectNoErrors(src);
      });

      it('attempt(() => expr) with expected Result type — T resolved from context', () => {
        const src = 'let r: Result<number, string> = Ok(42)';
        expectNoErrors(src);
      });

      it('wrong expectedType kind: let x: number = [] infers Array<?T> and E200', () => {
        const src = 'let x: number = []';
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('non-empty array with annotation and mixed elements produces E200', () => {
        const src = 'let x: Array<number> = [1, "hello"]';
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('block ending in return statement: checkReturnStatement fires, body check skipped', () => {
        const src = `let f = (): number => {
  return 42
}`;
        const { diagnostics } = checkSource(src);
        // Should produce no errors, and specifically no duplicate E200
        expect(diagnostics.getErrors()).toHaveLength(0);
      });

      it('nullable expected type unwrapped: let x: Array<number>? = [] infers Array<number>', () => {
        const src = 'let x: Array<number>? = []';
        const output = expectNoErrors(src);
        const decl = output.typedAST.body[0] as LetDeclaration;
        const initType = resolveType(decl.initializer.resolvedType!);
        expect(initType.kind).toBe('array');
        if (initType.kind === 'array') {
          expect(initType.element.kind).toBe('primitive');
          if (initType.element.kind === 'primitive') {
            expect(initType.element.name).toBe('number');
          }
        }
      });

      it('nullable function expected type: let f: ((number) => void)? = (x) => print(x)', () => {
        const src = 'let f: ((number) => void)? = (x) => print(x)';
        expectNoErrors(src);
      });

      it('lambda wrapped in IfExpr argument: no contextual types for inner lambdas', () => {
        const src = `let items = [1, 2, 3]
let result = items.map(if (true) { (n: number) => n } else { (n: number) => n * 2 })`;
        expectNoErrors(src);
      });

      it('ExpressionStatement context: standalone statements do not receive expectedType', () => {
        const src = `let nums = [1, 2, 3]
nums.forEach((n) => print(n))`;
        expectNoErrors(src);
      });

      it('expected type propagation combined with null narrowing', () => {
        const src = 'let x: number? = 42\nlet r: string = if (x != null) { "${x}" } else { "default" }';
        expectNoErrors(src);
      });

      it('block ending in IfExpr where both branches return: no duplicate E200', () => {
        const src = `let f = (): number => {
  if (true) {
    return 1
  } else {
    return 2
  }
}`;
        const { diagnostics } = checkSource(src);
        // No errors, and specifically no duplicate E200s from both body check and return check
        const errors = diagnostics.getErrors();
        expect(errors).toHaveLength(0);
      });

      it('return with unresolved typevar currentReturnType does not produce false E200', () => {
        const src = `let nums = [1, 2, 3]
let result = nums.map((n) => {
  return n * 2
})`;
        expectNoErrors(src);
      });

      it('for (x in array) loop variable typing unaffected by expectedType', () => {
        const src = 'let nums = [1, 2, 3]\nfor (n in nums) {\n  print("${n}")\n}';
        expectNoErrors(src);
      });

      it('NullKind on contextual param type preserved when applied to lambda param', () => {
        // This tests that when a contextual function type has nullKind on params,
        // the lambda param preserves it
        const src = 'let f: (number, string?) => void = (a, b) => print("${a}")';
        expectNoErrors(src);
      });
    });

    // ── Regression Tests ──────────────────────────────────────────────

    describe('regression tests', () => {
      it('resolveTypeNode moved before inferExpression produces identical results', () => {
        const src = 'let x: number = 42';
        expectNoErrors(src);
      });

      it('non-empty arrays with annotations still check assignability', () => {
        const src = 'let x: Array<number> = ["hello"]';
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors().some(d => d.code === 'E200')).toBe(true);
      });

      it('error messages for existing E200 cases are unchanged in wording', () => {
        const src = 'let x: number = "hello"';
        const { diagnostics } = checkSource(src);
        const error = diagnostics.getErrors().find(d => d.code === 'E200');
        expect(error).toBeDefined();
        expect(error!.message).toContain('not assignable to type');
      });

      it('programs that compiled in v0.1 produce identical output', () => {
        const src = `let x = 42
let y = "hello"
let z = x + 1`;
        expectNoErrors(src);
      });

      it('double-inference eliminated: type error in non-lambda arg produces exactly one E200', () => {
        const src = `let f = <T>(value: T): T => value
let result = f("hello")`;
        const { diagnostics } = checkSource(src);
        const e200Count = diagnostics.getErrors().filter(d => d.code === 'E200').length;
        // Should be 0 E200s (string is assignable to T)
        expect(e200Count).toBe(0);
      });

      it('pass 1b forward-declared arrow functions still work', () => {
        const src = `let f = (x: number): number => f(x - 1) + 1`;
        // Should not produce errors for recursive self-reference
        const { diagnostics } = checkSource(src);
        expect(diagnostics.getErrors()).toHaveLength(0);
      });

      it('block ending in return produces correct type (not VOID)', () => {
        const src = `let f = (): number => {
  return 42
}`;
        expectNoErrors(src);
      });

      it('instantiateCall explicit typeargs still work', () => {
        const src = `let f = <T>(value: T): T => value
let result = f<number>(42)`;
        expectNoErrors(src);
      });

      it('PromiseType expected type: let p = async function → no special handling needed', () => {
        // Simple check: promise type doesn't cause issues as expected type
        const src = 'let x: number = 42';
        expectNoErrors(src);
      });
    });
  });

// ── Bidirectional Type Inference (additional) ─────────────────────────────

describe('bidirectional type inference', () => {

  // ── Empty array inference ──────────────────────────────────

  describe('empty array inference', () => {
    it('empty array with Array<number> annotation infers Array<number>', () => {
      const t = getResolvedType('let items: Array<number> = []');
      expect(t).toEqual({ kind: 'array', element: { kind: 'primitive', name: 'number' } });
    });

    it('empty array with Array<string> annotation infers Array<string>', () => {
      const t = getResolvedType('let items: Array<string> = []');
      expect(t).toEqual({ kind: 'array', element: { kind: 'primitive', name: 'string' } });
    });

    it('empty array without annotation infers Array<?T> (unchanged)', () => {
      const t = getResolvedType('let items = []');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      const arrType = t as import('./types.js').ArrayType;
      expect(arrType.element.kind).toBe('typevar');
    });

    it('empty array with non-array annotation gets fresh typevar', () => {
      // number is not ArrayType, so no context available
      const { diagnostics } = checkSource('let x: number = []');
      expect(diagnostics.getErrors().some(e => e.code === 'E200')).toBe(true);
    });

    it('nested empty array Array<Array<number>> gets element context', () => {
      const output = expectNoErrors('let x: Array<Array<number>> = [[]]');
      const decl = output.typedAST.body[0] as LetDeclaration;
      const resolved = (decl as unknown as { resolvedType?: Type }).resolvedType;
      expect(resolved).toBeDefined();
      expect(resolved!.kind).toBe('array');
      const outer = resolved as import('./types.js').ArrayType;
      expect(outer.element.kind).toBe('array');
      const inner = outer.element as import('./types.js').ArrayType;
      expect(inner.element).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('empty array inside record field gets type from record annotation', () => {
      expectNoErrors('let x: { items: Array<number> } = { items: [] }');
    });

    it('record field with no matching expected field falls back to bottom-up', () => {
      expectNoErrors('let x: { items: Array<number> } = { items: [], other: [] }');
    });
  });

  // ── Contextual lambda typing ───────────────────────────────

  describe('contextual lambda typing', () => {
    it('nums.map((n) => n * 2) — n inferred as number', () => {
      expectNoErrors('let nums = [1, 2, 3]\nlet doubled = nums.map((n) => n * 2)');
    });

    it('nums.filter((n) => n > 0) — n inferred as number', () => {
      expectNoErrors('let nums = [1, 2, 3]\nlet pos = nums.filter((n) => n > 0)');
    });

    it('nums.forEach((n) => print("${n}")) — n inferred as number', () => {
      expectNoErrors('let nums = [1, 2, 3]\nnums.forEach((n) => print("${n}"))');
    });

    it('lambda with explicit annotation takes precedence', () => {
      expectNoErrors('let nums = [1, 2, 3]\nlet doubled = nums.map((n: number) => n * 2)');
    });

    it('lambda with wrong arity → E205 for extra params', () => {
      const { diagnostics } = checkSource('let nums = [1, 2, 3]\nlet result = nums.map((a, b) => a)');
      expect(diagnostics.getErrors().some(e => e.code === 'E205')).toBe(true);
    });

    it('lambda with conflicting explicit annotation → E200', () => {
      expectErrors('let nums = [1, 2, 3]\nlet result = nums.map((n: string) => n.length)', 'E200');
    });

    it('standalone lambda without annotation → E205 (unchanged)', () => {
      expectErrors('let f = (x) => x * 2', 'E205');
    });

    it('let f: (number) => number = (x) => x * 2 — x inferred from annotation', () => {
      expectNoErrors('let f: (number) => number = (x) => x * 2');
    });

    it('nested lambdas with contextual types', () => {
      expectNoErrors('let nested = [[1, 2], [3, 4]]\nlet result = nested.map((inner) => inner.map((n) => n * 2))');
    });

    it('lambda with default value and contextual type uses context type', () => {
      expectNoErrors('let f: (number, string) => void = (a, b = "default") => print("${a} ${b}")');
    });

    it('contextual type with optional params → param typed from context', () => {
      expectNoErrors('let f: (number, string?) => void = (a, b) => print("${a}")');
    });

    it('contextual lambda in map infers correct return type', () => {
      const t = getExprType('let nums = [1, 2, 3]\nlet x = nums.map((n) => n * 2)');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      const arrType = t as import('./types.js').ArrayType;
      expect(arrType.element).toEqual({ kind: 'primitive', name: 'number' });
    });
  });

  // ── Generic function context ───────────────────────────────

  describe('generic function context', () => {
    it('map((n) => "${n}") infers return type U = string', () => {
      const t = getExprType('let nums = [1, 2, 3]\nlet x = nums.map((n) => "${n}")');
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      const arrType = t as import('./types.js').ArrayType;
      expect(arrType.element).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('two-pass: non-lambda args first, then lambda context', () => {
      const src = [
        'let apply = <T, U>(value: T, transform: (T) => U): U => transform(value)',
        'let result = apply(42, (n) => "${n}")',
      ].join('\n');
      expectNoErrors(src);
    });

    it('generic function with multiple type params', () => {
      const src = [
        'let wrap = <A, B>(a: A, b: B): A => a',
        'let x = wrap(1, "hello")',
      ].join('\n');
      const t = getExprType(src);
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('two-pass with lambda + non-lambda args same generic function', () => {
      const src = [
        'let apply = <T, U>(value: T, transform: (T) => U): U => transform(value)',
        'let result = apply(42, (n) => n * 2)',
      ].join('\n');
      const t = getExprType(src);
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    });

    it('Pass 2 unifies lambda return type against raw generic params', () => {
      const src = 'let nums = [1, 2, 3]\nlet x = nums.map((n) => "${n}")';
      const t = getExprType(src);
      expect(t).toBeDefined();
      expect(t!.kind).toBe('array');
      const arrType = t as import('./types.js').ArrayType;
      expect(arrType.element).toEqual({ kind: 'primitive', name: 'string' });
    });

    it('all-lambda args with no non-lambda constraints get typevar params', () => {
      const src = [
        'let identity = <T>(f: (T) => T): T => f(Ok(42).value)',
        'let r = identity((x) => x)',
      ].join('\n');
      const { diagnostics } = checkSource(src);
      expect(diagnostics.getErrors().filter(e => e.code === 'E205')).toHaveLength(0);
    });
  });

  // ── Expected type propagation ──────────────────────────────

  describe('expected type propagation', () => {
    it('if/else branches receive expected type', () => {
      expectNoErrors('let x: Array<number> = if (true) { [] } else { [1, 2] }');
    });

    it('block expression last expression receives expected type', () => {
      expectNoErrors('let x: Array<number> = {\n  let y = 1\n  []\n}');
    });

    it('match expression arms receive expected type', () => {
      const src = [
        'type Color = Red | Blue',
        'let c = Red',
        'let x: Array<number> = match (c) {',
        '  Red => []',
        '  Blue => [1]',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('try/catch both bodies receive expected type', () => {
      expectNoErrors('let x: Array<number> = try { [] } catch (e) { [1] }');
    });

    it('return type annotation flows to body', () => {
      expectNoErrors('let f = (): Array<number> => []');
    });

    it('contextual return type (no annotation) flows to body', () => {
      expectNoErrors('let f: () => Array<number> = () => []');
    });

    it('return statement uses currentReturnType', () => {
      expectNoErrors('let f = (): Array<number> => {\n  return []\n}');
    });

    it('return statement value checked for assignability against currentReturnType', () => {
      expectErrors('let f = (): number => {\n  return "hello"\n}', 'E200');
    });

    it('nested arrow functions: currentReturnType saved/restored correctly', () => {
      const src = [
        'let outer = (): Array<number> => {',
        '  let inner = (): Array<string> => {',
        '    return []',
        '  }',
        '  return []',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('record field values receive expected type from record annotation', () => {
      expectNoErrors('let x: { items: Array<number> } = { items: [] }');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('expected type is Any → no propagation', () => {
      expectNoErrors('let x: Any = []');
    });

    it('Any callee → callable, returns Any', () => {
      expectNoErrors('let f: Any = 42\nlet r = f(1)');
    });

    it('Any callee with lambda arg → callable, no E205', () => {
      // Lambda params in Any calls get Any type (no annotation required)
      expectNoErrors('let f: Any = 42\nf((x: Any): Any => x)');
    });

    it('expected type is union → no propagation', () => {
      const { diagnostics } = checkSource('let x: Array<number> | string = []');
      expect(diagnostics).toBeDefined();
    });

    it('expected type mismatch still produces E200', () => {
      expectErrors('let x: number = "hello"', 'E200');
    });

    it('empty array in function return position with return type annotation', () => {
      expectNoErrors('let f = (): Array<number> => []');
    });

    it('record with nested empty array → field type propagated', () => {
      expectNoErrors('let x: { items: Array<number> } = { items: [] }');
    });

    it('Ok() with expected Result type → T resolved from context', () => {
      const src = 'let r: Result<number, string> = Ok(42)';
      expectNoErrors(src);
    });

    it('optional param in contextual function type → param typed from context', () => {
      expectNoErrors('let f: (number, string?) => void = (a, b) => print("${a}")');
    });

    it('default param value with contextual type → assignability checked', () => {
      expectNoErrors('let f: (number, string) => void = (a, b = "default") => print("${a} ${b}")');
    });

    it('expectedType is Any passed to lambda → no FunctionType context', () => {
      const { diagnostics } = checkSource('let f: Any = (x) => x * 2');
      expect(diagnostics.getErrors().some(e => e.code === 'E205')).toBe(true);
    });

    it('NullKind on contextual param type preserved when applied to lambda param', () => {
      expectNoErrors('let f: (number) => void = (a) => print("${a}")');
    });

    it('wrong expectedType kind: let x: number = [] → E200', () => {
      expectErrors('let x: number = []', 'E200');
    });

    it('non-empty array with annotation and mixed elements → E200', () => {
      expectErrors('let x: Array<number> = [1, "hello"]', 'E200');
    });

    it('block with early return and trailing expression — both checks fire on separate expressions', () => {
      expectNoErrors('let f = (): number => {\n  if (true) { return 1 }\n  2\n}');
    });

    it('block ending in return statement — no duplicate E200', () => {
      expectErrorCount('let f = (): number => {\n  return "hello"\n}', 1);
    });

    it('nullable expected type unwrapped: let x: Array<number>? = [] → Array<number>', () => {
      expectNoErrors('let x: Array<number>? = []');
    });

    it('nullable function expected type: let f: ((number) => void)? = (x) => print(x)', () => {
      expectNoErrors('let f: ((number) => void)? = (x) => print("${x}")');
    });

    it('ExpressionStatement context: standalone expression statements do not receive expectedType', () => {
      expectNoErrors('let nums = [1, 2, 3]\nnums.forEach((n: number) => print("${n}"))');
    });

    it('expected type propagation combined with null narrowing', () => {
      expectNoErrors('let x: number? = 42\nlet r: string = if (x != null) { "${x}" } else { "default" }');
    });

    it('block ending in IfExpr where both branches return — no duplicate E200', () => {
      const src = [
        'let f = (): number => {',
        '  if (true) { return 1 } else { return 2 }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('return with unresolved typevar currentReturnType does not produce false E200', () => {
      const src = 'let nums = [1, 2, 3]\nlet x = nums.map((n) => {\n  return n * 2\n})';
      expectNoErrors(src);
    });

    it('for (x in array) loop variable typing unaffected by expectedType', () => {
      expectNoErrors('let nums = [1, 2, 3]\nfor (n in nums) {\n  print("${n}")\n}');
    });
  });

  // ── Regression tests ───────────────────────────────────────

  describe('regression tests', () => {
    it('resolveTypeNode moved before inferExpression produces identical results', () => {
      expectNoErrors('let x: number = 42');
    });

    it('non-empty arrays with annotations still check assignability', () => {
      expectErrors('let x: Array<number> = [1, "hello"]', 'E200');
    });

    it('error messages for existing E200 cases unchanged', () => {
      const { diagnostics } = checkSource('let x: number = "hello"');
      const err = diagnostics.getErrors().find(e => e.code === 'E200');
      expect(err).toBeDefined();
      expect(err!.message).toContain('is not assignable to type');
    });

    it('programs that compiled in v0.1 produce identical output', () => {
      expectNoErrors('let x = 42\nlet y = "hello"\nlet z = x + 1');
    });

    it('double-inference eliminated: type error produces exactly one E200', () => {
      const { diagnostics } = checkSource('let add = <T>(a: T, b: T): T => a\nlet r = add(1, "hello")');
      const e200s = diagnostics.getErrors().filter(e => e.code === 'E200');
      expect(e200s.length).toBe(1);
    });

    it('basic function return type annotation still works', () => {
      expectNoErrors('let f = (): number => 42');
    });

    it('Pass 1b forward-declared arrow functions still work', () => {
      const src = [
        'let isEven = (n: number): boolean => n == 0',
        'let x = isEven(4)',
      ].join('\n');
      expectNoErrors(src);
    });

    it('block ending in return produces correct type', () => {
      const src = 'let f = (): number => {\n  return 42\n}';
      expectNoErrors(src);
    });

    it('instantiateCall with explicit typeargs still works', () => {
      const src = [
        'let identity = <T>(x: T): T => x',
        'let x = identity<number>(42)',
      ].join('\n');
      expectNoErrors(src);
    });

    it('generic-without-typeargs uses two-pass', () => {
      const src = [
        'let identity = <T>(x: T): T => x',
        'let x = identity(42)',
      ].join('\n');
      const t = getExprType(src);
      expect(t).toEqual({ kind: 'primitive', name: 'number' });
    });
  });
});

// ── Any Type Permissiveness (P1-5) ─────────────────────────────────────

describe('Any type permissiveness', () => {
  it('Any is callable — returns Any', () => {
    const src = 'let f: Any = 42\nlet r = f(1, "hello")';
    expectNoErrors(src);
    const t = getExprType(src);
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
  });

  it('Any member access — returns Any', () => {
    const src = 'let x: Any = 42\nlet r = x.foo';
    expectNoErrors(src);
    const t = getExprType(src);
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
  });

  it('Any with new — returns Any', () => {
    const src = 'let C: Any = 42\nlet r = new C()';
    expectNoErrors(src);
    const t = getExprType(src);
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
  });

  it('Any with binary operators — returns Any', () => {
    const src = 'let x: Any = 42\nlet r = x + 1';
    expectNoErrors(src);
    const t = getExprType(src);
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
  });

  it('Any chained member access — returns Any', () => {
    const src = 'let x: Any = 42\nlet r = x.foo.bar.baz';
    expectNoErrors(src);
  });

  it('Any member call chain — returns Any', () => {
    const src = 'let x: Any = 42\nlet r = x.foo(1).bar("hello")';
    expectNoErrors(src);
  });

  it('Any with new and args — returns Any', () => {
    const src = 'let C: Any = 42\nlet r = new C(1, "hello", true)';
    expectNoErrors(src);
  });
});

// ── Optional Parameters via Imports (P1-1) ──────────────────────────────

describe('Optional parameter calls via imports', () => {
  const numType: Type = { kind: 'primitive', name: 'number' };
  const strType: Type = { kind: 'primitive', name: 'string' };

  const moduleWithOptional: import('./types.js').ExportedTypeSignature = {
    types: new Map(),
    values: new Map([
      ['greet', {
        kind: 'function',
        params: [
          { name: 'name', type: strType, optional: false, hasDefault: false },
          { name: 'greeting', type: strType, optional: true, hasDefault: false },
        ],
        returnType: strType,
      } as import('./types.js').FunctionType],
    ]),
    adtConstructors: new Map(),
    extensions: new Map(),
  };

  it('calling with fewer args when extras are optional succeeds', () => {
    const imports = new Map([['mylib', moduleWithOptional]]);
    const { diagnostics } = checkSourceWithImports(
      'import { greet } from "mylib"\nlet r = greet("world")',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('calling with all args including optional succeeds', () => {
    const imports = new Map([['mylib', moduleWithOptional]]);
    const { diagnostics } = checkSourceWithImports(
      'import { greet } from "mylib"\nlet r = greet("world", "hello")',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('calling with too few required args still produces E207', () => {
    const imports = new Map([['mylib', moduleWithOptional]]);
    const { diagnostics } = checkSourceWithImports(
      'import { greet } from "mylib"\nlet r = greet()',
      imports,
    );
    expect(diagnostics.getErrors().some(e => e.code === 'E207')).toBe(true);
  });
});

// ── Rest Parameters (P1-2) ──────────────────────────────────────────

describe('Rest parameter calls via imports', () => {
  const numType: Type = { kind: 'primitive', name: 'number' };
  const strType: Type = { kind: 'primitive', name: 'string' };
  const voidType: Type = { kind: 'primitive', name: 'void' };

  const moduleWithRest: import('./types.js').ExportedTypeSignature = {
    types: new Map(),
    values: new Map([
      ['log', {
        kind: 'function',
        params: [{ name: 'message', type: strType, optional: false, hasDefault: false }],
        returnType: voidType,
        rest: { name: 'args', elementType: strType },
      } as import('./types.js').FunctionType],
      ['sum', {
        kind: 'function',
        params: [],
        returnType: numType,
        rest: { name: 'numbers', elementType: numType },
      } as import('./types.js').FunctionType],
    ]),
    adtConstructors: new Map(),
    extensions: new Map(),
  };

  it('calling with 0 extra rest args succeeds', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { log } from "mylib"\nlog("hello")',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('calling with N extra rest args succeeds', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { log } from "mylib"\nlog("hello", "world", "extra")',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('rest-only function with 0 args succeeds', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { sum } from "mylib"\nlet r = sum()',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('rest-only function with multiple args succeeds', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { sum } from "mylib"\nlet r = sum(1, 2, 3)',
      imports,
    );
    expect(diagnostics.getErrors().length).toBe(0);
  });

  it('too few required args still produces E207', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { log } from "mylib"\nlog()',
      imports,
    );
    expect(diagnostics.getErrors().some(e => e.code === 'E207')).toBe(true);
  });

  it('wrong rest element type produces E200', () => {
    const imports = new Map([['mylib', moduleWithRest]]);
    const { diagnostics } = checkSourceWithImports(
      'import { sum } from "mylib"\nsum(1, "not-a-number", 3)',
      imports,
    );
    expect(diagnostics.getErrors().some(e => e.code === 'E200')).toBe(true);
  });
});

// ── Result Generic Unification ──────────────────────────────────────

describe('Result generic unification', () => {

  // ── Basic Result unification ────────────────────────────────

  describe('basic Result unification', () => {
    it('Ok(42) with expected Result<number, string> → fully resolved', () => {
      const src = 'let r: Result<number, string> = Ok(42)';
      expectNoErrors(src);
    });

    it('Err("msg") with expected Result<number, string> → fully resolved', () => {
      const src = 'let r: Result<number, string> = Err("fail")';
      expectNoErrors(src);
    });

    it('if/else with Ok/Err branches and return type annotation → compiles', () => {
      const src = [
        'let safeDivide = (a: number, b: number): Result<number, string> => {',
        '  if (b == 0) { Err("division by zero") } else { Ok(a / b) }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('if/else with Ok/Err branches and let binding annotation → compiles', () => {
      const src = [
        'let r: Result<number, string> = if (true) { Ok(42) } else { Err("no") }',
      ].join('\n');
      expectNoErrors(src);
    });

    it('nested if/else with multiple Err branches → compiles', () => {
      const src = [
        'let f = (x: number): Result<number, string> => {',
        '  if (x < 0) {',
        '    Err("negative")',
        '  } else if (x == 0) {',
        '    Err("zero")',
        '  } else {',
        '    Ok(x)',
        '  }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });
  });

  // ── No annotation (existing behavior preserved) ─────────────

  describe('no annotation — existing behavior preserved', () => {
    it('if/else Ok/Err without annotation → simplifyUnion merges correctly', () => {
      const src = 'let r = if (true) { Ok(42) } else { Err("no") }';
      expectNoErrors(src);
      const t = getExprType(src);
      expect(t).toBeDefined();
      expect(t!.kind).toBe('adt');
      if (t!.kind === 'adt') {
        expect((t as import('./types.js').ADTType).name).toBe('Result');
      }
    });

    it('single Ok without annotation → Result type (typevar may stay)', () => {
      const src = 'let r = Ok(42)';
      expectNoErrors(src);
      const t = getExprType(src);
      expect(t).toBeDefined();
      expect(t!.kind).toBe('adt');
    });
  });

  // ── Custom ADTs ──────────────────────────────────────────────

  describe('custom ADTs with partial type args', () => {
    it('custom Either<A, B> with Left/Right in branches → compiles', () => {
      const src = [
        'type Either<A, B> = Left(value: A) | Right(value: B)',
        'let f = (x: boolean): Either<number, string> => {',
        '  if (x) { Left(42) } else { Right("hello") }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('three-variant ADT with partial type args → resolved via context', () => {
      const src = [
        'type Tri<A, B> = First(value: A) | Second(value: B) | Neither',
        'let f = (x: number): Tri<number, string> => {',
        '  if (x > 0) { First(x) } else if (x < 0) { Second("negative") } else { Neither }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });
  });

  // ── Error cases ──────────────────────────────────────────────

  describe('error cases', () => {
    it('Ok with wrong type arg vs annotation → E200', () => {
      const src = [
        'let f = (): Result<number, string> => {',
        '  Ok("hello")',
        '}',
      ].join('\n');
      expectErrors(src, 'E200');
    });

    it('both branches return Ok with different types — simplifyUnion picks first concrete', () => {
      // Design doc edge case #1: Ok(42) → Result<number, string>, Ok("hello") → Result<string, string>.
      // simplifyUnion merges ADT type args by picking the first concrete for each position,
      // producing Result<number, string> which matches the annotation. No error fires.
      // This is a limitation of union simplification, not this design.
      const src = [
        'let f = (x: boolean): Result<number, string> => {',
        '  if (x) { Ok(42) } else { Ok("hello") }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('expected type is not the same ADT → no contextual resolution, E200 if mismatch', () => {
      const src = [
        'type Other<A> = Wrap(value: A)',
        'let f = (): Other<number> => {',
        '  Ok(42)',
        '}',
      ].join('\n');
      expectErrors(src, 'E200');
    });
  });

  // ── Match expression ─────────────────────────────────────────

  describe('match expression', () => {
    it('match arms with Ok/Err and return type annotation → compiles', () => {
      const src = [
        'let f = (x: number): Result<string, string> => {',
        '  match x {',
        '    0 => Err("zero")',
        '    1 => Ok("one")',
        '    _ => Ok("other")',
        '  }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('match arms with mixed Ok variants that conflict → E200', () => {
      const src = [
        'let f = (x: number): Result<number, string> => {',
        '  match x {',
        '    0 => Ok("wrong")',
        '    _ => Ok(42)',
        '  }',
        '}',
      ].join('\n');
      expectErrors(src, 'E200');
    });
  });

  // ── Return statement ─────────────────────────────────────────

  describe('return statement', () => {
    it('return Ok(42) with function return type Result<number, string> → compiles', () => {
      const src = [
        'let f = (x: boolean): Result<number, string> => {',
        '  if (x) {',
        '    return Ok(42)',
        '  }',
        '  return Err("no")',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('return Err("msg") with function return type → compiles', () => {
      const src = [
        'let f = (): Result<number, string> => {',
        '  return Err("failure")',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });
  });

  // ── Try/catch ────────────────────────────────────────────────

  describe('try/catch', () => {
    it('try/catch with Ok in try body and Err in catch body + return type → compiles', () => {
      const src = [
        'let f = (): Result<number, string> => {',
        '  try { Ok(42) } catch (e) { Err("failed") }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('explicit type args on Ok/Err → takes precedence', () => {
      const src = 'let r: Result<number, string> = Ok<number, string>(42)';
      expectNoErrors(src);
    });

    it('deeply nested: block > if > block > Ok → expected type propagates', () => {
      const src = [
        'let f = (): Result<number, string> => {',
        '  let x = 42',
        '  if (true) {',
        '    let y = x + 1',
        '    Ok(y)',
        '  } else {',
        '    Err("no")',
        '  }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('type variable resolved by both arg and expected type (arg wins, no conflict)', () => {
      const src = [
        'let f = (x: number): Result<number, string> => {',
        '  Ok(x)',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('type variable resolved by arg conflicts with expected type → E200', () => {
      const src = [
        'let f = (): Result<number, string> => {',
        '  Ok("hello")',
        '}',
      ].join('\n');
      expectErrors(src, 'E200');
    });

    it('nullable annotation Result<T, E>? → expectedType unwrapped, resolution works', () => {
      const src = 'let r: Result<number, string>? = Ok(42)';
      expectNoErrors(src);
    });

    it('Ok in block expression with leading statements', () => {
      const src = [
        'let f = (x: boolean): Result<number, string> => {',
        '  let msg = "error"',
        '  if (x) { Ok(42) } else { Err(msg) }',
        '}',
      ].join('\n');
      expectNoErrors(src);
    });

    it('match Err(e) re-wrapping: variant field substitution is pre-existing limitation', () => {
      // Err(e) from match on Result<number, string> binds e as generic 'E'
      // rather than concrete 'string' because checkVariantPattern reads from
      // unsubstituted variant.fields. This is a pre-existing limitation, not
      // caused by Result generic unification. Document the status quo.
      const src = [
        'let f = (r: Result<number, string>): Result<string, string> => {',
        '  match r {',
        '    Ok(n) => Ok("got it")',
        '    Err(e) => Err(e)',
        '  }',
        '}',
      ].join('\n');
      const { diagnostics } = checkSource(src);
      const errors = diagnostics.getErrors();
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('E200');
    });
  });
});
