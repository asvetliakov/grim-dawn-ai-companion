/**
 * One character, loaded end to end.
 *
 * Picking a character, reading its `player.gdc` and the three account-wide
 * `.gst` files, resolving, aggregating and compiling the context document is a
 * single composition that both the CLI and the Electron main process need, and
 * it is the composition that must not drift: the document the UI shows and the
 * document the advisor is sent have to be the same document, built the same
 * way, or Stage 7B's advice-to-item join stops meaning anything.
 *
 * Failures are typed rather than printed. The CLI turns a `SessionError` into a
 * one-line message and exits; the window shows it in the frame it already has
 * open. Neither behaviour belongs down here.
 */

import { existsSync, readFileSync } from 'node:fs';

import { buildContextDoc, type ContextDoc, type ContextInput } from './context/builder.js';
import type { GameDb } from '@grimdawn/core/db/types';
import { aggregateCharacter, type CharacterAggregate } from './mechanics/aggregate.js';
import { characterSavePath, formulasPath, reagentsPath, transferStashPath } from '@grimdawn/core/paths';
import { resolveCharacter, type AccountFiles, type ResolvedCharacter } from '@grimdawn/core/resolve';
import { parseGdc } from '@grimdawn/core/save/gdc';
import {
  parseFormulasFile,
  parseReagents,
  parseTransferStash,
  type FormulasFile,
  type MaterialStore,
  type TransferStash,
} from '@grimdawn/core/save/gst';
import { parseDifficulty, type CharacterSave, type Difficulty } from '@grimdawn/core/save/types';
import { listCharacters } from '@grimdawn/core/paths';
import { type ResolvedSettings } from './settings.js';

