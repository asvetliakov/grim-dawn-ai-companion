/**
 * The last advice run for a character, on disk.
 *
 * A run is ~500 seconds and real money, so it has to survive closing the app —
 * reopening the window and finding the proposal column locked again would make
 * the feature feel like it had not happened. One file per character, last run
 * only: an advice history is a different feature (it would want diffing, and a
 * way to say which save each answer was about), and keeping N runs without one
 * is just a directory that grows.
 *
 * **A drifted file is not an error.** `loadLastAdvice` validates and answers
 * `undefined` on anything it does not recognise, because the alternative is an
 * app that cannot start until the user deletes a cache file. The run is
 * reproducible; the file is not precious.
 *
 * Separate module from `envelope.ts` on purpose: that one is in the renderer's
 * type graph (via `src/shared/ipc.ts`, which compiles with `types: []`), and
 * this one imports `node:fs`. The split is what makes "no Node import reaches
 * the renderer" a compile error rather than a convention.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appDataDir, ensureDir } from '../db/cache.js';
import { adviseEnvelopeSchema, type AdviseEnvelope } from './envelope.js';

/** `<appData>/advice/` — beside `cache/`, not inside it: this is not derived data. */
export function adviceDir(): string {
  return join(appDataDir(), 'advice');
}

/**
 * Character directory names come from the filesystem, so they are already safe
 * to use as one — `_Suchka` is a directory under `<saveDir>/main` before it is
 * ever a key here.
 */
export function lastAdvicePath(character: string): string {
  return join(adviceDir(), `${character}.json`);
}

export function saveLastAdvice(envelope: AdviseEnvelope): void {
  ensureDir(adviceDir());
  writeFileSync(lastAdvicePath(envelope.character), `${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * The stored run, or nothing.
 *
 * Every failure is the same answer: absent, unreadable, not JSON, or written by
 * a build whose envelope had a different shape. A missing last run is an
 * ordinary state the window already renders — it is what it shows before the
 * first run of all.
 */
export function loadLastAdvice(character: string): AdviseEnvelope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lastAdvicePath(character), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = adviseEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
