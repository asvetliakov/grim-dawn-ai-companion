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

/**
 * The item's *own* panel.
 *
 * Since Stage 7B the floating layer holds two panels for a marked item — what
 * the item is, and what the plan says to do about it — so a bare `.tooltip`
 * matches two elements and Playwright's strict mode rightly refuses to guess.
 * Every check that means "the item's stats" names this one.
 */
const ITEM_TIP = '.tooltip:not(.action-tooltip)';

/**
 * Hover something and wait for its panel.
 *
 * Every subject change waits 200 ms before it appears — the window is a grid of
 * two hundred items and every path across it crosses a dozen, so a panel that
 * followed the pointer immediately would strobe. Waiting for attachment is not
 * enough on a *switch*, where a panel is already up and only its contents change,
 * so this waits out the delay and then some.
 */
const OPEN_DELAY_MS = 200;

async function showTip(target) {
  await target.hover();
  await page.locator(ITEM_TIP).first().waitFor({ state: 'attached', timeout: 3000 });
  await page.waitForTimeout(OPEN_DELAY_MS + 140);
}

/**
 * Park the pointer in the corner and wait for the panel to actually be gone.
 *
 * A fixed pause is not enough any more: the panel outlives the pointer leaving
 * by a beat, and it takes the pointer rather than passing it through. Hovering
 * the next target while the old panel is still up would land the pointer on the
 * panel — which keeps it open, so the wait would never end.
 */
async function clearTip() {
  await page.mouse.move(5, 5);
  await page.locator(ITEM_TIP).waitFor({ state: 'detached', timeout: 2000 });
}
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

/**
 * The right-hand column is Loadout | Advice tabs since the fourth pass, so a
 * check about the panel that is not on screen switches first. The strip is its
 * own class — `.tab` alone would also match the container tabs.
 */
async function columnTab(label) {
  await page.locator('.column-tabs .tab', { hasText: label }).click();
  await page.waitForTimeout(120);
}

// ---------------------------------------------------------------------------
// With advice
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--with-advice'), { waitUntil: 'networkidle' });

// The column opens on the loadout: the result of a run is marks and proposals
// on the gear, and the table about them is one tab away.
check('the right column is two tabs', (await page.locator('.column-tabs .tab').count()) === 2);
check(
  'and opens on the loadout',
  (await page.locator('.column-tabs .tab.selected').innerText()).trim() === 'Loadout',
);

const rows = await page.locator('.slot-row').count();
check('the loadout renders one row per slot', rows === 14, `${rows} rows`);

// The two rows where a *different* item is proposed; the socket moves propose
// the same item again, and are checked below.
const proposals = page.locator('.slot-row:not(.socket-move) .slot-proposed .item-face');
check('advice fills the proposal column', (await proposals.count()) === 2, `${await proposals.count()} proposals`);

// An EQUIP can also say what to put *in* the new item, which one verdict per slot
// had no room for: an item holds a component and an augment in independent
// sockets, so a slot can legitimately need two socketable changes at once. The
// first live run argued in prose for fitting the new amulet with a loose Dread
// Skull and a Sagethorn Powder, and the plan could carry neither.
// By the slot *label*, not by row text: an item name can contain a slot's name,
// and `hasText` on the row would then match a weapon.
const handsRow = page
  .locator('.slot-row')
  .filter({ has: page.locator('.slot-name', { hasText: /^Hands$/ }) });
const fitChips = await handsRow.locator('.slot-proposed .socket-chip').allInnerTexts();
check(
  'an EQUIP proposal wears what the plan tells it to wear',
  fitChips.length === 2,
  fitChips.join(' | ').replace(/\n/g, ' '),
);
check(
  'and names both sockets',
  /Mogdrogen/.test(fitChips.join(' ')) && /Vigil/.test(fitChips.join(' ')),
  fitChips.join(' | ').replace(/\n/g, ' '),
);

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
await columnTab('Advice');
const actions = (await page.locator('.verdict-table td:nth-child(4)').allInnerTexts()).join(' ');
check('and spelled out in the advice table', actions.includes('SWAP-COMPONENT'), actions.trim().split(/\s{2,}/).join(' | '));
await columnTab('Loadout');
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
await showTip(swapRow.locator('.slot-proposed .face-name'));
const afterTip = await page.locator(ITEM_TIP).innerText();
check('the proposal tooltip carries the new component', afterTip.includes('Bloodied Crystal'), afterTip.split('\n')[0]);
check('and says what replacing costs', /destroy/i.test(afterTip));
await clearTip();

// ---------------------------------------------------------------------------
// The standing mark: which of two hundred items the advice touches at all
// ---------------------------------------------------------------------------

const marked = await page.locator('.item-cell.action').count();
check('items the plan acts on are marked without hovering', marked >= 3, `${marked} marked`);

// Four different instructions, four different marks: putting something on now,
// keeping it for a threshold, destroying it for the component inside, and
// selling it. One colour for all four turns a stash of things to wait for into a
// stash of upgrades.
const markKinds = () =>
  page
    .locator('.item-cell.action')
    .evaluateAll((els) => [...new Set(els.flatMap((e) => [...e.classList].filter((c) => c.startsWith('action-'))))].sort());
const kinds = await markKinds();
check('and coloured by what the action is', kinds.length >= 3, kinds.join(' '));
check('a held item is not marked as an upgrade', kinds.includes('action-hold'));
check('an extraction host is marked as destroyed', kinds.includes('action-destroy'));
const badges = await page.locator('.tab-todo').allInnerTexts();
check('and their container counts them', badges.length >= 1, badges.join('/'));

// The colour alone needs the legend to be read; a glyph does not. Four colours in
// a stash of two hundred items is exactly where a mark stops explaining itself.
const glyphs = await page.locator('.item-cell.action .advice-badge svg').count();
check('every mark carries a glyph, not just a colour', glyphs === marked, `${glyphs} of ${marked}`);
// And the glyph is chosen from the verdict: an EQUIP candidate is not a hold.
const titles = await page
  .locator('.item-cell.action .advice-badge')
  .evaluateAll((els) => [...new Set(els.map((e) => e.title.split(' →')[0]))].sort());
check('and the glyph says which action it is', titles.length >= 3, titles.join(' | '));

// A mark is a *standing* fact about sixteen items; the highlight is the transient
// answer to "what am I pointing at". The two must not look alike — the first draft
// of the ring gave the mark an inset glow, and every marked cell then read as lit.
const litWithoutHover = await page.locator('.item-cell.action.highlighted').count();
check('a marked item is not lit until something points at it', litWithoutHover === 0, `${litWithoutHover} lit`);
// The mark takes an edge the highlight never uses. A **border** is how this window
// says "this one", so sixteen standing marks may not borrow that vocabulary — the
// full ring this started as was perfectly visible and read as lit. A bar is an
// annotation; a border is a state.
const bar = await page.locator('.item-cell.action').first().evaluate((el) => {
  const before = getComputedStyle(el, '::before');
  return {
    height: before.height,
    border: before.borderTopWidth,
    background: before.backgroundColor,
    tint: getComputedStyle(el).backgroundColor,
  };
});
check('and carries an edge bar rather than a border', bar.height === '3px' && bar.border === '0px', JSON.stringify(bar));

