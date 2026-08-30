/**
 * The settings shape, on its own.
 *
 * Split out of `settings.ts` because the renderer has to *name* a `Settings` —
 * it edits one in the settings pane and receives one at boot — while never
 * reaching a module that imports `node:fs`. The reading, writing and
 * auto-detection all stay next door; this is the vocabulary, nothing more.
 */

import { z } from 'zod';

export const settingsSchema = z.object({
  /** Root of the save tree: holds `main/<character>/` and the shared `.gst` files. */
  saveDir: z.string().min(1).optional(),
  /** Grim Dawn install directory (the one containing `database/database.arz`). */
  gameDir: z.string().min(1).optional(),
  /** Character whose `player.gdc` the UI opens by default. */
  activeCharacter: z.string().min(1).optional(),
  /**
   * The language item and skill names come out in — one of the locales the
   * install ships a `resources/Text_<LOCALE>.arc` for (`db --stats` lists them).
   */
  locale: z.string().min(2).default('en'),
  /** Advisor backend — see `src/core/ai/provider.ts` (Stage 6). */
  provider: z.string().min(1).default('claude-cli'),
  /**
   * Model and reasoning effort for the advisor. Both are pinned rather than
   * inherited: without them the `claude` subprocess would pick up whatever the
   * user's interactive session specifies, and two runs on the same save would
   * be silently incomparable.
   */
  model: z.string().min(1).optional(),
  /** `ultra` exists only on the codex backend; the pane scopes the choices per backend. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  /**
   * Where each backend's CLI actually is, keyed by provider id — an absolute
   * path, used in place of the bare `claude`/`codex` name.
   *
   * This exists because **a packaged macOS app does not have your PATH**. A
   * `.app` is launched by launchd, not by a shell, so it inherits launchd's
   * environment — `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — while
   * `~/.local/bin` (where both CLIs' installers put their binaries) and every
   * other directory a `.zprofile` adds are absent. The same build run from a
   * terminal works, which is what makes the report confusing: `npm run dev` and
   * `npm run start` inherit the shell, and even `open release/….app` does not,
   * because `open` hands the launch to launchd too. Windows needs none of this
   * — a GUI process there gets the user's PATH from the registry.
   *
   * Keyed rather than a single field because a path belongs to a backend the
   * same way a model does: `/Users/me/.local/bin/claude` means nothing to the
   * codex provider, and one field would hand it over on the next switch.
   */
  providerBinary: z.record(z.string(), z.string().min(1)).optional(),
  /** Seconds before an advice request is killed. */
  advisorTimeoutSeconds: z.number().int().positive().optional(),
  /**
   * Codex fast mode (`service_tier=fast`, the renamed "priority processing").
   * Absent means **true**: it roughly halves an eight-minute wait and is
   * included in the ChatGPT subscription — at a 2–2.5× credit burn, which is
   * why it is a visible switch rather than an always-on detail. Codex only;
   * the claude CLI's fast mode bills API usage on top of the subscription, so
   * it is deliberately not offered there.
   */
  codexFast: z.boolean().optional(),
  /** Force advice for a difficulty other than the character's current one. */
  difficultyOverride: z.enum(['Normal', 'Elite', 'Ultimate']).optional(),
  /**
   * Whether an advice run's dossier includes the personal and transfer stash.
   * Absent means **true** — the stashes are where live runs found their best
   * candidates, so leaving them out is the choice that has to be made, not the
   * default. The materials store is always included either way; it is the
   * component census, not a container of gear.
   */
  includeStashInAdvice: z.boolean().optional(),
  /**
   * Give every included personal/transfer-stash gear item an explicit
   * equip/hold/sell disposition. Absent means false: merely including the
   * stash still shops it for upgrades without treating it as a clean-out job.
   */
  reviewStashForSale: z.boolean().optional(),
  /**
   * Keep the window above the game's.
   *
   * A *choice*, so it lives here — unlike the window's size and position, which
   * are state and live in the sibling `window.json`. Writing settings.json on
   * every drag of a window would be the wrong shape of file entirely.
   */
  alwaysOnTop: z.boolean().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Settings with the two path fields resolved — what callers actually want. */
export interface ResolvedSettings extends Settings {
  saveDir: string;
  /** Undefined only when Grim Dawn is not installed on this machine. */
  gameDir: string | undefined;
}
