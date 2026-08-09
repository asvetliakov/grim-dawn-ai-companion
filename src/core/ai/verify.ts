/**
 * Mechanical checks on the advisor's structured plan.
 *
 * These are the claims a model can get wrong in ways a human reader will not
 * notice: an item id that exists nowhere in the dossier, a component proposed
 * for a slot its use-on restriction rejects, an extraction host that the plan
 * then also tells you to keep. Each is decidable from the document plus the
 * database, so it is decided here rather than trusted.
 *
 * The result is warnings, never a rejection. The prose is usually still worth
 * reading, and a plan that trips one check is a signal to the user (and to
 * whoever tunes the prompt), not an error to swallow the answer over.
 */

import type { DbItem } from '../db/types.js';
import type { ResolvedItem } from '../resolve.js';
import { SOCKET_VERDICTS, type AdvisorPlan } from './provider.js';

export type PlanWarningKind =
  | 'unknown-id'
  | 'unknown-socketable'
  | 'missing-target'
  | 'destroyed-host'
  | 'illegal-socket';

export interface PlanWarning {
  kind: PlanWarningKind;
  message: string;
}

export interface PlanCheckInput {
  /** Every id the context document defined, to the item it named. */
  itemsById: ReadonlyMap<string, ResolvedItem>;
  /**
   * Components and augments the document named, keyed by normalized display
   * name — the census in §8, everything installed in §5/§7, and the faction
   * stock in §9. A socketable outside this map was not offered to the model.
   */
  socketables: ReadonlyMap<string, DbItem>;
}

/**
 * The use-on flag a template class corresponds to: `ArmorProtective_Head` →
 * `head`, `WeaponMelee_Sword2h` → `sword2h`. The two vocabularies were built
 * from the same 23 gear families, so the suffix *is* the flag.
 */
export function slotFlagForClass(templateClass: string | undefined): string | undefined {
  if (!templateClass) return undefined;
  const suffix = templateClass.split('_')[1];
  return suffix ? suffix.toLowerCase() : undefined;
}

/** Display names arrive wrapped in whatever markdown the answer used. */
export function normalizeName(name: string): string {
  return name
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function checkPlan(plan: AdvisorPlan, input: PlanCheckInput): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const warn = (kind: PlanWarningKind, message: string): void => {
    warnings.push({ kind, message });
  };

  const known = (id: string, where: string): boolean => {
    if (!id) return false;
    if (input.itemsById.has(id)) return true;
    warn('unknown-id', `${where} refers to \`#${id}\`, which is not an item id in the document`);
    return false;
  };

  for (const v of plan.verdicts) {
    const where = `${v.verdict} on ${v.slot}`;
    if (v.itemId) known(v.itemId, where);
    if (v.verdict === 'EQUIP') {
      if (!v.target) warn('missing-target', `${where} names no candidate to equip`);
      else known(v.target, `${where} target`);
    }
    for (const enabler of v.enablers ?? []) known(enabler, `${where} enabler`);
    if (v.componentFrom) known(v.componentFrom, `${where} extraction host`);
    if (SOCKET_VERDICTS.includes(v.verdict)) checkSocket(v, input, warn);
  }

  for (const h of plan.hold) known(h.itemId, `HOLD entry`);
  for (const id of plan.sell) known(id, `SELL entry`);

  // Extraction destroys the host. A destroyed item cannot also be kept, held,
  // sold or re-equipped — the plan has to spend it exactly once.
  const hosts = new Map<string, string>();
  for (const v of plan.verdicts) {
    if (v.componentFrom) hosts.set(v.componentFrom, `${v.verdict} on ${v.slot}`);
  }
  for (const [host, source] of hosts) {
    const name = input.itemsById.get(host)?.display ?? `#${host}`;
    for (const v of plan.verdicts) {
      if (v.itemId === host) {
        warn(
          'destroyed-host',
          `${name} is destroyed by the extraction in ${source}, but also carries a ${v.verdict} verdict on ${v.slot}`,
        );
      }
      if (v.verdict === 'EQUIP' && v.target === host) {
        warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but ${v.slot} is told to equip it`);
      }
    }
    if (plan.hold.some((h) => h.itemId === host)) {
      warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but also appears in HOLD`);
    }
    if (plan.sell.includes(host)) {
      warn('destroyed-host', `${name} is destroyed by the extraction in ${source}, but also appears in SELL`);
    }
  }

  return warnings;
}

function checkSocket(
  v: AdvisorPlan['verdicts'][number],
  input: PlanCheckInput,
  warn: (kind: PlanWarningKind, message: string) => void,
): void {
  if (!v.target) {
    warn('missing-target', `${v.verdict} on ${v.slot} names no component or augment`);
    return;
  }
  const socketable = input.socketables.get(normalizeName(v.target));
  if (!socketable) {
    warn(
      'unknown-socketable',
      `${v.verdict} on ${v.slot} names "${v.target}", which is not a component or augment the document offered`,
    );
    return;
  }

  // Without an item in the slot there is nothing to socket into — and without a
  // recorded restriction there is nothing to check. Both are silent: the first
  // is the model's problem to explain, the second is a data gap, not a fault.
  const host = v.itemId ? input.itemsById.get(v.itemId) : undefined;
  const flag = slotFlagForClass(host?.base?.slot);
  if (!flag || !socketable.allowedSlots?.length) return;

  if (!socketable.allowedSlots.includes(flag)) {
    warn(
      'illegal-socket',
      `${socketable.name} cannot go on ${host?.display ?? v.slot} — its use-on restriction does not accept ${flag}`,
    );
  }
}
