import { describe, expect, it } from 'vitest';
import { addMinorUnits, formatMinorUnits, parseMinorUnits } from './money.js';

describe('minor units', () => {
  it('parses integer strings and numbers', () => {
    expect(parseMinorUnits('1000')).toBe(1000n);
    expect(parseMinorUnits(250)).toBe(250n);
    expect(parseMinorUnits(10n)).toBe(10n);
  });

  it('rejects floats', () => {
    expect(() => parseMinorUnits(10.5)).toThrow(/floats are forbidden/);
    expect(() => parseMinorUnits('10.5')).toThrow(/integer string/);
  });

  it('formats without decimal conversion', () => {
    expect(formatMinorUnits(199n)).toBe('199');
  });

  it('adds without floating point', () => {
    expect(addMinorUnits(1n, 2n)).toBe(3n);
  });
});
