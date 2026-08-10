/**
 * Advisor entry point: registers every backend and re-exports the seam.
 *
 * Importing this module is what makes `createProvider('claude-cli')` work —
 * nothing else in `src/core` reaches for a concrete provider.
 */

import { createClaudeCliProvider, CLAUDE_CLI_ID, DEFAULT_EFFORT, DEFAULT_MODEL } from './claude-cli.js';
import { createCodexCliProvider, CODEX_CLI_ID, CODEX_DEFAULT_EFFORT, CODEX_DEFAULT_MODEL } from './codex-cli.js';
import { createMockProvider, MOCK_ID } from './mock.js';
import { registerProvider } from './provider.js';

registerProvider(CLAUDE_CLI_ID, (opts) => createClaudeCliProvider(opts));
registerProvider(CODEX_CLI_ID, (opts) => createCodexCliProvider(opts));
registerProvider(MOCK_ID, () => createMockProvider());

/**
 * What a backend runs when settings pin nothing — each provider's own defaults,
 * resolved by id *before* the run so status lines and stored envelopes can name
 * them. This table exists because the old call sites reached for claude's
 * `DEFAULT_MODEL` regardless of backend, which would have handed `opus` to a
 * codex subprocess. Unknown ids (the mock, a hand-edited settings.json) get no
 * model — the factory is the one that knows whether that is an error.
 */
export function providerDefaults(id: string): { model?: string; effort: string } {
  switch (id) {
    case CLAUDE_CLI_ID:
      return { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
    case CODEX_CLI_ID:
      return { model: CODEX_DEFAULT_MODEL, effort: CODEX_DEFAULT_EFFORT };
    default:
      return { effort: DEFAULT_EFFORT };
  }
}

export * from './provider.js';
export * from './envelope.js';
export * from './advice-store.js';
export * from './verify.js';
export * from './repair.js';
export { ADVISOR_SYSTEM_PROMPT, buildUserTurn } from './prompt.js';
export {
  CLAUDE_CLI_ID,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  createClaudeCliProvider,
  type ClaudeCliOptions,
  type SpawnFn,
} from './claude-cli.js';
export {
  CODEX_CLI_ID,
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  createCodexCliProvider,
  type CodexCliOptions,
} from './codex-cli.js';
export { MOCK_ID, CANNED_ANSWER, createMockProvider, type MockOptions } from './mock.js';
