/**
 * Behaviour checks over the stories.
 *
 * Screenshots catch layout; these catch what only exists as an interaction —
 * pointing at a proposal lighting the item up wherever it lives, clicking one
 * flipping the container panel to its tab, the tooltips, and whether the panes
 * can actually be scrolled. None of that is visible in a still.
 *
 * Usage: `node scripts/check-stories.mjs` against a Storybook on :6006
 * (`STORYBOOK_URL` overrides).
 */

import { chromium } from 'playwright';

const base = process.env.STORYBOOK_URL ?? 'http://localhost:6006';
const story = (id) => `${base}/iframe.html?id=${id}&viewMode=story`;

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

// ---------------------------------------------------------------------------
// With advice
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--with-advice'), { waitUntil: 'networkidle' });

const rows = await page.locator('.slot-row').count();
check('the loadout renders one row per slot', rows === 14, `${rows} rows`);

// The two rows where a *different* item is proposed; the socket moves propose
// the same item again, and are checked below.
const proposals = page.locator('.slot-row:not(.socket-move) .slot-proposed .item-face');
check('advice fills the proposal column', (await proposals.count()) === 2, `${await proposals.count()} proposals`);

// ---------------------------------------------------------------------------
// Socket moves — four of the seven verdicts keep the item and change what it
// carries, so the proposal column has to render a socketable, not a sentence.
// ---------------------------------------------------------------------------

const sockets = page.locator('.slot-row.socket-move');
check('a socket move keeps its slot', (await sockets.count()) === 3, `${await sockets.count()}`);
// Abbreviated so the column costs the card columns as little as possible, but
// keeping the distinction inside each pair: `+` fills an empty socket and is
// free, `↔` replaces what is in one and destroys it.
const short = (await sockets.locator('.verdict-tag').allInnerTexts()).sort().join(',');
check('and names the move, short', short === '+COMP,↔AUG,↔COMP', short);
const full = (
  await sockets.locator('.verdict-tag').evaluateAll((els) => els.map((e) => e.title).sort())
).join(',');
check('with the full verdict still on it', full === 'ADD-COMPONENT,RE-AUGMENT,SWAP-COMPONENT', full);
// The abbreviation is only safe because the word survives somewhere legible.
const actions = (await page.locator('.verdict-table td:nth-child(4)').allInnerTexts()).join(' ');
check('and spelled out in the advice table', actions.includes('SWAP-COMPONENT'), actions.trim().split(/\s{2,}/).join(' | '));
// Nothing may be clipped: a verdict that nearly fits is the one the reader most
// needs to read.
const clipped = await page
  .locator('.verdict-tag')
  .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
check('no verdict is clipped by its column', clipped.length === 0, clipped.join(','));

// The row exists so the two cards can be read side by side. A caption above one
// of them put it a line lower than the other, which is the one thing the layout
// may not do.
const aligned = await page.locator('.slot-row.socket-move').evaluateAll((rows) =>
  rows.map((r) => {
    const a = r.querySelector('.slot-current .item-face').getBoundingClientRect();
    const b = r.querySelector('.slot-proposed .item-face').getBoundingClientRect();
    return Math.round(Math.abs(a.top - b.top));
  }),
);
check('worn and proposed sit at the same height', aligned.every((d) => d <= 1), JSON.stringify(aligned));
const everyRow = await page.locator('.slot-row:has(.slot-proposed .item-face)').evaluateAll((rows) =>
  rows.map((r) => {
    const a = r.querySelector('.slot-current .item-face')?.getBoundingClientRect();
    const b = r.querySelector('.slot-proposed .item-face')?.getBoundingClientRect();
    return a && b ? Math.round(Math.abs(a.top - b.top)) : 0;
  }),
);
check('in every row that has both', everyRow.every((d) => d <= 1), JSON.stringify(everyRow));
// The Inventor recovers the component *or* the item, so this is the price of
// the move — it belongs with the other costs, not as a caption over a card.
const destroys = await page.locator('.slot-reason .socket-destroys').innerText();
check('an extraction says what it destroys, beside the other costs', destroys.includes('destroys'), destroys);

