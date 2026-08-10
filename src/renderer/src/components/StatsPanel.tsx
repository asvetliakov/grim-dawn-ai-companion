/**
 * The character sheet.
 *
 * Every number comes from `CharacterAggregate` unchanged, which is what makes
 * `npm run cli -- aggregates` a check on this panel rather than a second
 * opinion. Three things are shown the way the game works rather than the way it
 * is usually summarised:
 *
 * - the difficulty penalty is **per resistance** (Ultimate takes nothing off
 *   Physical), so it gets its own column instead of a footnote;
 * - armour is **localized** — six body parts, each meeting a hit alone — so
 *   there is no total, only alternatives and their hit weights;
 * - speeds are rates against a cap, with the headroom stated, because a `+%`
 *   past the cap is worth exactly nothing.
 *
 * When an advice run exists the plan's projected figures arrive as an extra
 * column with the delta coloured. The plan states *effective* resistances —
 * post-penalty — so they line up with the column they are compared against and
 * not with the pre-penalty one, which is the ambiguity the dossier's
 * qualified-stat rule exists to kill.
 */

import type { AdviseEnvelope, PlanProjection, UiStats } from '../../../shared/ipc.js';
import { projectedResistances } from '../advice.js';
import { statClass } from '../statColors.js';

const round = (n: number): string => String(Math.round(n));
const signed = (n: number): string => (n < 0 ? round(n) : `+${round(n)}`);

