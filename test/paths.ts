/**
 * The saves the tests run against.
 *
 * The user's real saves are the only fixtures that prove these parsers against
 * the actual game version — but they are also *live*: played, respecced,
 * re-geared and deleted between runs. So each one is copied into git-ignored
 * `test/fixtures/` the first time it is asked for, and every test reads that
 * copy from then on. The install is consulted once; after that the suite is
 * stable no matter what happens in game.
 *
 * Nothing here is committed. Saves are game-derived data and stay out of the
 * repo, which is why the fixtures are built on the machine that has them rather
 * than shipped, and why the roster is discovered rather than written down.
 *
 * Path resolution itself lives in `@grimdawn/core/paths` (and honours `GD_SAVE_DIR`),
 * so the tests exercise the same lookup the CLI uses rather than a parallel copy.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { findGameDir } from '@grimdawn/core/db/gamefiles';
import { listCharacters } from '@grimdawn/core/paths';
import { loadGameDb } from '@grimdawn/core/db';
import type { GameDb } from '@grimdawn/core/db/types';
import { parseGdc } from '@grimdawn/core/save/gdc';
import type { CharacterSave } from '@grimdawn/core/save/types';
import {
  characterSavePath as coreCharacterSavePath,
  formulasPath as coreFormulasPath,
  reagentsPath as coreReagentsPath,
  saveDir,
  transferStashPath as coreTransferStashPath,
} from '@grimdawn/core/paths';

/** Steam Cloud userdata save directory — override with `GD_SAVE_DIR`. */
export const SAVE_DIR = saveDir();

/** Git-ignored snapshot copies, so a test can pin a byte-exact fixture. */
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

/**
 * Copy a live file into the fixture directory on first use and return that path.
 * An existing fixture is never refreshed — that is the whole point: the game
 * rewrites saves as they are played, and a test's subject must not move under it.
 */
function snapshot(source: string, name: string): string {
  const target = join(FIXTURE_DIR, name);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return target;
}

/**
 * The characters the tests run against: **snapshots, not live saves.**
 *
 * A test that reads `save/main/<name>/player.gdc` is a test whose subject the
 * user can respec, re-gear or delete between runs, and both failure modes have
 * happened here. The roster was hardcoded as `['_Suchka', '_abcdef']`;
 * `_abcdef` was deleted in game, `haveSaves()` went false, and forty-one live
 * tests began skipping *silently* — a skip being exactly what a machine without
 * the game is supposed to report. The ones still running then failed on a
 * character that had been respecced out of the mastery they named.
 *
 * So the live tree is read exactly once per fixture: `snapshot()` copies a save
 * into git-ignored `test/fixtures/` the first time it is asked for, and every
 * test reads the copy forever after. A fixture whose character no longer exists
 * keeps working — `_abcdef` is still a test subject months after being deleted —
 * and playing the game cannot move an assertion.
 *
 * Nothing here is committed: saves are game-derived data. Which is why the
 * roster is still *discovered* rather than written down — on a machine with no
 * fixtures yet, it is whatever that install has, and tests that need a
 * character of a particular shape look for one (`characterWith`,
 * `primaryCharacter`) instead of naming it.
 */
function fixtureRoster(): string[] {
  const snapshots = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR)
        // `user-` is the Custom Game tree's prefix, and those are not campaign
        // characters: a mod's class does not match `playerclassNN`, so one
        // showing up here reports no masteries and a class tag it cannot explain.
        .filter((f) => f.endsWith('.gdc') && !f.startsWith('user-'))
        .map((f) => basename(f, '.gdc'))
    : [];
  if (snapshots.length > 0) return snapshots.sort();

  // First run on this machine: take a copy of every campaign character, and
  // from here on this list is frozen against anything the user does in game.
  const live = listCharacters(SAVE_DIR, 'main');
  for (const name of live) snapshot(coreCharacterSavePath(name, SAVE_DIR), `${name}.gdc`);
  return live;
}

