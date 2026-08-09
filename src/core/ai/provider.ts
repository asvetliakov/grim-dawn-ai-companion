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

export interface AdvisorProvider {
  readonly id: string;
  /** Cheap liveness check — a backend that cannot run should say so, not throw later. */
  available(): Promise<boolean>;
  advise(req: AdvisorRequest, signal?: AbortSignal): Promise<AdvisorResult>;
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

const verdictSchema = z.object({
  slot: z.string(),
  /** Dossier id of what is in the slot; empty string when the slot is empty. */
  itemId: z.string().default(''),
  verdict: z.enum(VERDICTS),
  /** EQUIP: the candidate's item id. BUY/CRAFT/RE-AUGMENT/…: an exact dossier name. */
  target: z.string().optional(),
  /** Item ids whose joint equip is what satisfies this move's requirements. */
  enablers: z.array(z.string()).optional(),
  /** Extraction source: the host item id, which the extraction DESTROYS. */
  componentFrom: z.string().optional(),
  reason: z.string().default(''),
});

export const advisorPlanSchema = z.object({
  verdicts: z.array(verdictSchema).default([]),
  hold: z
    .array(
      z.object({
        itemId: z.string(),
        reason: z.string().default(''),
        /** "level 84", "42 more spirit" — the threshold that ends the hold. */
        until: z.string().optional(),
      }),
    )
    .default([]),
  sell: z.array(z.string()).default([]),
  projectedResistances: z.record(z.string(), z.number()).optional(),
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
      ...(v.enablers ? { enablers: v.enablers.map(normalizeId) } : {}),
      ...(v.componentFrom !== undefined ? { componentFrom: normalizeId(v.componentFrom) } : {}),
    })),
    hold: plan.hold.map((h) => ({ ...h, itemId: normalizeId(h.itemId) })),
    sell: plan.sell.map(normalizeId),
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
