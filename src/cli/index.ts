#!/usr/bin/env tsx
/**
 * Dev CLI for the Grim Dawn companion core.
 *
 * This is how `src/core` gets exercised without Electron in the loop — every
 * stage adds a command here. Run with `npm run cli -- <command>`.
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';

import {
  buildContextDoc,
  documentSocketables,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PER_GROUP,
  type ContextDoc,
  type ContextInput,
} from '../core/context/builder.js';
import {
  adviseWithRepair,
  buildEnvelope,
  wornSlots,
  wornSocketables,
  createProvider,
  verdictRows,
  normalizeName,
  providerIds,
  repairEffort,
  totalUsage,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  type AdvisorPlan,
  type PlanWarning,
} from '../core/ai/index.js';
import { findGameDirs } from '../core/db/gamefiles.js';
import { loadGameDb } from '../core/db/index.js';
import { REP_TIERS, type GameDb, type SpeedCaps } from '../core/db/types.js';
import { createIconService, readPngSize } from '../core/icons/index.js';
import { aggregateCharacter, type CharacterAggregate } from '../core/mechanics/aggregate.js';
import { RESIST_COLUMNS, type ResistVector } from '../core/mechanics/stats.js';
import { characterSavePath, formulasPath, reagentsPath, transferStashPath } from '../core/paths.js';
import {
  CoverageTracker,
  resolveCharacter,
  shortHash,
  type ResolvedCharacter,
  type ResolvedItem,
} from '../core/resolve.js';
import {
  accountFiles,
  adviceScope,
  loadSnapshot,
  readSave as coreReadSave,
  requireDifficulty,
  SessionError,
} from '../core/session.js';
import { findSaveDirs, listCharacters, resolveSettings } from '../core/settings.js';
import { createSaveWatcher } from '../core/watcher.js';
import { parseGdc } from '../core/save/gdc.js';
import { parseFormulasFile, parseReagents, parseTransferStash, type TransferStash } from '../core/save/gst.js';
import {
  EQUIP_SLOT_NAMES,
  parseDifficulty,
  type BlockReport,
  type CharacterSave,
  type Difficulty,
} from '../core/save/types.js';

const program = new Command();

program
  .name('gd')
  .description('Grim Dawn companion — development CLI')
  .version('0.1.0');

/**
 * Anything the session layer reports as a typed failure becomes a one-line
 * message and a non-zero exit. A missing save is an ordinary situation (the
 * user has not played that mode, or the path is wrong) and should read as one,
 * not as a stack trace — the window, which has no `process.exit`, catches the
 * same errors and shows them in place.
 */
function orExit<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SessionError) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function readSave(path: string): Buffer {
  return orExit(() => coreReadSave(path));
}

function formatPlayTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function countItems(save: CharacterSave): { equipped: number; inventory: number; stash: number } {
  return {
    equipped: save.equipment.filter((e) => e !== null).length,
    inventory: save.inventorySacks.reduce((n, sack) => n + sack.length, 0),
    stash: save.personalStash.reduce((n, tab) => n + tab.items.length, 0),
  };
}