export const CHARACTERS: readonly string[] = fixtureRoster();

/**
 * A character's save **as the tests see it** — the snapshot, taken from the live
 * tree on first use. Use `liveCharacterSavePath` for the handful of cases that
 * genuinely mean the file the game is writing.
 */
export function characterSavePath(name: string): string {
  return snapshot(coreCharacterSavePath(name, SAVE_DIR), `${name}.gdc`);
}

/** The real file under the save tree, which the game rewrites as it is played. */
export function liveCharacterSavePath(name: string): string {
  return coreCharacterSavePath(name, SAVE_DIR);
}

/**
 * The most developed campaign character on this machine — highest level, ties
 * broken by name so a run is deterministic.
 *
 * Tests that want a character with gear in every slot, damage conversions,
 * augments and a grown devotion tree need *this* one rather than whichever name
 * happens to sort first. They used to say `CHARACTERS[0]`, which was fine while
 * the roster was hardcoded with the developed character at the front; the moment
 * it became discovered, a level-8 alt beginning with "_B" took the slot and
 * "bands, ranks and profiles a real character" quietly became a test about a
 * character wearing nothing.
 */
export function primaryCharacter(): string {
  let best: { name: string; level: number } | undefined;
  for (const name of CHARACTERS) {
    try {
      const level = parseGdc(readFileSync(characterSavePath(name))).attributes.level;
      if (!best || level > best.level) best = { name, level };
    } catch {
      // A save being written as the suite starts is not this helper's problem.
    }
  }
  if (!best) throw new Error('no campaign characters — guard with haveSaves()');
  return best.name;
}

/**
 * Custom Game characters (`save/user`), snapshotted like the campaign ones.
 *
 * Machine-dependent and optional: a campaign-only install has none, so every
 * test over them is skipped rather than failed. The name deliberately collides
 * with a campaign character here — this machine has a `_Suchka` and a `_Bitch`
 * in both trees — which is the case the tree parameter exists for, and the
 * reason their fixtures are filed under a `user-` prefix.
 */
export function customCharacters(): string[] {
  const snapshots = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR)
        .filter((f) => f.startsWith('user-') && f.endsWith('.gdc'))
        .map((f) => basename(f.slice('user-'.length), '.gdc'))
    : [];
  if (snapshots.length > 0) return snapshots.sort();

  const live = listCharacters(SAVE_DIR, 'user');
  for (const name of live) snapshot(coreCharacterSavePath(name, SAVE_DIR, 'user'), `user-${name}.gdc`);
  return live;
}

export function customCharacterSavePath(name: string): string {
  return snapshot(coreCharacterSavePath(name, SAVE_DIR, 'user'), `user-${name}.gdc`);
}

export function haveCustomSaves(): boolean {
  return customCharacters().length > 0;
}

export const MISSING_CUSTOM_SAVES_MESSAGE =
  `no Custom Game characters under ${SAVE_DIR}/user — ` +
  'these cover the save tree a mod or custom map writes to';

/**
 * An account-wide file, snapshotted like a character. The game rewrites these
 * as you play too — a stash tab reorders itself the moment you move an item.
 * Falls back to the live path when there is nothing to copy, so `haveX()` below
 * still reports honestly on a machine without the game.
 */
function sharedSave(livePath: string): string {
  const fixture = join(FIXTURE_DIR, basename(livePath));
  if (existsSync(fixture)) return fixture;
  if (existsSync(livePath)) return snapshot(livePath, basename(livePath));
  return livePath;
}

export const TRANSFER_STASH_PATH = sharedSave(coreTransferStashPath(SAVE_DIR));
export const FORMULAS_PATH = sharedSave(coreFormulasPath(SAVE_DIR));
export const REAGENTS_PATH = sharedSave(coreReagentsPath(SAVE_DIR));

/** Is there anything to test the parsers against — a fixture, or a live save to make one from? */
export function haveSaves(): boolean {
  return CHARACTERS.length > 0;
}