// The proposal is the *same item* with the new socketable in it — that is what
// the slot will actually look like — and only the socket that changes is marked.
const changed = page.locator('.slot-proposed .socket-chip.changed');
check('the changed socket is marked, and only that one', (await changed.count()) === 3, `${await changed.count()}`);
const swapRow = page.locator('.slot-row.verdict-swap-component').first();
const [before, after] = [
  await swapRow.locator('.slot-current .face-name').innerText(),
  await swapRow.locator('.slot-proposed .face-name').innerText(),
];
check('a socket move proposes the same item, not a different one', before === after, `${before} → ${after}`);
check(
  'with a different component in it',
  (await swapRow.locator('.slot-current .socket-name').first().innerText()) !==
    (await swapRow.locator('.slot-proposed .socket-name').first().innerText()),
);

// Hovering the proposal must show the item *as it would be*: the new component
// in place, and the consequences of getting it there.
await swapRow.locator('.slot-proposed .face-name').hover();
await page.waitForTimeout(220);
const afterTip = await page.locator('.tooltip').innerText();
check('the proposal tooltip carries the new component', afterTip.includes('Bloodied Crystal'), afterTip.split('\n')[0]);
check('and says what replacing costs', /destroy/i.test(afterTip));
await page.mouse.move(5, 5);
await page.waitForTimeout(100);

// ---------------------------------------------------------------------------
// The standing mark: which of two hundred items the advice touches at all
// ---------------------------------------------------------------------------

const marked = await page.locator('.item-cell.action').count();
check('items the plan acts on are marked without hovering', marked >= 3, `${marked} marked`);

// Three different instructions, three different marks: putting something on
// now, keeping it for a threshold, and destroying it for the component inside.
const kinds = await page
  .locator('.item-cell.action')
  .evaluateAll((els) => [...new Set(els.flatMap((e) => [...e.classList].filter((c) => c.startsWith('action-'))))].sort());
check('and coloured by what the action is', kinds.length >= 3, kinds.join(' '));
check('a held item is not marked as an upgrade', kinds.includes('action-hold'));
check('an extraction host is marked as destroyed', kinds.includes('action-destroy'));
const badges = await page.locator('.tab-todo').allInnerTexts();
check('and their container counts them', badges.length >= 1, badges.join('/'));

// A mark that means something without being hovered has to say what it means.
const legend = await page.locator('.mark-legend .legend-item').allInnerTexts();
check('the marks come with a legend', legend.length === 3, legend.join(' | ').replace(/\n/g, ' '));
check('drawn in the same colours as the flags', (await page.locator('.mark-legend .action-hold').count()) === 1);

// Three columns at 1920: loadout, sheet, containers — all visible at once.
check('all three panes are on screen at 1920', (await page.locator('.pane').count()) === 3);
check('the containers pane is visible', await page.locator('.pane-containers .tab-strip').isVisible());

// Hovering a proposal must light the same item up in the container grid, and
// mark the tab holding it — that tab is usually not the one on screen.
await proposals.first().hover();
await page.waitForTimeout(120);
check('hovering a proposal highlights it in its container', (await page.locator('.item-cell.highlighted').count()) === 1);
check('the tab holding it is marked', (await page.locator('.container-panel .tab.lit').count()) >= 1);

// Gains and costs sit on their own full-width line under their row, as they do
// in the loadout — in a fifth column the longest stat string set the height of
// every row.
const detail = await page.locator('.verdict-table .verdict-detail td').first().evaluate((td) => ({
  span: td.colSpan,
  wraps: getComputedStyle(td).whiteSpace,
  wider: td.getBoundingClientRect().width > td.closest('table').querySelector('tbody th').getBoundingClientRect().width,
}));
check('gains and costs run the full width under their row', detail.span === 4 && detail.wider, JSON.stringify(detail));
check('and wrap rather than ellipsise', detail.wraps === 'normal', detail.wraps);

