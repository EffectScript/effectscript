/**
 * @module value-params.test
 *
 * Tests for value parameter semantics (E240/E241): function parameters are
 * deeply immutable by default; `var` allows content mutation.
 */

import { describe, it, expect } from 'vitest';
import { check } from './checker.js';
import type { CheckerOutput } from './checker.js';
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { DiagnosticCollectorImpl } from '../diagnostics/collector.js';
import { createPrelude } from '../prelude/prelude.js';
import type { Program, ArrowFunction, LetDeclaration, FunctionParam } from '../parser/ast.js';
import type { Diagnostic } from '../diagnostics/diagnostic.js';

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

function getErrors(source: string): readonly Diagnostic[] {
  const { diagnostics } = checkSource(source);
  return diagnostics.getErrors();
}

function parseOk(source: string): Program {
  const diagnostics = new DiagnosticCollectorImpl();
  const tokens = tokenize(source, 'test.efs', diagnostics);
  const program = parse(tokens, 'test.efs', diagnostics);
  const errors = diagnostics.getAll().filter(d => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Expected no errors but got:\n${errors.map(d => `  ${d.code}: ${d.message}`).join('\n')}`);
  }
  return program;
}

// ── Parser Tests ─────────────────────────────────────────────────────

describe('value parameter semantics — parser', () => {
  it('parses (var x: number) — FunctionParam has mutable: true', () => {
    const prog = parseOk('let f = (var x: number): number => x');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params.length).toBe(1);
    expect(fn.params[0].mutable).toBe(true);
    expect(fn.params[0].name.name).toBe('x');
  });

  it('parses (x: number) — FunctionParam has mutable: false', () => {
    const prog = parseOk('let f = (x: number): number => x');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params.length).toBe(1);
    expect(fn.params[0].mutable).toBe(false);
  });

  it('parses mixed mutability: (var items: Array<string>, name: string)', () => {
    const prog = parseOk('let f = (var items: Array<string>, name: string): void => { }');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params.length).toBe(2);
    expect(fn.params[0].mutable).toBe(true);
    expect(fn.params[0].name.name).toBe('items');
    expect(fn.params[1].mutable).toBe(false);
    expect(fn.params[1].name.name).toBe('name');
  });

  it('parses var with default value: (var x: number = 42)', () => {
    const prog = parseOk('let f = (var x: number = 42): number => x');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params[0].mutable).toBe(true);
    expect(fn.params[0].defaultValue).toBeDefined();
  });

  it('rejects double var: (var var x: number) — parse error', () => {
    const diagnostics = new DiagnosticCollectorImpl();
    const tokens = tokenize('let f = (var var x: number): number => x', 'test.efs', diagnostics);
    parse(tokens, 'test.efs', diagnostics);
    const errors = diagnostics.getAll().filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects var in type position: (x: var number) — parse error', () => {
    const diagnostics = new DiagnosticCollectorImpl();
    const tokens = tokenize('let f = (x: var number): number => x', 'test.efs', diagnostics);
    parse(tokens, 'test.efs', diagnostics);
    const errors = diagnostics.getAll().filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('var in generic function: <T>(var items: Array<T>): void', () => {
    const prog = parseOk('let f = <T>(var items: Array<T>): void => { }');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params[0].mutable).toBe(true);
  });

  it('var combined with return type annotation', () => {
    const prog = parseOk('let f = (var items: Array<number>): Array<number> => items');
    const decl = prog.body[0] as LetDeclaration;
    const fn = decl.initializer as ArrowFunction;
    expect(fn.params[0].mutable).toBe(true);
    expect(fn.returnType).toBeDefined();
  });

  it('var in extension function params', () => {
    const prog = parseOk('fun string.doSomething(var items: Array<number>): void => { }');
    const decl = prog.body[0];
    expect(decl.kind).toBe('ExtensionFunctionDeclaration');
    const ext = decl as import('../parser/ast.js').ExtensionFunctionDeclaration;
    expect(ext.params[0].mutable).toBe(true);
  });
});

// ── Checker Tests — Immutable Parameters ─────────────────────────────

describe('value parameter semantics — immutable params', () => {

  // Direct mutation rejection (E241)
  describe('E241 — direct property mutation', () => {
    it('rejects param.field = value on record parameter', () => {
      expectErrors(
        `let f = (user: { name: string }): void => { user.name = "Bob" }`,
        'E241',
      );
    });

    it('rejects deep param.nested.field = value', () => {
      expectErrors(
        `let f = (config: { db: { host: string } }): void => { config.db.host = "localhost" }`,
        'E241',
      );
    });

    it('rejects param.a.b.c = value', () => {
      expectErrors(
        `let f = (x: { a: { b: { c: number } } }): void => { x.a.b.c = 42 }`,
        'E241',
      );
    });
  });

  // Mutating method rejection (E240)
  describe('E240 — mutating method calls', () => {
    it('rejects param.push(x) on array parameter', () => {
      expectErrors(
        `let f = (items: Array<number>): void => { items.push(42) }`,
        'E240',
      );
    });

    it('rejects param.pop() on array parameter', () => {
      expectErrors(
        `let f = (items: Array<number>): void => { items.pop() }`,
        'E240',
      );
    });

    it('rejects param.shift() on array parameter', () => {
      expectErrors(
        `let f = (items: Array<number>): void => { items.shift() }`,
        'E240',
      );
    });

    it('rejects param.unshift(x) on array parameter', () => {
      expectErrors(
        `let f = (items: Array<number>): void => { items.unshift(42) }`,
        'E240',
      );
    });

    it('rejects param.sort() on array parameter', () => {
      expectErrors(
        `let f = (items: Array<number>): void => { items.sort() }`,
        'E240',
      );
    });
  });

  // Non-mutating methods allowed
  describe('non-mutating methods on immutable params', () => {
    it('allows param.map(f)', () => {
      expectNoErrors(
        `let f = (items: Array<number>): Array<number> => items.map((n: number): number => n * 2)`,
      );
    });

    it('allows param.filter(f)', () => {
      expectNoErrors(
        `let f = (items: Array<number>): Array<number> => items.filter((n: number): boolean => n > 0)`,
      );
    });

    it('allows param.forEach(f)', () => {
      expectNoErrors(
        `let f = (items: Array<number>): void => { items.forEach((n: number): void => { print(n) }) }`,
      );
    });

    it('allows param.includes(x)', () => {
      expectNoErrors(
        `let f = (items: Array<number>): boolean => items.includes(42)`,
      );
    });

    it('allows param.at(0)', () => {
      expectNoErrors(
        `let f = (items: Array<number>): number? => items.at(0)`,
      );
    });

    it('allows param.length', () => {
      expectNoErrors(
        `let f = (items: Array<number>): number => items.length`,
      );
    });

  });

  // Reassignment rejection (E202, existing)
  it('rejects param = newValue (E202)', () => {
    expectErrors(
      `let f = (items: Array<number>): void => { items = [1, 2, 3] }`,
      'E202',
    );
  });

  // Deep mutation through chains
  describe('deep mutation through chains', () => {
    it('rejects param.nested.push(x) — E240 on param', () => {
      expectErrors(
        `let f = (data: { items: Array<number> }): void => { data.items.push(42) }`,
        'E240',
      );
    });
  });

  // Read-only access (allowed)
  describe('read-only access is allowed', () => {
    it('allows passing param to other functions', () => {
      expectNoErrors(
        `let f = (items: Array<number>): number => items.length`,
      );
    });

    it('allows reading record fields', () => {
      expectNoErrors(
        `let f = (user: { name: string, age: number }): string => user.name`,
      );
    });
  });
});

// ── Checker Tests — Mutable Parameters ───────────────────────────────

describe('value parameter semantics — mutable params', () => {
  it('allows (var items: Array<number>) => { items.push(42) }', () => {
    expectNoErrors(
      `let f = (var items: Array<number>): void => { items.push(42) }`,
    );
  });

  it('allows (var user: { var name: string }) => { user.name = "Bob" }', () => {
    expectNoErrors(
      `let f = (var user: { var name: string }): void => { user.name = "Bob" }`,
    );
  });

  it('allows (var items: Array<number>) => { items.sort() }', () => {
    expectNoErrors(
      `let f = (var items: Array<number>): void => { items.sort() }`,
    );
  });

  it('rejects reassignment (var items: Array<number>) => { items = [] } — E202', () => {
    expectErrors(
      `let f = (var items: Array<number>): void => { items = [] }`,
      'E202',
    );
  });

  it('mixed: E240 on immutable, no error on mutable', () => {
    const source = `
      let f = (items: Array<number>, var other: Array<number>): void => {
        other.push(2)
      }
    `;
    expectNoErrors(source);
  });

  it('mixed: immutable param still errors', () => {
    expectErrors(
      `let f = (items: Array<number>, var other: Array<number>): void => { items.push(1) }`,
      'E240',
    );
  });
});

// ── Checker Tests — Set/Map Parameters ───────────────────────────────

describe('value parameter semantics — Set/Map', () => {
  it('rejects Set param.add() — E240', () => {
    expectErrors(
      `let f = (names: Set<string>): void => { names.add("x") }`,
      'E240',
    );
  });

  it('rejects Set param.delete() — E240', () => {
    expectErrors(
      `let f = (names: Set<string>): void => { names.delete("x") }`,
      'E240',
    );
  });

  it('allows var Set param.add()', () => {
    expectNoErrors(
      `let f = (var names: Set<string>): void => { names.add("x") }`,
    );
  });

  it('rejects Map param.set() — E240', () => {
    expectErrors(
      `let f = (scores: Map<string, number>): void => { scores.set("x", 1) }`,
      'E240',
    );
  });

  it('rejects Map param.delete() — E240', () => {
    expectErrors(
      `let f = (scores: Map<string, number>): void => { scores.delete("x") }`,
      'E240',
    );
  });

  it('allows var Map param.set()', () => {
    expectNoErrors(
      `let f = (var scores: Map<string, number>): void => { scores.set("x", 1) }`,
    );
  });
});

// ── Edge Case Tests ──────────────────────────────────────────────────

describe('value parameter semantics — edge cases', () => {
  it('alias escape: let alias = param; alias.push(x) — no error', () => {
    expectNoErrors(
      `let f = (items: Array<number>): void => {
        let alias = items
        alias.push(42)
      }`,
    );
  });

  it('closure capture: param.push(x) in inner lambda — E240', () => {
    expectErrors(
      `let f = (items: Array<number>): () => void => {
        let mutator = (): void => { items.push(42) }
        mutator
      }`,
      'E240',
    );
  });

  it('for loop variable: item.field = x — no error with var field (not a param)', () => {
    expectNoErrors(
      `let f = (items: Array<{ var name: string }>): void => {
        for (item in items) {
          item.name = "changed"
        }
      }`,
    );
  });

  it('Any parameter: x.push(42) — no error', () => {
    expectNoErrors(
      `let f = (x: Any): void => { x.push(42) }`,
    );
  });

  it('primitive parameter: s.toUpperCase() — no error', () => {
    expectNoErrors(
      `let f = (s: string): string => s.toUpperCase()`,
    );
  });

  it('catch parameter mutation: catch (e) { e.message = "changed" } — E275 (immutable field on error record)', () => {
    expectErrors(
      `let f = (): void => {
        try { print("hello") } catch (e) { e.message = "changed" }
      }`,
      'E275',
    );
  });

  it('passing immutable param to var-param function — no error (type-level)', () => {
    expectNoErrors(
      `let sortHelper = (var items: Array<number>): void => { items.sort() }
       let process = (items: Array<number>): void => { sortHelper(items) }`,
    );
  });

  it('generic parameter: <T>(items: Array<T>) — E240 on push', () => {
    expectErrors(
      `let f = <T>(items: Array<T>): void => { items.push(items.at(0)) }`,
      'E240',
    );
  });

  it('extension function this: this.push(0) — no error', () => {
    expectNoErrors(
      `fun Array<number>.addDefault(): void => { this.push(0) }`,
    );
  });

  it('extension function param: items.push(0) — E240', () => {
    expectErrors(
      `fun string.doStuff(items: Array<number>): void => { items.push(0) }`,
      'E240',
    );
  });

  it('extension function var param: items.push(0) — no error', () => {
    expectNoErrors(
      `fun string.doStuff(var items: Array<number>): void => { items.push(0) }`,
    );
  });

  it('nullable parameter: items?.push(42) — E240', () => {
    // Optional chaining is still a member access on immutable param
    expectErrors(
      `let f = (items: Array<number>?): void => {
        if (items != null) {
          items.push(42)
        }
      }`,
      'E240',
    );
  });
});

// ── Diagnostic Quality Tests ─────────────────────────────────────────

describe('value parameter semantics — diagnostic quality', () => {
  it('E241 message includes parameter name', () => {
    const errors = getErrors(
      `let f = (user: { name: string }): void => { user.name = "Bob" }`,
    );
    const e241 = errors.find(e => e.code === 'E241');
    expect(e241).toBeDefined();
    expect(e241!.message).toContain('user');
  });

  it('E240 message includes method name and parameter name', () => {
    const errors = getErrors(
      `let f = (items: Array<number>): void => { items.push(42) }`,
    );
    const e240 = errors.find(e => e.code === 'E240');
    expect(e240).toBeDefined();
    expect(e240!.message).toContain('push');
    expect(e240!.message).toContain('items');
  });

  it('E240 includes relatedSpan pointing to parameter declaration', () => {
    const errors = getErrors(
      `let f = (items: Array<number>): void => { items.push(42) }`,
    );
    const e240 = errors.find(e => e.code === 'E240');
    expect(e240).toBeDefined();
    expect(e240!.relatedSpans).toBeDefined();
    expect(e240!.relatedSpans!.length).toBeGreaterThan(0);
  });

  it('E241 includes suggested fix mentioning var', () => {
    const errors = getErrors(
      `let f = (user: { name: string }): void => { user.name = "Bob" }`,
    );
    const e241 = errors.find(e => e.code === 'E241');
    expect(e241).toBeDefined();
    expect(e241!.fix).toBeDefined();
    expect(e241!.fix!.description).toContain('var');
  });

  it('E240/E241 do not fire on var local variables', () => {
    expectNoErrors(
      `let f = (): void => {
        var items: Array<number> = [1, 2, 3]
        items.push(42)
      }`,
    );
  });
});
