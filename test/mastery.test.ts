import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGdc, parseGdcRecording } from '../src/core/save/gdc.js';
import { characterMasteries, classTagFor, planMasteryRemoval } from '../src/core/save/mastery.js';
import { MISSING_SAVES_MESSAGE, characterSavePath, haveSaves } from './paths.js';

describe('classTagFor', () => {
  it('concatenates the class numbers in ascending order', () => {
    expect(classTagFor([{ classNumber: '10' }, { classNumber: '04' }])).toBe('tagSkillClassName0410');
    expect(classTagFor([{ classNumber: '10' }])).toBe('tagSkillClassName10');
    expect(classTagFor([])).toBe('');
  });
});

function plan(character: string, mastery: string) {
  const source = readFileSync(characterSavePath(character));
  const { save, transcript } = parseGdcRecording(source);
  return { save, source, result: planMasteryRemoval({ character, save, transcript, source, mastery }) };
}

describe.skipIf(!haveSaves())('removing a mastery (live saves)', () => {
  if (!haveSaves()) {
    it.skip(MISSING_SAVES_MESSAGE, () => {});
  }

  it('reads both of _Suchka’s masteries off the skill list', () => {
    const save = parseGdc(readFileSync(characterSavePath('_Suchka')));
    const masteries = characterMasteries(save);

    expect(masteries.map((m) => m.classNumber)).toEqual(['04', '10']);
    expect(save.classRecord).toBe(classTagFor(masteries));
  });

  it('removes a mastery that has been reset to its bar', () => {
    const { save, result } = plan('_Suchka', 'records/skills/playerclass04/_classtraining_class04.dbr');

    expect(result.refusals).toEqual([]);
    expect(result.removed.map((r) => r.record)).toEqual([
      'records/skills/playerclass04/_classtraining_class04.dbr',
    ]);
    expect(result.skillPointsRefunded).toBe(1);
    expect(result.skillPointsAfter).toBe(save.attributes.skillPoints + 1);
    expect(result.classRecordBefore).toBe('tagSkillClassName0410');
    expect(result.classRecordAfter).toBe('tagSkillClassName10');
    // A binding lives on the host skill and names a devotion, so removing a
    // mastery takes its bindings with it. Anything else means the model is off.
    expect(result.danglingReferences).toEqual([]);
    expect(result.output).toBeDefined();
  });

  it('produces a save whose only changes are the intended ones', () => {
    // Selected by class number; the localized name needs the game database,
    // which these tests deliberately do without.
    const { save, result } = plan('_Suchka', '04');
    expect(result.refusals).toEqual([]);
    const after = parseGdc(result.output!);

    // Structurally sound: this is the check the game itself would make first.
    expect(after.warnings).toEqual([]);
    expect(after.blocks.filter((b) => !b.checksumOk || b.status !== 'parsed')).toEqual([]);
    expect(after.blocks.map((b) => b.id)).toEqual(save.blocks.map((b) => b.id));

    expect(after.classRecord).toBe('tagSkillClassName10');
    expect(after.attributes.skillPoints).toBe(save.attributes.skillPoints + 1);
    expect(after.skillEntries).toHaveLength(save.skillEntries.length - 1);
    expect(after.skillEntries.filter((e) => /playerclass04/i.test(e.record))).toEqual([]);
    expect(characterMasteries(after).map((m) => m.classNumber)).toEqual(['10']);

    // Everything else is untouched, field for field. `blocks` carries the two
    // edited blocks' new lengths, so it is compared by id above instead.
    const strip = (s: typeof save) => ({
      ...s,
      classRecord: '',
      attributes: { ...s.attributes, skillPoints: 0 },
      skillEntries: s.skillEntries.filter((e) => !/playerclass04/i.test(e.record)),
      skills: s.skills.filter((e) => !/playerclass04/i.test(e.record)),
      blocks: [],
    });
    expect(strip(after)).toEqual(strip(save));

    // Devotions ride in the same array as skills and must all survive.
    expect(after.devotions).toEqual(save.devotions);
  });

  it('refuses a mastery that still holds skills', () => {
    const { result } = plan('_Suchka', 'records/skills/playerclass10/_classtraining_class10.dbr');

    expect(result.refusals).toEqual([
      { kind: 'mastery-not-reset', entryCount: 16, pointsInvested: 121 },
    ]);
    expect(result.output).toBeUndefined();
  });

  it('refuses to leave a character with no mastery at all', () => {
    const { result } = plan('_abcdef', '01');

    expect(result.refusals).toEqual([{ kind: 'last-mastery' }]);
    expect(result.output).toBeUndefined();
  });

  it('refuses a mastery the character does not have', () => {
    const { result } = plan('_Suchka', 'Necromancer');

    expect(result.refusals).toEqual([{ kind: 'unknown-mastery', record: 'Necromancer' }]);
    expect(result.output).toBeUndefined();
  });

  it('refuses a save it cannot reproduce byte for byte', () => {
    const source = readFileSync(characterSavePath('_Suchka'));
    const { save, transcript } = parseGdcRecording(source);
    const tampered = Buffer.from(source);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;

    const result = planMasteryRemoval({
      character: '_Suchka',
      save,
      transcript,
      source: tampered,
      mastery: '04',
    });

    expect(result.refusals.map((r) => r.kind)).toContain('roundtrip-mismatch');
    expect(result.output).toBeUndefined();
  });
});
