/**
 * The CLI's error manners.
 *
 * A missing file is the commonest thing a user does wrong, and the parsers live
 * in another package now — so what is being checked is this app's own `orExit`
 * wrapper: exit 1, name the file, say what went wrong, and print no stack. A
 * stack trace here would say the tool crashed when in fact it was handed a path
 * that is not there.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('CLI error handling', () => {
  it.each(['stash', 'formulas', 'reagents'])('reports a missing file for `%s` without a stack trace', (command) => {
    const missing = join(REPO_ROOT, 'test', 'does-not-exist.gst');
    let stderr = '';
    let status = 0;
    try {
      // `npx` is an npm `.cmd` shim on Windows, which execFile cannot launch
      // without a shell. Run tsx's JS entrypoint with this Node executable: no
      // shell, identical argv, and portable across every host in the matrix.
      execFileSync(process.execPath, [TSX_CLI, 'src/cli/index.ts', command, missing], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }

    expect(status).toBe(1);
    expect(stderr).toContain('does-not-exist.gst');
    expect(stderr).toContain('no such file');
    expect(stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
  }, 30_000);
});
