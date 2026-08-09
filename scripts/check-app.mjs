/**
 * Behaviour checks against the real Electron app.
 *
 * Storybook covers the renderer and vitest covers the core; this covers the seam
 * between them, which neither can reach — the preload bridge, the nine IPC
 * channels, the main-process run manager, and the advice file. It launches the
 * built app, clicks Advise, watches the phases, and reads the panel.
 *
 * Runs against the **mock** advisor in a throwaway data directory, so it costs
 * nothing and can be run as often as the story checks. Point `GD_DATA_DIR` at a
 * directory with a real `provider` in its `settings.json` for one live run.
 *
 * Usage: `npm run app:check` (builds first). Needs a Grim Dawn install, like
 * every other live check in this repo.
 *
 * The `env -u ELECTRON_RUN_AS_NODE` in the npm script is load-bearing: some
 * shells (Claude Code's among them) export it, and it turns the Electron binary
 * into plain Node, so `require('electron').protocol` is undefined and the main
 * process dies before it runs a line.
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/**
 * A throwaway data directory with the mock advisor pinned, unless the caller
 * supplied one. A first boot there builds the item database from the install,
 * which is half a minute and also proves a cold start works.
 */
function dataDirectory() {
  if (process.env.GD_DATA_DIR) {
    // Cold advice, warm everything else. Leaving the last run in place makes the
    // "locked before any run" check fail *by working*, since an app restart is
    // supposed to re-show stored advice.
    if (!process.env.KEEP_ADVICE) {
      rmSync(join(process.env.GD_DATA_DIR, 'advice'), { recursive: true, force: true });
    }
    return process.env.GD_DATA_DIR;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gd-app-check-'));
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ locale: 'en', provider: 'mock' }, null, 2)}\n`);
  return dir;
}

const dataDir = dataDirectory();
const shot = process.env.SHOT;
/** A mock answers inside a frame; a real call is ~500 s and the ceiling is 900. */
const runBudgetMs = Number(process.env.RUN_BUDGET_MS ?? 120_000);
const QUESTION = 'app check — verifying the pipeline';

const app = await electron.launch({
  args: ['out/main/index.cjs'],
  env: { ...process.env, GD_DATA_DIR: dataDir },
});
const page = await app.firstWindow();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});

// ---------------------------------------------------------------------------
// The window, over the live save
// ---------------------------------------------------------------------------

await page.locator('.loadout-grid').waitFor({ state: 'visible', timeout: 300_000 });
check('the window opens and renders the loadout', (await page.locator('.slot-row').count()) === 14);
const character = await page.locator('.app-header select').first().inputValue();
check('on a real character', character.length > 0, character);
// The proposal column says what the app does better than a hidden column would.
check('with the proposal column locked before any run', (await page.locator('.face-locked.waiting').count()) === 14);

// ---------------------------------------------------------------------------
// A run, started from the button
// ---------------------------------------------------------------------------

await page.locator('.advice-question').fill(QUESTION);
await page.locator('.advice-panel .run-button').click();

// The phases come from the main process's own pushes. Only observable on a run
// that takes real time — the sequence itself is pinned in
// `test/advise-runner.test.ts`, where the provider's timing is controllable.
const phases = new Set();
const started = Date.now();
while (Date.now() - started < runBudgetMs) {
  const label = await page.locator('.run-phase').innerText().catch(() => null);
  if (label && !phases.has(label)) {
    phases.add(label);
    console.log(`       …${label} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  if ((await page.locator('.verdict-table').count()) > 0) break;
  await page.waitForTimeout(250);
}
check(
  'the run finished and produced a verdict table',
  (await page.locator('.verdict-table').count()) === 1,
  phases.size ? `phases: ${[...phases].join(' → ')}` : 'answered inside a frame — no phase to observe',
);
const cost = await page.locator('.advice-cost').innerText();
check('with a cost line', /call/.test(cost), cost.replace(/\n/g, ' '));
check('that repeats the question asked', cost.includes(QUESTION));
check('and the proposal column is no longer locked', (await page.locator('.face-locked.waiting').count()) < 14);

// ---------------------------------------------------------------------------
// The file, and re-showing it after a reload
// ---------------------------------------------------------------------------

const adviceDir = join(dataDir, 'advice');
mkdirSync(adviceDir, { recursive: true });
check(
  'the run was written to advice/<character>.json',
  readdirSync(adviceDir).includes(`${character}.json`),
  readdirSync(adviceDir).join(', '),
);
const stored = JSON.parse(readFileSync(join(adviceDir, `${character}.json`), 'utf8'));
check('the stored envelope carries the question', stored.question === QUESTION);
check('and the table it rendered', Array.isArray(stored.verdictRows), `${stored.verdictRows?.length} row(s)`);

// A reload is what happens on every hot module replacement in development and on
// any renderer crash in production. The run lives in main; the window re-asks.
await page.reload();
await page.locator('.loadout-grid').waitFor({ state: 'visible', timeout: 120_000 });
await page.locator('.verdict-table').waitFor({ state: 'visible', timeout: 60_000 });
check('a reload re-shows the stored advice', (await page.locator('.verdict-table').count()) === 1);

// The marks, joined against the live grid by document id. A mock's placeholder
// ids join onto nothing, which is the stale path — and it must say so.
const marked = await page.locator('.item-cell.action').count();
const stale = await page.locator('.advice-stale').count();
check(
  'the plan is joined onto the live grid, or says it could not be',
  marked > 0 || stale === 1,
  marked > 0 ? `${marked} marked item(s)` : 'nothing joined, and the panel says so',
);

if (shot) {
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
}

await app.close();
check('no uncaught errors in the window', problems.length === 0, problems[0] ?? '');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall app checks passed');
