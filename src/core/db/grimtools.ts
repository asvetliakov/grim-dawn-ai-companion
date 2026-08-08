/**
 * The GrimTools half of the database.
 *
 * GrimTools (by Dammitt — https://www.grimtools.com, credited in the README/UI)
 * publishes its Grim Dawn database as plain JS that assigns globals. We use two
 * pieces of it:
 *
 *  - `l10n/<locale>.js` — the tag → text table. This is what turns the game's
 *    `itemNameTag` values into "Bloodrager's Cowl", and it saves us from having
 *    to parse `resources/Text_EN.arc` ourselves.
 *  - `itemdb.js` — read only for `gameVersion`, the human-readable label shown
 *    next to the cache key.
 *
 * What it deliberately does *not* provide is item identity: the dump carries no
 * DBR record paths at all (verified — `grep -c "records/" itemdb.js` is 0), and
 * its `bitmap` field is many-to-one because records share art. That is why item
 * data comes from the game's own `.arz` archives instead. See the Stage 3 plan's
 * Outcome section.
 *
 * Etiquette: fetched at most once per game build (the cache key rotates only when
 * the archives change), kept in the local cache, never committed.
 */

import { runInNewContext } from 'node:vm';
import { z } from 'zod';

export const GRIMTOOLS_BASE = 'https://www.grimtools.com/db/itemdb';
export const ITEMDB_URL = `${GRIMTOOLS_BASE}/itemdb.js`;
export const l10nUrl = (locale: string): string => `${GRIMTOOLS_BASE}/l10n/${locale}.js`;

/** Long enough for an 8.7 MB file on a slow link, short enough to fail usefully. */
const FETCH_TIMEOUT_MS = 120_000;
/** The dumps are data, not programs; anything slower than this is a bad download. */
const EVAL_TIMEOUT_MS = 60_000;

export async function download(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Evaluate a GrimTools dump in a throwaway realm.
 *
 * These files are ~9 MB of assignments to globals, so there is no parsing to do
 * beyond running them — but never in this process's realm. `runInNewContext`
 * gives them a fresh global object with no `require`, no `process`, no timers,
 * and a wall-clock cap.
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

const itemDbSchema = z.object({
  gameVersion: z.string().min(1),
  allItems: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, 'is empty'),
  factions: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, 'is empty'),
});

export interface ItemDbSummary {
  gameVersion: string;
  itemCount: number;
  factionCount: number;
  merchantCount: number;
}

/**
 * Validate `itemdb.js` and pull out what we use. Validation is strict and names
 * the offending global so a truncated or restructured dump reads as "GrimTools
 * changed" rather than as a mysterious undefined downstream.
 */
export function parseItemDb(src: string): ItemDbSummary {
  const sandbox = evalInSandbox(src, { window: {} }, 'itemdb.js');
  const win = sandbox['window'];
  if (win === null || typeof win !== 'object') {
    throw new Error('itemdb.js: the dump defined no `window` globals at all — the download is probably truncated');
  }

  const parsed = itemDbSchema.safeParse(win);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `window.${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`itemdb.js: unexpected structure — ${issues}`);
  }

  const merchants = (win as Record<string, unknown>)['merchants'];
  return {
    gameVersion: parsed.data.gameVersion,
    itemCount: Object.keys(parsed.data.allItems).length,
    factionCount: Object.keys(parsed.data.factions).length,
    merchantCount: merchants && typeof merchants === 'object' ? Object.keys(merchants).length : 0,
  };
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