// A mark that means something without being hovered has to say what it means.
const legend = await page.locator('.mark-legend .legend-item').allInnerTexts();
check('the marks come with a legend', legend.length === 4, legend.join(' | ').replace(/\n/g, ' '));
check('drawn in the same colours as the flags', (await page.locator('.mark-legend .action-hold').count()) === 1);
check(
  'and with the same glyphs',
  (await page.locator('.mark-legend .legend-flag svg').count()) === legend.length,
);

// The legend is also the control for its own count. "Sell or salvage 13" answers
// "is it worth opening this tab"; *which thirteen* is the question straight after
// it, and before this it was answerable only by hovering the advice table row by
// row. Scoped to the containers, which is what the legend counts.
const equipLegend = page.locator('.mark-legend .legend-item.action-equip');
await equipLegend.hover();
await page.waitForTimeout(120);
const litByLegend = await page.locator('.item-cell.action-equip.highlighted').count();
const litOthers = await page.locator('.item-cell.action-hold.highlighted, .item-cell.action-sell.highlighted').count();
check('hovering a legend entry lights that kind', litByLegend >= 1, `${litByLegend} lit`);
check('and only that kind', litOthers === 0, `${litOthers} others lit`);
// The loadout is not a container, so a candidate's card there is left alone: the
// legend is counting the stash, and the same item is on both sides of a swap.
const litCards = await page.locator('.loadout-grid .item-face.highlighted').count();
check('and nothing in the loadout, which the legend does not count', litCards === 0, `${litCards} cards lit`);
await page.mouse.move(4, 4);
await page.waitForTimeout(120);
check('leaving the legend puts them out again', (await page.locator('.item-cell.highlighted').count()) === 0);

// The legend counts every container, not the open one — and that is the point:
// the fourth kind lives on the Stash tab, so it is a count of something the
// reader cannot see. The tab badge is what sends them there.
const sellTab = page.locator('.container-panel .tab', { hasText: 'Stash' });
check('a container holding an unseen action says how many', (await sellTab.locator('.tab-todo').count()) >= 1);
await sellTab.click();
await page.waitForTimeout(120);
const stashKinds = await markKinds();
check('and a sell is its own mark, not an extraction', stashKinds.includes('action-sell'), stashKinds.join(' '));
await page.locator('.container-panel .tab', { hasText: 'Inventory' }).click();
await page.waitForTimeout(120);

// ---------------------------------------------------------------------------
// The action tooltip: what the plan says about the item under the pointer
// ---------------------------------------------------------------------------

// Beside the item's own panel, not inside it: one is what the item *is* and is
// true whether or not a run happened, the other is an opinion a re-run replaces.
await clearTip();
await showTip(page.locator('.item-cell.action-equip').first());
check('a marked item shows its own panel and the action panel', (await page.locator('.tooltip').count()) === 2);
const actionPanel = await page.locator('.action-tooltip').innerText();
check('the action panel names the verb', /Equip/.test(actionPanel), actionPanel.split('\n')[0]);
check('and the slot it is for', /HANDS|BELT/i.test(actionPanel), actionPanel.replace(/\n/g, ' · '));
check('with the gains the move buys', (await page.locator('.action-tooltip .gain').count()) >= 1);
check('and the argument for it', (await page.locator('.action-reason').count()) === 1);
// A move is often only worth making together with three others, which a per-item
// panel would otherwise hide entirely.
check('and the key move it belongs to', /part of:/.test(actionPanel));

// Two panels, side by side rather than one on top of the other — and neither may
// be pushed off the screen by the other.
const pair = await page.locator('.tooltip-layer').evaluate((layer) => {
  const [a, b] = [...layer.querySelectorAll('.tooltip')].map((e) => e.getBoundingClientRect());
  return {
    sideBySide: Math.round(b.left) >= Math.round(a.right) - 2,
    onScreen: b.right <= window.innerWidth + 1,
    // The two panels are different heights, so the row's own box is taller than
    // the shorter one. That empty ground must belong to nobody.
    shorter: Math.round(a.height - b.height),
    dead: { x: Math.round(b.left + b.width / 2), y: Math.round(b.bottom + (a.bottom - b.bottom) / 2) },
  };
});
check('the two panels sit side by side', pair.sideBySide, JSON.stringify(pair));
check('and both stay on screen', pair.onScreen);

// The two panels touch, so the pointer can cross from the item's stats into the
// advice and back without passing over anything else. A gap between them would
// be a strip belonging to neither, and crossing it would hand the pointer to
// whatever item cell is underneath — closing the pair on the way to reading it.
const advicePanel = await page.locator('.action-tooltip').boundingBox();
await page.mouse.move(advicePanel.x + advicePanel.width / 2, advicePanel.y + 20);
await page.waitForTimeout(300);
check('the pointer can cross into the advice panel', (await page.locator('.action-tooltip').count()) === 1);
check('and the item panel stays with it', (await page.locator(ITEM_TIP).count()) === 1);

// The empty space beside the shorter panel is not a hover target. It used to be:
// the flex row took pointer events, so its box — as tall as the *taller* panel —
// left the pointer sitting in open ground with the tooltip refusing to close.
if (pair.shorter > 20) {
  const under = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.className ?? '',
    pair.dead,
  );
  check(
    'the empty space beside the shorter panel belongs to nobody',
    !/tooltip/.test(String(under)),
    `hit ${String(under) || '(nothing)'}`,
  );
  await page.mouse.move(pair.dead.x, pair.dead.y);
  await page.waitForTimeout(400);
  check('so moving into it closes the pair', (await page.locator('.tooltip').count()) === 0);
} else {
  check('the two panels are close enough in height that there is no dead ground', true, `${pair.shorter}px`);
}

// An extraction host's panel is about *it*, not about the slot the component is
// going into — the verdict there is SWAP-COMPONENT, the consequence here is death.
await clearTip();
await showTip(page.locator('.item-cell.action-destroy').first());
const destroyPanel = await page.locator('.action-tooltip').innerText();
check('an extraction host is told it is being spent', /Destroyed/.test(destroyPanel), destroyPanel.split('\n')[0]);

// A hold states its threshold, because the threshold is the reason it is a hold
// rather than an equip.
await clearTip();
await showTip(page.locator('.item-cell.action-hold').first());
const holdPanel = await page.locator('.action-tooltip').innerText();
check('a hold states its threshold', /until level 84/.test(holdPanel), holdPanel.replace(/\n/g, ' · '));
check('and which slot it is being held for', /HEAD/i.test(holdPanel));

