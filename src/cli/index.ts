#!/usr/bin/env tsx
/**
 * Dev CLI for the Grim Dawn companion core.
 *
 * This is how `src/core` gets exercised without Electron in the loop — every
 * stage adds a command here. Run with `npm run cli -- <command>`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';

import { loadGameDb } from '../core/db/index.js';
import { REP_TIERS, type GameDb } from '../core/db/types.js';
import { characterSavePath, formulasPath, transferStashPath } from '../core/paths.js';
import { CoverageTracker, resolveCharacter, type ResolvedItem } from '../core/resolve.js';
import { listCharacters, resolveSettings } from '../core/settings.js';
import { parseGdc } from '../core/save/gdc.js';
import {
  parseFormulasFile,
  parseTransferStash,
  type FormulasFile,
  type TransferStash,
} from '../core/save/gst.js';
import { EQUIP_SLOT_NAMES, type BlockReport, type CharacterSave } from '../core/save/types.js';

const program = new Command();

program
  .name('gd')
  .description('Grim Dawn companion — development CLI')
  .version('0.1.0');

/**
 * Read a save file, turning the usual filesystem failures into a one-line
 * message. A missing save is an ordinary situation (the user has not played
 * that mode, or the path is wrong) and should read as one, not as a stack trace.
 */
function readSave(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' ? 'no such file' : code === 'EACCES' ? 'permission denied' : (err as Error).message;
    console.error(`error: cannot read ${path} — ${reason}`);
    process.exit(1);
  }
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
  .description('build or inspect the game item database (game .arz + GrimTools localization)')
  .option('--refresh', 're-read the archives and re-download the localization table')
  .option('--stats', 'print coverage and content counts')
  .option('--faction <id>', 'list a faction vendor’s stock')
  .option('--tier <tier>', `market tier for --faction (${REP_TIERS.join(' | ')})`, 'Revered')
  .action(async (opts: { refresh?: boolean; stats?: boolean; faction?: string; tier?: string }) => {
    await withDb({ refresh: opts.refresh }, (db) => {
      const s = db.stats();
      console.log(`${s.gameVersion} — ${s.items.toLocaleString('en-US')} items, ${s.affixes.toLocaleString('en-US')} affixes (${s.namedAffixes.toLocaleString('en-US')} named)`);
      console.log(`  cache          ${s.fingerprint} (built ${s.builtAt})`);
      console.log(`  archives       ${s.archives.join(', ')}`);
      console.log(`  factions       ${s.factions} (${s.vendorFactions} with vendors, ${s.vendorItems} items stocked)`);
      console.log(`  blueprints     ${s.recipes}`);

      if (opts.stats) {
        const pct = ((s.localizedNames / s.items) * 100).toFixed(1);
        console.log('\nCoverage');
        console.log(`  localization   ${s.l10nTags.toLocaleString('en-US')} tags`);
        console.log(`  item names     ${s.localizedNames.toLocaleString('en-US')}/${s.items.toLocaleString('en-US')} localized (${pct}%)`);
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
  if (item.base) bits.push(item.base.rarity, `lvl ${item.base.levelReq}`);
  if (item.modifierName) bits.push(`modifier: ${item.modifierName}`);
  if (item.component) bits.push(`component: ${item.component.name}`);
  if (item.augment) bits.push(`augment: ${item.augment.name}`);
  if (item.base?.setName) bits.push(`set: ${item.base.setName}`);
  if (item.stackCount > 1) bits.push(`×${item.stackCount}`);
  return bits.join(', ');
}

function readOptionalSave(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

program
  .command('resolve')
  .description('resolve every item a character can reach to names, rarity and level, with a coverage report')
  .option('-c, --char <name>', 'character directory name under <saveDir>/main (default: all characters)')
  .option('--source <source>', 'only show one of: equipped, inventory, stash, transfer')
  .option('--refresh', 'rebuild the database first')
  .option('--json', 'emit resolved items as JSON instead of a listing')
  .action(async (opts: { char?: string; source?: string; refresh?: boolean; json?: boolean }) => {
    const settings = resolveSettings();
    const characters = opts.char ? [opts.char] : listCharacters(settings.saveDir);
    if (characters.length === 0) {
      console.error(`error: no characters found under ${settings.saveDir}/main`);
      process.exit(1);
    }

    const stashBuf = readOptionalSave(transferStashPath(settings.saveDir));
    const formulasBuf = readOptionalSave(formulasPath(settings.saveDir));
    const stash: TransferStash | undefined = stashBuf ? parseTransferStash(stashBuf) : undefined;
    const formulas: FormulasFile | undefined = formulasBuf ? parseFormulasFile(formulasBuf) : undefined;

    await withDb({ refresh: opts.refresh, quiet: opts.json }, (db) => {
      // One tracker across every character: coverage is about distinct records,
      // and the two characters share plenty of them.
      const track = new CoverageTracker();
      const resolved = characters.map((name) => {
        const path = characterSavePath(name, settings.saveDir);
        // Only the first character gets the shared files attributed to it, so
        // the transfer stash is not counted (or listed) once per character.
        const first = name === characters[0];
        return resolveCharacter(
          parseGdc(readSave(path), { path }),
          first ? stash : undefined,
          first ? formulas : undefined,
          db,
          track,
        );
      });

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

program.parse();
