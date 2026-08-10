/**
 * Behaviour checks against the real Electron app.
 *
 * Storybook covers the renderer and vitest covers the core; this covers the seam
 * between them, which neither can reach — the preload bridge, the ten IPC
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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    // Cold advice, warm everything else: the run below is meant to be this
    // character's first, and the picker's option count is asserted against that.
    // (Since the window opens on the empty state either way, stored runs no longer
    // change what the *first* checks see — only how many answers are on the list.)
    if (!process.env.KEEP_ADVICE) {
      rmSync(join(process.env.GD_DATA_DIR, 'advice'), { recursive: true, force: true });
    }
    return process.env.GD_DATA_DIR;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gd-app-check-'));
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ locale: 'en', provider: 'mock' }, null, 2)}\n`);
  return dir;
}

/**
 * A throwaway *save tree*, so the watcher can be driven for real.
 *
 * The window is pointed at a copy rather than at the live saves for two reasons:
 * the checks below deliberately tear a `player.gdc` in half to prove the torn-write
 * path, which is not something to do to someone's character; and a copy is the only
 * way to make a character *appear* while the app is running, which is what proves
 * the whole chain from `fs.watch` to the character picker.
 *
 * Only the files the tool reads are copied — the `.map` directories beside a save
 * are megabytes the parser never opens.
 */
function saveTree() {
  const source = JSON.parse(
    execFileSync('npx', ['tsx', 'src/cli/index.ts', 'paths', '--json'], { encoding: 'utf8' }),
  ).saveDir;
  const dir = mkdtempSync(join(tmpdir(), 'gd-app-saves-'));
  mkdirSync(join(dir, 'main'), { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.endsWith('.gst')) copyFileSync(join(source, name), join(dir, name));
  }
  const characters = readdirSync(join(source, 'main')).filter((name) =>
    existsSync(join(source, 'main', name, 'player.gdc')),
  );
  return { dir, source, characters };
}

const dataDir = dataDirectory();
const saves = saveTree();
/** The first character is copied in now; the second is what the watcher will find. */
const [firstCharacter, spareCharacter] = saves.characters;
function installCharacter(name) {
  mkdirSync(join(saves.dir, 'main', name), { recursive: true });
  copyFileSync(join(saves.source, 'main', name, 'player.gdc'), join(saves.dir, 'main', name, 'player.gdc'));
}
installCharacter(firstCharacter);

const shot = process.env.SHOT;
/** A mock answers inside a frame; a real call is ~500 s and the ceiling is 900. */
const runBudgetMs = Number(process.env.RUN_BUDGET_MS ?? 120_000);
const QUESTION = 'app check — verifying the pipeline';