// An unmarked item gets one panel, not an empty second one.
await clearTip();
await showTip(page.locator('.item-cell:not(.action)').first());
check('an item the plan says nothing about gets one panel', (await page.locator('.tooltip').count()) === 1);
await clearTip();

// ---------------------------------------------------------------------------
// What the run cost, and what it can no longer find
// ---------------------------------------------------------------------------

await columnTab('Advice');
const cost = await page.locator('.advice-cost').innerText();
check('the panel says what the run cost', /2 calls/.test(cost) && /\$4\.16/.test(cost), cost);
check('and how long it took', /14m/.test(cost), cost);
// The only visible sign that the repair loop fired at all.
check('and repeats the question that was asked', /asked:/.test(cost));
check('nothing is stale while the save matches the run', (await page.locator('.advice-stale').count()) === 0);
await columnTab('Loadout');

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
await columnTab('Advice');
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
await showTip(cells.first());
const fromTable = (await page.locator(ITEM_TIP).innerText()).split('\n')[0];
check('hovering the Current cell shows that item', fromTable.length > 0, fromTable);
await showTip(cells.nth(1));
const nextTip = (await page.locator(ITEM_TIP).innerText()).split('\n')[0];
check('and the New cell shows the other one', nextTip !== fromTable, `${fromTable} → ${nextTip}`);
// And the Action cell names a socketable, whose own stats are the whole
// question about `ADD-COMPONENT Mark of Mogdrogen`. Parked first: with the
// panel at the top of its column the previous cell's tooltip pair covers this
// row, and `.hover()` would retry onto the panel — which keeps it open forever.
await clearTip();
const actionCell = page.locator('.verdict-table tbody', { hasText: 'ADD-COMPONENT' }).locator('td.has-tooltip').last();
await showTip(actionCell);
const actionTip = (await page.locator(ITEM_TIP).innerText()).split('\n');
check('hovering an Action shows the socketable it installs', actionTip[0]?.includes('Mogdrogen'), actionTip.slice(0, 2).join(' · '));
check('labelled with the socket it fills', actionTip[1] === 'Component', actionTip[1]);
// The stats say what the component does; the advisor's sentence says why this
// one. A reader asking "and why?" is looking at this panel when they ask it.
check(
  'and carries the advisor’s reason for the move',
  actionTip.some((l) => l.includes('socket is empty')),
  actionTip[actionTip.length - 1],
);
await clearTip();

// A verdict row is about two items; lighting one is half an answer. The loadout
// is on the other tab now, so what it lights from here is the container copy.
await page.locator('.verdict-table tbody').nth(1).hover();
await page.waitForTimeout(120);
const bothLit = await page.locator('.item-cell.highlighted, .item-face.highlighted').count();
check('an advice row highlights both items it names', bothLit >= 1, `${bothLit} lit`);
await columnTab('Loadout');

// Clicking reveals: the panel switches to the tab and page holding the item.
await page.locator('.container-panel .tab', { hasText: 'Transfer' }).click();
await page.waitForTimeout(80);
await proposals.first().click();
await page.waitForTimeout(150);
const selectedTab = await page.locator('.container-panel .tab.selected').innerText();
check('clicking a proposal reveals its container', selectedTab.startsWith('Inventory'), selectedTab.trim());

// The chrome — tabs and legend — sticks while the grids scroll under it: deep
// in a tall bag, "which container am I in" and "what do the marks mean" are
// questions about the top of the pane, and scrolling back up to answer them was
// the complaint. The fixture's containers happen to fit at 1080, so the pane has
// nothing to scroll here — what is checked is the mechanism: pinned to the
// pane's top edge, and opaque, so grids pass under it rather than through it.
const chrome = await page.locator('.container-chrome').evaluate((bar) => {
  const style = getComputedStyle(bar);
  return { position: style.position, top: style.top, opaque: !/rgba\(.*,\s*0\)/.test(style.backgroundColor) };
});
check(
  'the container chrome is pinned over the scrolling grids',
  chrome.position === 'sticky' && chrome.top === '0px' && chrome.opaque,
  JSON.stringify(chrome),
);

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

const tooltip = page.locator(ITEM_TIP);

// A panel waits before it appears, and the point of the wait is what does *not*
// happen: a pointer crossing the pane on its way somewhere else passes over a
// dozen items, and without the delay each one would flash a panel.
await clearTip();
const passingCells = page.locator('.item-cell');
for (const i of [0, 1, 2, 3]) await passingCells.nth(i).hover();
check('a pointer passing over items opens nothing', (await tooltip.count()) === 0);
// Resting is what asks for one.
await passingCells.nth(3).hover();
await page.waitForTimeout(60);
check('and nothing has appeared a third of the way into the delay', (await tooltip.count()) === 0);
await page.waitForTimeout(OPEN_DELAY_MS + 140);
check('but resting on one opens it', (await tooltip.count()) === 1);
await clearTip();

// The whole face, not the 46 px of icon in it: the name is what the eye lands
// on and what the pointer goes to.
await showTip(page.locator('.slot-row .face-name').first());
check('hovering an item *name* shows its tooltip', (await tooltip.count()) === 1);
check('and so does its icon', await (async () => {
  await clearTip();
  await showTip(page.locator('.slot-row .face-art').first());
  return (await tooltip.count()) === 1;
})());
check('the tooltip names its stats', (await tooltip.innerText()).includes('Resistance'));
check('and colours them by type', (await page.locator(`${ITEM_TIP} [class*="stat-"]`).count()) > 0);

// The panel is a hover target of its own: a long stat block is worth reading at
// leisure, and worth selecting out of. It sits 8 px below the card, so this is
// also the check that the close is delayed — an immediate one would fire in the
// gap and the panel would be gone before the pointer arrived.
const tipTitle = await tooltip.locator('.tooltip-title').innerText();
const tipBox = await tooltip.boundingBox();
await page.mouse.move(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);
await page.waitForTimeout(400);
// The *same* panel, not merely one: a panel that passes the pointer through
// hands it to whatever is underneath, which opens that item's panel instead.
check(
  'the pointer can move onto the panel without it closing',
  (await tooltip.count()) === 1 && (await tooltip.locator('.tooltip-title').innerText()) === tipTitle,
  tipTitle,
);
check('and its text can be selected', await tooltip.evaluate((e) => getComputedStyle(e).userSelect === 'text'));
// The card the panel describes stays lit while the panel is up, including now
// that the pointer is on the panel and not on the card. Without it the card and
// its copy in the container grid both went dark under the reader mid-sentence.
check('the card stays lit while the pointer is on the panel', (await page.locator('.item-face.highlighted, .item-cell.highlighted').count()) >= 1);