// The table must fit its panel. It used to be 735 px of auto-laid-out columns
// inside a 689 px panel, and the pane clips horizontally — so the Action column
// was cut off at the app's own window size, with no scrollbar to say so.
const fits = await page.locator('.verdict-table').evaluate((t) => {
  const panel = t.closest('.advice-panel');
  return { table: Math.round(t.scrollWidth), panel: panel.clientWidth };
});
check('the verdict table fits its panel', fits.table <= fits.panel, `${fits.table} in ${fits.panel}`);
// Nothing an ellipsis hides may be unreachable.
const reachable = await page.locator('.verdict-table tr:not(.verdict-detail) td, .verdict-table tbody th').evaluateAll((cells) =>
  cells
    .filter((c) => c.scrollWidth > c.clientWidth + 1)
    .every((c) => c.title.trim().length > 0 || c.classList.contains('has-tooltip')),
);
check('and every truncated cell can still be read', reachable);

// The two item cells carry the item's own panel: this table is where a reader
// decides whether to act, and deciding means reading both items' stats.
const cells = page.locator('.verdict-table tbody').nth(1).locator('td.has-tooltip');
await cells.first().hover();
await page.waitForTimeout(220);
const fromTable = (await page.locator('.tooltip').innerText()).split('\n')[0];
check('hovering the Current cell shows that item', fromTable.length > 0, fromTable);
await cells.nth(1).hover();
await page.waitForTimeout(220);
const nextTip = (await page.locator('.tooltip').innerText()).split('\n')[0];
check('and the New cell shows the other one', nextTip !== fromTable, `${fromTable} → ${nextTip}`);
// And the Action cell names a socketable, whose own stats are the whole
// question about `ADD-COMPONENT Mark of Mogdrogen`.
const actionCell = page.locator('.verdict-table tbody', { hasText: 'ADD-COMPONENT' }).locator('td.has-tooltip').last();
await actionCell.hover();
await page.waitForTimeout(220);
const actionTip = (await page.locator('.tooltip').innerText()).split('\n');
check('hovering an Action shows the socketable it installs', actionTip[0]?.includes('Mogdrogen'), actionTip.slice(0, 2).join(' · '));
check('labelled with the socket it fills', actionTip[1] === 'Component', actionTip[1]);
// The stats say what the component does; the advisor's sentence says why this
// one. A reader asking "and why?" is looking at this panel when they ask it.
check(
  'and carries the advisor’s reason for the move',
  actionTip.some((l) => l.includes('socket is empty')),
  actionTip[actionTip.length - 1],
);
await page.mouse.move(5, 5);
await page.waitForTimeout(100);

// A verdict row is about two items; lighting one is half an answer.
await page.locator('.verdict-table tbody').nth(1).hover();
await page.waitForTimeout(120);
const bothLit = await page.locator('.item-cell.highlighted, .item-face.highlighted').count();
check('an advice row highlights both items it names', bothLit >= 1, `${bothLit} lit`);

// Clicking reveals: the panel switches to the tab and page holding the item.
await page.locator('.container-panel .tab', { hasText: 'Transfer' }).click();
await page.waitForTimeout(80);
await proposals.first().click();
await page.waitForTimeout(150);
const selectedTab = await page.locator('.container-panel .tab.selected').innerText();
check('clicking a proposal reveals its container', selectedTab.startsWith('Inventory'), selectedTab.trim());

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

const tooltip = page.locator('.tooltip');

