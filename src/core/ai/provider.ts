/**
 * The advisor seam.
 *
 * Everything above this file knows only `AdvisorProvider`: hand it a context
 * document, get back prose plus an optional machine-readable plan. Which model
 * produced it — the local `claude` binary today, an HTTP API later — is a
 * settings string, not a code path.
 *
 * The structured plan is also the contract with Stage 7's UI: the markdown is
 * what gets displayed, the JSON block is what paints verdict chips on the
 * equipment grid. Parsing it is deliberately forgiving — a malformed block
 * costs the chips, never the advice.
 */

import { z } from 'zod';

export interface AdvisorRequest {
  /** The Stage 5B markdown document. Goes to the model verbatim. */
  contextDoc: string;
  /** An extra user instruction, appended after the document. */
  question?: string;
}

export interface AdvisorResult {
  text: string;
  provider: string;
  /** The model that actually ran, as resolved by the provider. */
  model?: string;
  /** Reasoning effort, when the backend has such a knob. */
  effort?: string;
  structured?: AdvisorPlan;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number };
}

/**
 * Something the model did while the call was in flight.
 *
 * The run takes eight to twelve minutes behind one opaque subprocess, and the
 * honest progress that could be shown without this was three phase labels and a
 * clock. That is truthful and it is not enough: the phase says "asking the model"
 * for ten minutes, so the only way to tell a working run from a wedged one was to
 * wait for the timeout. The backend does have something to say — `claude
 * --output-format stream-json --include-partial-messages` emits the reasoning and
 * the answer as they are written — so the seam carries it.
 *
 * Deltas, not snapshots: the text is whatever arrived since the last call, and
 * the consumer accumulates. A backend with nothing to stream simply never calls
 * it, which is why this is optional at every level rather than a required channel.
 */
export interface AdvisorActivity {
  /** `thinking` is the model reasoning; `answer` is the prose it is writing. */
  kind: 'thinking' | 'answer';
  /** The newest text, to be appended to what came before. */
  text: string;
  /** Output tokens so far, where the backend counts them for us. */
  outputTokens?: number;
}

export type ActivityListener = (activity: AdvisorActivity) => void;

export interface AdvisorProvider {
  readonly id: string;
  /** Cheap liveness check — a backend that cannot run should say so, not throw later. */
  available(): Promise<boolean>;
  advise(req: AdvisorRequest, signal?: AbortSignal, onActivity?: ActivityListener): Promise<AdvisorResult>;
}

// ---------------------------------------------------------------------------
// The structured plan
// ---------------------------------------------------------------------------

/**
 * The verdicts §11 of the context document asks for, one per equipment slot.
 * `SWAP-COMPONENT` is the destructive twin of `ADD-COMPONENT`: filling an empty
 * socket is free, replacing an installed component destroys the old one and
 * removes the augment.
 */
