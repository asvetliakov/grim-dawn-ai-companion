/**
 * Advice runs for a character, on disk.
 *
 * A run is ~500 seconds and real money, so it has to survive closing the app —
 * reopening the window and finding the proposal column locked again would make
 * the feature feel like it had not happened.
 *
 * **It keeps every run, not just the last one.** The first draft kept one file
 * per character on the argument that a history is a different feature wanting
 * diffing and provenance. Two things turned that around. Runs at four dollars
 * each are not disposable: overwriting one to take a second opinion is a decision
 * the user should not be forced into by the storage layout. And the envelope now
 * records the loadout it was written against (`worn`), which is exactly the
 * provenance that argument said was missing — a stored run can say which save it
 * is about, so several of them can coexist without becoming ambiguous.
 *
 * One directory per character, one file per run, named for the run's own
 * timestamp so the newest sorts last by string comparison and no index file has
 * to be kept honest. The **filename stem is the run id** the renderer asks for.
 *
 * **A drifted file is not an error.** Every read validates and skips what it does
 * not recognise, because the alternative is an app that cannot start until the
 * user deletes a cache file. A run is reproducible; the file is not precious.
 *
 * Separate module from `envelope.ts` on purpose: that one is in the renderer's
 * type graph (via `src/shared/ipc.ts`, which compiles with `types: []`), and this
 * one imports `node:fs`. The split is what makes "no Node import reaches the
 * renderer" a compile error rather than a convention.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appDataDir } from '../data-dir.js';
import { ensureDir } from '@grimdawn/core/db/cache';
import { adviseEnvelopeSchema, type AdviceRunRef, type AdviseEnvelope } from './envelope.js';

/** `<appData>/advice/` — beside `cache/`, not inside it: this is not derived data. */
export function adviceDir(): string {
  return join(appDataDir(), 'advice');
}

/**
 * Character directory names come from the filesystem, so they are already safe
 * to use as one — `_Suchka` is a directory under `<saveDir>/main` before it is
 * ever a key here.
 */
export function characterAdviceDir(character: string): string {
  return join(adviceDir(), character);
}

/**
 * A run id from its timestamp: `2026-08-09T19:29:00.000Z` → `2026-08-09T19-29-00-000Z`.
 *
 * Colons and dots are legal in a macOS filename and awkward everywhere else — in
 * a shell, in a URL, in the Finder's own display of a path. Sorting is unaffected
 * because the substitution is positional.
 */
function runId(generatedAt: string): string {
  return generatedAt.replace(/[:.]/g, '-');
}

export function advicePath(character: string, id: string): string {
  return join(characterAdviceDir(character), `${id}.json`);
}

/** Writes the run and returns the id it can be fetched back by. */
export function saveAdvice(envelope: AdviseEnvelope): string {
  migrateFlatFile(envelope.character);
  ensureDir(characterAdviceDir(envelope.character));
  const id = runId(envelope.generatedAt);
  writeFileSync(advicePath(envelope.character, id), `${JSON.stringify(envelope, null, 2)}\n`);
  return id;
}

/**
 * Every stored run for a character, newest first, as summaries.
 *
 * Summaries rather than envelopes because the picker only needs a label and the
 * files are ~70 kB each; the chosen one is fetched whole by `loadAdvice`. Reading
 * and validating each file to build the summary is the price of not keeping a
 * separate index that could disagree with the directory.
 */
export function listAdvice(character: string): AdviceRunRef[] {
  migrateFlatFile(character);
  const dir = characterAdviceDir(character);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const out: AdviceRunRef[] = [];
  for (const name of names) {
    const envelope = readEnvelope(join(dir, name));
    if (!envelope) continue;
    out.push({
      id: name.replace(/\.json$/, ''),
      generatedAt: envelope.generatedAt,
      model: envelope.model,
      calls: envelope.calls,
      costUsd: envelope.usage.costUsd ?? 0,
      verdicts: envelope.verdictRows.length,
      warnings: envelope.warnings.length,
      ...(envelope.question ? { question: envelope.question } : {}),
    });
  }
  // By the timestamp *inside* the file rather than by filename: a file copied in
  // by hand still lands in the right place.
  return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export function loadAdvice(character: string, id: string): AdviseEnvelope | undefined {
  // `id` reaches this from the renderer, and it is about to become a path
  // segment. Anything that is not a filename this module could have written is
  // refused outright rather than sanitised — there is no legitimate caller that
  // needs a separator, and a rejected id costs one absent panel.
  if (!/^[\w.-]+$/.test(id)) return undefined;
  return readEnvelope(advicePath(character, id));
}

/**
 * The newest stored run, or nothing.
 *
 * Every failure is the same answer: absent, unreadable, not JSON, or written by
 * a build whose envelope had a different shape. A missing last run is an ordinary
 * state the window already renders — it is what it shows before the first run.
 */
export function loadLastAdvice(character: string): AdviseEnvelope | undefined {
  const newest = listAdvice(character)[0];
  return newest ? loadAdvice(character, newest.id) : undefined;
}

/** Discards one run. Returns what is left, so a caller needs no second read. */
export function deleteAdvice(character: string, id: string): AdviceRunRef[] {
  if (/^[\w.-]+$/.test(id)) rmSync(advicePath(character, id), { force: true });
  return listAdvice(character);
}

function readEnvelope(path: string): AdviseEnvelope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = adviseEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Move a pre-history `advice/<character>.json` into the character's directory.
 *
 * One-time and idempotent. The alternative — reading the flat file as a special
 * entry forever — would leave the layout with two shapes permanently, to avoid
 * six lines that run once.
 */
function migrateFlatFile(character: string): void {
  const flat = join(adviceDir(), `${character}.json`);
  if (!existsSync(flat)) return;
  const envelope = readEnvelope(flat);
  if (!envelope) {
    // Unreadable by the current schema, so it has no timestamp to be named for
    // and nothing to offer the picker. Getting it out of the way is the fix.
    rmSync(flat, { force: true });
    return;
  }
  const dir = characterAdviceDir(character);
  mkdirSync(dir, { recursive: true });
  renameSync(flat, advicePath(character, runId(envelope.generatedAt)));
}
