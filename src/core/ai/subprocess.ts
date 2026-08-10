/**
 * The one way an advisor backend runs a CLI: spawn, feed stdin, collect both
 * pipes, and be killable three ways (timeout, AbortSignal, the terminal's own
 * SIGINT/SIGTERM).
 *
 * Extracted from the claude-cli provider when the codex-cli one arrived: the
 * kill-the-whole-group and signal-forwarding logic is the subtle part of either
 * provider, and two hand-maintained copies of it would drift.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';

/** Injectable so the tests can drive every branch without a real subprocess. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const defaultSpawn: SpawnFn = nodeSpawn as SpawnFn;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** Raw stdout chunks, for a streaming line reader. Exceptions are swallowed. */
  onStdout?: (chunk: string) => void;
  /** What ENOENT means to the user — "install X" is the provider's sentence to write. */
  notFoundMessage: string;
  /** Names the binary in generic spawn failures, e.g. "claude CLI". */
  label: string;
}

/**
 * Spawn, feed stdin, collect both pipes.
 *
 * The child gets its own process group (`detached`) so a timeout or an abort
 * can take down anything it started rather than orphaning it — both `claude`
 * and `codex` spawn helpers of their own. `cwd` is the temp directory, so the
 * subprocess does not pick up this repo's CLAUDE.md/AGENTS.md or any other
 * project context.
 */
export function runCommand(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  opts: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: tmpdir(),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      reject(notFound(err, opts));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onAbort);
      process.removeListener('SIGTERM', onAbort);
    };
    const kill = (): void => {
      // Negative pid = the whole group. Falls back to the child alone on the
      // platforms/mocks where the group is not addressable.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      kill();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // The timer must not hold the process open once everything else is done.
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Its own process group means the child does *not* get the terminal's
    // Ctrl-C, so an interrupted CLI would otherwise leave a model call running.
    process.once('SIGINT', onAbort);
    process.once('SIGTERM', onAbort);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // Still accumulated in full: the result is read off the collected stream,
      // and the error paths quote the beginning of stdout. The reader is a
      // second pass over the same bytes, and the whole stream is a few hundred kB.
      stdout += chunk;
      // A listener that throws is the consumer's problem, not the run's — this is
      // a progress report on a call that has already been paid for.
      try {
        opts.onStdout?.(chunk);
      } catch {
        /* ignore */
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      stop();
      reject(notFound(err, opts));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      stop();
      if (signal?.aborted && !timedOut) {
        reject(new Error('advice request was cancelled'));
        return;
      }
      resolve({ code, stdout, stderr, timedOut });
    });

    // EPIPE here means the child died before reading; the close handler has the
    // real story, so swallow it rather than racing two rejections.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

function notFound(err: unknown, opts: RunOptions): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new Error(opts.notFoundMessage);
  return new Error(`could not run the ${opts.label} — ${(err as Error).message}`);
}

/** The last of stderr, appended to an error message so the cause travels with it. */
export function stderrTail(stderr: string, limit = 500): string {
  const text = stderr.trim();
  if (!text) return '';
  return `\n${text.length > limit ? `…${text.slice(-limit)}` : text}`;
}