// The whole face, not the 46 px of icon in it: the name is what the eye lands
// on and what the pointer goes to.
await page.locator('.slot-row .face-name').first().hover();
await page.waitForTimeout(200);
check('hovering an item *name* shows its tooltip', (await tooltip.count()) === 1);
check('and so does its icon', await (async () => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(80);
  await page.locator('.slot-row .face-art').first().hover();
  await page.waitForTimeout(200);
  return (await tooltip.count()) === 1;
})());
check('the tooltip names its stats', (await tooltip.innerText()).includes('Resistance'));
check('and colours them by type', (await page.locator('.tooltip [class*="stat-"]').count()) > 0);

// The slot label is a hover target too.
await page.mouse.move(5, 5);
await page.waitForTimeout(100);
await page.locator('.slot-name').first().hover();
await page.waitForTimeout(200);
check('hovering a slot label shows the equipped item', (await tooltip.count()) === 1);

// The panel opens *below* the card it describes, left-aligned with it. A
// loadout row is a comparison two cards wide, and a panel opening to the side
// of either card lands on the other one — the very item being compared against.
const boxes = [];
for (const sel of ['.slot-current .face-art', '.slot-current .face-name', '.slot-current .socket-chip.filled']) {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(80);
  await page.locator(`.slot-row:first-child ${sel}`).first().hover();
  await page.waitForTimeout(220);
  boxes.push(
    await page.evaluate(() => {
      const card = document.querySelector('.slot-row .slot-current .item-face').getBoundingClientRect();
      const other = document.querySelector('.slot-row .slot-proposed').getBoundingClientRect();
      const tip = document.querySelector('.tooltip').getBoundingClientRect();
      return {
        below: Math.round(tip.top) >= Math.round(card.bottom),
        clearsOther: Math.round(tip.top) >= Math.round(other.bottom) || Math.round(tip.right) <= Math.round(other.left),
        left: Math.round(tip.left),
      };
    }),
  );
}
check('the tooltip opens below the card', boxes.every((b) => b.below), JSON.stringify(boxes.map((b) => b.left)));
check('clear of the card it is being compared against', boxes.every((b) => b.clearsOther));
check(
  'and in one place however you point at that card',
  new Set(boxes.map((b) => b.left)).size === 1,
  JSON.stringify(boxes.map((b) => b.left)),
);

// Pointing at a card lights it, whatever verdict its row carries and whether or
// not it has a second item to cross-highlight. That used to depend on the
// advice, so RE-AUGMENT rows and every worn item silently had no hover state.
const lit = [];
for (const [what, sel] of [
  ['a worn item', '.slot-row.socket-move .slot-current .item-face'],
  ['a socket proposal', '.slot-row.socket-move .slot-proposed .item-face'],
  ['an EQUIP proposal', '.slot-row:not(.socket-move) .slot-proposed .item-face'],
]) {
  const card = page.locator(sel).first();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(80);
  const before = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
  await card.hover();
  await page.waitForTimeout(150);
  const after = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
  check(`pointing at ${what} lights the card`, before !== after, `${before} -> ${after}`);
  lit.push(after);
}
// One highlight, whatever caused it: what the advice says about an item is
// carried by the row border and the corner flag, not by a second brightness.
check('every card lights the same way', new Set(lit).size === 1, [...new Set(lit)].join(' / '));
await page.mouse.move(5, 5);
await page.waitForTimeout(100);

// A component gets its own panel, not the host item's — and its *name* is as
// much a hover target as its icon, which is the half the pointer usually lands
// on. The pointer arrives here straight off the item's own art, which is the
// path that has to keep working.
await page.locator('.slot-current .face-art').first().hover();
await page.waitForTimeout(120);
await page.locator('.slot-current .socket-chip.filled .socket-name').first().hover();
await page.waitForTimeout(200);
const chipTip = await tooltip.innerText();
check('hovering a component name shows the component', chipTip.includes('Component'), chipTip.split('\n')[0]);
check('and its stats keep their type colours', (await page.locator('.tooltip [class*="stat-"]').count()) > 0);

