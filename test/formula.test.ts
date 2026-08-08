import { describe, expect, it } from 'vitest';

import { evaluateFormula } from '../src/core/db/formula.js';

// The three equations are copied verbatim from records/game/itemcostformulas.dbr
// (v1.3.0.6); the expected values were computed independently during the design
// probe and match in-game requirement magnitudes.
const CHEST_BASE =
  '(2.1*(itemLevel*6.55)^1.25-1.80*(itemLevel*5.84)^1.2785+((itemLevel^1.5)*0.0125-1)*-5)*0.98+12';
const RANGED2H_DEX =
  '2.5*(itemLevel*6.55)^1.22-1.8*(itemLevel*5.84)^1.2785+((itemLevel^1.5)*0.0125-1)*-5+25';
const AMULET_INT =
  '0.9*(2.0*(itemLevel*6.5)^1.223-1.52*(itemLevel*5.80)^1.2785+((itemLevel^1.5)/150-1)*15+(itemLevel*3)*((totalAttCount-1)/100)+11)';

describe('evaluateFormula', () => {
  it('applies standard precedence', () => {
    expect(evaluateFormula('2+3*4', {})).toBe(14);
    expect(evaluateFormula('(2+3)*4', {})).toBe(20);
    expect(evaluateFormula('10-4-3', {})).toBe(3); // left-assoc
    expect(evaluateFormula('12/4/3', {})).toBe(1);
  });

  it('treats ^ as right-associative and tighter than unary minus', () => {
    expect(evaluateFormula('2^3^2', {})).toBe(512);
    expect(evaluateFormula('-2^2', {})).toBe(-4);
    expect(evaluateFormula('3*-5', {})).toBe(-15); // the equations' `*-5` idiom
  });

  it('substitutes variables and rejects unknown ones', () => {
    expect(evaluateFormula('itemLevel*2', { itemLevel: 21 })).toBe(42);
    expect(() => evaluateFormula('bogus+1', {})).toThrow(/unknown variable "bogus"/);
  });

  it('rejects malformed input', () => {
    expect(() => evaluateFormula('(1+2', {})).toThrow(/expected/);
    expect(() => evaluateFormula('1 2', {})).toThrow(/trailing/);
    expect(() => evaluateFormula('', {})).toThrow(/unexpected end/);
  });

  it('reproduces the game requirement magnitudes', () => {
    expect(evaluateFormula(CHEST_BASE, { itemLevel: 30 })).toBeCloseTo(218.2, 1);
    expect(evaluateFormula(RANGED2H_DEX, { itemLevel: 70 })).toBeCloseTo(479.5, 1);
    expect(
      evaluateFormula(AMULET_INT, { itemLevel: 75, totalAttCount: 1 }),
    ).toBeCloseTo(312.1, 1);
  });

  it('shows the jewelry totalAttCount kicker is linear in totalAttCount', () => {
    const at = (totalAttCount: number) =>
      evaluateFormula(AMULET_INT, { itemLevel: 75, totalAttCount });
    const step = at(2) - at(1);
    expect(at(3) - at(2)).toBeCloseTo(step, 8);
    // 0.9 outer factor × itemLevel×3 ÷ 100
    expect(step).toBeCloseTo((0.9 * 75 * 3) / 100, 8);
  });
});
