import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { DbFactionBooster } from '../src/core/db/types.js';
import { bestBoosters, planFactionBoosters } from '../src/core/save/boosters.js';
import { factionSlot, factionSlotByKey } from '../src/core/save/factions.js';
import { encodeBlock13, parseGdc, parseGdcRecording } from '../src/core/save/gdc.js';
import { spliceRegion } from '../src/core/save/transcript.js';
import {
  CHARACTERS,
  MISSING_GAME_MESSAGE,
  MISSING_SAVES_MESSAGE,
  characterSavePath,
  gameDb,
  haveGameInstall,
  haveSaves,
} from './paths.js';

describe('factionSlotByKey', () => {
  it('inverts factionSlot for both spellings of a faction key', () => {
    // The eight fixed slugs, and the `factionUser<N>` → N + 6 rule.
    expect(factionSlotByKey('Survivors')).toBe(1);
    expect(factionSlotByKey('Beasts')).toBe(5);
    expect(factionSlotByKey('User2')).toBe(8);
    expect(factionSlotByKey('User21')).toBe(27);
    // User0 lands on Rovers: the numbered table agreeing with the fixed one on
    // the slot they share, which is what makes the offset rule checkable.
    expect(factionSlotByKey('User0')).toBe(6);
    expect(factionSlot(6)?.id).toBe('drifters');
    expect(factionSlotByKey('nonsense')).toBeUndefined();
    expect(factionSlotByKey('User99')).toBeUndefined();
  });
});

describe('bestBoosters', () => {
  const booster = (name: string, factionKey: string, multiplier: number, kind: 'reputation' | 'nemesis') =>
    ({ record: `records/${name}`, name, factionKey, multiplier, kind }) satisfies DbFactionBooster;

  it('keeps the largest multiplier per faction per direction — a Mandate does not stack with a Writ', () => {
    const { targets } = bestBoosters(
      [
        booster('Writ of the Rovers', 'User0', 1.5, 'reputation'),
        booster('Mandate of the Rovers', 'User0', 3, 'reputation'),
      ],
      factionSlotByKey,
    );
    expect(targets.get(6)?.reputation).toEqual({ to: 3, source: 'Mandate of the Rovers' });
  });

  it('files both directions of a faction that sells a writ and a warrant on one slot', () => {
    const { targets } = bestBoosters(
      [
        booster('Mandate of the Kymon’s Chosen', 'User8', 3, 'reputation'),
        booster('Kymon’s Warrant', 'User8', 3, 'nemesis'),
      ],
      factionSlotByKey,
    );
    expect(targets.get(14)).toEqual({
      reputation: { to: 3, source: 'Mandate of the Kymon’s Chosen' },
      nemesis: { to: 3, source: 'Kymon’s Warrant' },
    });
  });

  it('reports a faction key it cannot place rather than dropping it', () => {
    const { targets, unmapped } = bestBoosters([booster('Writ of Nowhere', 'Nowhere', 3, 'reputation')], factionSlotByKey);
    expect(targets.size).toBe(0);
    expect(unmapped.map((b) => b.name)).toEqual(['Writ of Nowhere']);
  });
});

describe.skipIf(!haveGameInstall())('the booster table (live game database)', () => {
  if (!haveGameInstall()) it.skip(MISSING_GAME_MESSAGE, () => {});

  it('finds every Writ, Mandate and Warrant the game ships', async () => {
    const db = await gameDb();
    const boosters = db.factionBoosters();
    const rep = boosters.filter((b) => b.kind === 'reputation');
    const nem = boosters.filter((b) => b.kind === 'nemesis');

    expect(boosters).toHaveLength(42);
    expect(rep.filter((b) => b.multiplier === 1.5)).toHaveLength(15); // Writs
    expect(rep.filter((b) => b.multiplier === 3)).toHaveLength(15); // Mandates
    expect(nem.every((b) => b.multiplier === 3)).toBe(true);
    expect(nem).toHaveLength(12);
    expect(boosters.every((b) => b.record.startsWith('records/items/faction/booster/'))).toBe(true);
  });

  it('resolves each writ’s faction key to the slot its own vendor names', async () => {
    const db = await gameDb();
    // An independent check on the slot table: the record says `boostedFaction:
    // User7`, and the vendor that stocks it says `factionId: f7`. Warrants carry
    // no vendor entry at all, which is why they cannot be checked this way.
    let checked = 0;
    for (const booster of db.factionBoosters()) {
      const vendor = db.getItem(booster.record)?.vendors?.[0];
      if (!vendor) continue;
      const slot = factionSlotByKey(booster.factionKey);
      expect(slot, booster.name).toBeDefined();
      expect(factionSlot(slot!)?.id, booster.name).toBe(vendor.factionId);
      checked++;
    }
    expect(checked).toBe(30); // 15 Writs + 15 Mandates
  });
});