// The socketable block inside a *whole item's* tooltip is stats too. It was
// being flattened to the body colour by a rule meant for granted skills.
await page.mouse.move(5, 5);
await page.waitForTimeout(100);
await page.locator('.slot-current .face-art').first().hover();
await page.waitForTimeout(200);
check(
  'a component block inside an item tooltip is coloured too',
  (await page.locator('.tooltip .tooltip-socketable [class*="stat-"]').count()) > 0,
);

// A damage-over-time type is its own stat, so it is its own shade — the same
// family as its parent, not the same colour.
await page.mouse.move(5, 5);
await page.waitForTimeout(100);
await page.locator('.slot-row', { hasText: 'OFF HAND' }).locator('.face-name').first().hover();
await page.waitForTimeout(220);
const dot = await page.locator('.tooltip .stat-burn, .tooltip .stat-fire').evaluateAll((els) =>
  els.map((e) => [e.textContent.trim(), getComputedStyle(e).color]),
);
check('a DoT type and its parent are both coloured', dot.length === 2, JSON.stringify(dot));
check('and not with the same colour', dot.length === 2 && dot[0][1] !== dot[1][1]);

// ---------------------------------------------------------------------------
// The character sheet
// ---------------------------------------------------------------------------

await page.mouse.move(5, 5);
await page.waitForTimeout(100);

// The sheet's rows and the tooltips are about the same things, so they are
// coloured by the same rule.
const resistColours = await page
  .locator('.resist-table tbody th')
  .evaluateAll((els) => new Set(els.map((e) => getComputedStyle(e).color)).size);
check('resistance rows are coloured by type', resistColours >= 8, `${resistColours} distinct colours`);

// Armour is localized: six alternatives, and the weakest is the finding.
check('the weakest body part is called out', (await page.locator('.stat-tag').innerText()).includes('weakest'));
const armour = await page.locator('.stats-section', { hasText: 'Armour' }).first().innerText();
check(
  'the character-wide bonus is stated once, on the list it applies to',
  /per body part — each/.test(armour),
  armour.split('\n')[0],
);
check('and not as a paragraph under it', !/rolled per hit/.test(armour));

// ---------------------------------------------------------------------------
// The model's own prose
// ---------------------------------------------------------------------------

await page.locator('.advice-tabs .tab', { hasText: 'Full answer' }).click();
await page.waitForTimeout(150);
check('the answer tab renders the prose', (await page.locator('.markdown').count()) === 1);
check('with its headings', (await page.locator('.markdown .md-h').count()) >= 3);
check('its lists', (await page.locator('.markdown .md-list li').count()) >= 4);
check('and its table', (await page.locator('.markdown .md-table tbody tr').count()) >= 3);
// A wrapped list item must stay in the list rather than breaking out of it.
const listText = await page.locator('.markdown .md-list li').nth(2).innerText();
check('a wrapped list item stays whole', listText.trim().endsWith('.'), listText.slice(-40));
await page.locator('.advice-tabs .tab', { hasText: 'Plan' }).click();
await page.waitForTimeout(120);
check('and the plan is still there behind it', (await page.locator('.verdict-table').count()) === 1);

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

// A hold says what it is *for*. Without that it is a list of things you cannot
// wear, which is not advice.
const hold = await page.locator('.hold-list li').first().innerText();
check('a hold names its slot and what it displaces', /for Head over /.test(hold), hold.split('\n')[0]);
check('and what it gains', (await page.locator('.hold-list .gain').count()) >= 1);

