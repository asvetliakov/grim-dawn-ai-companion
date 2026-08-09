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
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Seconds before an advice request is killed. */
  advisorTimeoutSeconds: z.number().int().positive().optional(),
  /** Force advice for a difficulty other than the character's current one. */
  difficultyOverride: z.enum(['Normal', 'Elite', 'Ultimate']).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Settings with the two path fields resolved — what callers actually want. */
export interface ResolvedSettings extends Settings {
  saveDir: string;
  /** Undefined only when Grim Dawn is not installed on this machine. */
  gameDir: string | undefined;
}
