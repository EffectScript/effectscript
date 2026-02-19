import { describe, it, expect } from 'vitest';
import { OPERATOR_PRECEDENCE, getOperatorPrecedence } from './operators.js';

describe('operators.ts', () => {
  it('?? has higher precedence than && and ||', () => {
    expect(OPERATOR_PRECEDENCE['??']).toBeGreaterThan(OPERATOR_PRECEDENCE['&&']!);
    expect(OPERATOR_PRECEDENCE['??']).toBeGreaterThan(OPERATOR_PRECEDENCE['||']!);
  });

  it('?? has lower precedence than arithmetic', () => {
    expect(OPERATOR_PRECEDENCE['??']).toBeLessThan(OPERATOR_PRECEDENCE['+']!);
    expect(OPERATOR_PRECEDENCE['??']).toBeLessThan(OPERATOR_PRECEDENCE['*']!);
  });

  it('getOperatorPrecedence returns 0 for unknown operators', () => {
    expect(getOperatorPrecedence('unknown')).toBe(0);
  });

  it('getOperatorPrecedence returns correct value for known operators', () => {
    expect(getOperatorPrecedence('??')).toBe(OPERATOR_PRECEDENCE['??']);
    expect(getOperatorPrecedence('+')).toBe(OPERATOR_PRECEDENCE['+']);
    expect(getOperatorPrecedence('|>')).toBe(OPERATOR_PRECEDENCE['|>']);
  });
});