describe.skipIf(!haveSaves())('encodeBlock13 (live saves)', () => {
  if (!haveSaves()) it.skip(MISSING_SAVES_MESSAGE, () => {});

  it.each(CHARACTERS)('reproduces %s’s faction block field for field', (character) => {
    const { save, transcript } = parseGdcRecording(readFileSync(characterSavePath(character)));
    const block = transcript.segments.find((s) => s.kind === 'block' && s.id === 13);
    expect(block?.kind).toBe('block');
    if (block?.kind !== 'block') return;
    const version = block.body[0];
    expect(version?.kind).toBe('u32');
    if (version?.kind !== 'u32') return;

    // A no-op splice: the encoder's output must be a structural prefix of what
    // was read, which is the check that catches an encoder drifting from its
    // decoder before it can write a plausible-looking wrong file.
    const encoded = encodeBlock13(save, version.value);
    expect(() => spliceRegion(block.body, encoded, encoded, 'block 13')).not.toThrow();
  });
});

describe.skipIf(!haveSaves() || !haveGameInstall())('applying faction boosters (live saves)', () => {
  if (!haveSaves() || !haveGameInstall()) it.skip(`${MISSING_SAVES_MESSAGE} / ${MISSING_GAME_MESSAGE}`, () => {});

  async function plan(source: Buffer, opts: Record<string, unknown> = {}) {
    const { save, transcript } = parseGdcRecording(source);
    return planFactionBoosters({ character: '_Suchka', save, transcript, source, db: await gameDb(), ...opts });
  }

  it('sets every booster the game sells, and nothing else in the file', async () => {
    const source = readFileSync(characterSavePath('_Suchka'));
    const before = parseGdc(source);
    const result = await plan(source);

    expect(result.refusals).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.output).toBeDefined();
    // 15 factions sell a writ, 12 sell a warrant.
    expect(result.changes.filter((c) => c.kind === 'reputation')).toHaveLength(15);
    expect(result.changes.filter((c) => c.kind === 'nemesis')).toHaveLength(12);

    const after = parseGdc(result.output!);
    expect(after.warnings).toEqual([]);
    expect(after.blocks.every((b) => b.checksumOk)).toBe(true);
    expect(after.blocks).toHaveLength(before.blocks.length);

    const touched = new Set(result.changes.map((c) => c.slot));
    for (const [i, was] of before.factions.entries()) {
      const now = after.factions[i]!;
      if (!touched.has(i)) {
        expect(now, `slot ${i}`).toEqual(was);
        continue;
      }
      // Only the two multipliers move; reputation, unlock and changed flags stay.
      expect({ ...now, positiveBoost: 0, negativeBoost: 0 }).toEqual({ ...was, positiveBoost: 0, negativeBoost: 0 });
      for (const c of result.changes.filter((c) => c.slot === i)) {
        expect(c.to).toBe(3);
        expect(c.kind === 'reputation' ? now.positiveBoost : now.negativeBoost).toBe(3);
      }
    }
    // Everything outside block 13 is untouched.
    const strip = (s: typeof before) => ({ ...s, factions: [], blocks: [] });
    expect(strip(after)).toEqual(strip(before));
  });

  it('is a no-op the second time — an applied booster is not rewritten', async () => {
    const source = readFileSync(characterSavePath('_Suchka'));
    const once = await plan(source);
    const twice = await plan(once.output!);

    expect(twice.refusals).toEqual([]);
    expect(twice.changes).toEqual([]);
    expect(twice.unchanged).toHaveLength(27);
    expect(twice.output).toBeUndefined();
  });

  it('clears every multiplier, including a writ the character had already used', async () => {
    const source = readFileSync(characterSavePath('_Suchka'));
    const before = parseGdc(source);
    // This character has consumed Writs: some slots read 1.5 rather than 0.
    expect(before.factions.some((f) => f.positiveBoost === 1.5)).toBe(true);

    const applied = await plan(source);
    const cleared = await plan(applied.output!, { clear: true });
    expect(cleared.refusals).toEqual([]);
    expect(cleared.changes).toHaveLength(27);

    const after = parseGdc(cleared.output!);
    expect(after.factions.every((f) => f.positiveBoost === 0 && f.negativeBoost === 0)).toBe(true);
  });

  it('honours --no-warrants and --faction, and refuses a faction it does not know', async () => {
    const source = readFileSync(characterSavePath('_Suchka'));

    const writsOnly = await plan(source, { warrants: false });
    expect(writsOnly.changes.every((c) => c.kind === 'reputation')).toBe(true);
    expect(writsOnly.changes).toHaveLength(15);

    const one = await plan(source, { factions: ['Kurn'] });
    expect(one.changes.map((c) => c.faction)).toEqual(['Kurn']);

    const wrong = await plan(source, { factions: ['The Fourth Wall'] });
    expect(wrong.refusals).toContainEqual({ kind: 'unknown-faction', name: 'The Fourth Wall' });
    expect(wrong.output).toBeUndefined();
  });
});
