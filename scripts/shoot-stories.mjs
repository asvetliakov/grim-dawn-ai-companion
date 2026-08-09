/**
 * Screenshot every story.
 *
 * The point is a look at the real UI without an Electron window: Storybook
 * serves the components in a browser, Playwright opens each story's iframe at
 * the window's own size and writes a PNG. That is the whole review loop —
 * change a component, re-shoot, look.
 *
 * Usage: `npm run stories:shoot [outputDir]` with Storybook already running on
 * :6006, or `npm run stories:check`, which builds a static Storybook and shoots
 * that instead (no server to leave behind).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.STORYBOOK_URL ?? 'http://localhost:6006';
const outDir = resolve(process.argv[2] ?? 'out/screenshots');
/** The window's own size, so a screenshot shows what the app shows. */
const VIEWPORT = { width: 1920, height: 1080 };

/**
 * The layout has three arrangements — three columns, two, and stacked — and
 * they are chosen by media query, so the only way to see them is to resize the
 * page. One story is shot at all three; the rest at the window's own size.
 */
const RESPONSIVE_STORY = 'app-workspace--with-advice';
const WIDTHS = [
  { label: '3col', width: 1920, height: 1080 },
  { label: '2col', width: 1500, height: 1000 },
  { label: '1col', width: 1100, height: 1000 },
];

function storyIds() {
  // Storybook writes the full index next to the static build; served mode
  // exposes the same file. Reading it beats hardcoding a list that drifts.
  const local = join(outDir, '..', 'storybook', 'index.json');
  try {
    return Object.values(JSON.parse(readFileSync(local, 'utf8')).entries)
      .filter((e) => e.type === 'story')
      .map((e) => e.id);
  } catch {
    return undefined;
  }
}

async function fetchIds() {
  const fromDisk = storyIds();
  if (fromDisk) return fromDisk;
  const res = await fetch(`${base}/index.json`);
  if (!res.ok) throw new Error(`cannot read ${base}/index.json — is Storybook running?`);
  const index = await res.json();
  return Object.values(index.entries)
    .filter((e) => e.type === 'story')
    .map((e) => e.id);
}

const ids = await fetchIds();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

const problems = [];
page.on('pageerror', (err) => problems.push(`${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(msg.text());
});

for (const id of ids) {
  problems.length = 0;
  await page.goto(`${base}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(250);
  const sizes = id === RESPONSIVE_STORY ? WIDTHS : [null];
  for (const size of sizes) {
    if (size) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.waitForTimeout(150);
    }
    const file = join(outDir, `${id}${size ? `--${size.label}` : ''}.png`);
    // Full page for the part stories (which are taller than the viewport) and
    // viewport-sized for the workspace ones, where the point is the fit.
    await page.screenshot({ path: file, fullPage: !id.startsWith('app-workspace') });
    console.log(`${file}${problems.length ? `  ⚠ ${problems.length} console error(s): ${problems[0]}` : ''}`);
  }
  await page.setViewportSize(VIEWPORT);
  if (problems.length) process.exitCode = 1;
}

await browser.close();
console.log(`\n${ids.length} story screenshot(s) in ${outDir}`);
