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

import type { AdviseEnvelope, UiStats } from '../../../shared/ipc.js';
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
        {stats.attributes.map((attr) => (
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
          />
        ))}
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
                    <td className={`projected-col ${deltaClass(delta)}`}>
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
        />
        <Row
          label="Absorption"
          labelClass="stat-armor"
          value={`${stats.absorption.toFixed(1)}%`}
          // Absorption is a share of the damage the rating above meets, and it
          // is multiplicative on its own base — flat +Armor never touches it.
          detail={`of what a part stops · ${stats.absorptionBase}% base, multiplicative`}
        />
        {stats.block && (
          <Row label="Block" value={`${round(stats.block.chance)}%`} detail={`${round(stats.block.amount)} absorbed`} />
        )}
      </section>

      <section className="stats-section">
        <h3>Speed</h3>
        {stats.speeds.map((line) => {
          const after = projectedSpeedFor(line.label, projectedSpeed);
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
        {projectedSpeed && projectedSpeed.notDerivable.length > 0 && (
          <div className="stats-note">not projected: {projectedSpeed.notDerivable.join('; ')}</div>
        )}
      </section>

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