/** Why a snapshot could not be produced. `kind` is what a caller branches on. */
export class SessionError extends Error {
  constructor(
    readonly kind: 'no-characters' | 'bad-difficulty' | 'unreadable-save',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SnapshotOptions {
  /** Character directory under `<saveDir>/main`; default: settings, then first. */
  character?: string | undefined;
  /** Overrides both the setting and the save's own current difficulty. */
  difficulty?: Difficulty | undefined;
  maxTokens?: number | undefined;
  perGroup?: number | undefined;
  /**
   * A `player.gdc` somebody has already read, with the path it came off.
   *
   * The watcher is the only caller: it has just parsed the file — retrying
   * through the torn write, and falling back to a `player.gNN` rotation backup if
   * the live save never settled — and re-reading it here would throw that away
   * and re-run the race it just won, on the backup path with no chance of
   * winning. Must be the save of `opts.character`; nothing checks that, because
   * the one caller resolves the name first.
   */
  preparsed?: { save: CharacterSave; path: string } | undefined;
}

export interface CharacterSnapshot {
  character: string;
  savePath: string;
  save: CharacterSave;
  difficulty: Difficulty;
  /**
   * The account-wide files as parsed. The resolved items already carry
   * everything they hold, but the transfer stash's tab *dimensions* live only
   * here — and a grid has to be drawn at the size the game drew it.
   */
  account: AccountFiles;
  resolved: ResolvedCharacter;
  aggregate: CharacterAggregate;
  input: ContextInput;
  doc: ContextDoc;
}

/**
 * Read a save file, turning the usual filesystem failures into a sentence. A
 * missing save is an ordinary situation — the user has not played that mode, or
 * the path is stale — and should read as one.
 */
export function readSave(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' ? 'no such file' : code === 'EACCES' ? 'permission denied' : (err as Error).message;
    throw new SessionError('unreadable-save', `cannot read ${path} — ${reason}`);
  }
}

function readOptionalSave(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

/**
 * The three account-wide files, each skipped if absent. One helper so every
 * consumer reads the same set of containers — which is exactly how the reagent
 * store went unread for five stages.
 */
export function accountFiles(saveDir: string): AccountFiles {
  const stashBuf = readOptionalSave(transferStashPath(saveDir));
  const formulasBuf = readOptionalSave(formulasPath(saveDir));
  const reagentsBuf = readOptionalSave(reagentsPath(saveDir));
  const stash: TransferStash | undefined = stashBuf ? parseTransferStash(stashBuf) : undefined;
  const formulas: FormulasFile | undefined = formulasBuf ? parseFormulasFile(formulasBuf) : undefined;
  const materials: MaterialStore | undefined = reagentsBuf ? parseReagents(reagentsBuf) : undefined;
  return { stash, formulas, materials };
}

/** `elite`, `Elite`, `1` — all three name the same difficulty. */
export function requireDifficulty(input: string): Difficulty {
  const parsed = parseDifficulty(input);
  if (parsed) return parsed;
  throw new SessionError(
    'bad-difficulty',
    `unknown difficulty ${JSON.stringify(input)}; expected Normal, Elite, Ultimate or 0/1/2`,
  );
}

/**
 * Which character to open: what the caller asked for, else the pinned active
 * one, else the first on disk.
 */
export function pickCharacter(settings: ResolvedSettings, requested?: string): string {
  const name = requested ?? settings.activeCharacter ?? listCharacters(settings.saveDir)[0];
  if (!name) throw new SessionError('no-characters', `no characters found under ${settings.saveDir}/main`);
  return name;
}

/**
 * Everything a view or an advice call works from.
 *
 * The difficulty precedence is deliberate and unchanged from Stage 5B: an
 * explicit request wins, then the settings override, then whatever the save
 * says the character is currently playing.
 */
export function loadSnapshot(
  db: GameDb,
  settings: ResolvedSettings,
  opts: SnapshotOptions = {},
): CharacterSnapshot {
  const character = pickCharacter(settings, opts.character);
  const savePath = opts.preparsed?.path ?? characterSavePath(character, settings.saveDir);
  const save = opts.preparsed?.save ?? parseGdc(readSave(savePath), { path: savePath });
  const difficulty = opts.difficulty ?? settings.difficultyOverride ?? save.difficulty;

  const account = accountFiles(settings.saveDir);
  const resolved = resolveCharacter(save, account, db);
  const aggregate = aggregateCharacter(save, db, difficulty);
  const input: ContextInput = { save, aggregate, resolved, db, account };
  // No projections here: this runs on every watcher tick and its document
  // only feeds ids to the window. `adviceScope` builds the one the model reads.
  const doc = buildContextDoc(input, {
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.perGroup !== undefined ? { perGroup: opts.perGroup } : {}),
  });

  return { character, savePath, save, difficulty, account, resolved, aggregate, input, doc };
}

/**
 * The input and document an advice run should actually send.
 *
 * With the stash included this is the snapshot's own pair, untouched — one
 * composition, no drift. With it excluded, the stored items are removed from the
 * *resolved walk* and the document rebuilt, which takes the stashes out of every
 * section at once: §7 stops ranking their gear, §8 stops counting components
 * installed in it, §12 stops costing thresholds against it. The materials store
 * is not a stash and always stays — it is the component census.
 *
 * The snapshot itself is never filtered: it also feeds the window, and a
 * preference about what the *model* reads must not make items vanish from the
 * screen. The ids still join across the two documents, because an item's id is a
 * hash of the item itself, not of its position in the list — the only wobble is
 * the disambiguating suffix on byte-identical duplicates, which can shift a mark
 * between two copies of the same thing.
 *
 * This is also the one place the **candidate projections** are switched on:
 * the document the model reads carries the projected swap under every §7
 * candidate, and the snapshot's own document (built on every watcher tick)
 * does not. So the stash-included branch rebuilds too — every existing line
 * comes out byte-identical, the ids being hashes of the items — and the result
 * is memoised per snapshot, because the context viewer and the run both ask
 * for it and a hundred aggregates need not run twice.
 */
export function adviceScope(
  snapshot: CharacterSnapshot,
  includeStash: boolean,
  opts: { projections?: boolean } = {},
): { input: ContextInput; doc: ContextDoc } {
  const projections = opts.projections ?? true;
  const key = `${includeStash ? 'stash' : 'no-stash'}:${projections ? 'projected' : 'plain'}`;
  const cached = scopeCache.get(snapshot) ?? new Map<string, Scope>();
  const hit = cached.get(key);
  if (hit) return hit;

  let input = snapshot.input;
  if (!includeStash) {
    const items = snapshot.resolved.items.filter((i) => i.source !== 'stash' && i.source !== 'transfer');
    input = { ...snapshot.input, resolved: { ...snapshot.resolved, items } };
  }
  const scope = { input, doc: buildContextDoc(input, { projections }) };
  cached.set(key, scope);
  scopeCache.set(snapshot, cached);
  return scope;
}

type Scope = { input: ContextInput; doc: ContextDoc };
const scopeCache = new WeakMap<CharacterSnapshot, Map<string, Scope>>();