export function StatsPanel({
  stats,
  advice,
}: {
  stats: UiStats;
  advice: AdviseEnvelope | null;
}): React.ReactNode {
  const projected = projectedResistances(advice);
  const projectedSpeed = advice?.plan?.projected;
  // The tool-computed projection, when the stored run carries one. It wins over
  // the model-authored figures everywhere both exist.
  const projection = advice?.projection;
  const hasProjection = projected.size > 0;

  return (
    <div className="stats-panel">
      <section className="stats-section">
        <h2>
          Level {stats.level} {stats.className}
        </h2>
        <div className="stats-sub">
          {stats.difficulty}
          {stats.hardcore ? ' · hardcore' : ''} · {stats.wielding.mode}
          {stats.wielding.mainHand
            ? ` (${stats.wielding.mainHand}${stats.wielding.offHand ? ` + ${stats.wielding.offHand}` : ''})`
            : ''}
        </div>
        {stats.wielding.enablers.length > 0 && (
          <div className="stats-note">dual wield enabled by {stats.wielding.enablers.join('; ')}</div>
        )}
      </section>

      <section className="stats-section">
        <h3>Attributes</h3>
        {stats.attributes.map((attr) => {
          // The computed projection knows the attribute totals — outgoing gear
          // takes its `+Attribute` with it, which is what the models were
          // hand-computing in prose notes before the defense block existed.
          const projectedAttr = projection?.defense?.attributes[attr.key];
          const attrDelta = projectedAttr ? projectedAttr.after - attr.total : 0;
          return (
            <Row
              key={attr.key}
              label={attr.label}
              labelClass="stat-attribute"
              value={round(attr.total)}
              detail={[
                `${round(attr.base)} base`,
                attr.flat ? `${signed(attr.flat)} gear/skills` : '',
                attr.percent ? `${signed(attr.percent)}%` : '',
              ]
                .filter(Boolean)
                .join(', ')}
              {...(projectedAttr
                ? { after: `${round(projectedAttr.after)} (${signed(attrDelta)})`, afterClass: deltaClass(attrDelta) }
                : {})}
            />
          );
        })}
        <Row label="Health" labelClass="stat-health" value={round(stats.health)} detail={bonus(stats.healthBonus)} />
        <Row label="Energy" labelClass="stat-energy" value={round(stats.energy)} />
        <Row
          label="OA"
          labelClass="stat-ability"
          value={signed(stats.offensiveAbility.flat)}
          detail={contribution(stats.offensiveAbility)}
        />
        <Row
          label="DA"
          labelClass="stat-ability"
          value={signed(stats.defensiveAbility.flat)}
          detail={contribution(stats.defensiveAbility)}
        />
        {stats.unspent.attribute > 0 && (
          <Row label="Unspent" value={`${stats.unspent.attribute} pt`} detail="attribute points" />
        )}
      </section>

      <section className="stats-section">
        <h3>Resistances — {stats.difficulty}</h3>
        <table className="resist-table">
          <thead>
            <tr>
              <th />
              <th>perm</th>
              <th>buffed</th>
              <th>pen</th>
              <th>eff</th>
              <th>cap</th>
              {hasProjection && <th className="projected-col">after</th>}
            </tr>
          </thead>
          <tbody>
            {stats.resistances.map((row) => {
              const after = projected.get(row.label.toLowerCase());
              const delta = after === undefined ? 0 : after - row.effective;
              // Where the computed projection knows both bands and they differ,
              // the split is worth a hover: "80, of which 30 is maintainable
              // buffs" is a different fact from a permanent 80.
              const computed = projection?.resistances.find(
                (r) => r.label.toLowerCase() === row.label.toLowerCase(),
              );
              const maintainablePart =
                computed?.afterPermanent === undefined ? 0 : computed.after - computed.afterPermanent;
              return (
                <tr key={row.key} className={row.effective < row.cap ? 'short' : ''}>
                  {/* The same colour the tooltips give this type, so a row here
                      and a line there are recognisably about one thing. The
                      lookup takes the finished label for the same reason. */}
                  <th scope="row" className={statClass(`${row.label} Resistance`)}>
                    {row.label}
                  </th>
                  <td>{round(row.permanent)}</td>
                  <td>{round(row.withMaintainable)}</td>
                  <td className="penalty">{row.penalty ? round(row.penalty) : '—'}</td>
                  <td className="effective">{round(row.effective)}</td>
                  <td>{round(row.cap)}</td>
                  {hasProjection && (
                    <td
                      className={`projected-col ${deltaClass(delta)}`}
                      {...(maintainablePart !== 0 && computed
                        ? {
                            title: `of which ${signed(maintainablePart)} is maintainable buffs — permanent-band ${round(computed.afterPermanent ?? 0)}`,
                          }
                        : {})}
                    >
                      {after === undefined ? '—' : `${round(after)} (${signed(delta)})`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {stats.secondaryResistances.length > 0 && (
          <div className="stats-note">
            {stats.secondaryResistances.map((s) => `${s.label} ${round(s.value)}%`).join(' · ')}
          </div>
        )}
      </section>

      <section className="stats-section">
        {/* The explanation is on the heading rather than under it. It is a fact
            about the engine that does not change between characters or between
            refreshes, and a paragraph of it above six numbers is read once and
            then skipped past forever. */}
        <h3 title="The engine rolls one body part per hit and that part meets the hit alone, so these are alternatives — not a total.">
          Armour <span className="stats-aside">{armorMath(stats)}</span>
        </h3>
        {stats.armor.map((part) => (
          <Row
            key={part.slot}
            label={part.slot}
            value={round(part.effective)}
            detail={`piece ${round(part.piece)} · ${part.hitChance}% of hits`}
            className={part.weakest ? 'weakest' : ''}
            {...(part.weakest ? { tag: 'weakest' } : {})}
          />
        ))}
        <Row
          label="Mean"
          labelClass="stat-armor"
          value={round(stats.armorAverage)}
          detail={`hit-weighted${stats.armorClasses.length ? ` · ${stats.armorClasses.join('/')} armour` : ''}`}
          {...afterProp(projection?.defense?.armorMean, stats.armorAverage)}
        />
        <Row
          label="Absorption"
          labelClass="stat-armor"
          value={`${stats.absorption.toFixed(1)}%`}
          // Absorption is a share of the damage the rating above meets, and it
          // is multiplicative on its own base — flat +Armor never touches it.
          detail={`of what a part stops · ${stats.absorptionBase}% base, multiplicative`}
          {...afterProp(projection?.defense?.absorption, stats.absorption, (v) => `${v.toFixed(1)}%`)}
        />
        {stats.block && (
          <Row label="Block" value={`${round(stats.block.chance)}%`} detail={`${round(stats.block.amount)} absorbed`} />
        )}
      </section>

      <section className="stats-section">
        <h3>Speed</h3>
        {stats.speeds.map((line) => {
          const after = computedSpeedFor(line.label, projection) ?? projectedSpeedFor(line.label, projectedSpeed);
          const delta = after === undefined ? 0 : after - line.percent;
          return (
            <Row
              key={line.label}
              label={line.label}
              labelClass="stat-speed"
              value={`${round(line.percent)}%`}
              detail={
                `${line.rate.toFixed(2)} ${line.unit}` +
                (line.percentWithMaintainable !== line.percent
                  ? ` → ${round(line.percentWithMaintainable)}% buffed`
                  : '') +
                (line.wasted > 0
                  ? ` · ${round(line.wasted)}pp past the ${round(line.cap)}% cap`
                  : ` · ${round(line.headroom)}pp headroom`)
              }
              className={line.wasted > 0 ? 'wasted' : ''}
              {...(after !== undefined
                ? { after: `${round(after)}% (${signed(delta)})`, afterClass: deltaClass(delta) }
                : {})}
            />
          );
        })}
        {!projection && projectedSpeed && projectedSpeed.notDerivable.length > 0 && (
          <div className="stats-note">not projected: {projectedSpeed.notDerivable.join('; ')}</div>
        )}
      </section>

      <DamageSection stats={stats} projection={projection} />

      <details className="stats-exclusions">
        <summary>What these numbers leave out ({stats.exclusions.length})</summary>
        <ul>
          {stats.exclusions.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * The build's damage profile — the same vocabulary as the dossier's §4: per-type
 * `+%` and post-conversion flat pools, never a DPS number. With a stored run
 * whose projection is computed, each row gains "after" columns, and the skill
 * ranks the plan moves are stated underneath, because they are what explains
 * the deltas.
 */
function DamageSection({
  stats,
  projection,
}: {
  stats: UiStats;
  projection: PlanProjection | undefined;
}): React.ReactNode {
  const d = stats.damage;
  const after = new Map((projection?.damage ?? []).map((row) => [row.key, row]));
  const hasAfter = after.size > 0;

  // Union: a type the plan's conversions create is absent from the before-side.
  const rows = d.entries.map((e) => ({ ...e, projected: after.get(e.key) }));
  const known = new Set(d.entries.map((e) => e.key));
  for (const row of projection?.damage ?? []) {
    if (!known.has(row.key) && (row.percentAfter || row.flatAfter)) {
      rows.push({
        key: row.key,
        label: row.label,
        overTime: row.overTime,
        percent: row.percentBefore,
        flat: row.flatBefore,
        projected: row,
      });
    }
  }
  if (!rows.length) return null;

  const notes: string[] = [];
  if (projection) {
    for (const s of projection.skipped) notes.push(`not projected: ${s.slot} ${s.verdict} — ${s.reason}`);
    notes.push(...projection.notes);
  }

  return (
    <section className="stats-section">
      <h3 title="Per-type +% modifiers and post-conversion flat pools, as the dossier ranks them — fit, not DPS.">
        Damage
      </h3>
      <table className="resist-table damage-table">
        <thead>
          <tr>
            <th />
            <th>+%</th>
            <th>flat</th>
            {hasAfter && <th className="projected-col">+% after</th>}
            {hasAfter && <th>flat after</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const p = row.projected;
            const percentDelta = p ? p.percentAfter - row.percent : 0;
            const flatDelta = p ? p.flatAfter - row.flat : 0;
            return (
              <tr key={row.key}>
                <th scope="row" className={statClass(`${row.label} Damage`)}>
                  {row.label}
                </th>
                <td>{row.percent ? `${signed(row.percent)}%` : '—'}</td>
                <td>{row.flat ? round(row.flat) : '—'}</td>
                {hasAfter && (
                  <td className={`projected-col ${deltaClass(percentDelta)}`}>
                    {p ? `${signed(p.percentAfter)}% (${signed(percentDelta)})` : '—'}
                  </td>
                )}
                {hasAfter && (
                  <td className={deltaClass(flatDelta)}>
                    {p ? `${round(p.flatAfter)} (${signed(flatDelta)})` : '—'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {(d.totalPercent !== 0 || d.mainAttack || d.composition.length > 0) && (
        <div className="stats-note">
          {[
            d.totalPercent ? `${signed(d.totalPercent)}% Total Damage` : '',
            d.mainAttack ? `main attack: ${d.mainAttack}` : '',
            d.composition.length
              ? `weapon attack: ${d.composition.map((c) => `${c.share}% ${c.label}`).join(' · ')}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {projection?.payload && (
        <div className={`stats-note payload-note ${deltaClass(projection.payload.after - projection.payload.before)}`}>
          payload index {payloadFmt(projection.payload.before)} → {payloadFmt(projection.payload.after)} (
          {payloadDelta(projection.payload)}) — flat pools × their +% columns; an index, not DPS
        </div>
      )}
      {projection && projection.skillRanks.length > 0 && (
        <div className="stats-note">
          after plan: {projection.skillRanks.map((r) => `${r.skill} ${r.before} → ${r.after}`).join(' · ')}
        </div>
      )}
      {notes.map((note, i) => (
        <div key={i} className="stats-note">
          {note}
        </div>
      ))}
    </section>
  );
}

/** `41200` → `41.2k`: the index is compared, not read to the unit. */
function payloadFmt(v: number): string {
  return Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(1)}k` : round(v);
}

/** The relative cost/gain — the way the tolerance rule states it. */
function payloadDelta(pair: { before: number; after: number }): string {
  if (!pair.before) return signed(pair.after - pair.before);
  const pct = ((pair.after - pair.before) / pair.before) * 100;
  return `${pct < 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%`;
}

/** The computed projection's speed for a sheet line, matched by channel. */
function computedSpeedFor(label: string, projection: PlanProjection | undefined): number | undefined {
  if (!projection) return undefined;
  const key = label.toLowerCase();
  const channel = key.startsWith('attack')
    ? 'attack'
    : key.startsWith('cast')
      ? 'cast'
      : key.startsWith('move')
        ? 'movement'
        : undefined;
  return projection.speeds.find((s) => s.key === channel)?.after;
}

/** Speed lines are labelled by the aggregate; the plan names them by channel. */
function projectedSpeedFor(
  label: string,
  projected: { attackSpeedPercent?: number; castSpeedPercent?: number; movementSpeedPercent?: number } | undefined,
): number | undefined {
  if (!projected) return undefined;
  const key = label.toLowerCase();
  if (key.startsWith('attack')) return projected.attackSpeedPercent;
  if (key.startsWith('cast')) return projected.castSpeedPercent;
  if (key.startsWith('move')) return projected.movementSpeedPercent;
  return undefined;
}

function deltaClass(delta: number): string {
  return delta > 0 ? 'better' : delta < 0 ? 'worse' : 'same';
}

/** `after`/`afterClass` for a Row, from a projected before/after pair. */
function afterProp(
  pair: { before: number; after: number } | undefined,
  current: number,
  fmt: (v: number) => string = round,
): { after: string; afterClass: string } | Record<string, never> {
  if (!pair) return {};
  const delta = pair.after - current;
  return { after: `${fmt(pair.after)} (${signed(delta)})`, afterClass: deltaClass(delta) };
}

function Row({
  label,
  value,
  detail,
  className = '',
  labelClass = '',
  after,
  afterClass,
  tag,
}: {
  label: string;
  value: string;
  detail?: string;
  className?: string;
  /** The type colour for the label, when the row is about a typed stat. */
  labelClass?: string;
  after?: string;
  afterClass?: string;
  /** A word about the row itself — `weakest`. Coloured, not merely appended. */
  tag?: string;
}): React.ReactNode {
  return (
    <div className={`stat-row ${className}`}>
      <span className={`stat-label ${labelClass}`}>{label}</span>
      <span className="stat-value">{value}</span>
      {after && <span className={`stat-after ${afterClass ?? ''}`}>{after}</span>}
      {detail && (
        <span className="stat-detail">
          {tag && <span className="stat-tag">{tag}</span>}
          {detail}
        </span>
      )}
    </div>
  );
}

function bonus(b: { flat: number; percent: number }): string {
  return [b.flat ? `${signed(b.flat)} flat` : '', b.percent ? `${signed(b.percent)}%` : '']
    .filter(Boolean)
    .join(', ');
}

/**
 * What every body part gets on top of the piece it wears: `per body part, each
 * +482 then ×1.17`.
 *
 * Flat `+Armor` from rings, components and skills is added to **every** part
 * before the percentage multiplies, so it is a property of the whole list — it
 * belongs on the heading, said once, in the words "each" and "part". Stated as
 * a note *underneath* the six rows it read as a footnote about the Absorption
 * line below it, which is the one number it has nothing to do with.
 */
function armorMath(stats: UiStats): string {
  const terms = [
    stats.armorBonus.flat ? `${signed(stats.armorBonus.flat)}` : '',
    stats.armorBonus.percent ? `×${(1 + stats.armorBonus.percent / 100).toFixed(2)}` : '',
  ].filter(Boolean);
  return terms.length ? `per body part — each ${terms.join(' then ')}` : 'per body part';
}

/** OA/DA are gear-and-skill contributions only; the engine's own floor is not modelled. */
function contribution(v: { flat: number; percent: number }): string {
  return [v.percent ? `${signed(v.percent)}%` : '', 'gear/skill contributions only'].filter(Boolean).join(' · ');
}
