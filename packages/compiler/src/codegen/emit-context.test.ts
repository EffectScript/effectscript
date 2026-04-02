import { describe, it, expect } from 'vitest';
import { EmitContext } from './emit-context.js';

describe('EmitContext', () => {
  // ── write / getOutput ─────────────────────────────────────

  it('produces empty string for no writes', () => {
    const ctx = new EmitContext();
    expect(ctx.getOutput()).toBe('');
  });

  it('write appends text', () => {
    const ctx = new EmitContext();
    ctx.write('hello');
    ctx.write(' world');
    expect(ctx.getOutput()).toBe('hello world');
  });

  it('writeLine appends text + newline', () => {
    const ctx = new EmitContext();
    ctx.writeLine('hello');
    ctx.writeLine('world');
    expect(ctx.getOutput()).toBe('hello\nworld\n');
  });

  it('newLine emits a newline', () => {
    const ctx = new EmitContext();
    ctx.write('a');
    ctx.newLine();
    ctx.write('b');
    expect(ctx.getOutput()).toBe('a\nb');
  });

  // ── indentation ───────────────────────────────────────────

  it('writeIndented adds current indent', () => {
    const ctx = new EmitContext();
    ctx.indent();
    ctx.writeIndented('hello');
    expect(ctx.getOutput()).toBe('  hello');
  });

  it('writeLineIndented adds indent + text + newline', () => {
    const ctx = new EmitContext();
    ctx.indent();
    ctx.writeLineIndented('hello');
    expect(ctx.getOutput()).toBe('  hello\n');
  });

  it('indent/dedent changes indentation level', () => {
    const ctx = new EmitContext();
    ctx.writeLineIndented('level 0');
    ctx.indent();
    ctx.writeLineIndented('level 1');
    ctx.indent();
    ctx.writeLineIndented('level 2');
    ctx.dedent();
    ctx.writeLineIndented('level 1 again');
    ctx.dedent();
    ctx.writeLineIndented('level 0 again');
    expect(ctx.getOutput()).toBe(
      'level 0\n' +
      '  level 1\n' +
      '    level 2\n' +
      '  level 1 again\n' +
      'level 0 again\n'
    );
  });

  it('dedent does not go below 0', () => {
    const ctx = new EmitContext();
    ctx.dedent(); // should be no-op
    ctx.writeIndented('no indent');
    expect(ctx.getOutput()).toBe('no indent');
  });

  // ── position tracking ────────────────────────────────────

  it('starts at line 1 column 0', () => {
    const ctx = new EmitContext();
    expect(ctx.getGeneratedLine()).toBe(1);
    expect(ctx.getGeneratedColumn()).toBe(0);
  });

  it('tracks column after write', () => {
    const ctx = new EmitContext();
    ctx.write('hello');
    expect(ctx.getGeneratedLine()).toBe(1);
    expect(ctx.getGeneratedColumn()).toBe(5);
  });

  it('tracks line after newline', () => {
    const ctx = new EmitContext();
    ctx.writeLine('hello');
    expect(ctx.getGeneratedLine()).toBe(2);
    expect(ctx.getGeneratedColumn()).toBe(0);
  });

  it('tracks position through indented writes', () => {
    const ctx = new EmitContext();
    ctx.indent();
    ctx.writeLineIndented('hi');
    // "  hi\n" => line 2, col 0
    expect(ctx.getGeneratedLine()).toBe(2);
    expect(ctx.getGeneratedColumn()).toBe(0);
  });

  it('tracks multi-line text in single write', () => {
    const ctx = new EmitContext();
    ctx.write('line1\nline2\nline3');
    expect(ctx.getGeneratedLine()).toBe(3);
    expect(ctx.getGeneratedColumn()).toBe(5); // "line3".length
  });

  // ── source mapping ───────────────────────────────────────

  it('collects mappings via addMapping', () => {
    const ctx = new EmitContext();
    const span = {
      file: 'test.efs',
      start: { offset: 0, line: 1, column: 0 },
      end: { offset: 5, line: 1, column: 5 },
    };
    ctx.addMapping(span);
    ctx.write('hello');
    const mappings = ctx.getMappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].generatedLine).toBe(1);
    expect(mappings[0].generatedColumn).toBe(0);
    expect(mappings[0].sourceLine).toBe(1);
    expect(mappings[0].sourceColumn).toBe(0);
    expect(mappings[0].sourceFile).toBe('test.efs');
  });

  it('tracks multiple mappings across lines', () => {
    const ctx = new EmitContext();
    const span1 = {
      file: 'test.efs',
      start: { offset: 0, line: 1, column: 0 },
      end: { offset: 5, line: 1, column: 5 },
    };
    const span2 = {
      file: 'test.efs',
      start: { offset: 10, line: 2, column: 0 },
      end: { offset: 15, line: 2, column: 5 },
    };
    ctx.addMapping(span1);
    ctx.writeLine('const x = 42;');
    ctx.addMapping(span2);
    ctx.writeLine('const y = 10;');
    const mappings = ctx.getMappings();
    expect(mappings).toHaveLength(2);
    expect(mappings[0].generatedLine).toBe(1);
    expect(mappings[1].generatedLine).toBe(2);
  });

  it('getMappings returns empty array when no mappings added', () => {
    const ctx = new EmitContext();
    ctx.write('hello');
    expect(ctx.getMappings()).toHaveLength(0);
  });
});
