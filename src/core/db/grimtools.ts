/**
 * The GrimTools half of the database — the localization table, and nothing else.
 *
 * GrimTools (by Dammitt — https://www.grimtools.com, credited in the README/UI)
 * publishes its Grim Dawn database as plain JS that assigns globals. We use one
 * file: `l10n/<locale>.js`, the tag → text table. That is what turns the game's
 * `itemNameTag` values into "Bloodrager's Cowl", and it saves us from parsing
 * `resources/Text_EN.arc` ourselves (which Stage 4's `.arc` reader would make
 * cheap, and would then remove this dependency entirely).
 *
 * Two things it deliberately does *not* supply:
 *
 *  - **Item identity.** `itemdb.js` carries no DBR record paths at all (verified:
 *    `grep -c "records/" itemdb.js` is 0), and its `bitmap` field is many-to-one
 *    because records reuse art. Item data comes from the game's own `.arz`
 *    archives instead — see the Stage 3 plan's Outcome section.
 *  - **The game version.** GrimTools reports the version of *its dump*, which
 *    lags the installed game (it said 1.3.0.0 against a 1.3.0.6 install). That
 *    comes from `Engine.dll` — see `readGameVersion` in `gamefiles.ts`.
 *
 * Etiquette: fetched at most once per game build (the cache key rotates only when
 * the archives change), kept in the local cache, never committed.
 */

import { runInNewContext } from 'node:vm';
import { z } from 'zod';

export const GRIMTOOLS_BASE = 'https://www.grimtools.com/db/itemdb';
export const l10nUrl = (locale: string): string => `${GRIMTOOLS_BASE}/l10n/${locale}.js`;

/** Long enough for a ~1 MB file on a slow link, short enough to fail usefully. */
const FETCH_TIMEOUT_MS = 120_000;
/** The dump is data, not a program; anything slower than this is a bad download. */
const EVAL_TIMEOUT_MS = 60_000;

export async function download(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Evaluate a GrimTools dump in a throwaway realm.
 *
 * The file is a megabyte of assignments to globals, so there is no parsing to do
 * beyond running it — but never in this process's realm. `runInNewContext` gives
 * it a fresh global object with no `require`, no `process`, no timers, and a
 * wall-clock cap.
 */
function evalInSandbox(src: string, seed: Record<string, unknown>, what: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { ...seed };
  // Some assignments are bare (`foo = ...`) rather than `window.foo = ...`;
  // pointing globalThis at the sandbox catches both without leaking anything.
  sandbox['globalThis'] = sandbox;
  try {
    runInNewContext(src, sandbox, { timeout: EVAL_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`${what}: could not evaluate the GrimTools dump — ${(err as Error).message}`);
  }
  return sandbox;
}

const l10nSchema = z
  .record(z.string(), z.string())
  .refine((v) => Object.keys(v).length > 100, 'holds too few tags to be a complete localization table');

/**
 * Validate `l10n/<locale>.js` and return its tag → text table.
 *
 * The file assigns into a pre-existing `db_l10n_texts` global keyed by locale,
 * so the sandbox has to seed that object or the script throws on the subscript.
 */
export function parseL10n(src: string, locale: string): Record<string, string> {
  const seed: Record<string, unknown> = { db_l10n_texts: {}, window: {} };
  const sandbox = evalInSandbox(src, seed, `l10n/${locale}.js`);

  const table = sandbox['db_l10n_texts'];
  if (table === null || typeof table !== 'object') {
    throw new Error(`l10n/${locale}.js: no \`db_l10n_texts\` global — the download is probably truncated`);
  }
  const forLocale = (table as Record<string, unknown>)[locale];
  if (forLocale === undefined) {
    const have = Object.keys(table as object).join(', ') || '(none)';
    throw new Error(`l10n/${locale}.js: db_l10n_texts['${locale}'] is missing; the file defines: ${have}`);
  }

  const parsed = l10nSchema.safeParse(forLocale);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `db_l10n_texts['${locale}']${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`)
      .join('; ');
    throw new Error(`l10n/${locale}.js: unexpected structure — ${issues}`);
  }
  return parsed.data;
}
