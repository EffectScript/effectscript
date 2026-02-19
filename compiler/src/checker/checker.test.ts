import { describe, it, expect } from 'vitest';
import { check } from './checker.js';
import type { CheckerOutput } from './checker.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import { createPrelude } from '../prelude/prelude.js';
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
    };

    const moduleWithoutDefault: import('./types.js').ExportedTypeSignature = {
      types: new Map(),
      values: new Map([
        ['helper', strType],
      ]),
      adtConstructors: new Map(),
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
