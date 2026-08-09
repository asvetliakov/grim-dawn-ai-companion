/**
 * Advisor entry point: registers every backend and re-exports the seam.
 *
 * Importing this module is what makes `createProvider('claude-cli')` work —
 * nothing else in `src/core` reaches for a concrete provider.
 */

import { createClaudeCliProvider, CLAUDE_CLI_ID } from './claude-cli.js';
import { createMockProvider, MOCK_ID } from './mock.js';
import { createOpenAiProvider, OPENAI_ID } from './openai.js';
import { registerProvider } from './provider.js';

registerProvider(CLAUDE_CLI_ID, (opts) => createClaudeCliProvider(opts));
registerProvider(MOCK_ID, () => createMockProvider());
registerProvider(OPENAI_ID, () => createOpenAiProvider());

export * from './provider.js';
export * from './verify.js';
export { ADVISOR_SYSTEM_PROMPT } from './prompt.js';
export {
  CLAUDE_CLI_ID,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  createClaudeCliProvider,
  type ClaudeCliOptions,
  type SpawnFn,
} from './claude-cli.js';
export { MOCK_ID, CANNED_ANSWER, createMockProvider } from './mock.js';
export { OPENAI_ID, OPENAI_NOT_CONFIGURED, createOpenAiProvider } from './openai.js';