/**
 * Is the *live* save tree present on this machine?
 *
 * Almost nothing should ask. Parsing tests want a fixture and do not care where
 * it came from; this is for the handful of assertions that are about the
 * filesystem itself — that path detection reaches the real tree — and which are
 * meaningless once the saves have been copied out of it.
 */
export function haveLiveSaves(): boolean {
  return liveCharacters().length > 0;
}

/**
 * Campaign characters in the save tree as it is *now*.
 *
 * For tests that load a character the way the app does — through the session,
 * off the real save directory — rather than by handing a parser some bytes.
 * Those cannot run against a fixture of a character that has been deleted, and
 * should not: what they are checking is the path from the save tree to the
 * screen.
 */
export function liveCharacters(): string[] {
  return listCharacters(SAVE_DIR, 'main');
}

/** The most developed character the save tree actually holds. */
export function primaryLiveCharacter(): string {
  const live = liveCharacters();
  let best: { name: string; level: number } | undefined;
  for (const name of live) {
    try {
      const level = parseGdc(readFileSync(liveCharacterSavePath(name))).attributes.level;
      if (!best || level > best.level) best = { name, level };
    } catch {
      // Mid-write; another character will do.
    }
  }
  if (!best) throw new Error('no live campaign characters — guard with haveLiveSaves()');
  return best.name;
}

/**
 * The first campaign character satisfying a predicate, or undefined.
 *
 * For the tests that need a *shape* rather than a name — "a character with only
 * one mastery" is what proves the last-mastery refusal, and which character that
 * is on a given machine is nobody's business but this function's.
 */
export function characterWith(matches: (save: CharacterSave) => boolean): string | undefined {
  for (const name of CHARACTERS) {
    try {
      if (matches(parseGdc(readFileSync(characterSavePath(name))))) return name;
    } catch {
      // A save being written as the suite starts is not this helper's problem.
    }
  }
  return undefined;
}

export function haveTransferStash(): boolean {
  return existsSync(TRANSFER_STASH_PATH);
}

export function haveFormulas(): boolean {
  return existsSync(FORMULAS_PATH);
}

export function haveReagents(): boolean {
  return existsSync(REAGENTS_PATH);
}

export const MISSING_SAVES_MESSAGE =
  `live Grim Dawn saves not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing main/<character>/player.gdc to run these tests';

export const MISSING_GST_MESSAGE =
  `live transfer.gst / formulas.gst / reagents.gst not found under ${SAVE_DIR} — ` +
  'set GD_SAVE_DIR to a save directory containing them to run these tests';

/**
 * Kept as names for the snapshotting `characterSavePath` and the shared-file
 * constants now do by default. Every test path is a fixture; these two say so
 * at the call site, which is worth keeping where a test is explicitly about
 * byte stability.
 */
export function snapshotCharacterSave(name: string): string {
  return characterSavePath(name);
}

export function snapshotSharedSave(path: string): string {
  return sharedSave(path);
}

// ---------------------------------------------------------------------------
// The game install (Stage 3)
// ---------------------------------------------------------------------------

/**
 * The database tests need Grim Dawn itself, because item identity lives in the
 * game's `.arz` archives and nowhere else. They build the database once into the
 * *real* cache directory rather than a temp one — the build is keyed on the game
 * archives, so reusing the real cache is what keeps a full run at a second
 * instead of re-parsing 26k records for every test file.
 */
export function haveGameInstall(): boolean {
  return findGameDir() !== undefined;
}

export const MISSING_GAME_MESSAGE =
  `Grim Dawn install not found — ` +
  'set GD_GAME_DIR to a directory containing database/database.arz to run these tests';

let dbPromise: Promise<GameDb> | undefined;

/** The shared database, built at most once per test run. */
export function gameDb(): Promise<GameDb> {
  dbPromise ??= loadGameDb();
  return dbPromise;
}
