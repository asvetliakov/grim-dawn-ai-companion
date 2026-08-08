#!/usr/bin/env tsx
/**
 * Dev CLI for the Grim Dawn companion core.
 *
 * This is how `src/core` gets exercised without Electron in the loop — every
 * stage adds a command here. Run with `npm run cli -- <command>`.
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';

import { formulasPath, transferStashPath } from '../core/paths.js';
import { parseGdc } from '../core/save/gdc.js';
import { parseFormulasFile, parseTransferStash, type TransferStash } from '../core/save/gst.js';
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

program.parse();
