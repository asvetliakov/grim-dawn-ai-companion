/** Shared shapes for parsed Grim Dawn save data. */

/**
 * An item as stored in a save: DBR record paths plus the seeds the game uses to
 * regenerate its rolled stats. Everything user-visible (name, stats, icon) comes
 * from the game DB — see `src/core/resolve.ts` (Stage 3).
 */
export interface ItemInstance {
  baseName: string;
  prefixName: string;
  suffixName: string;
  modifierName: string;
  transmuteName: string;
  seed: number;
  relicName: string;
  relicBonus: string;
  relicSeed: number;
  augmentName: string;
  unknown: number;
  augmentSeed: number;
  /** gd-edit calls this `var1`; believed to be relic completion level. */
  relicCompletionLevel: number;
  stackCount: number;
  /**
   * Four fields present in 1.3.0.6 saves that the 1.2-era specs do not describe
   * (two before `stackCount`, two after). They are zero for every item across
   * both test characters, so their meaning is unknown — possibly empty strings
   * rather than integers, which reads identically while they stay empty.
   */
  unknownExtra: [number, number, number, number];
}

/** An item at a grid position (inventory sack / stash tab). X,Y are i32 here. */
export interface PositionedItem extends ItemInstance {
  x: number;
  y: number;
}

/** An item in an equipment slot; `attached` marks it as actually worn. */
export interface EquippedItem extends ItemInstance {
  attached: boolean;
}

/**
 * Equipment slot order as written in the save's inventory block, confirmed
 * against a fully-geared character by matching each slot to the item category
 * of the record it held. Weapons are *not* here — main/off hand live in the
 * alternate weapon sets, and slot 11 is the relic.
 */
export enum EquipSlot {
  Head = 0,
  Neck = 1,
  Chest = 2,
  Legs = 3,
  Feet = 4,
  Hands = 5,
  Ring1 = 6,
  Ring2 = 7,
  Belt = 8,
  Shoulders = 9,
  Medal = 10,
  Relic = 11,
}

export const EQUIP_SLOT_NAMES: readonly string[] = [
  'Head',
  'Neck',
  'Chest',
  'Legs',
  'Feet',
  'Hands',
  'Ring 1',
  'Ring 2',
  'Belt',
  'Shoulders',
  'Medal',
  'Relic',
];

export type FactionTier = 'Hostile' | 'Neutral' | 'Friendly' | 'Respected' | 'Honored' | 'Revered';

export interface FactionRep {
  /** Array index in the save — this *is* the faction identity; no names stored. */
  id: number;
  /** Best-effort display name from the hardcoded table; may be undefined. */
  name?: string;
  changed: boolean;
  unlocked: boolean;
  value: number;
  positiveBoost: number;
  negativeBoost: number;
  tier: FactionTier;
}

export interface CharacterSkill {
  record: string;
  level: number;
  enabled: boolean;
  devotionLevel: number;
  devotionExperience: number;
  sublevel: number;
  active: boolean;
  autoCastSkill: string;
  autoCastController: string;
}

export interface Attributes {
  level: number;
  experience: number;
  /** Unspent attribute points. */
  attributePoints: number;
  /** Unspent skill points. */
  skillPoints: number;
  /** Unspent devotion points. */
  devotionPoints: number;
  totalDevotionPoints: number;
  physique: number;
  cunning: number;
  spirit: number;
  health: number;
  energy: number;
}

export type Difficulty = 'Normal' | 'Elite' | 'Ultimate';

/**
 * Only the leading, positively-identified fields of the play-stats block. The
 * block's tail grows with every patch, so the rest is walked (and checksummed)
 * but not modelled.
 */
export interface PlayStats {
  playTimeSeconds: number;
  deaths: number;
  kills: number;
}

export interface StashTab {
  width: number;
  height: number;
  items: PositionedItem[];
}

/** One block as encountered while walking the file — the checksum audit trail. */
export interface BlockReport {
  id: number;
  length: number;
  status: 'parsed' | 'skipped';
  checksumOk: boolean;
  note?: string;
}

export interface CharacterSave {
  /** Absolute path the save was read from, when known. */
  path?: string;
  headerVersion: number;
  dataVersion: number;
  name: string;
  sex: number;
  /** e.g. "tagSkillClassName0410" — resolves to the mastery combo name. */
  classRecord: string;
  level: number;
  hardcore: boolean;
  expansionStatus: number;
  difficulty: Difficulty;
  greatestDifficultyCompleted: Difficulty;
  iron: number;
  tributes: number;
  attributes: Attributes;
  skills: CharacterSkill[];
  /** Skills whose record path lives under the devotion tree. */
  devotions: CharacterSkill[];
  masteriesAllowed: number;
  skillReclamationPointsUsed: number;
  devotionReclamationPointsUsed: number;
  /** 12 equipment slots, plus 2×2 alternate weapon sets. */
  equipment: (EquippedItem | null)[];
  weaponSet1: (EquippedItem | null)[];
  weaponSet2: (EquippedItem | null)[];
  /**
   * Which weapon set the character is holding: false = set 1, true = set 2.
   * Only the held set contributes to any stat total, so an aggregate that
   * assumed set 1 would be wrong for every player who swaps.
   */
  alternateWeaponSetActive: boolean;
  inventorySacks: PositionedItem[][];
  personalStash: StashTab[];
  factions: FactionRep[];
  playStats: PlayStats;
  blocks: BlockReport[];
  /** Non-fatal problems: unknown blocks, unexpected versions, torn fields. */
  warnings: string[];
}
