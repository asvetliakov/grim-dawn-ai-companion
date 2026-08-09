/**
 * OpenAI, registered but not implemented.
 *
 * It is here so `provider` in settings is a real choice with a real list, and
 * so the seam is proved by more than one implementation shape — a backend that
 * reports itself unavailable and fails with a message rather than a stack
 * trace. Wiring it up is a backlog item; nothing above this file changes when
 * that happens.
 */

import type { AdvisorProvider, AdvisorResult } from './provider.js';

export const OPENAI_ID = 'openai';

export const OPENAI_NOT_CONFIGURED =
  'the openai provider is not implemented yet — this tool ships with `claude-cli` (uses your local Claude Code login) ' +
  'and `mock`. Set "provider" in settings.json or pass --provider claude-cli.';

export function createOpenAiProvider(): AdvisorProvider {
  return {
    id: OPENAI_ID,
    available: async () => false,
    advise: async (): Promise<AdvisorResult> => {
      throw new Error(OPENAI_NOT_CONFIGURED);
    },
  };
}