// An answer is model output this window has no control over. Each hostile shape
// has its own escape hatch, and none of them may push the panel sideways —
// the pane clips rather than scrolls, so that overflow would be silent.
await page.goto(story('parts--answer-hostile'), { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const hostile = await page.evaluate(() => {
  const panel = document.querySelector('.advice-panel');
  const wrap = document.querySelector('.md-table-wrap');
  const code = document.querySelector('.md-code');
  return {
    panelOverflows: panel.scrollWidth > panel.clientWidth,
    tableScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
    codeScrolls: code ? code.scrollWidth > code.clientWidth : false,
    paraOverflow: [...document.querySelectorAll('.md-p')].map((e) => e.scrollWidth - e.clientWidth),
  };
});
check('an oversized answer never widens the panel', !hostile.panelOverflows, JSON.stringify(hostile));
check('its wide table scrolls inside itself', hostile.tableScrolls);
check('its code block scrolls inside itself', hostile.codeScrolls);
check('and an unbreakable identifier breaks rather than overflowing', hostile.paraOverflow.every((d) => d <= 0));

await page.goto(story('parts--materials'), { waitUntil: 'networkidle' });
const materialRows = page.locator('.material-row');
check('the materials list renders every entry', (await materialRows.count()) === 6, `${await materialRows.count()} rows`);
check('components state what they do', (await page.locator('.material-effect').count()) >= 2);

// The whole row is the hover target, not the 32 px of icon in it.
await materialRows.nth(2).hover();
await page.waitForTimeout(200);
check('hovering a material row shows its tooltip', (await tooltip.count()) === 1);
check(
  'a quest item that is also a reagent says both',
  (await page.locator('.material-row', { hasText: 'Ancient Heart' }).count()) === 1,
);

// ---------------------------------------------------------------------------
// Without advice, and the states that are easy to forget
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--before-advice'), { waitUntil: 'networkidle' });
const locked = await page.locator('.face-locked.waiting').count();
check('without advice every proposal slot reads as locked', locked === 14, `${locked} locked`);
check('and says what would fill it', (await page.locator('.loadout-hint').count()) === 1);
check('the header offers the run', (await page.locator('.chrome-button.primary').innerText()).includes('Run advice'));

// The panes are `height: 100%` all the way down; if the chain breaks they
// collapse to their content and a long loadout simply cannot be reached.
const scroll = await page.locator('.pane-loadout').evaluate((el) => ({
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
}));
check(
  'the loadout pane scrolls rather than overflowing',
  scroll.scrollHeight > scroll.clientHeight && scroll.clientHeight > 400,
  `${scroll.scrollHeight} content in ${scroll.clientHeight}`,
);
const scrolled = await page.locator('.pane-loadout').evaluate((el) => {
  el.scrollTop = 400;
  return el.scrollTop;
});
check('and actually moves when scrolled', scrolled > 0, `scrollTop ${scrolled}`);

await page.goto(story('app-workspace--first-boot'), { waitUntil: 'networkidle' });
check('a first boot reports progress instead of sitting blank', (await page.locator('.banner.loading').count()) === 1);
check('with a spinner', (await page.locator('.spinner').count()) === 1);

await page.goto(story('app-workspace--sparse-character'), { waitUntil: 'networkidle' });
check('a sparse character still renders every slot', (await page.locator('.slot-row').count()) === 14);
check('empty slots say so', (await page.locator('.face-empty').count()) >= 10);

// ---------------------------------------------------------------------------
// Responsive
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--with-advice'), { waitUntil: 'networkidle' });
for (const [label, width] of [
  ['three columns', 1920],
  ['two columns', 1500],
  ['stacked', 1100],
]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(150);
  const visible = await page.locator('.pane-containers .tab-strip').isVisible();
  const body = await page.locator('.app-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  check(`${label}: the containers stay reachable`, visible);
  check(`${label}: nothing overflows sideways`, body);

  // The widest container is a 19-cell stash tab. A column narrower than that
  // scrolls sideways forever, which is why the third column is a measurement
  // rather than a fraction.
  await page.locator('.container-panel .tab', { hasText: 'Stash' }).click();
  await page.waitForTimeout(120);
  const fits = await page
    .locator('.pane-containers')
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  check(`${label}: a full stash tab fits its column`, fits);
  await page.locator('.container-panel .tab', { hasText: 'Inventory' }).click();
  await page.waitForTimeout(80);
}

await browser.close();
check('no uncaught errors in any story', problems.length === 0, problems[0] ?? '');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