function shortRecord(record: string): string {
  return record.replace(/^records\/items\//, '').replace(/\.dbr$/, '');
}

function printParse(save: CharacterSave): void {
  const counts = countItems(save);

  console.log(`${save.name} — level ${save.level} ${save.hardcore ? '(hardcore)' : ''}`);
  console.log(`  class record   ${save.classRecord}`);
  console.log(`  difficulty     ${save.difficulty} (greatest completed: ${save.greatestDifficultyCompleted})`);
  console.log(`  iron           ${save.iron.toLocaleString('en-US')}`);
  console.log(`  tributes       ${save.tributes}`);
  console.log(`  play time      ${formatPlayTime(save.playStats.playTimeSeconds)}, ${save.playStats.deaths} deaths, ${save.playStats.kills.toLocaleString('en-US')} kills`);
  console.log(`  save format    header v${save.headerVersion}, data v${save.dataVersion}, expansions 0x${save.expansionStatus.toString(16)}`);

  const a = save.attributes;
  console.log('\nAttributes');
  console.log(`  physique ${a.physique}   cunning ${a.cunning}   spirit ${a.spirit}`);
  console.log(`  health ${a.health}   energy ${a.energy}   xp ${a.experience.toLocaleString('en-US')}`);
  console.log(`  unspent: ${a.attributePoints} attribute, ${a.skillPoints} skill, ${a.devotionPoints} devotion (${a.totalDevotionPoints} total earned)`);

  console.log('\nEquipment');
  save.equipment.forEach((item, i) => {
    const slot = (EQUIP_SLOT_NAMES[i] ?? `Slot ${i}`).padEnd(10);
    if (!item) {
      console.log(`  ${slot} —`);
      return;
    }
    const extras: string[] = [];
    if (item.relicName) extras.push(`component: ${shortRecord(item.relicName)}`);
    if (item.augmentName) extras.push(`augment: ${shortRecord(item.augmentName)}`);
    console.log(`  ${slot} ${shortRecord(item.baseName)}${extras.length ? `  [${extras.join(', ')}]` : ''}`);
  });

  const printSet = (label: string, set: CharacterSave['weaponSet1']) => {
    const held = set.map((w) => (w ? shortRecord(w.baseName) : '—')).join(' + ');
    console.log(`  ${label.padEnd(10)} ${held}`);
  };
  console.log('\nWeapon sets');
  printSet('Set 1', save.weaponSet1);
  printSet('Set 2', save.weaponSet2);

  const unlocked = save.factions.filter((f) => f.unlocked);
  console.log(`\nFactions (${unlocked.length} unlocked of ${save.factions.length} slots)`);
  for (const f of unlocked) {
    const label = (f.name ?? `faction ${f.id}`).padEnd(30);
    console.log(`  ${String(f.id).padStart(2)}  ${label} ${String(Math.round(f.value)).padStart(7)}  ${f.tier}`);
  }

  console.log('\nCounts');
  console.log(`  equipped ${counts.equipped}/12, inventory ${counts.inventory} across ${save.inventorySacks.length} sacks, stash ${counts.stash} across ${save.personalStash.length} tabs`);
  console.log(`  skills ${save.skills.length}, devotions ${save.devotions.length}, masteries allowed ${save.masteriesAllowed}`);

  console.log('\nBlocks');
  for (const b of save.blocks) {
    const status = b.status === 'parsed' ? 'ok (checksum)' : `skipped${b.note ? ` (${b.note})` : ''}`;
    const flag = b.checksumOk ? '' : '  << checksum NOT verified';
    console.log(`  block ${String(b.id).padStart(2)}: ${status}${flag}   ${b.length} bytes`);
  }

  const unverified = save.blocks.filter((b) => !b.checksumOk);
  console.log(
    `\n${save.blocks.length} blocks, ${save.blocks.filter((b) => b.checksumOk).length} checksum-verified` +
      (unverified.length ? `, ${unverified.length} UNVERIFIED` : ''),
  );

  if (save.warnings.length) {
    console.log('\nWarnings');
    for (const w of save.warnings) console.log(`  ! ${w}`);
  }
}

program
  .command('parse')
  .description('parse a player.gdc and print a character summary + block checksum report')
  .argument('<path>', 'path to player.gdc')
  .option('--json', 'emit the parsed save as JSON instead of a summary')
  .action((path: string, opts: { json?: boolean }) => {
    const save = parseGdc(readSave(path), { path });
    if (opts.json) {
      console.log(JSON.stringify(save, null, 2));
      return;
    }
    printParse(save);
    if (save.blocks.some((b) => !b.checksumOk)) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// Stage 2 — the shared .gst files
// ---------------------------------------------------------------------------

function printBlocks(blocks: BlockReport[]): void {
  console.log('\nBlocks');
  for (const b of blocks) {
    const status = b.status === 'parsed' ? 'ok (checksum)' : `skipped${b.note ? ` (${b.note})` : ''}`;
    const flag = b.checksumOk ? '' : '  << checksum NOT verified';
    console.log(`  block ${String(b.id).padStart(2)}: ${status}${flag}   ${b.length} bytes`);
  }
}

function printStash(stash: TransferStash): void {
  const total = stash.sacks.reduce((n, s) => n + s.items.length, 0);
  console.log(`Transfer stash — ${stash.sacks.length} sack(s), ${total} item(s)`);
  console.log(`  format         version ${stash.version}, expansions 0x${stash.expansionStatus.toString(16)}`);
  console.log(`  mod            ${stash.mod || '(vanilla)'}`);

  stash.sacks.forEach((sack, i) => {
    console.log(`\nSack ${i + 1} — ${sack.width}×${sack.height}, ${sack.items.length} item(s)`);
    for (const item of sack.items) {
      // Coordinates are floats in this file; they are grid cells, so round.
      const pos = `(${Math.round(item.x)},${Math.round(item.y)})`.padEnd(9);
      const stack = item.stackCount > 1 ? ` ×${item.stackCount}` : '';
      const extras: string[] = [];
      if (item.relicName) extras.push(`component: ${shortRecord(item.relicName)}`);
      if (item.augmentName) extras.push(`augment: ${shortRecord(item.augmentName)}`);
      console.log(`  ${pos} ${shortRecord(item.baseName)}${stack}${extras.length ? `  [${extras.join(', ')}]` : ''}`);
    }
  });

  printBlocks(stash.blocks);
  const verified = stash.blocks.filter((b) => b.checksumOk).length;
  const unverified = stash.blocks.length - verified;
  console.log(
    `\n${stash.blocks.length} blocks, ${verified} checksum-verified` +
      (unverified ? `, ${unverified} UNVERIFIED` : ''),
  );

  if (stash.warnings.length) {
    console.log('\nWarnings');
    for (const w of stash.warnings) console.log(`  ! ${w}`);
  }
}

program
  .command('stash')
  .description('parse the shared transfer stash (transfer.gst) and list its contents')
  .argument('[path]', 'path to transfer.gst', transferStashPath())
  .option('--json', 'emit the parsed stash as JSON instead of a summary')
  .action((path: string, opts: { json?: boolean }) => {
    const stash = parseTransferStash(readSave(path), { path });
    if (opts.json) {
      console.log(JSON.stringify(stash, null, 2));
      return;
    }
    printStash(stash);
    if (stash.blocks.some((b) => !b.checksumOk)) process.exitCode = 1;
  });

program
  .command('formulas')
  .description('parse learned blueprints (formulas.gst) and list their record paths')
  .argument('[path]', 'path to formulas.gst', formulasPath())
  .option('--json', 'emit the parsed blueprints as JSON instead of a summary')
  .option('-a, --all', 'list every blueprint rather than the first 10')
  .action((path: string, opts: { json?: boolean; all?: boolean }) => {
    const file = parseFormulasFile(readSave(path), { path });
    if (opts.json) {
      console.log(JSON.stringify(file, null, 2));
      return;
    }

    const unread = file.entries.filter((e) => !e.read).length;
    console.log(`Learned blueprints — ${file.entries.length}${unread ? ` (${unread} unread)` : ''}`);
    console.log(`  format         version ${file.version}, expansions 0x${file.expansionStatus.toString(16)}`);

    const shown = opts.all ? file.entries : file.entries.slice(0, 10);
    console.log('');
    for (const e of shown) console.log(`  ${e.read ? ' ' : '*'} ${shortRecord(e.record)}`);
    if (shown.length < file.entries.length) {
      console.log(`  … and ${file.entries.length - shown.length} more (--all to list them)`);
    }

    if (file.warnings.length) {
      console.log('\nWarnings');
      for (const w of file.warnings) console.log(`  ! ${w}`);
    }
  });

program
  .command('reagents')
  .description('parse the shared material store (reagents.gst): crafting materials and every loose component')
  .argument('[path]', 'path to reagents.gst', reagentsPath())
  .option('--json', 'emit the parsed store as JSON instead of a summary')
  .action((path: string, opts: { json?: boolean }) => {
    const store = parseReagents(readSave(path), { path });
    if (opts.json) {
      console.log(JSON.stringify(store, null, 2));
      return;
    }

    const total = store.entries.reduce((n, e) => n + e.quantity, 0);
    console.log(`Material store — ${store.entries.length} kind(s), ${total.toLocaleString('en-US')} item(s)`);
    console.log(`  format         version ${store.version}, block ${store.blockId}`);
    console.log(`  mod            ${store.mod || '(vanilla)'}`);
    console.log('');
    for (const e of store.entries) {
      console.log(`  ${String(e.quantity).padStart(4)}× ${shortRecord(e.record)}`);
    }

    printBlocks(store.blocks);
    const verified = store.blocks.filter((b) => b.checksumOk).length;
    console.log(`\n${store.blocks.length} block(s), ${verified} checksum-verified`);
    if (store.warnings.length) {
      console.log('\nWarnings');
      for (const w of store.warnings) console.log(`  ! ${w}`);
    }
    if (store.blocks.some((b) => !b.checksumOk)) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// Stage 3 — the game database and the resolver
// ---------------------------------------------------------------------------

/** Turn a thrown Error into a one-line message; stack traces help nobody here. */
async function withDb<T>(
  opts: { refresh?: boolean; quiet?: boolean },
  fn: (db: GameDb) => T | Promise<T>,
): Promise<T> {
  const settings = resolveSettings();
  try {
    const db = await loadGameDb({
      ...(settings.gameDir ? { gameDir: settings.gameDir } : {}),
      locale: settings.locale,
      refresh: opts.refresh === true,
      onProgress: opts.quiet ? () => {} : (m) => console.error(`… ${m}`),
    });
    return await fn(db);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

program
  .command('db')
  .description('build or inspect the game item database (read from the installed game)')
  .option('--refresh', 're-read the archives instead of using the cached database')
  .option('--stats', 'print coverage and content counts')
  .option('--faction <id>', 'list a faction vendor’s stock')
  .option('--tier <tier>', `market tier for --faction (${REP_TIERS.join(' | ')})`, 'Revered')
  .action(async (opts: { refresh?: boolean; stats?: boolean; faction?: string; tier?: string }) => {
    await withDb({ refresh: opts.refresh }, (db) => {
      const s = db.stats();
      console.log(`${s.gameVersion} — ${s.items.toLocaleString('en-US')} items, ${s.affixes.toLocaleString('en-US')} affixes (${s.namedAffixes.toLocaleString('en-US')} named)`);
      console.log(`  cache          ${s.fingerprint} (built ${s.builtAt})`);
      console.log(`  archives       ${s.archives.join(', ')}`);
      console.log(`  language       ${s.locale} (installed: ${s.locales.join(', ').toLowerCase()})`);
      console.log(`  factions       ${s.factions} (${s.vendorFactions} with vendors, ${s.vendorItems} items stocked)`);
      console.log(`  blueprints     ${s.recipes}`);
      console.log(`  skills         ${s.skills.toLocaleString('en-US')} with per-rank stats, ${s.skillNames.toLocaleString('en-US')} named`);
      console.log(`  item sets      ${s.sets}`);

      if (opts.stats) {
        const pct = ((s.localizedNames / s.items) * 100).toFixed(1);
        console.log('\nCoverage');
        console.log(`  localization   ${s.l10nTags.toLocaleString('en-US')} tags`);
        console.log(`  item names     ${s.localizedNames.toLocaleString('en-US')}/${s.items.toLocaleString('en-US')} localized (${pct}%)`);
        console.log(`  attribute reqs ${s.itemsWithAttrReq.toLocaleString('en-US')} items (from cost equations; medals and cost-less gear have none)`);
        console.log(`  socketables    ${s.socketables.toLocaleString('en-US')} components/augments with use-on slot restrictions`);
        console.log('\nFactions');
        for (const f of db.factions()) {
          const stock = f.hasVendor ? `${db.vendorItems(f.id, 'Revered').length} items` : '—';
          console.log(`  ${f.id.padEnd(12)} ${f.name.padEnd(28)} ${stock}`);
        }
      }

      if (opts.faction) {
        const tier = REP_TIERS.find((t) => t.toLowerCase() === (opts.tier ?? '').toLowerCase());
        if (!tier) {
          console.error(`error: unknown tier ${JSON.stringify(opts.tier)}; expected one of ${REP_TIERS.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        const stock = db.vendorItems(opts.faction, tier);
        const faction = db.factions().find((f) => f.id === opts.faction);
        console.log(`\n${faction?.name ?? opts.faction} — stock up to ${tier} (${stock.length} items)`);
        for (const item of stock) {
          const at = item.vendors?.find((v) => v.factionId === opts.faction)?.repTier ?? '';
          console.log(`  ${at.padEnd(10)} lvl ${String(item.levelReq).padStart(3)}  ${item.name}  [${item.slot}]`);
        }
        if (stock.length === 0) {
          console.log(`  (nothing — is ${JSON.stringify(opts.faction)} a faction id? try \`db --stats\`)`);
        }
      }
    });
  });

function describeItem(item: ResolvedItem): string {
  const bits: string[] = [];
  if (item.base) bits.push(item.base.rarity, describeRequirements(item));
  if (item.modifierName) bits.push(`modifier: ${item.modifierName}`);
  if (item.component) bits.push(`component: ${item.component.name}`);
  if (item.augment) bits.push(`augment: ${item.augment.name}`);
  if (item.base?.setName) bits.push(`set: ${item.base.setName}`);
  if (item.stackCount > 1) bits.push(`×${item.stackCount}`);
  return bits.join(', ');
}

/** `req: lvl 84, 830 physique` — the rolled item's own demands, unreduced. */
function describeRequirements(item: ResolvedItem): string {
  const req = item.requirements;
  if (!req) return `lvl ${item.base?.levelReq ?? 0}`;
  const bits = [`lvl ${req.level}`];
  for (const key of ['physique', 'cunning', 'spirit'] as const) {
    if (req[key] !== undefined) bits.push(`${Math.round(req[key])} ${key}`);
  }
  return bits.length > 1 ? `req: ${bits.join(', ')}` : bits[0]!;
}

/**
 * Resolve every character the user asked for (all of them by default), against
 * one shared coverage tracker.
 *
 * The account-wide files are attributed to the first character only: the transfer
 * stash and the blueprint list belong to the account, and counting them once per
 * character would inflate every total that follows.
 */
function resolveAllCharacters(
  db: GameDb,
  char: string | undefined,
): { characters: ResolvedCharacter[]; track: CoverageTracker } {
  const settings = resolveSettings();
  const names = char ? [char] : listCharacters(settings.saveDir);
  if (names.length === 0) {
    console.error(`error: no characters found under ${settings.saveDir}/main`);
    process.exit(1);
  }

  const account = accountFiles(settings.saveDir);

  const track = new CoverageTracker();
  const characters = names.map((name) => {
    const path = characterSavePath(name, settings.saveDir);
    const first = name === names[0];
    return resolveCharacter(parseGdc(readSave(path), { path }), first ? account : {}, db, track);
  });
  return { characters, track };
}

program
  .command('resolve')
  .description('resolve every item a character can reach to names, rarity and level, with a coverage report')
  .option('-c, --char <name>', 'character directory name under <saveDir>/main (default: all characters)')
  .option('--source <source>', 'only show one of: equipped, inventory, stash, transfer')
  .option('--refresh', 'rebuild the database first')
  .option('--json', 'emit resolved items as JSON instead of a listing')
  .action(async (opts: { char?: string; source?: string; refresh?: boolean; json?: boolean }) => {
    await withDb({ refresh: opts.refresh, quiet: opts.json }, (db) => {
      // One tracker across every character: coverage is about distinct records,
      // and the two characters share plenty of them.
      const { characters: resolved, track } = resolveAllCharacters(db, opts.char);

      if (opts.json) {
        console.log(JSON.stringify({ characters: resolved, coverage: track.report() }, null, 2));
        return;
      }

      for (const character of resolved) {
        console.log(`\n${character.name} — level ${character.level}`);
        for (const source of ['equipped', 'inventory', 'stash', 'transfer'] as const) {
          if (opts.source && opts.source !== source) continue;
          const items = character.items.filter((i) => i.source === source);
          if (items.length === 0) continue;
          console.log(`\n  ${source} (${items.length})`);
          for (const item of items) {
            const detail = describeItem(item);
            console.log(`    ${item.location.padEnd(18)} ${item.display}${detail ? `  — ${detail}` : ''}`);
            for (const miss of item.unresolved) console.log(`    ${' '.repeat(18)}   !! unresolved: ${miss}`);
          }
        }
        if (character.recipes.length && !opts.source) {
          const named = character.recipes.filter((r) => r.name).length;
          console.log(`\n  blueprints: ${named}/${character.recipes.length} named`);
        }
      }

      const c = track.report();
      const pct = (n: number, total: number) => (total === 0 ? '100.0' : ((n / total) * 100).toFixed(1));
      console.log(
        `\nresolved ${c.baseResolved}/${c.baseTotal} base records (${pct(c.baseResolved, c.baseTotal)}%), ` +
          `${c.affixResolved}/${c.affixTotal} affix records (${pct(c.affixResolved, c.affixTotal)}%)`,
      );
      if (c.affixUnnamed.length) {
        console.log(`  ${c.affixUnnamed.length} affix record(s) are nameless by design (crafting bonuses)`);
      }
      for (const miss of c.baseMissing) console.log(`  unresolved base:  ${miss}`);
      for (const miss of c.affixMissing) console.log(`  unresolved affix: ${miss}`);
      if (c.baseResolved < c.baseTotal) process.exitCode = 1;
    });
  });

// ---------------------------------------------------------------------------
// Stage 4 — icons
// ---------------------------------------------------------------------------

/** A PNG's dimensions, from the IHDR chunk (`readPngSize` lives in core now). */
function pngSize(path: string): string {
  const size = readPngSize(path);
  return size ? `${size.width}×${size.height}` : '?×?';
}

/**
 * Every icon an item can contribute: its own, plus its fitted component and
 * augment, both of which the UI draws as overlays. A part with an empty
 * `iconPath` is kept — a record that declares no art at all is a different
 * finding from one whose art is missing, and worth saying out loud.
 */
function iconPartsOf(item: ResolvedItem): { iconPath: string; label: string; record: string }[] {
  const parts: { iconPath: string; label: string; record: string }[] = [];
  if (item.base) parts.push({ iconPath: item.base.iconPath, label: item.display, record: item.base.record });
  if (item.component) {
    parts.push({ iconPath: item.component.iconPath, label: item.component.name, record: item.component.record });
  }
  if (item.augment) {
    parts.push({ iconPath: item.augment.iconPath, label: item.augment.name, record: item.augment.record });
  }
  return parts;
}

program
  .command('icon')
  .description('extract item icons from the game’s .arc archives as PNGs')
  .argument('[target]', 'icon path (items/…/x.tex) or item record path (records/items/…dbr)')
  .option('-o, --out <file>', 'also write the PNG here')
  .option('--check-all', 'resolve icons for every item both characters can reach')
  .option('-c, --char <name>', 'with --check-all: one character instead of all of them')
  .action(async (target: string | undefined, opts: { out?: string; checkAll?: boolean; char?: string }) => {
    if (!target && !opts.checkAll) {
      console.error('error: pass an icon path, an item record path, or --check-all');
      process.exit(1);
    }

    const needsDb = opts.checkAll === true || (target?.startsWith('records/') ?? false) || (target?.endsWith('.dbr') ?? false);

    const run = async (db: GameDb | undefined): Promise<void> => {
      const icons = createIconService();
      try {
        if (opts.checkAll) await checkAllIcons(icons, db!, opts.char);
        else await oneIcon(icons, db, target!, opts.out);
      } finally {
        icons.close();
      }
    };

    if (needsDb) await withDb({ quiet: true }, run);
    else {
      try {
        await run(undefined);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  });

async function oneIcon(
  icons: ReturnType<typeof createIconService>,
  db: GameDb | undefined,
  target: string,
  out: string | undefined,
): Promise<void> {
  let iconPath = target;
  let label = '';

  if (target.startsWith('records/') || target.endsWith('.dbr')) {
    const item = db?.getItem(target);
    if (!item) {
      console.error(`error: ${target} is not an item record in the database`);
      process.exitCode = 1;
      return;
    }
    if (!item.iconPath) {
      console.error(`error: ${item.name} (${target}) declares no icon`);
      process.exitCode = 1;
      return;
    }
    iconPath = item.iconPath;
    label = `${item.name} — `;
  } else if (iconPath.endsWith('.png')) {
    // The textures are `.tex`; accept the rendered extension so a path copied
    // from a filename or a web tool still works.
    iconPath = `${iconPath.slice(0, -4)}.tex`;
  }

  const png = await icons.getIconPng(iconPath);
  if (!png) {
    console.error(`error: no icon for ${iconPath} — ${icons.problems().get(iconPath) ?? 'unknown reason'}`);
    process.exitCode = 1;
    return;
  }

  const fresh = icons.stats().decoded > 0;
  console.log(`${label}${iconPath}`);
  console.log(`  ${pngSize(png)}, ${statSync(png).size} bytes  (${fresh ? 'extracted' : 'cached'})`);
  console.log(`  ${png}`);
  if (out) {
    copyFileSync(png, out);
    console.log(`  copied to ${out}`);
  }
}

async function checkAllIcons(
  icons: ReturnType<typeof createIconService>,
  db: GameDb,
  char: string | undefined,
): Promise<void> {
  const { characters } = resolveAllCharacters(db, char);

  // One request per distinct icon path, but remember every place it came from so
  // a miss can be reported against the item (and the source) that wanted it.
  const wanted = new Map<string, { sources: Set<string>; label: string }>();
  const artless = new Map<string, string>();
  for (const character of characters) {
    for (const item of character.items) {
      for (const { iconPath, label, record } of iconPartsOf(item)) {
        if (!iconPath) {
          artless.set(record, label);
          continue;
        }
        const entry = wanted.get(iconPath) ?? { sources: new Set<string>(), label };
        entry.sources.add(item.source);
        wanted.set(iconPath, entry);
      }
    }
  }

  const missing: { iconPath: string; label: string; sources: string[] }[] = [];
  for (const [iconPath, { sources, label }] of wanted) {
    if (await icons.getIconPng(iconPath)) continue;
    missing.push({ iconPath, label, sources: [...sources] });
  }

  const s = icons.stats();
  const found = s.requested - s.missing - s.failed;
  console.log(
    `${found}/${s.requested} icons found for ${characters.map((c) => c.name).join(', ')}` +
      ` (${s.decoded} extracted, ${s.cached} already cached)`,
  );
  console.log(`  cache: ${icons.cacheDir}`);

  if (artless.size) {
    console.log(`\n${artless.size} record(s) declare no icon at all (lore notes and the like):`);
    for (const [record, label] of artless) console.log(`  ${label} — ${record}`);
  }

  if (missing.length) {
    console.log(`\n${missing.length} icon(s) not in the archives:`);
    for (const m of missing.sort((a, b) => a.iconPath.localeCompare(b.iconPath))) {
      console.log(`  [${m.sources.join(',')}] ${m.label}\n      ${m.iconPath} — ${icons.problems().get(m.iconPath)}`);
    }
  }

  // Equipped gear is the gate: the UI can fall back to text for a stashed
  // oddity, but a blank equipment grid is a broken window.
  const equippedMisses = missing.filter((m) => m.sources.includes('equipped'));
  if (equippedMisses.length) {
    console.error(`\n${equippedMisses.length} equipped item(s) have no icon`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Stage 5A — the mechanics aggregates
// ---------------------------------------------------------------------------

const COLUMN_WIDTH = 6;

function resistHeader(): string {
  return RESIST_COLUMNS.map((c) => c.label.slice(0, COLUMN_WIDTH).padStart(COLUMN_WIDTH)).join(' ');
}

function resistCells(values: ResistVector, blankZero = true): string {
  return RESIST_COLUMNS.map((c) => {
    const value = values[c.key] ?? 0;
    const text = blankZero && value === 0 ? '·' : String(Math.round(value));
    return text.padStart(COLUMN_WIDTH);
  }).join(' ');
}

function printAggregate(agg: CharacterAggregate, caps: SpeedCaps): void {
  const r = agg.resistances;
  console.log(
    `${agg.name} — level ${agg.level}, ${agg.difficulty} (weapon set ${agg.weaponSet})`,
  );

  const w = agg.wielding;
  const hands = w.mainHand ? ` (${w.mainHand}${w.offHand ? ` + ${w.offHand}` : ''})` : '';
  const enablers = w.enablers.length
    ? ` — enabled by ${w.enablers.map((e) => (e.source === 'skill' ? e.name : `${e.name}, ${e.source}`)).join('; ')}`
    : '';
  console.log(`  wielding: ${w.mode}${hands}${enablers}`);
  if (w.mode.startsWith('dual-wield') && w.enablers.length === 0) {
    console.log('  ⚠ dual-wielding with no enabler found — model gap, investigate');
  }
  console.log(`  speed caps (game): attack ${caps.attack}% · cast ${caps.cast}% · run ${caps.run}%`);

  console.log('\nSpeed');
  for (const w of agg.speed.weapons) {
    console.log(
      `  ${w.slot.padEnd(10)} ${w.item} — ${w.tag || 'no descriptor'}, ` +
        `base ${w.aps.toFixed(2)}/s (delta ${w.delta >= 0 ? '+' : ''}${w.delta.toFixed(2)})`,
    );
  }
  for (const line of [agg.speed.attack, agg.speed.cast, agg.speed.movement] as const) {
    const buffed =
      line.maintainablePercent !== 0
        ? ` → ${line.percentWithMaintainable.toFixed(0)}% (${line.rateWithMaintainable.toFixed(2)}) buffed`
        : '';
    const wasted = line.rawPercentWithMaintainable > line.cap
      ? `  ⚠ ${(line.rawPercentWithMaintainable - line.cap).toFixed(0)}pp past the ${line.cap}% cap`
      : `  ${line.headroom.toFixed(0)}pp of +% headroom`;
    console.log(
      `  ${line.label.padEnd(10)} ${line.percent.toFixed(0)}% (${line.rate.toFixed(2)})${buffed}` +
        `  [base ${line.weaponBase.toFixed(2)}, +${line.permanentPercent.toFixed(0)}%` +
        `${line.maintainablePercent ? ` +${line.maintainablePercent.toFixed(0)}% maintainable` : ''}]${wasted}`,
    );
    if (line.weaponNote) console.log(`             from ${line.weaponNote}`);
  }

  console.log(`\nResistances by source${' '.repeat(24)}${resistHeader()}`);
  let band: string | undefined;
  for (const row of r.rows) {
    if (row.band !== band) {
      band = row.band;
      console.log(`  — ${band} —`);
    }
    const where = `${row.slot}: ${row.label}`.slice(0, 40);
    const note = row.note ? `  (${row.note})` : '';
    console.log(`  ${where.padEnd(42)}${resistCells(row.values)}${note}`);
  }

  console.log(`\n  ${'permanent total'.padEnd(42)}${resistCells(r.permanent, false)}`);
  console.log(`  ${'+ maintainable buffs'.padEnd(42)}${resistCells(r.withMaintainable, false)}`);
  console.log(`  ${`${agg.difficulty} penalty`.padEnd(42)}${resistCells(r.penalty, false)}`);
  console.log(`  ${'effective'.padEnd(42)}${resistCells(r.effective, false)}`);
  console.log(`  ${'cap'.padEnd(42)}${resistCells(r.caps, false)}`);
  const overcap: ResistVector = {};
  for (const c of RESIST_COLUMNS) overcap[c.key] = (r.effective[c.key] ?? 0) - (r.caps[c.key] ?? 0);
  console.log(`  ${'over / (under) cap'.padEnd(42)}${resistCells(overcap, false)}`);

  if (r.secondary.length) {
    console.log('\nOther resistances');
    console.log(`  ${r.secondary.map((s) => `${s.label} ${Math.round(s.value)}%`).join(', ')}`);
  }

  const d = agg.defense;
  console.log('\nDefensive skeleton');
  // Armour is localized: one body part is rolled per hit and meets it alone, so
  // there is no total to quote — only six alternatives and their hit weights.
  console.log(
    `  armour per body part (hit-weighted mean ${Math.round(d.armorAverage)}, ` +
      `${d.armorClasses.join('/') || 'no armour class'}):`,
  );
  for (const slot of d.armorSlots) {
    const flag = slot === d.weakestSlot ? '  << weakest' : '';
    console.log(
      `    ${slot.slot.padEnd(10)} ${String(Math.round(slot.effective)).padStart(5)}` +
        `  (piece ${Math.round(slot.piece)}, ${slot.hitChance}% of hits)${flag}`,
    );
  }
  const bonuses = [
    d.bonusArmor ? `+${Math.round(d.bonusArmor)} flat to every part` : '',
    d.armorPercent ? `+${Math.round(d.armorPercent)}%` : '',
  ].filter(Boolean);
  if (bonuses.length) console.log(`    character-wide: ${bonuses.join(', ')}`);
  console.log(
    `  absorption ${d.absorption.toFixed(1)}%` +
      (d.absorptionPercent
        ? `  (${d.absorptionBase}% base × 1 + ${Math.round(d.absorptionPercent)}%)`
        : `  (base, no bonuses)`),
  );
  console.log(`  health +${Math.round(d.health)}${d.healthPercent ? ` +${Math.round(d.healthPercent)}%` : ''}`);
  if (d.hasShield) {
    console.log(`  block ${Math.round(d.blockChance)}% chance, ${Math.round(d.blockAmount)} absorbed`);
  }
  if (d.lifeLeechPercent) console.log(`  ${d.lifeLeechPercent.toFixed(1)}% of attack damage converted to health`);

  const a = agg.attributes;
  console.log('\nAttributes');
  for (const key of ['physique', 'cunning', 'spirit'] as const) {
    const t = a[key];
    const pieces = [
      `${Math.round(t.base)} base`,
      t.flat ? `+${Math.round(t.flat)} gear/skills` : '',
      t.percent ? `+${Math.round(t.percent)}%` : '',
    ].filter(Boolean);
    console.log(`  ${key.padEnd(10)} ${String(Math.round(t.total)).padStart(5)}  (${pieces.join(', ')})`);
  }
  const ability = (label: string, v: { flat: number; percent: number }): void => {
    if (v.flat || v.percent) {
      const bits = [v.flat ? `+${Math.round(v.flat)}` : '', v.percent ? `+${Math.round(v.percent)}%` : ''];
      console.log(`  ${label.padEnd(10)} ${bits.filter(Boolean).join(', ')}  (gear/skill contributions only)`);
    }
  };
  ability('OA', a.offensiveAbility);
  ability('DA', a.defensiveAbility);
  if (a.unspentPoints) console.log(`  unspent    ${a.unspentPoints} attribute point(s) — 8 each`);

  if (agg.requirementReductions.rows.length || agg.requirementReductions.levelFlat) {
    console.log('\nRequirement reductions');
    for (const row of agg.requirementReductions.rows) {
      const what = row.attr ? `${row.attr} on ${row.scope}` : `all attributes on ${row.scope}`;
      console.log(`  -${row.percent}% ${what}  (${row.source})`);
    }
    if (agg.requirementReductions.levelFlat) {
      console.log(`  -${agg.requirementReductions.levelFlat} level requirement on items`);
    }
  }

  const failing = agg.equippedRequirements.filter((e) => !e.check.meets);
  if (failing.length === 0) {
    console.log('\nEquipped items: all requirements satisfied');
  } else {
    // The character is wearing these, so a listed gap means the model missed a
    // source — surfaced loudly precisely because it should never print.
    console.log('\nEquipped items with UNMET requirements (model gap — investigate)');
    for (const entry of failing) {
      for (const gap of entry.check.gaps) {
        console.log(`  ${entry.slot}: ${entry.item} — ${gap.attr} ${gap.have}/${gap.need}`);
      }
    }
  }

  const dmg = agg.damage;
  console.log('\nDamage profile (flat figures are post-conversion midpoints)');
  for (const entry of dmg.ranked.slice(0, 12)) {
    const flat = entry.flat ? `, +${entry.flat} flat` : '';
    console.log(`  ${entry.label.padEnd(16)} +${entry.percent}%${flat}${entry.overTime ? '  (over time)' : ''}`);
  }
  if (dmg.totalDamagePercent) console.log(`  ${'Total Damage'.padEnd(16)} +${dmg.totalDamagePercent}%  (scales every type)`);
  for (const c of dmg.conversions) {
    console.log(`  convert ${c.percent}% ${c.from} → ${c.to}  (${c.source}, ${c.scope})`);
  }
  const top = dmg.ranked.slice(0, 2).map((entry) => entry.label);
  if (top.length) console.log(`  build path: ${top.join(' + ')}`);

  if (dmg.weaponAttack.composition.length) {
    const shares = dmg.weaponAttack.composition
      .map((s) => `${s.share}% ${s.label.toLowerCase()}${s.overTime ? ' (over time)' : ''}`)
      .join(' · ');
    console.log(`\nWeapon attack: ${shares}`);
    if (dmg.weaponAttack.mainAttack) console.log(`  main attack: ${dmg.weaponAttack.mainAttack}`);
  }
  if (dmg.skillDamage.length) {
    console.log('\nAttack skills (own damage at rank; conversions apply to that skill only)');
    for (const s of dmg.skillDamage) {
      const parts: string[] = [];
      if (s.weaponDamagePct) parts.push(`${s.weaponDamagePct}% weapon dmg`);
      parts.push(...s.flat.map((f) => `+${f.amount} ${f.label.toLowerCase()}${f.overTime ? '/time' : ''}`));
      const conv = s.conversions.map((c) => `converts ${c.percent}% ${c.from} → ${c.to}`);
      const detail = [...parts, ...conv].join(' · ') || 'utility';
      const marker = s.isDefaultAttack ? '  [main attack]' : '';
      console.log(`  ${s.skill} r${s.rank}: ${detail}${marker}`);
    }
  }
  if (dmg.resistReduction.length) {
    console.log('\nResistance reduction (applies to enemies, not to the totals above)');
    for (const rr of dmg.resistReduction) console.log(`  ${rr.source}: ${rr.effect} ${Math.round(rr.value)}`);
  }
  if (dmg.weaponRestrictions.length) {
    console.log('\nWeapon-restricted skills');
    for (const w of dmg.weaponRestrictions) console.log(`  ${w.skill}: ${w.weapons.join(', ')}`);
  }

  console.log('\nSkill ranks (invested + gear, clamped at ultimate)');
  for (const rank of agg.ranks.slice(0, 15)) {
    const bonus = rank.bonus ? ` +${rank.bonus}` : '';
    console.log(`  ${rank.name.padEnd(30)} ${rank.invested}${bonus} → ${rank.effective}${rank.capped ? ' (capped)' : ''}`);
  }
  if (agg.maintained.length) {
    console.log('\nCounted as maintainable');
    for (const m of agg.maintained) {
      console.log(`  ${m.name} (rank ${m.rank}, ${m.duration ?? '?'}s duration / ${m.cooldown ?? 0}s cooldown)`);
    }
  }
  if (agg.grantedSkills.length) {
    console.log('\nGranted skills (named, not summed)');
    for (const g of agg.grantedSkills) console.log(`  ${g.item} → ${g.skill}`);
  }
  if (agg.skillModifiers.length) {
    console.log('\nItem skill modifiers (named, not summed)');
    for (const m of agg.skillModifiers) {
      console.log(`  ${m.item}: modifies ${m.skill}${m.modifier ? ` (${m.modifier})` : ''}`);
    }
  }

  console.log('\nNot counted in any total above');
  for (const note of agg.exclusions) console.log(`  · ${note}`);
}

program
  .command('aggregates')
  .description('per-source resistance matrix and damage profile for a character')
  .option('-c, --char <name>', 'character directory name under <saveDir>/main')
  .option('--difficulty <d>', 'Normal | Elite | Ultimate (default: the character’s current one)')
  .option('--refresh', 'rebuild the database first')
  .option('--json', 'emit the aggregate as JSON instead of tables')
  .action(async (opts: { char?: string; difficulty?: string; refresh?: boolean; json?: boolean }) => {
    await withDb({ refresh: opts.refresh, quiet: opts.json }, (db) => {
      const settings = resolveSettings();
      const names = opts.char ? [opts.char] : listCharacters(settings.saveDir);
      if (names.length === 0) {
        console.error(`error: no characters found under ${settings.saveDir}/main`);
        process.exit(1);
      }

      let difficulty: Difficulty | undefined;
      if (opts.difficulty) {
        const wanted = (['Normal', 'Elite', 'Ultimate'] as const).find(
          (d) => d.toLowerCase() === opts.difficulty!.toLowerCase(),
        );
        if (!wanted) {
          console.error(`error: unknown difficulty ${JSON.stringify(opts.difficulty)}; expected Normal, Elite or Ultimate`);
          process.exit(1);
        }
        difficulty = wanted;
      }

      const aggregates = names.map((name) => {
        const path = characterSavePath(name, settings.saveDir);
        const save = parseGdc(readSave(path), { path });
        return aggregateCharacter(save, db, difficulty ?? save.difficulty);
      });

      if (opts.json) {
        console.log(JSON.stringify(aggregates, null, 2));
        return;
      }
      aggregates.forEach((agg, i) => {
        if (i) console.log('\n' + '='.repeat(72));
        printAggregate(agg, db.speedCaps());
      });
    });
  });

// ---------------------------------------------------------------------------
// Stage 5B — the context document
// ---------------------------------------------------------------------------

interface DocRequest {
  char?: string | undefined;
  difficulty?: string | undefined;
  maxTokens: number;
  perGroup?: number | undefined;
}

/**
 * Everything both `context` and `advise` need. A thin wrapper over the session
 * layer now: the composition itself lives in `src/core/session.ts`, so the CLI
 * and the window cannot drift into sending different documents.
 */
function contextFor(
  db: GameDb,
  opts: DocRequest,
  includeStash = true,
): {
  name: string;
  input: ContextInput;
  doc: ContextDoc;
  worn: Record<string, string>;
  wornSockets: Record<string, { component?: string; augment?: string }>;
} {
  const snap = orExit(() =>
    loadSnapshot(db, resolveSettings(), {
      character: opts.char,
      ...(opts.difficulty !== undefined ? { difficulty: requireDifficulty(opts.difficulty) } : {}),
      maxTokens: opts.maxTokens,
      perGroup: opts.perGroup,
    }),
  );
  // `adviceScope` filters the stashes out of the document when asked; with them
  // included it hands back the snapshot's own pair untouched.
  const scope = adviceScope(snap, includeStash);
  // The loadout the document describes, so a stored envelope can later say
  // whether it is still describing the save in front of the reader.
  return {
    name: snap.character,
    input: scope.input,
    doc: scope.doc,
    worn: wornSlots(snap.resolved.items),
    wornSockets: wornSocketables(snap.resolved.items, shortHash),
  };
}

program
  .command('context')
  .description('compile the character + database + aggregates into the markdown context document')
  .option('-c, --char <name>', 'character directory name under <saveDir>/main')
  .option('--difficulty <d>', 'Normal | Elite | Ultimate (or 0/1/2); default: the character’s current one')
  .option('-o, --out <file>', 'write the document here instead of stdout')
  .option('--max-tokens <n>', 'token budget the document is trimmed to fit', String(DEFAULT_MAX_TOKENS))
  .option('--candidates <n>', 'candidates per equipment slot before trimming', String(DEFAULT_PER_GROUP))
  .option('--refresh', 'rebuild the database first')
  .action(
    async (opts: {
      char?: string;
      difficulty?: string;
      out?: string;
      maxTokens: string;
      candidates: string;
      refresh?: boolean;
    }) => {
      await withDb({ refresh: opts.refresh, quiet: opts.out === undefined }, (db) => {
        const { doc } = contextFor(db, {
          char: opts.char,
          difficulty: opts.difficulty,
          maxTokens: Number(opts.maxTokens),
          perGroup: Number(opts.candidates),
        });

        if (opts.out) {
          writeFileSync(opts.out, doc.markdown);
          console.log(`${opts.out} — ${doc.markdown.length.toLocaleString('en-US')} chars, ~${doc.tokenEstimate.toLocaleString('en-US')} tokens`);
        } else {
          process.stdout.write(doc.markdown);
        }
        // Trimming and the estimate go to stderr so `context > doc.md` stays clean.
        console.error(`~${doc.tokenEstimate.toLocaleString('en-US')} tokens (budget ${Number(opts.maxTokens).toLocaleString('en-US')})`);
        for (const note of doc.trimmed) console.error(`  trimmed: ${note}`);
        if (doc.trimmed.length) {
          console.error('  raise --max-tokens to keep them — the untrimmed document is bounded by the candidate level window, not by this budget');
        }
      });
    },
  );

// ---------------------------------------------------------------------------
// Stage 6 — the advisor
// ---------------------------------------------------------------------------

/**
 * The token budget for advice.
 *
 * Passed explicitly rather than inherited so the prompt size is a property of
 * this command's contract: a change to the document's default budget must not
 * silently change what gets sent to the model.
 */
const ADVISE_MAX_TOKENS = 100_000;

function printPlan(plan: AdvisorPlan): void {
  const byVerdict = new Map<string, number>();
  for (const v of plan.verdicts) byVerdict.set(v.verdict, (byVerdict.get(v.verdict) ?? 0) + 1);
  const breakdown = [...byVerdict].map(([verdict, n]) => `${n} ${verdict}`).join(', ');
  console.log(
    `plan: ${plan.verdicts.length} verdict(s)` +
      (breakdown ? ` (${breakdown})` : '') +
      `, ${plan.hold.length} hold, ${plan.sell.length} sell`,
  );
}

/**
 * The per-slot verdict table, rendered from the structured plan rather than
 * trusted to the model's prose.
 *
 * Formatting then does not depend on the answer at all, and it dogfoods the
 * Stage 7 contract: the UI will paint the same grid from the same fields, with
 * `isReplacement` — not a local guess — deciding which rows are swaps.
 */
function verdictTableLines(plan: AdvisorPlan, itemsById: ReadonlyMap<string, ResolvedItem>): string[] {
  if (plan.verdicts.length === 0) return [];
  // Gains and costs share one column: they are two halves of the same delta,
  // and splitting them doubles the width of a table that is already wide.
  // A cost usually already reads as negative ("-35% Acid Resistance"); when it
  // does not ("breaks the two-piece set bonus") it needs saying, so the label
  // goes on only where the sign is missing.
  const delta = (r: { gains: string[]; costs: string[] }): string =>
    [...r.gains, ...r.costs.map((c) => (/^[+\-−]/.test(c) ? c : `costs ${c}`))].join(', ') || '—';

  const rows = verdictRows(plan, (id) => itemsById.get(id)?.display).map((r) => [
    r.slot,
    r.current,
    r.next,
    r.action,
    delta(r),
    r.why,
  ]);

  const headers = ['Slot', 'Current', 'New', 'Action', 'Gains / costs', 'Why'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;

  const out = [
    '',
    'Per-slot verdicts (rendered from the structured plan):',
    line(headers),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
  ];

  if (plan.nextLevels?.length) {
    out.push('', 'Next levels:');
    for (const step of plan.nextLevels) {
      const unlocks = step.unlocks.map((id) => itemsById.get(id)?.display ?? `#${id}`);
      out.push(
        `  ${step.threshold} → ${unlocks.length ? `${unlocks.length} item(s): ${unlocks.join(', ')}` : 'nothing listed'}` +
          (step.recommendation ? `\n    ${step.recommendation}` : ''),
      );
    }
  }
  return out;
}

program
  .command('advise')
  .description('compile the context document and ask an AI for equip/replace/hold recommendations')
  .option('-c, --char <name>', 'character directory name under <saveDir>/main')
  .option('--provider <id>', `advisor backend (${providerIds().join(' | ')})`)
  .option('--model <model>', 'model to pin for this run')
  .option('--effort <level>', 'reasoning effort: low | medium | high | xhigh | max')
  .option('--question <text>', 'an extra instruction to steer the answer')
  .option('--difficulty <d>', 'Normal | Elite | Ultimate (or 0/1/2); default: the character’s current one')
  .option('--max-tokens <n>', 'token budget for the context document', String(ADVISE_MAX_TOKENS))
  .option('--timeout <seconds>', 'kill the request after this long')
  .option('-o, --out <file>', 'also write the answer here')
  .option('--json <file>', 'write the answer, the structured plan and the run metadata here as one JSON object')
  .option('--save-context <file>', 'write the exact document that was sent')
  .option('--dry-run', 'build and report the document without calling the provider')
  .option('--no-repair', 'do not spend a second call correcting a plan that fails the checks')
  .option('--no-stash', 'leave the personal and transfer stash out of the dossier (materials always ship)')
  .option('--refresh', 'rebuild the database first')
  .action(
    async (opts: {
      char?: string;
      provider?: string;
      model?: string;
      effort?: string;
      question?: string;
      difficulty?: string;
      maxTokens: string;
      timeout?: string;
      out?: string;
      json?: string;
      saveContext?: string;
      dryRun?: boolean;
      repair?: boolean;
      stash?: boolean;
      refresh?: boolean;
    }) => {
      await withDb({ refresh: opts.refresh, quiet: true }, async (db) => {
        const settings = resolveSettings();
        const providerId = opts.provider ?? settings.provider;
        const model = opts.model ?? settings.model ?? DEFAULT_MODEL;
        const effort = opts.effort ?? settings.effort ?? DEFAULT_EFFORT;
        const timeoutMs = opts.timeout
          ? Number(opts.timeout) * 1000
          : (settings.advisorTimeoutSeconds ?? 0) * 1000 || DEFAULT_TIMEOUT_MS;

        let provider;
        let repairProvider;
        try {
          provider = createProvider(providerId, { model, effort, timeoutMs });
          // The corrective call is an edit, so it runs at `repairEffort`.
          repairProvider = createProvider(providerId, { model, effort: repairEffort(effort), timeoutMs });
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }

        // A backend that cannot run should say so *before* a document is
        // compiled for it. `advise` on an unimplemented provider is a
        // configuration mistake, and it should read as one.
        const usable = opts.dryRun === true || (await provider.available());
        if (!usable) {
          try {
            await provider.advise({ contextDoc: '' });
            console.error(`error: provider ${JSON.stringify(providerId)} is not available`);
          } catch (err) {
            console.error(`error: ${(err as Error).message}`);
          }
          process.exit(1);
        }

        // The flag wins; without it the window's stored preference applies, so
        // a CLI run and a window run on the same save read the same dossier.
        const includeStash = opts.stash === false ? false : (settings.includeStashInAdvice ?? true);
        const { name, input, doc, worn, wornSockets } = contextFor(
          db,
          {
            char: opts.char,
            difficulty: opts.difficulty,
            maxTokens: Number(opts.maxTokens),
          },
          includeStash,
        );

        console.error(
          `${name} — context document ${doc.markdown.length.toLocaleString('en-US')} chars, ` +
            `~${doc.tokenEstimate.toLocaleString('en-US')} tokens, ${doc.itemsById.size} item ids`,
        );
        for (const note of doc.trimmed) console.error(`  trimmed: ${note}`);
        if (opts.saveContext) writeFileSync(opts.saveContext, doc.markdown);

        if (opts.dryRun) {
          console.error(`dry run — would ask ${providerId} (${model}, effort ${effort})`);
          return;
        }

        const socketables = new Map(
          documentSocketables(input).map((item) => [normalizeName(item.name), item]),
        );
        const check = {
          itemsById: doc.itemsById,
          socketables,
          socketablesById: doc.socketablesById,
          candidateIds: doc.candidateIds,
          freeComponentIds: doc.freeComponentIds,
        };

        console.error(`asking ${providerId} (${model}, effort ${effort})…`);
        const started = Date.now();
        let outcome;
        try {
          outcome = await adviseWithRepair(
            provider,
            { contextDoc: doc.markdown, ...(opts.question ? { question: opts.question } : {}) },
            check,
            {
              repair: opts.repair !== false,
              repairProvider,
              onRepair: (warnings: readonly PlanWarning[]) =>
                console.error(
                  `plan had ${warnings.length} warning(s); asking for one revision at ${repairEffort(effort)} effort…`,
                ),
            },
          );
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }

        const result = outcome.result;
        // The prose no longer carries a per-slot table — the tool owns that
        // rendering — so the saved answer has to carry the rendered one, or a
        // file read on its own is missing the verdicts it argues about.
        const table = result.structured ? verdictTableLines(result.structured, doc.itemsById) : [];

        console.log(result.text);
        if (opts.out) {
          writeFileSync(opts.out, table.length ? `${result.text}\n${table.join('\n')}\n` : result.text);
          console.error(`\nanswer written to ${opts.out}`);
        }

        console.log('');
        if (result.structured) {
          printPlan(result.structured);
          for (const line of table) console.log(line);
          if (outcome.revised) {
            console.log(
              `\nplan had ${outcome.firstWarnings.length} warning(s); asked for one revision → ` +
                (outcome.revisionRejected
                  ? `still ${outcome.warnings.length}, so the original answer is shown`
                  : outcome.warnings.length === 0
                    ? 'clean'
                    : `${outcome.warnings.length} left`),
            );
          }
          if (outcome.warnings.length) {
            console.log(`\n${outcome.warnings.length} plan check warning(s):`);
            for (const w of outcome.warnings) console.log(`  ! [${w.kind}] ${w.message}`);
            process.exitCode = 1;
          } else {
            console.log('plan checks: every item id exists, no illegal socket, no destroyed host reused, no free socket walked past, every stat qualified');
          }
        } else {
          console.log('plan: not parseable — text only');
        }

        // Usage covers *every* call the repair loop made, not just the one whose
        // answer is shown — the second call is spent whether or not it wins.
        const usage = totalUsage(outcome.results);

        // One envelope, so Stage 7 consumes a file rather than re-parsing prose.
        // The markdown stays the model's own: it is where the reasoning happens
        // and it is the human product, so the JSON sits beside it, not over it.
        if (opts.json) {
          const envelope = buildEnvelope({
            character: name,
            gameVersion: db.gameVersion,
            ...(opts.question ? { question: opts.question } : {}),
            outcome,
            usage,
            durationMs: Date.now() - started,
            itemNames: Object.fromEntries([...doc.itemsById].map(([id, item]) => [id, item.display])),
            socketableNames: Object.fromEntries([...doc.socketablesById].map(([id, item]) => [id, item.name])),
            worn,
            wornSockets,
            stashIncluded: includeStash,
          });
          writeFileSync(opts.json, `${JSON.stringify(envelope, null, 2)}\n`);
          console.error(`structured output written to ${opts.json}`);
        }
        const bits = [
          `${result.provider} / ${result.model ?? '?'}${result.effort ? ` (effort ${result.effort})` : ''}`,
          outcome.results.length > 1 ? `${outcome.results.length} calls` : '',
          `${usage.inputTokens.toLocaleString('en-US')} in`,
          `${usage.outputTokens.toLocaleString('en-US')} out`,
          usage.costUsd ? `$${usage.costUsd.toFixed(4)}` : '',
          `${((Date.now() - started) / 1000).toFixed(1)}s`,
        ].filter(Boolean);
        console.log(`\n${bits.join(' · ')}`);
      });
    },
  );

// ---------------------------------------------------------------------------
// Stage 7C — the save watcher
// ---------------------------------------------------------------------------

program
  .command('paths')
  .description('report where this machine keeps Grim Dawn and its saves')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    const settings = resolveSettings();
    const found = { saveDirs: findSaveDirs(), gameDirs: findGameDirs(), using: settings };

    if (opts.json) {
      console.log(JSON.stringify({ saveDir: settings.saveDir, gameDir: settings.gameDir, ...found }, null, 2));
      return;
    }

    console.log('In use');
    console.log(`  saves  ${settings.saveDir}`);
    console.log(`  game   ${settings.gameDir ?? '(not found)'}`);
    console.log(`  locale ${settings.locale}`);
    console.log('\nSave trees found');
    for (const dir of found.saveDirs) console.log(`  ${dir}`);
    if (!found.saveDirs.length) console.log('  (none — set saveDir in settings.json or GD_SAVE_DIR)');
    console.log('\nInstalls found');
    for (const dir of found.gameDirs) console.log(`  ${dir}`);
    if (!found.gameDirs.length) console.log('  (none — set gameDir in settings.json or GD_GAME_DIR)');
  });

program
  .command('watch')
  .description('watch the save tree and print what the game writes (Ctrl-C to stop)')
  .option('--debounce <ms>', 'quiet time after the last write before a file is read', '2000')
  .option('--retries <n>', 'parse attempts before falling back to a rotation backup', '3')
  .action(async (opts: { debounce: string; retries: string }) => {
    const settings = resolveSettings();
    const stamp = (): string => new Date().toTimeString().slice(0, 8);

    console.log(`watching ${settings.saveDir}`);
    console.log('play the game, or `touch` a save in another terminal — Ctrl-C to stop\n');

    const watcher = createSaveWatcher({
      saveDir: settings.saveDir,
      debounceMs: Number(opts.debounce),
      attempts: Number(opts.retries),
      onEvent: (event) => {
        switch (event.type) {
          case 'character-updated':
            console.log(
              `${stamp()}  character-updated  ${event.character} — level ${event.save.level}, ` +
                `${event.save.equipment.filter(Boolean).length} equipped` +
                (event.fromBackup ? `  [from the rotation backup ${basename(event.path)}]` : ''),
            );
            break;
          case 'parse-failed':
            console.log(`${stamp()}  parse-failed       ${event.character ?? ''} ${event.message}`.trimEnd());
            break;
          default:
            console.log(`${stamp()}  ${event.type}`);
        }
      },
    });

    process.on('SIGINT', () => {
      watcher.close();
      console.log('\nstopped');
      process.exit(0);
    });
    // Nothing else to do: the watch handle is what keeps the process alive.
    await new Promise(() => {});
  });

program.parse();