// And the wheel still works over it. The panel takes pointer events and is
// portaled to the body, so without forwarding it was a dead spot: the wheel
// reached neither the panel (nothing to scroll) nor the pane it was covering.
const paneTop = await page.locator('.pane-loadout').evaluate((el) => el.scrollTop);
await page.mouse.move(tipBox.x + tipBox.width / 2, tipBox.y + tipBox.height / 2);

// A gesture-sized delta first: a trackpad is applied 1:1, exactly as the pane
// itself would apply it, so once it has settled the panel is back beside its
// card with nothing in flight to race the measurement.
await page.mouse.wheel(0, 24);
await page.waitForTimeout(250);
const nudged = await page.locator('.pane-loadout').evaluate((el) => el.scrollTop);
check('a gesture over the panel scrolls the pane 1:1', nudged === paneTop + 24, `${paneTop} → ${nudged}`);
const followed = await page.evaluate(() => {
  const card = document.querySelector('.slot-row .slot-current .item-face').getBoundingClientRect();
  const tip = document.querySelector('.tooltip:not(.action-tooltip)').getBoundingClientRect();
  return Math.round(tip.top - card.bottom);
});
check('and the panel comes with its card', followed >= 0 && followed <= 12, `${followed}px below it`);

// A mouse notch is the other device, and the browser treats it differently over
// an ordinary scroller: one ~100 px event, *animated*. Forwarding it unchanged
// landed the whole delta in a single frame, which is what read as clunky beside
// the container next to it.
await page.mouse.wheel(0, 220);
await page.waitForTimeout(20);
const partway = await page.locator('.pane-loadout').evaluate((el) => el.scrollTop);
await page.waitForTimeout(500);
const paneMoved = await page.locator('.pane-loadout').evaluate((el) => el.scrollTop);
check('a notch over the panel scrolls it too', paneMoved > nudged, `${nudged} → ${paneMoved}`);
check(
  'and eases rather than jumping the whole delta at once',
  partway > nudged && partway < paneMoved,
  `${nudged} → ${partway} (one frame) → ${paneMoved}`,
);
// Whether a panel is still up after *this* scroll is deliberately not asserted:
// 220 px slides the card out from under the pointer, which may then be over
// another item — or over nothing, which closes the panel and is correct. The
// gesture check above is where "the panel survives a scroll" is pinned.

// It is not sticky, though: leaving it closes it on the same short delay.
await page.mouse.move(5, 5);
await page.waitForTimeout(400);
check('and leaving it closes the panel', (await tooltip.count()) === 0);

// The slot label is a hover target too.
await clearTip();
await showTip(page.locator('.slot-name').first());
check('hovering a slot label shows the equipped item', (await tooltip.count()) === 1);