const app = await electron.launch({
  args: ['out/main/index.cjs'],
  env: { ...process.env, GD_DATA_DIR: dataDir, GD_SAVE_DIR: saves.dir },
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

// The question box lives in the advice panel, one column tab over from the
// loadout the window opens on.
await page.locator('.column-tabs .tab', { hasText: 'Advice' }).click();
await page.locator('.advice-question').fill(QUESTION);
await page.locator('.advice-panel .run-button').click();

// The phases come from the main process's own pushes. Only observable on a run
// that takes real time — the sequence itself is pinned in
// `test/advise-runner.test.ts`, where the provider's timing is controllable.
// Completion is read off the *loadout*: the run finishing switches the column
// back there (that auto-switch is itself part of what this proves), so the
// verdict table is deliberately not on screen at this point.
const phases = new Set();
const started = Date.now();
while (Date.now() - started < runBudgetMs) {
  const label = await page.locator('.run-phase').innerText().catch(() => null);
  if (label && !phases.has(label)) {
    phases.add(label);
    console.log(`       …${label} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  // The loadout reappearing *is* the completion signal: the column switched to
  // Advice for the run, and only the run finishing switches it back.
  if ((await page.locator('.loadout-grid').count()) > 0) break;
  await page.waitForTimeout(250);
}
// One beat for the same render to land everywhere, with the pointer parked: it
// was left where the Run button was, which is where the New run button now is —
// and a hovered control unmounting is exactly the orphaned-panel case the
// tooltip provider now closes itself out of.
await page.mouse.move(5, 5);
await page.waitForTimeout(500);
const afterRun = {
  loadout: await page.locator('.loadout-grid').count(),
  waiting: await page.locator('.face-locked.waiting').count(),
  tab: (await page.locator('.column-tabs .tab.selected').innerText().catch(() => '?')).trim(),
  phase: await page.locator('.run-phase').count(),
};
// The degenerate case is the mock's, not the app's: when the answer lands while
// the renderer is still busy, Electron delivers every push in one task, React
// batches them into a single render, and the run is over before it was ever on
// screen — so there is no transition to switch back from and the column stays
// where the script put it. A real ~500 s run cannot do that.
const cameBack = afterRun.loadout === 1 && afterRun.waiting < 14;
const tooFastToRender = phases.size === 0 && afterRun.tab === 'Advice' && afterRun.phase === 0;
check(
  'the run finished and came back to the loadout',
  cameBack || tooFastToRender,
  `${phases.size ? `phases: ${[...phases].join(' → ')}` : 'answered inside a frame'}${tooFastToRender ? ' — before the run ever rendered, so nothing to switch back from' : ''}; ${JSON.stringify(afterRun)}`,
);
await page.locator('.column-tabs .tab', { hasText: 'Advice' }).click();
await page.locator('.verdict-table').waitFor({ state: 'visible', timeout: 10_000 });
check('and produced a verdict table', (await page.locator('.verdict-table').count()) === 1);
const cost = await page.locator('.advice-cost').innerText();
check('with a cost line', /call/.test(cost), cost.replace(/\n/g, ' '));
check('that repeats the question asked', cost.includes(QUESTION));

// ---------------------------------------------------------------------------
// The file, and re-showing it after a reload
// ---------------------------------------------------------------------------

// One directory per character, one file per run: runs are kept rather than
// overwritten, because each is minutes and real money.
const adviceDir = join(dataDir, 'advice', character);
mkdirSync(adviceDir, { recursive: true });
const runFiles = readdirSync(adviceDir).filter((n) => n.endsWith('.json'));
check('the run was written to advice/<character>/<run>.json', runFiles.length === 1, runFiles.join(', '));
const stored = JSON.parse(readFileSync(join(adviceDir, runFiles[0] ?? 'missing.json'), 'utf8'));
check('the stored envelope carries the question', stored.question === QUESTION);
check('and the table it rendered', Array.isArray(stored.verdictRows), `${stored.verdictRows?.length} row(s)`);
// And the loadout it was written against, which is what lets a stored run say
// whether it is still about the save in front of the reader.
check(
  'and the loadout it was written against',
  stored.worn && Object.keys(stored.worn).length > 0,
  `${Object.keys(stored.worn ?? {}).length} slot(s)`,
);
// The computed projection crossed the pipeline: against a real save the mock's
// canned ids mostly do not resolve, so this exercises the *degrade* path —
// before ≈ after, with the unresolvable verdicts named in `skipped` rather
// than silently dropped. The positive path (numbers moving) is owned by
// test/project.test.ts and the stories.
check(
  'and a computed projection with the degrade path said out loud',
  Array.isArray(stored.projection?.resistances) && stored.projection.resistances.length === 10,
  `${stored.projection?.resistances?.length ?? 0} resistance row(s), ${stored.projection?.skipped?.length ?? 0} skipped verdict(s)`,
);
// Stage 8B widened the projection: both resistance bands per row, the payload
// index and the defense block all cross IPC and land in the stored file.
check(
  'and the projection carries the 8B bands, payload and defense block',
  stored.projection?.payload !== undefined &&
    stored.projection?.defense !== undefined &&
    stored.projection?.resistances?.every((r) => typeof r.afterPermanent === 'number'),
  `payload ${JSON.stringify(stored.projection?.payload)}, defense ${stored.projection?.defense ? 'present' : 'missing'}`,
);

// ---------------------------------------------------------------------------
// New run: a fresh session that keeps the answer
// ---------------------------------------------------------------------------

// This control used to be `Clear` and used to delete the run it sat beside. It is
// the button a reader reaches for after acting on a plan — "I have done these, ask
// me again" — so it had a four-dollar answer one click from gone. Now it selects
// nothing and destroys nothing, and this is where that is proved: same file on
// disk, empty panel, Run button back.
await page.locator('.advice-panel .run-button.subtle').click();
await page.waitForTimeout(300);
check('New run empties the panel', (await page.locator('.verdict-table').count()) === 0);
check('and offers a run again', (await page.locator('.advice-panel .run-button:not(.cancel)').count()) === 1);
check(
  'while the answer stays on disk',
  readdirSync(adviceDir).filter((n) => n.endsWith('.json')).length === 1,
);
// And is reachable: the header picker is the only door into a stored answer now
// — its first entry is the fresh session, then every run already paid for.
const options = await page.locator('.app-header .advice-runs option').allInnerTexts();
check('and on the list, behind the header picker', options.length === 2, options.join(' | '));
check('whose first entry is the fresh session', (options[0] ?? '').trim() === 'New run', options[0]);
await page.locator('.app-header .advice-runs').selectOption({ index: 1 });
await page.locator('.verdict-table').waitFor({ state: 'visible', timeout: 30_000 });
check('picking it shows it again', (await page.locator('.verdict-table').count()) === 1);
// The picker itself offers the way back out. This is the fix for a real trap:
// with exactly one stored run open, a picker that hid itself when there was
// "nothing to choose" removed every way back to the empty state short of
// restarting the app.
check('and stays on screen while that run is open', (await page.locator('.app-header .advice-runs').count()) === 1);
await page.locator('.app-header .advice-runs').selectOption({ index: 0 });
await page.waitForTimeout(300);
check('picking New run in it puts the answer away too', (await page.locator('.verdict-table').count()) === 0);
await page.locator('.app-header .advice-runs').selectOption({ index: 1 });
await page.locator('.verdict-table').waitFor({ state: 'visible', timeout: 30_000 });

// A reload is what happens on every hot module replacement in development and on
// any renderer crash in production. The run lives in main; the window comes back to
// the empty state — deliberately, since reopening last week's plan by itself would
// put its marks on the gear before the reader asked for them — and the answer is
// still one pick away.
await page.reload();
await page.locator('.loadout-grid').waitFor({ state: 'visible', timeout: 120_000 });
await page.waitForTimeout(500);
check('a reload comes back to the empty state', (await page.locator('.verdict-table').count()) === 0);
check('and to the loadout tab', (await page.locator('.loadout-grid').count()) === 1);
check('with the stored answer still on the list', (await page.locator('.app-header .advice-runs option').count()) === 2);
await page.locator('.app-header .advice-runs').selectOption({ index: 1 });
// Opening a stored run switches no tabs — only a *run* moves the column — so the
// table is read on the Advice tab.
await page.locator('.column-tabs .tab', { hasText: 'Advice' }).click();
await page.locator('.verdict-table').waitFor({ state: 'visible', timeout: 30_000 });
check('and re-shows it when picked', (await page.locator('.verdict-table').count()) === 1);

// The marks, joined against the live grid by document id. A mock's placeholder
// ids join onto nothing, which is the stale path — and it must say so.
const marked = await page.locator('.item-cell.action').count();
const stale = await page.locator('.advice-stale').count();
check(
  'the plan is joined onto the live grid, or says it could not be',
  marked > 0 || stale === 1,
  marked > 0 ? `${marked} marked item(s)` : 'nothing joined, and the panel says so',
);

// ---------------------------------------------------------------------------
// Settings, and the context document
// ---------------------------------------------------------------------------

await page.locator('.settings-button').click();
await page.locator('.modal').waitFor({ state: 'visible', timeout: 10_000 });
const settingsFacts = await page.locator('.settings-facts').innerText();
check('the settings pane names the save tree in use', settingsFacts.includes(saves.dir), saves.dir);
check(
  'and offers the installs this machine has',
  (await page.locator('.settings-path').nth(1).locator('.settings-found-path').count()) >= 1,
);

// Always-on-top is a setting, so it goes to settings.json through the same road
// as every other preference — and the main process applies it to the window.
await page.locator('.settings-check input').check();
await page.waitForTimeout(400);
const settingsFile = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
check('a settings change is written to settings.json', settingsFile.alwaysOnTop === true, JSON.stringify(settingsFile));
check('and the window is actually on top', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()));
await page.locator('.settings-check input').uncheck();
await page.waitForTimeout(400);

// The debug affordance: what the model would actually be sent, compiled now.
await page.locator('.settings-section', { hasText: 'Advice' }).locator('.chrome-button').click();
// Rendered is the view it opens on; Raw is the same document as the bytes that
// are actually sent, and both have to be real.
await page.locator('.context-rendered').waitFor({ state: 'visible', timeout: 120_000 });
check('the context document opens rendered', (await page.locator('.context-rendered .md-table').count()) > 0);
await page.locator('.view-tabs .tab', { hasText: 'Raw' }).click();
await page.locator('.context-document').waitFor({ state: 'visible', timeout: 30_000 });
const contextText = await page.locator('.context-document').innerText();
check('and is the real document', contextText.length > 20_000, `${contextText.length} chars`);
const contextSubtitle = await page.locator('.modal-subtitle').innerText();
check('titled with the character and difficulty it was built for', contextSubtitle.includes(character), contextSubtitle);
await page.locator('.modal .chrome-button', { hasText: 'Close' }).click();
await page.waitForTimeout(200);
check('and closes again', (await page.locator('.modal').count()) === 0);

// The override is only meaningful if it reaches the model, and the document is
// the only place that is *visible*. The resistance penalty is per difficulty and
// is not uniform, so the two documents cannot be the same text — provided the
// override actually differs from the save's own difficulty, which is the live
// character's to choose: this once always picked Normal, and failed the day the
// character was actually played on Normal. The subtitle above named the
// difficulty the first document was built at, so pick the other one.
const wasDifficulty = await page.locator('.app-header select').nth(1).inputValue();
const overrideDifficulty = contextSubtitle.includes('Normal') ? 'Ultimate' : 'Normal';
await page.locator('.app-header select').nth(1).selectOption(overrideDifficulty);
// The stats panel, not the loadout: the column has been on the Advice tab since
// the reload checks, and a difficulty change re-aggregates rather than rebuilding
// the database, so this is a fast re-read.
await page.locator('.stats-panel').waitFor({ state: 'visible', timeout: 60_000 });
await page.waitForTimeout(800);
await page.locator('.settings-button').click();
await page.locator('.settings-section', { hasText: 'Advice' }).locator('.chrome-button').click();
await page.locator('.context-rendered').waitFor({ state: 'visible', timeout: 120_000 });
await page.locator('.view-tabs .tab', { hasText: 'Raw' }).click();
await page.locator('.context-document').waitFor({ state: 'visible', timeout: 30_000 });
const onOverride = await page.locator('.context-document').innerText();
check('the difficulty override changes what the model is sent', onOverride !== contextText, `${contextText.length} → ${onOverride.length} chars`);
check(
  'and the document says which difficulty it was built for',
  (await page.locator('.modal-subtitle').innerText()).includes(overrideDifficulty),
);
await page.locator('.modal .chrome-button', { hasText: 'Close' }).click();
await page.locator('.app-header select').nth(1).selectOption(wasDifficulty);
await page.locator('.stats-panel').waitFor({ state: 'visible', timeout: 60_000 });
await page.waitForTimeout(800);

// ---------------------------------------------------------------------------
// The watcher, over a real save tree
// ---------------------------------------------------------------------------

// A character created while the app is running. This is the whole chain in one
// assertion: `fs.watch` → the 2 s debounce → a parse that checksums → the
// snapshot invalidation → the renderer's re-read → the picker.
if (spareCharacter) {
  const before = await page.locator('.app-header select').first().locator('option').count();
  installCharacter(spareCharacter);
  const picker = page.locator('.app-header select').first();
  const grew = await picker
    .locator('option')
    .nth(before)
    .waitFor({ state: 'attached', timeout: 20_000 })
    .then(() => true, () => false);
  check('a character created while the app is open turns up in the picker', grew, `${before} → ${before + 1}`);
} else {
  check('a character created while the app is open turns up in the picker', true, 'only one character on this machine — skipped');
}

// A torn write: the game is mid-save, so the checksums fail. What must *not*
// happen is the window emptying — the last good snapshot is still true, it is
// just not the newest one, and the banner says exactly that.
// Back to the loadout first: the assertion below is that the window still has
// what it had, and the column has been sitting on Advice since the reload
// checks. Clicked *before* the file is torn, because a click raises focus and
// the focus refresh would read the half-written file on purpose.
await page.locator('.column-tabs .tab', { hasText: 'Loadout' }).click();
await page.waitForTimeout(200);

const livePath = join(saves.dir, 'main', character, 'player.gdc');
const goodBytes = readFileSync(livePath);
const tornBytes = Buffer.from(goodBytes);
tornBytes[Math.floor(tornBytes.length / 2)] ^= 0xff;
writeFileSync(livePath, tornBytes);
const warned = await page
  .locator('.banner.warn-banner')
  .waitFor({ state: 'visible', timeout: 30_000 })
  .then(() => true, () => false);
check('a torn save is reported rather than swallowed', warned);
check('and the loadout it already had is still on screen', (await page.locator('.slot-row').count()) === 14);
writeFileSync(livePath, goodBytes);
const recovered = await page
  .locator('.banner.warn-banner')
  .waitFor({ state: 'detached', timeout: 30_000 })
  .then(() => true, () => false);
check('and the notice goes when the game finishes writing', recovered);

if (shot) {
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
}

// ---------------------------------------------------------------------------
// The window remembers where it was
// ---------------------------------------------------------------------------

// A geometry that survives a restart is not testable without one. The database
// is cached by now, so the second launch is seconds rather than the first one's
// half a minute.
const moved = { x: 120, y: 90, width: 1280, height: 860 };
await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), moved);
await page.waitForTimeout(900);
await app.close();

const remembered = JSON.parse(readFileSync(join(dataDir, 'window.json'), 'utf8'));
check(
  'the window writes where it was to window.json',
  remembered.bounds?.width === moved.width,
  JSON.stringify(remembered.bounds),
);

const again = await electron.launch({
  args: ['out/main/index.cjs'],
  env: { ...process.env, GD_DATA_DIR: dataDir, GD_SAVE_DIR: saves.dir },
});
const reopened = await again.firstWindow();
await reopened.locator('.loadout-grid').waitFor({ state: 'visible', timeout: 120_000 });
const bounds = await again.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
check(
  'and comes back there',
  bounds.width === moved.width && bounds.height === moved.height,
  JSON.stringify(bounds),
);
await again.close();

rmSync(saves.dir, { recursive: true, force: true });
check('no uncaught errors in the window', problems.length === 0, problems[0] ?? '');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall app checks passed');