export const VERDICTS = [
  'KEEP',
  'EQUIP',
  'RE-AUGMENT',
  'ADD-COMPONENT',
  'SWAP-COMPONENT',
  'BUY-AUGMENT',
  'CRAFT',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Verdicts whose `target` names a socketable rather than an item id. */
export const SOCKET_VERDICTS: readonly Verdict[] = [
  'RE-AUGMENT',
  'ADD-COMPONENT',
  'SWAP-COMPONENT',
  'BUY-AUGMENT',
];

/**
 * The one verdict that *replaces* the item in the slot. Everything else keeps
 * it — a re-augment or a new component changes what the item carries, not which
 * item it is. Exported so the CLI's verdict table and Stage 7's grid cannot
 * disagree about which rows are swaps.
 */
export function isReplacement(verdict: Verdict): boolean {
  return verdict === 'EQUIP';
}

/**
 * What a mechanical check found wrong with a plan. Defined here rather than in
 * `verify.ts` (which re-exports it) because it is part of the plan's public
 * vocabulary: a stored advice envelope carries these, and that envelope has to
 * be describable from the renderer, where nothing may reach a module that
 * imports `node:fs`.
 */
export const PLAN_WARNING_KINDS = [
  'unknown-id',
  'unknown-socketable',
  'missing-target',
  'destroyed-host',
  'illegal-socket',
  'ambiguous-stat',
  'name-mismatch',
  'unjustified-hold',
] as const;

export type PlanWarningKind = (typeof PLAN_WARNING_KINDS)[number];

/**
 * Schemas rather than bare interfaces because a stored advice envelope carries
 * these and has to be *validated on the way back in*: a file written by an older
 * build must degrade to "no last advice", not to a renderer reading fields that
 * are not there. The types stay inferred, so there is still one definition.
 */
export const planWarningSchema = z.object({
  kind: z.enum(PLAN_WARNING_KINDS),
  message: z.string(),
});

export type PlanWarning = z.infer<typeof planWarningSchema>;

/** The `Slot | Current | New | Action | Gains / Costs | Why` row for one verdict. */
export const verdictRowSchema = z.object({
  slot: z.string(),
  current: z.string(),
  /** Display name of `current`, without the id — for a UI that renders ids separately. */
  currentName: z.string(),
  currentId: z.string(),
  /** `— (keep)` unless the item itself is replaced. */
  next: z.string(),
  nextName: z.string(),
  nextId: z.string(),
  /** The socketable move, or `KEEP`. Empty on a plain replacement. */
  action: z.string(),
  /**
   * What the move adds and what it costs, already qualified. The first live
   * table showed neither, so "+12% Fire Resistance and +12% Lightning
   * Resistance" existed in the prose and nowhere a UI could reach it.
   */
  gains: z.array(z.string()),
  costs: z.array(z.string()),
  why: z.string(),
  replaces: z.boolean(),
});

export type VerdictRow = z.infer<typeof verdictRowSchema>;

/** What a row shows when the slot keeps the item it already has. */
export const KEEP_CELL = '— (keep)';

/**
 * Derive the per-slot verdict table from the plan rather than from the model's
 * prose.
 *
 * The live run improvised its own columns and showed only the current item in
 * every row but one, so "this slot keeps its item and gains an augment" and
 * "this slot's item is replaced" looked identical — the single most important
 * distinction in the table. Deriving it here means the CLI and Stage 7's grid
 * paint the same thing from the same fields, and neither has to guess which
 * verdicts are swaps.
 *
 * `nameFor` resolves a dossier id to a display name; ids the document never
 * defined are left visible rather than hidden, because `checkPlan` is about to
 * report them anyway.
 */
export function verdictRows(plan: AdvisorPlan, nameFor: (id: string) => string | undefined): VerdictRow[] {
  const label = (id: string | undefined): string =>
    !id ? '' : `${nameFor(id) ?? '(not in the dossier)'} #${id}`;

  return plan.verdicts.map((v) => {
    const replaces = isReplacement(v.verdict);
    const nextId = replaces ? (v.target ?? '') : '';
    return {
      slot: v.slot,
      current: label(v.itemId) || '—',
      currentName: (v.itemId ? nameFor(v.itemId) : undefined) ?? v.itemName ?? '',
      currentId: v.itemId,
      next: replaces ? label(v.target) || `EQUIP ${v.target ?? '?'}` : KEEP_CELL,
      nextName: (nextId ? nameFor(nextId) : undefined) ?? (replaces ? v.targetName ?? '' : ''),
      nextId,
      // A socketable change belongs in Action, never in New: a re-augment is
      // not a new item. `fits` joins it there too — for an `EQUIP` it is the
      // whole cell, and for a socket move it is the second socket, which is the
      // one the verdict's own name cannot mention.
      action: actionCell(v),
      gains: [...(v.gains ?? [])],
      costs: [...(v.costs ?? [])],
      why: v.reason,
      replaces,
    };
  });
}

/**
 * The Action cell: the verdict's own socketable, then anything else the slot is
 * told to fit.
 *
 * A replacement's cell used to be empty, on the reasoning that the New column
 * already says everything — true until an `EQUIP` could also say what to put in
 * the new item's sockets, which is a second instruction and belongs in the column
 * about instructions.
 */
function actionCell(v: AdvisorPlan['verdicts'][number]): string {
  const extra = (v.fits ?? []).map((f) => `${f.name ?? `#${f.id}`} (${f.kind})`);
  const primary = isReplacement(v.verdict)
    ? extra.length > 0
      ? 'FIT'
      : ''
    : v.verdict === 'KEEP' && extra.length === 0
      ? 'KEEP'
      : `${v.verdict}${v.target ? ` ${v.target}` : ''}`;
  return [primary, extra.join(' + ')].filter(Boolean).join(' ');
}

/**
 * A socketable the slot should end up carrying, *beyond* the one its verdict is
 * named for.
 *
 * One verdict per slot is the right shape for the question "what goes in this
 * slot", and it was the wrong shape for the answer. An item holds a component
 * **and** an augment in independent sockets, so a slot can legitimately need two
 * socketable changes at once — and the verdict enum has one name for the move,
 * so the second one had nowhere to go. The first live run hit it twice and said
 * so out loud: the Neck `EQUIP` argued in prose for fitting the new amulet with
 * a loose Dread Skull *and* a Sagethorn Powder, and the plan carried neither,
 * while `projected.notes` contained the sentence "two free component fills are
 * part of this plan and are not separate verdict rows". A recommendation the
 * window cannot render is a recommendation the user does not get.
 *
 * The division of labour: `target`/`targetId` stay the socketable the verdict is
 * *about* — it is what makes a `RE-AUGMENT` a re-augment — and `fits` carries the
 * rest. An `EQUIP` has no primary socketable, so for one of those every socket
 * to fill is here.
 */
const socketFitSchema = z.object({
  kind: z.enum(['component', 'augment']),
  id: z.string(),
  /** The name that id belongs to, on the same "the pair proves the id" reasoning as `itemName`. */
  name: z.string().optional(),
});

export type SocketFit = z.infer<typeof socketFitSchema>;

const verdictSchema = z.object({
  slot: z.string(),
  /** Dossier id of what is in the slot; empty string when the slot is empty. */
  itemId: z.string().default(''),
  /**
   * The display name that goes with `itemId`.
   *
   * Redundant on purpose. The id is the key and a UI resolves it, but carrying
   * the name the model *meant* is what lets `checkPlan` catch the failure an
   * id-only plan hides: a right name paired with the wrong id reads as a valid
   * plan for a different item. Optional, so an older answer still validates.
   */
  itemName: z.string().optional(),
  verdict: z.enum(VERDICTS),
  /** EQUIP: the candidate's item id. BUY/CRAFT/RE-AUGMENT/…: an exact dossier name. */
  target: z.string().optional(),
  /** The dossier id of `target`. Socketables carry ids too, so this always exists. */
  targetId: z.string().optional(),
  /** The display name that goes with `targetId`, on the same reasoning as `itemName`. */
  targetName: z.string().optional(),
  /** Item ids whose joint equip is what satisfies this move's requirements. */
  enablers: z.array(z.string()).optional(),
  /** Extraction source: the host item id, which the extraction DESTROYS. */
  componentFrom: z.string().optional(),
  /**
   * Socketables to install in whatever item this slot ends up holding — the
   * candidate for an `EQUIP`, the worn item otherwise. See `socketFitSchema`.
   */
  fits: z.array(socketFitSchema).optional(),
  /**
   * What this move adds and what it costs, as **fully-qualified** stat strings
   * (`+12% Fire Resistance`, not `+12 Fire`). Deliberately strings rather than a
   * typed effects tree: the dossier already types every stat, and duplicating
   * that here would create a second source of truth to keep in sync. The point
   * is only that the UI can render a delta without re-parsing prose.
   */
  gains: z.array(z.string()).optional(),
  costs: z.array(z.string()).optional(),
  reason: z.string().default(''),
});

/**
 * A multi-slot combination — the reasoning that makes the tool worth running,
 * and until now the one part of the answer that existed only as prose.
 *
 * Stage 7 renders these as the headline: "these four moves go together, here is
 * what they buy". A UI that can only show a per-slot table shows the *result* of
 * the reasoning with the reasoning removed.
 */
const keyMoveSchema = z.object({
  title: z.string(),
  /** Slots this move touches, matching `verdicts[].slot`. */
  slots: z.array(z.string()).default([]),
  /** Item ids the move involves, so the UI can highlight the whole combination. */
  itemIds: z.array(z.string()).default([]),
  /** The argument, with the dossier's numbers in it. */
  detail: z.string().default(''),
});

export const advisorPlanSchema = z.object({
  /**
   * Two or three sentences: what this build is and what the loadout's problem
   * is. The prose opens with it; without it here a UI has a table and no thesis.
   */
  summary: z.string().optional(),
  verdicts: z.array(verdictSchema).default([]),
  keyMoves: z.array(keyMoveSchema).optional(),
  hold: z
    .array(
      z.object({
        itemId: z.string(),
        itemName: z.string().optional(),
        /**
         * What the hold is *for*.
         *
         * A hold is a recommendation, not a status: "keep this, because on the
         * day the threshold is met you will put it on". Being unequippable is
         * neither necessary nor sufficient for that, and a plan without these
         * fields cannot tell the two apart — which is how every over-levelled
         * item in a stash ends up marked HOLD. `slot` says where it goes,
         * `beats` names the item it would displace (absent when the slot is
         * empty), and `gains` is what it wins by. Optional in the schema so an
         * older stored answer still validates; `checkPlan` reports their
         * absence rather than the parser rejecting it.
         */
        slot: z.string().optional(),
        beats: z.string().optional(),
        gains: z.array(z.string()).optional(),
        reason: z.string().default(''),
        /** "level 84", "42 more spirit" — the threshold that ends the hold. */
        until: z.string().optional(),
        /**
         * The same threshold, machine-readable, so the UI can sort holds by
         * what they cost instead of parsing `until`. Optional: an older answer
         * that only carries the free text still validates.
         */
        needs: z
          .object({
            levels: z.number().optional(),
            attributePoints: z
              .object({
                attribute: z.enum(['physique', 'cunning', 'spirit']),
                points: z.number(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  sell: z.array(z.string()).default([]),
  /**
   * Post-change **effective** resistance percentages — after the difficulty
   * penalty, before nothing else — keyed by the §3 column labels. Effective, not
   * pre-penalty: the same ambiguity the qualified-stat rule fixes in the prose
   * would otherwise live on in the machine-readable half.
   */
  projectedResistances: z.record(z.string(), z.number()).optional(),
  /**
   * The rest of the projected "after" state the task asks for in prose. Speed
   * belongs here because attack speed multiplies the whole damage profile, so a
   * swap that moves it has a consequence §4's figures do not show.
   */
  projected: z
    .object({
      attackSpeedPercent: z.number().optional(),
      castSpeedPercent: z.number().optional(),
      movementSpeedPercent: z.number().optional(),
      /** Anything the projection could not be derived for, said rather than estimated. */
      notDerivable: z.array(z.string()).default([]),
      notes: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * The "Next levels" ladder: one entry per threshold worth committing to,
   * cheapest first. `unlocks` holds dossier item ids.
   */
  nextLevels: z
    .array(
      z.object({
        threshold: z.string(),
        unlocks: z.array(z.string()).default([]),
        recommendation: z.string().default(''),
      }),
    )
    .optional(),
});

export type AdvisorPlan = z.infer<typeof advisorPlanSchema>;

/** Every fenced block in the answer, in order, with its info string. */
function fencedBlocks(text: string): { lang: string; body: string }[] {
  const blocks: { lang: string; body: string }[] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  for (const match of text.matchAll(fence)) {
    blocks.push({ lang: (match[3] ?? '').trim().toLowerCase(), body: match[4] ?? '' });
  }
  return blocks;
}

/**
 * Pull the machine-readable plan out of an answer.
 *
 * The *last* fenced json block wins: the prose above it may legitimately quote
 * JSON while explaining something, and the prompt puts the real plan last.
 * Anything that fails to parse or fails validation returns undefined — the
 * caller keeps the text and the UI degrades to prose.
 */
export function parseAdvice(text: string): AdvisorPlan | undefined {
  const candidates = fencedBlocks(text).filter((b) => b.lang === 'json' || b.lang === '');
  for (const block of candidates.reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(block.body);
    } catch {
      continue;
    }
    const parsed = advisorPlanSchema.safeParse(raw);
    if (parsed.success) return normalizePlan(parsed.data);
  }
  return undefined;
}

/**
 * Item ids are written `#a1b2c3` in the document, so the model echoes the hash
 * about half the time. Strip it once here rather than at every comparison.
 */
export function normalizeId(id: string): string {
  return id.trim().replace(/^#/, '');
}

function normalizePlan(plan: AdvisorPlan): AdvisorPlan {
  return {
    ...plan,
    verdicts: plan.verdicts.map((v) => ({
      ...v,
      itemId: normalizeId(v.itemId),
      ...(v.target !== undefined ? { target: v.verdict === 'EQUIP' ? normalizeId(v.target) : v.target.trim() } : {}),
      ...(v.targetId !== undefined ? { targetId: normalizeId(v.targetId) } : {}),
      ...(v.enablers ? { enablers: v.enablers.map(normalizeId) } : {}),
      ...(v.componentFrom !== undefined ? { componentFrom: normalizeId(v.componentFrom) } : {}),
      ...(v.fits ? { fits: v.fits.map((f) => ({ ...f, id: normalizeId(f.id) })) } : {}),
    })),
    hold: plan.hold.map((h) => ({
      ...h,
      itemId: normalizeId(h.itemId),
      ...(h.beats !== undefined ? { beats: normalizeId(h.beats) } : {}),
    })),
    sell: plan.sell.map(normalizeId),
    ...(plan.keyMoves
      ? { keyMoves: plan.keyMoves.map((m) => ({ ...m, itemIds: m.itemIds.map(normalizeId) })) }
      : {}),
    ...(plan.nextLevels
      ? { nextLevels: plan.nextLevels.map((n) => ({ ...n, unlocks: n.unlocks.map(normalizeId) })) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderOptions {
  model?: string;
  effort?: string;
  timeoutMs?: number;
  systemPrompt?: string;
}

export type ProviderFactory = (opts: ProviderOptions) => AdvisorProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(id: string, factory: ProviderFactory): void {
  registry.set(id, factory);
}

export function providerIds(): string[] {
  return [...registry.keys()];
}

/** Instantiate a provider by id, or say what the valid ids are. */
export function createProvider(id: string, opts: ProviderOptions = {}): AdvisorProvider {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(`unknown advisor provider ${JSON.stringify(id)} — known: ${providerIds().join(', ')}`);
  }
  return factory(opts);
}
