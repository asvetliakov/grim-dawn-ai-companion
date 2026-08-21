/**
 * Where the window opens.
 *
 * Arithmetic that fails silently: a window restored onto a monitor that is no
 * longer plugged in is invisible and indistinguishable from an app that did not
 * start. Install and save-tree detection is next door in `platform.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_SIZE, restoreBounds, startingSize } from '../src/main/window-size.js';
import { readWindowState, windowStatePath, writeWindowState } from '../src/main/window-state.js';

const LAPTOP = { x: 0, y: 25, width: 1512, height: 916 };

describe('where the window opens', () => {
  it('opens at the design size only when the work area can hold it', () => {
    expect(startingSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 });
    expect(startingSize({ width: 1920, height: 1055 })).toEqual({ width: 1896, height: 1031 });
    // A screen smaller than the minimum: the window overflows rather than
    // collapsing into something unusable.
    expect(startingSize({ width: 640, height: 480 })).toEqual(MIN_SIZE);
  });

  it('remembers nothing when there is nothing remembered', () => {
    expect(restoreBounds(undefined, LAPTOP)).toBeUndefined();
    expect(restoreBounds({ x: 10, y: 10 }, LAPTOP)).toBeUndefined();
    // A hand-mangled window.json is not a reason to fail to open.
    expect(restoreBounds({ x: NaN, y: 0, width: 1200, height: 800 }, LAPTOP)).toBeUndefined();
  });

  it('restores a window that is still on screen, exactly', () => {
    const saved = { x: 120, y: 60, width: 1200, height: 800 };
    expect(restoreBounds(saved, LAPTOP)).toEqual(saved);
  });

  it('clamps a window bigger than the screen it is opening on', () => {
    const restored = restoreBounds({ x: 0, y: 25, width: 3200, height: 1800 }, LAPTOP)!;
    expect(restored.width).toBe(LAPTOP.width);
    expect(restored.height).toBe(LAPTOP.height);
  });

  it('re-centres a window left on a monitor that is gone', () => {
    // Saved on a second display hanging off to the right, which is not there any
    // more. Nudging it would leave it in a corner; centring puts it where a
    // window that has just been opened belongs.
    const restored = restoreBounds({ x: 2600, y: 400, width: 1200, height: 800 }, LAPTOP)!;
    expect(restored).toEqual({ x: 156, y: 83, width: 1200, height: 800 });
  });

  it('treats a window with only its edge on screen as lost', () => {
    // 40 px of a 1200-wide window peeking in from the left is not a window
    // anyone can grab.
    const restored = restoreBounds({ x: -1160, y: 100, width: 1200, height: 800 }, LAPTOP)!;
    expect(restored.x).toBeGreaterThan(0);
  });
});

describe('window.json', () => {
  let dir: string;
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env['GD_DATA_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'gd-window-'));
    process.env['GD_DATA_DIR'] = dir;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['GD_DATA_DIR'];
    else process.env['GD_DATA_DIR'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a size and position', () => {
    writeWindowState({ bounds: { x: 10, y: 20, width: 1400, height: 900 }, maximized: false });
    expect(readWindowState()).toEqual({ bounds: { x: 10, y: 20, width: 1400, height: 900 }, maximized: false });
  });

  it('degrades to nothing remembered rather than throwing', () => {
    writeFileSync(windowStatePath(), 'not json at all');
    expect(readWindowState()).toEqual({});
    writeFileSync(windowStatePath(), '{"bounds":{"x":"left"}}');
    expect(readWindowState()).toEqual({});
  });
});