// The panel opens *below* the card it describes, left-aligned with it. A
// loadout row is a comparison two cards wide, and a panel opening to the side
// of either card lands on the other one — the very item being compared against.
const boxes = [];
for (const sel of ['.slot-current .face-art', '.slot-current .face-name', '.slot-current .socket-chip.filled']) {
  await clearTip();
  await showTip(page.locator(`.slot-row:first-child ${sel}`).first());
  boxes.push(
    await page.evaluate(() => {
      const card = document.querySelector('.slot-row .slot-current .item-face').getBoundingClientRect();
      const other = document.querySelector('.slot-row .slot-proposed').getBoundingClientRect();
      const tip = document.querySelector('.tooltip:not(.action-tooltip)').getBoundingClientRect();
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
  await clearTip();
  const before = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
  await showTip(card);
  const after = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
  check(`pointing at ${what} lights the card`, before !== after, `${before} -> ${after}`);
  lit.push(after);
}
// One highlight, whatever caused it: what the advice says about an item is
// carried by the row border and the corner flag, not by a second brightness.
check('every card lights the same way', new Set(lit).size === 1, [...new Set(lit)].join(' / '));
await clearTip();

// A socket move proposes the *same item*, so its proposal card is lit by its own
// id — which is the case that was missing: the card went dark the moment the
// pointer moved onto the panel describing it, because the only thing lighting it
// was the extraction source.
for (const [what, sel] of [
  ['a swapped component', '.slot-row.verdict-swap-component'],
  ['a changed augment', '.slot-row.verdict-re-augment'],
]) {
  await clearTip();
  const row = page.locator(sel).first();
  await showTip(row.locator('.slot-proposed .face-name'));
  const box = await page.locator(ITEM_TIP).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  // Exactly one. Both cards of a socket-move row carry the same document id, so
  // an id-based highlight lit the pair — which reads as "this whole row" where the
  // reader pointed at one side of a comparison.
  const lit = await row.locator('.item-face.highlighted').count();
  check(`${what} keeps its own card lit, and only that one`, lit === 1, `${lit} lit`);
}
await clearTip();

// A component gets its own panel, not the host item's — and its *name* is as
// much a hover target as its icon, which is the half the pointer usually lands
// on. The pointer arrives here straight off the item's own art, which is the
// path that has to keep working.
await page.locator('.slot-current .face-art').first().hover();
await page.waitForTimeout(120);
await showTip(page.locator('.slot-current .socket-chip.filled .socket-name').first());
const chipTip = await tooltip.innerText();
check('hovering a component name shows the component', chipTip.includes('Component'), chipTip.split('\n')[0]);
check('and its stats keep their type colours', (await page.locator(`${ITEM_TIP} [class*="stat-"]`).count()) > 0);

// A component's granted skill belongs to the component: it arrives with it and
// leaves with it, and a SWAP-COMPONENT is exactly the move that takes it away.
// It used to be lifted into the host item's block, which left a component whose
// whole point is the buff describing itself as one stat line.
await clearTip();
await showTip(page.locator('.slot-row', { hasText: 'MAIN HAND' }).locator('.socket-chip.filled .socket-name').first());
const grantTip = await tooltip.innerText();
check('a component that grants a skill says so itself', /Grants: Might of Empyrion/.test(grantTip), grantTip.split('\n')[0]);
check('and how the skill is obtained', /toggle/.test(grantTip));
// And says it once: the host's own granted-skill block must not repeat it.
await clearTip();
await showTip(page.locator('.slot-row', { hasText: 'MAIN HAND' }).locator('.slot-current .face-art'));
const hostTip = await tooltip.innerText();
check('the host names it under the component', /Component: Seal of Might/.test(hostTip));
check('and states the grant exactly once', (hostTip.match(/Might of Empyrion/g) ?? []).length === 1, hostTip.match(/Might of Empyrion/g)?.length + '×');

// The socketable block inside a *whole item's* tooltip is stats too. It was
// being flattened to the body colour by a rule meant for granted skills.
await clearTip();
await showTip(page.locator('.slot-current .face-art').first());
check(
  'a component block inside an item tooltip is coloured too',
  (await page.locator(`${ITEM_TIP} .tooltip-socketable [class*="stat-"]`).count()) > 0,
);

// A damage-over-time type is its own stat, so it is its own shade — the same
// family as its parent, not the same colour.
await clearTip();
await showTip(page.locator('.slot-row', { hasText: 'OFF HAND' }).locator('.face-name').first());
const dot = await page.locator(`${ITEM_TIP} .stat-burn, ${ITEM_TIP} .stat-fire`).evaluateAll((els) =>
  els.map((e) => [e.textContent.trim(), getComputedStyle(e).color]),
);
check('a DoT type and its parent are both coloured', dot.length === 2, JSON.stringify(dot));
check('and not with the same colour', dot.length === 2 && dot[0][1] !== dot[1][1]);

// ---------------------------------------------------------------------------
// The character sheet
// ---------------------------------------------------------------------------

await clearTip();

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

await columnTab('Advice');
await page.locator('.advice-tabs .tab', { hasText: 'Full answer' }).click();
await page.waitForTimeout(150);
check('the answer tab renders the prose', (await page.locator('.markdown').count()) === 1);
// And not the plan block that ends it. Every field in that block has already been
// rendered on the Plan tab as something hoverable; as raw JSON it was 17k of the
// first live answer's 28k, which buries the argument the run was actually for.
const proseText = await page.locator('.advice-answer').innerText();
check('and not the machine-readable plan it ends with', !/"verdicts"\s*:/.test(proseText), `${proseText.length} chars`);
check('which is still on the Plan tab', proseText.length > 200);
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

// The ladder. §12 of the dossier costs every threshold; a costing with no verdict
// on it is not advice, and two of the four entries on the first live run were
// "skip this" — a recommendation that exists nowhere else.
const steps = await page.locator('.next-levels li').allInnerTexts();
check('the plan tab carries the next-levels ladder', steps.length === 2, steps.join(' | ').replace(/\n/g, ' '));
check('each threshold says whether it is worth committing to', /Skip/.test(steps.join(' ')));
const unlocks = await page.locator('.next-levels .level-unlocks').first().innerText();
check('and names what it unlocks, by name rather than by id', !/#/.test(unlocks), unlocks);
// Hovering one lights everything it unlocks, wherever those items live.
await page.locator('.next-levels li').first().hover();
await page.waitForTimeout(120);
check('hovering a threshold lights what it unlocks', (await page.locator('.item-cell.highlighted').count()) >= 1);
await page.mouse.move(4, 4);
await page.waitForTimeout(120);

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
await showTip(materialRows.nth(2));
check('hovering a material row shows its tooltip', (await tooltip.count()) === 1);
check(
  'a quest item that is also a reagent says both',
  (await page.locator('.material-row', { hasText: 'Ancient Heart' }).count()) === 1,
);

// A loose component's own panel states where it can go — the same "use-on"
// line its chip shows once installed. It used to appear only on the installed
// copy, where the question has already been answered.
await clearTip();
await showTip(page.locator('.material-row', { hasText: 'Manticore Eye' }));
const materialTip = await page.locator('.tooltip:not(.action-tooltip)').innerText();
check('a loose component says what it can be used on', /use-on: any armor/.test(materialTip), materialTip.replace(/\n/g, ' — ').slice(0, 120));
await clearTip();

// ---------------------------------------------------------------------------
// Without advice, and the states that are easy to forget
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--before-advice'), { waitUntil: 'networkidle' });
const locked = await page.locator('.face-locked.waiting').count();
check('without advice every proposal slot reads as locked', locked === 14, `${locked} locked`);
check('and says what would fill it', (await page.locator('.loadout-hint').count()) === 1);
check('the header offers the run', (await page.locator('.chrome-button.primary').innerText()).includes('Run advice'));
// The question box belongs to the run that is about to start, and it lives in
// the advice panel — one tab over from the loadout the column opens on.
await columnTab('Advice');
check('and the question box is offered with it', (await page.locator('.advice-question').count()) === 1);
// Nothing to put away yet, and — with no stored runs for this character — nothing
// to pick between either.
check(
  'with nothing to put away',
  (await page.locator('.header-advice .chrome-button.subtle').count()) === 0 &&
    (await page.locator('.advice-panel .run-button.subtle').count()) === 0,
);
check('and — no stored runs — nothing to pick between', (await page.locator('.advice-runs').count()) === 0);
await columnTab('Loadout');

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

// ---------------------------------------------------------------------------
// A run in flight — the state the app spends the most time in
// ---------------------------------------------------------------------------

await page.goto(story('app-workspace--advice-running'), { waitUntil: 'networkidle' });
await page.waitForTimeout(200);
// A run starting opens the Advice tab by itself — the transcript is what there
// is to watch — and the strip says a run is alive in there from the other tab.
check(
  'a run in flight opens the Advice tab by itself',
  (await page.locator('.advice-panel').count()) === 1 && (await page.locator('.loadout-grid').count()) === 0,
);
check('and the Advice tab carries a live dot', (await page.locator('.column-tabs .tab-running').count()) === 1);
const phase = await page.locator('.run-phase').innerText();
check('a run in flight says which phase it is in', phase === 'asking the model', phase);
const clock = await page.locator('.run-clock').innerText();
// Four minutes in, not zero: "0:03" and "4:07" are read completely differently,
// and the clock has to be the run's age rather than this renderer's.
check('and how long it has been going', /^4m 0\ds$/.test(clock), clock);
check('and offers a way out', await page.locator('.run-button.cancel').isEnabled());
check('the run button is not offered twice', (await page.locator('.advice-panel .run-button:not(.cancel)').count()) === 0);
check('the header agrees a run is in flight', (await page.locator('.chrome-button.primary').innerText()).includes('Thinking'));
// The toggle configures the *next* run's dossier; mid-run it can only mislead,
// so it waits.
check('the stash toggle waits for the next run', await page.locator('.include-stash input').isDisabled());
// No invented percentage anywhere: the call is one opaque subprocess that reports
// nothing until it returns, and a bar stuck at 40% teaches distrust of the panel.
check('and nothing pretends to know how far along it is', (await page.locator('.advice-panel progress, .advice-panel .progress-bar').count()) === 0);
// The question box is for the *next* run; while one is live there is nothing to
// steer.
check('the question box is out of the way while running', (await page.locator('.advice-question').count()) === 0);

// What the backend *will* tell us. The phase label says "asking the model" for ten
// minutes either way, so it cannot distinguish a working run from a wedged one —
// and the streamed reasoning both can and is worth reading in its own right, being
// about the reader's own gear. Kept **whole**, not as a tail: "why did it decide
// that" is a question the finished answer routinely raises and does not answer.
const hasLog = (await page.locator('.activity-log').count()) === 1;
check('a streaming run shows what the model is writing', hasLog);
const logKind = hasLog ? await page.locator('.activity-log .activity-kind').innerText() : '';
check('and says whether it is reasoning or answering', /reasoning/i.test(logKind), logKind);
const written = hasLog ? await page.locator('.run-activity').innerText() : '';
check('with a token count rather than a percentage', /21,480 tokens/.test(written), written);
// Expanded while the run is live, because that is when it is progress; the whole
// transcript is there, not the last few hundred characters of it.
const logBox = hasLog
  ? await page.locator('.activity-log .activity-text').evaluate((el) => ({
      chars: el.textContent.length,
      height: Math.round(el.getBoundingClientRect().height),
      scrolls: el.scrollHeight > el.clientHeight + 1,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 30,
    }))
  : { chars: 0, height: 0, scrolls: false, atBottom: false };
check('the whole transcript is there, not a tail', logBox.chars > 1500, `${logBox.chars} chars`);
// A **capped** height that scrolls: the text arrives several times a second, and a
// box that sized itself to its contents would reflow the panel — and the loadout
// above it — continuously for twelve minutes.
check('in a box whose height does not depend on it', logBox.height <= 190 && logBox.scrolls, JSON.stringify(logBox));
check('scrolled to the newest line while the run is live', logBox.atBottom, JSON.stringify(logBox));
// And it collapses to one line, so a finished run's reasoning is available without
// being in the way of the answer it produced.
if (hasLog) {
  await page.locator('.activity-head').click();
  await page.waitForTimeout(150);
  check('clicking the header collapses it', (await page.locator('.activity-text').count()) === 0);
  const peek = await page.locator('.activity-peek').innerText();
  check('leaving the newest line visible', peek.trim().length > 20, peek.slice(0, 60));
}

// The same thing as its own story, on the panel alone.
//
// Because in the workspace it is *below the fold*: the advice panel sits under a
// fourteen-row loadout, so at 1080 the transcript is off the bottom of the
// screenshot — which is exactly as much use as not having a story for it.
await page.goto(story('parts--advice-thinking'), { waitUntil: 'networkidle' });
await page.waitForTimeout(200);
check('the reasoning has a story of its own', (await page.locator('.activity-log.open').count()) === 1);
const partsLog = await page.locator('.activity-text').innerText();
check('showing the whole transcript', partsLog.length > 1500, `${partsLog.length} chars`);

// And after the run: collapsed, not gone. `open = pinned ?? running` is what makes
// the box follow the run without arguing with a reader who has an opinion.
await page.goto(story('parts--advice-thinking-done'), { waitUntil: 'networkidle' });
await page.waitForTimeout(200);
check('once the answer is in, the reasoning is one line', (await page.locator('.activity-log:not(.open)').count()) === 1);
check('and out of the way of the plan', (await page.locator('.activity-text').count()) === 0);
check('but still reachable', (await page.locator('.activity-head').count()) === 1);
await page.locator('.activity-head').click();
await page.waitForTimeout(150);
check('a click reopens it', (await page.locator('.activity-text').count()) === 1);

// A refused start is the readable half of this feature. It must be a sentence in
// the panel, never a blank pane.
await page.goto(story('app-workspace--advice-failed'), { waitUntil: 'networkidle' });
await page.waitForTimeout(200);
// A refusal never becomes a run, so the run-follows-tab rule cannot surface it;
// the error does so itself — a sentence on a hidden tab explains nothing.
check('a refusal surfaces the Advice tab by itself', (await page.locator('.advice-panel').count()) === 1);
const failure = await page.locator('.advice-error').innerText();
check('a refused run explains itself in the panel', /claude CLI not found/.test(failure), failure);
check('and the run can still be started', await page.locator('.advice-panel .run-button').isEnabled());

// Ids the current save no longer has. An item quietly missing from the advice
// looks exactly like advice that never mentioned it.
await page.goto(story('parts--advice-stale'), { waitUntil: 'networkidle' });
const staleNote = await page.locator('.advice-stale').innerText();
check('a stale id is named rather than dropped', /Mythical Ashfallen Visor/.test(staleNote), staleNote.replace(/\n/g, ' '));
check('and the fix is stated', /Re-run/.test(staleNote));

// ---------------------------------------------------------------------------
// A run the user has partly acted on
// ---------------------------------------------------------------------------

// The distinction the panel exists to draw: **carrying the advice out is what
// makes the loadout differ from it**. A single "is it stale" bit would call this
// answer stale as its reward for being followed, and discarding the stored run on
// any mismatch — the design that suggests itself next — would delete a
// twelve-minute answer at the moment the user did what it said.
await page.goto(story('app-workspace--advice-after-acting'), { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
// Counted before it is read: a missing note must fail this check rather than hang
// it waiting for an element that is never coming.
const hasDone = (await page.locator('.advice-done').count()) === 1;
check('a move already made is reported as done', hasDone);
const doneNote = hasDone ? await page.locator('.advice-done').innerText() : '';
check('and names the slot and what is in it now', /Hands now holds/.test(doneNote), doneNote.replace(/\n/g, ' '));
const hasDrift = (await page.locator('.advice-drift').count()) === 1;
check('a slot the plan did not ask about gets its own note', hasDrift);
const driftNote = hasDrift ? await page.locator('.advice-drift').innerText() : '';
check(
  'a slot the plan did not ask about is reported separately',
  /changed since this run/i.test(driftNote),
  driftNote.replace(/\n/g, ' '),
);
check('and named, so the reader knows which verdicts to ignore', /Feet/.test(driftNote));
// The answer is still there. Most of a fourteen-slot plan survives one slot moving.
await columnTab('Advice');
check('the plan is still shown', (await page.locator('.verdict-table').count()) === 1);
const struck = await page.locator('.verdict-table tbody.done').count();
check('with the finished row struck through rather than removed', struck === 1, `${struck} struck`);
await columnTab('Loadout');
// And in the loadout, where the same item now sits on both sides of the row: an
// unmarked EQUIP there reads as "equip the item you are already wearing".
const doneTag = await page.locator('.slot-row.done .verdict-tag').count();
check('and the loadout row no longer reads as an instruction', doneTag === 1, `${doneTag} marked`);

// Stamped under the slot name, where the eye starts on a row, and stamped with a
// glyph as well as a word: a tick and a warning triangle are recognisable in an
// 84 px column without reading, and the word settles which of the two it is.
const stamps = await page
  .locator('.slot-state')
  .evaluateAll((els) =>
    els.map((e) => ({
      text: e.textContent.trim(),
      glyph: e.querySelector('svg') !== null,
      bordered: getComputedStyle(e).borderTopWidth !== '0px',
    })),
  );
check('each affected slot is stamped', stamps.length === 2, JSON.stringify(stamps));
check('DONE and CHANGED are told apart', stamps.map((x) => x.text).sort().join(',') === 'CHANGED,DONE');
check('each stamp carries a glyph', stamps.every((x) => x.glyph));
check('and a border, so it reads as a stamp not a third line of the name', stamps.every((x) => x.bordered));

// ---------------------------------------------------------------------------
// The landing state: answers kept, none of them open
// ---------------------------------------------------------------------------

// The window no longer reopens the newest answer by itself — that put a stale
// plan's marks on the gear before the reader had asked for them. So the picker is
// the *door*, it lives in the header and only there, and the empty state has to
// say the old answers are still behind it, or starting fresh reads as having
// lost them.
await page.goto(story('app-workspace--advice-nothing-open'), { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check('nothing is open on arrival', (await page.locator('.verdict-table').count()) === 0);
// The story opens on the Advice tab (it is about the empty state's own words);
// the locked column is the loadout's half of the same fact.
await columnTab('Loadout');
check('and the proposal column reads as locked', (await page.locator('.face-locked.waiting').count()) === 14);
check('with no marks on the containers', (await page.locator('.item-cell.action').count()) === 0);
await columnTab('Advice');
const doorOptions = await page.locator('.app-header .advice-runs option').allInnerTexts();
check('the stored answers are one click away', doorOptions.length === 3, doorOptions.join(' | '));
// The fresh session is a real entry, not a "N saved answers" placeholder: it is
// the state the window is in, so the list reads as what it is — New run, then
// every answer already paid for.
check('and the fresh session leads the list', (doorOptions[0] ?? '').trim() === 'New run', doorOptions[0] ?? '(none)');
check('with no second picker in the panel', (await page.locator('.advice-panel .advice-runs').count()) === 0);
const keptNote = await page.locator('.advice-kept').innerText();
check('the panel says they are kept', /2 earlier answers are kept/.test(keptNote), keptNote);
check('and points at the top bar', /top bar/.test(keptNote), keptNote);
check('the run is offered', (await page.locator('.advice-panel .run-button:not(.cancel)').count()) === 1);
check('and there is nothing to put away yet', (await page.locator('.run-button.subtle').count()) === 0);
// The stash toggle rides with the Run button: it configures the question the
// next run asks, and its default is *include* — the first live run's three best
// finds were all in the stash.
check('the stash toggle is offered with the run', (await page.locator('.include-stash input').count()) === 1);
check('and defaults to include', await page.locator('.include-stash input').isChecked());

// ---------------------------------------------------------------------------
// Several stored runs
// ---------------------------------------------------------------------------

// Runs are kept rather than overwritten: each is minutes and real money, so taking
// a second opinion must not be a decision to destroy the first answer.
await page.goto(story('app-workspace--advice-history'), { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
// The picker lives in the header and only there — the panel copy was sometimes
// off screen and always a duplicate. It is **always rendered once any run
// exists**: the first version hid itself when there was "nothing to choose", and
// with exactly one stored run open that removed the way back to the empty state.
const runOptions = await page.locator('.app-header .advice-runs option').allInnerTexts();
check('stored runs get a picker, led by the fresh session', runOptions.length === 3, runOptions.join(' | '));
if (runOptions.length !== 3) runOptions.push('', '', '');
check('whose first entry is New run', (runOptions[0] ?? '').trim() === 'New run', runOptions[0]);
// The label is the run's identity. Two runs on one save differ by what was asked
// far more usefully than by two timestamps half an hour apart.
check('labelled by what was asked', /committing to bleeding/.test(runOptions[1]), runOptions[1]);
check('and by what it cost', /\$4\.16/.test(runOptions[1]));
check('the newest is marked as such', /newest/.test(runOptions[1]));
check('the open run is the selection', (await page.locator('.app-header .advice-runs').inputValue()) !== '');
// The panel shows *which* answer is open — a date — and offers no second picker.
check('the panel names its run without a second picker', (await page.locator('.advice-panel .advice-runs').count()) === 0);
check('and New run is beside the picker', (await page.locator('.header-advice .chrome-button.subtle').count()) === 1);

// One control at a time, and never both. A second opinion costs eight minutes and a
// few dollars and does *not* replace the answer beside it, so offering a Re-run next
// to a finished plan is inviting an expensive accident: asking again is two steps on
// purpose.
check('no Re-run is offered beside an answer', (await page.locator('.chrome-button.primary').count()) === 0);
check(
  'and none in the panel either',
  (await page.locator('.advice-panel .run-button:not(.cancel):not(.subtle)').count()) === 0,
);
check('the question box goes with it', (await page.locator('.advice-question').count()) === 0);

// Every control in the toolbar row on one height. Three different font sizes across
// a select and two buttons is three different heights on one baseline, which reads
// as a row that has not been laid out.
const rowHeights = await page.evaluate(() =>
  ['.field select', '.app-header .advice-runs', '.app-header .chrome-button'].map((sel) =>
    Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0),
  ),
);
check('the picker is the same height as the buttons and the selects', new Set(rowHeights).size === 1, rowHeights.join(' / '));

// It used to be `Clear`, and it used to delete the answer it sat beside — one click
// from gone, under the button a reader reaches for *after acting on the plan*. It
// says what it does now, in the window's own panel: a native `title` takes a second
// to appear, renders in the OS's style, and vanishes while being read.
await clearTip();
await page.locator('.advice-header .run-button.subtle').hover();
await page.locator('.control-note').waitFor({ state: 'visible', timeout: 3000 });
const newRunNote = await page.locator('.control-note').innerText();
check(
  'New run explains itself in a panel',
  /Put this answer away/.test(newRunNote),
  newRunNote.replace(/\n/g, ' — '),
);
check('saying nothing is deleted and nothing is spent', /Nothing is deleted and nothing is spent/.test(newRunNote));
const nativeTitle = await page.locator('.advice-header .run-button.subtle').getAttribute('title');
check('and not also in a native tooltip on top of it', nativeTitle === null, String(nativeTitle));
await page.mouse.move(4, 4);
await page.waitForTimeout(300);

// Refresh is the last step of the loop this app is for — play, come back, refresh,
// and the plan says which of its moves you have made. So its note is about the save
// and the stamps, in those words: "the item database is untouched" is a sentence for
// whoever wrote it.
await clearTip();
await page.locator('.app-header .chrome-button', { hasText: 'Refresh' }).hover();
await page.locator('.control-note').waitFor({ state: 'visible', timeout: 3000 });
const refreshNote = await page.locator('.control-note').innerText();
check('Refresh explains itself in the reader’s terms', /save file again/i.test(refreshNote), refreshNote.replace(/\n/g, ' — '));
check('naming what it picks up', /wearing/.test(refreshNote) && /bags and stashes/.test(refreshNote));
check('and what happens to the answer on screen', /stays open/.test(refreshNote) && /DONE and amber CHANGED/.test(refreshNote));
// Since the watcher this button is the belt-and-braces rather than the loop, and
// a reader pressing it and seeing nothing change deserves to know why.
check('and that the window keeps up on its own', /by itself/.test(refreshNote) && /rarely need it/.test(refreshNote));
check(
  'with no jargon from the inside of the app',
  !/dossier|envelope|snapshot|item database/i.test(refreshNote),
  refreshNote.replace(/\n/g, ' — '),
);
await page.mouse.move(4, 4);
await page.waitForTimeout(300);

await page.goto(story('app-workspace--first-boot'), { waitUntil: 'networkidle' });
check('a first boot reports progress instead of sitting blank', (await page.locator('.banner.loading').count()) === 1);
check('with a spinner', (await page.locator('.spinner').count()) === 1);

await page.goto(story('app-workspace--sparse-character'), { waitUntil: 'networkidle' });
check('a sparse character still renders every slot', (await page.locator('.slot-row').count()) === 14);
check('empty slots say so', (await page.locator('.face-empty').count()) >= 10);

// ---------------------------------------------------------------------------
// A panel taller than the screen
// ---------------------------------------------------------------------------

// A legendary with a component, an augment, granted skills and a requirement
// block can outgrow the viewport. `shift` can only keep it on screen; it cannot
// make it shorter, so the panel has to scroll inside itself — and then the wheel
// belongs to *it* rather than to the pane underneath.
await page.goto(story('app-workspace--with-advice'), { waitUntil: 'networkidle' });
await page.setViewportSize({ width: 1920, height: 320 });
await page.waitForTimeout(200);
await showTip(page.locator('.slot-row .face-name').first());
const tall = await page.locator(ITEM_TIP).evaluate((el) => ({
  scrolls: el.scrollHeight > el.clientHeight,
  onScreen: el.getBoundingClientRect().bottom <= window.innerHeight + 1,
}));
check('a panel taller than the screen scrolls inside itself', tall.scrolls, JSON.stringify(tall));
check('and stays on screen rather than running off it', tall.onScreen);
const paneBefore = await page.locator('.pane-loadout').evaluate((el) => el.scrollTop);
const tipBoxTall = await page.locator(ITEM_TIP).boundingBox();
await page.mouse.move(tipBoxTall.x + tipBoxTall.width / 2, tipBoxTall.y + tipBoxTall.height / 2);
await page.mouse.wheel(0, 120);
await page.waitForTimeout(200);
const inner = await page.locator(ITEM_TIP).evaluate((el) => el.scrollTop);
check('the wheel scrolls the panel first, not the pane', inner > 0, `panel ${inner}`);
check(
  'and leaves the pane where it was',
  (await page.locator('.pane-loadout').evaluate((el) => el.scrollTop)) === paneBefore,
);
await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(150);

// ---------------------------------------------------------------------------
// Settings, and the context document
// ---------------------------------------------------------------------------

await page.goto(story('app-settings--pane'), { waitUntil: 'networkidle' });
await page.locator('.modal').waitFor({ state: 'visible' });

// The facts the old read-only `Paths` popover showed are still here — but now
// next to the fields that set them, which is the whole reason it moved.
const facts = await page.locator('.settings-facts').innerText();
check('settings states where the saves are being read from', facts.includes('/fixture/Steam/userdata'), facts.split('\n')[1]);
check('and the game version it resolved against', /\d+\.\d+\.\d+/.test(facts), facts);

// Detection is an offer, not a mechanism: a machine with both stores installed
// gets both, and neither is chosen for the user.
const gameOptions = await page.locator('.settings-path').nth(1).locator('.settings-found-path').allInnerTexts();
check('both installs are offered when both are found', gameOptions.length === 2, gameOptions.join(' | '));
check('and the one in use is marked', (await page.locator('.settings-found-path.current').count()) >= 1);

// A path is typed *or* picked. Committing on blur rather than per keystroke is
// what keeps `gameDir` from rebuilding the item database once per character.
const saveField = page.locator('.settings-path').first().locator('.settings-path-input');
await saveField.fill('/somewhere/nobody/could/guess');
check('typing a path does not commit it yet', (await page.locator('.settings-found-path.current').count()) >= 1);
await saveField.blur();
await page.waitForTimeout(120);
check('and blurring does', (await saveField.inputValue()) === '/somewhere/nobody/could/guess');
check(
  'after which none of the detected paths is the current one',
  (await page.locator('.settings-path').first().locator('.settings-found-path.current').count()) === 0,
);
// `Auto` is how a hand-typed path is given back to detection — it appears only
// once there is a pinned value to clear.
await page.locator('.settings-path').first().locator('.chrome-button').click();
await page.waitForTimeout(120);
check('Auto hands the path back to detection', (await saveField.inputValue()) === '');

// Every locale the *install* ships, not every locale the game has.
const locales = await page.locator('.settings-section').nth(1).locator('option').count();
check('the language list is what this install ships', locales === 8, `${locales} option(s)`);

// Always-on-top is a setting rather than window state, so it round-trips
// through the same file every other preference does.
const onTop = page.locator('.settings-check input');
check('always-on-top starts off', (await onTop.isChecked()) === false);
await onTop.check();
check('and can be turned on', await onTop.isChecked());

await page.goto(story('app-settings--pane-with-nothing-found'), { waitUntil: 'networkidle' });
await page.locator('.modal').waitFor({ state: 'visible' });
check(
  'with nothing detected the fields are still the way in',
  (await page.locator('.settings-found-path').count()) === 0 &&
    (await page.locator('.settings-path-input').count()) === 2,
);

await page.goto(story('app-settings--context-document'), { waitUntil: 'networkidle' });
// Rendered first: thirty thousand tokens of headings and resistance tables are a
// wall of pipes as plain text, and the tables are most of what is worth reading.
await page.locator('.context-rendered').waitFor({ state: 'visible' });
check('the context viewer opens rendered', (await page.locator('.context-rendered .md-h').count()) > 0);
check('with the document’s tables as tables', (await page.locator('.context-rendered .md-table').count()) > 0);
// And raw is one click, because the document's exact bytes are the contract the
// advice-to-item join rests on — a viewer that could only show a rendering would
// be showing something the model never received.
await page.locator('.view-tabs .tab', { hasText: 'Raw' }).click();
await page.locator('.context-document').waitFor({ state: 'visible' });
const docText = await page.locator('.context-document').innerText();
check('and raw shows the bytes that are actually sent', docText.includes('# Grim Dawn character dossier'));
check('with no markup of its own', (await page.locator('.context-document h1').count()) === 0);
// The switch sits in the sheet's chrome next to Close, on the same 30 px line.
const heights = await page.locator('.modal-head').evaluate((head) => ({
  tab: head.querySelector('.view-tabs .tab').getBoundingClientRect().height,
  close: head.querySelector('.chrome-button').getBoundingClientRect().height,
}));
check('the view switch lines up with Close', heights.tab === heights.close, JSON.stringify(heights));
const docSubtitle = await page.locator('.modal-subtitle').innerText();
check('with the difficulty it was built for', docSubtitle.includes('Ultimate'), docSubtitle);
check('and whether the stashes are in it', docSubtitle.includes('stashes included'), docSubtitle);

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
