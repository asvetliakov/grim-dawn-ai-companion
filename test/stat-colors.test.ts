/**
 * Which colour a rendered stat line gets.
 *
 * The rule reads the *finished string* — the same string the context document
 * shows the advisor — which is only safe because Stage 6C made "every stat
 * reference names its kind" a mechanical check. That makes this a genuine unit:
 * the input is text the formatter really emits, and the failure mode (a line
 * silently taking the wrong type's colour) is invisible in a screenshot.
 *
 * The DoT twins are the interesting part. Grim Dawn names them `Burn`,
 * `Frostburn`, `Electrocute`, `Poison`, `Vitality Decay` and `Internal Trauma`
 * — verified against the game's own `tagCharStats*` strings — and each is a
 * separate stat that caps and resists on its own, so it gets its own shade of
 * its parent's colour rather than the parent's exact colour.
 */

import { describe, expect, it } from 'vitest';

import { statClass } from '../src/renderer/src/statColors.js';

describe('statClass', () => {
  it('gives each direct damage type its own colour', () => {
    expect(statClass('+120% Pierce Damage')).toBe('stat-pierce');
    expect(statClass('+22% Fire Resistance')).toBe('stat-fire');
    expect(statClass('+18% Cold Damage')).toBe('stat-cold');
    expect(statClass('+30% Lightning Resistance')).toBe('stat-lightning');
    expect(statClass('+12% Acid Resistance')).toBe('stat-acid');
    expect(statClass('+16% Vitality Resistance')).toBe('stat-vitality');
    expect(statClass('+15% Aether Resistance')).toBe('stat-aether');
    expect(statClass('+18% Chaos Damage')).toBe('stat-chaos');
    expect(statClass('991 Armor')).toBe('stat-armor');
  });

  it('separates a damage-over-time type from the type it belongs to', () => {
    // Same family, different stat. The names are the game's own.
    expect(statClass('+50% Burn Damage')).toBe('stat-burn');
    expect(statClass('+60% Frostburn Damage')).toBe('stat-frostburn');
    expect(statClass('+38% Electrocute Damage')).toBe('stat-electrocute');
    expect(statClass('+15% Poison Damage')).toBe('stat-poison');
    expect(statClass('+12% Vitality Decay Damage')).toBe('stat-decay');
    expect(statClass('+65% Internal Trauma Damage')).toBe('stat-trauma');

    // And none of them steals its parent's line.
    expect(statClass('+22% Fire Damage')).toBe('stat-fire');
    expect(statClass('+94% Cold Damage')).toBe('stat-cold');
    expect(statClass('+30% Acid Damage')).toBe('stat-acid');
    expect(statClass('+16% Vitality Damage')).toBe('stat-vitality');
    expect(statClass('+4% Physical Resistance')).toBe('stat-physical');
  });

  it('keeps Frostburn out of Cold’s pattern and Burn out of Frostburn’s', () => {
    // `\bburn\b` must not match inside "Frostburn": there is no word boundary
    // between `t` and `b`, which is the whole reason the pattern works.
    expect(statClass('+52% Frostburn Damage')).not.toBe('stat-burn');
    expect(statClass('+25% Burn Damage')).not.toBe('stat-frostburn');
  });

  it('reads a shared elemental line as elemental, not as one of its three', () => {
    expect(statClass('+26% Fire, Cold and Lightning Resistance')).toBe('stat-elemental');
    expect(statClass('+12% Elemental Damage')).toBe('stat-elemental');
  });

  it('leaves Bleeding alone — it has no twin and never converts', () => {
    expect(statClass('+85% Bleeding Damage')).toBe('stat-bleeding');
    expect(statClass('+20% Bleeding Resistance')).toBe('stat-bleeding');
  });

  it('falls back to the non-elemental families, then to nothing', () => {
    expect(statClass('+550 Health')).toBe('stat-health');
    expect(statClass('+40 Offensive Ability')).toBe('stat-ability');
    expect(statClass('+18% Attack Speed')).toBe('stat-speed');
    expect(statClass('+25 Physique')).toBe('stat-attribute');
    expect(statClass('+3 to Searing Might')).toBe('stat-skill');
    expect(statClass('+8% Chance to Avoid Melee Attacks')).toBe('');
  });
});
