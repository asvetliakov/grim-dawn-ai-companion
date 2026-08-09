/**
 * Everything the character can reach that is not worn.
 *
 * Four tabs, because these are four genuinely different containers: the bags
 * the character carries, the personal stash, the account-wide transfer stash,
 * and the reagent store — a list rather than a grid, and where loose components
 * actually live, which took five stages to notice.
 *
 * The panel answers reveal requests from the loadout: clicking a proposed item
 * switches to the tab and page holding it and lights it up.
 */

import { useEffect, useState } from 'react';

import type { ItemPosition, UiGrid, UiItem, UiSnapshot } from '../../../shared/ipc.js';
import type { ActionKind } from '../advice.js';
import { AdviceBadge, badgeForKind, primaryMark } from '../badges.js';
import { useHighlight } from '../highlight.js';
import { rarityClass } from '../rarity.js';
import { useTooltip } from '../tooltip.js';
import { ItemArt } from './ItemFace.js';
import { ItemGrid } from './ItemGrid.js';

export type TabKey = 'inventory' | 'stash' | 'transfer' | 'materials';

const TAB_FOR: Record<ItemPosition['kind'], TabKey | undefined> = {
  inventory: 'inventory',
  stash: 'stash',
  transfer: 'transfer',
  materials: 'materials',
  equipment: undefined,
  weapon: undefined,
};

export function ContainerPanel({
  snapshot,
  initialTab = 'inventory',
}: {
  snapshot: UiSnapshot;
  /** Which container to open on. Only a story ever sets it. */
  initialTab?: TabKey;
}): React.ReactNode {
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [page, setPage] = useState(0);
  const { reveal, isHighlighted, actionFor, highlightKind } = useHighlight();
  // A tab lights for the item being pointed at and counts the ones the plan
  // asks you to act on — "there are three in here" is the reason to open it.
  const marked = (item: UiItem): boolean => isHighlighted(item.docId) || actionFor(item.docId) !== undefined;

  // A reveal is a request to *look at* an item, so it moves the panel. The
  // nonce is in the dependency list so clicking the same proposal twice — after
  // wandering off to another tab — still brings you back.
  useEffect(() => {
    if (!reveal) return;
    const target = TAB_FOR[reveal.position.kind];
    if (!target) return;
    setTab(target);
    const p = reveal.position;
    if (p.kind === 'stash' || p.kind === 'transfer') setPage(p.tab);
  }, [reveal?.nonce, reveal]);

  const tabs: { key: TabKey; label: string; count: number; lit: boolean; todo: TodoCount }[] = [
    {
      key: 'inventory',
      label: 'Inventory',
      count: countAll(snapshot.bags),
      lit: holds(snapshot.bags, marked),
      todo: todoIn(snapshot.bags.flatMap((g) => g.items), actionFor),
    },
    {
      key: 'stash',
      label: 'Stash',
      count: countAll(snapshot.personalStash),
      lit: holds(snapshot.personalStash, marked),
      todo: todoIn(snapshot.personalStash.flatMap((g) => g.items), actionFor),
    },
    {
      key: 'transfer',
      label: 'Transfer',
      count: countAll(snapshot.transferStash),
      lit: holds(snapshot.transferStash, marked),
      todo: todoIn(snapshot.transferStash.flatMap((g) => g.items), actionFor),
    },
    {
      key: 'materials',
      label: 'Materials',
      count: snapshot.materials.length,
      lit: snapshot.materials.some(marked),
      todo: todoIn(snapshot.materials, actionFor),
    },
  ];

  const grids = tab === 'stash' ? snapshot.personalStash : tab === 'transfer' ? snapshot.transferStash : [];
  // Nothing is marked without a run, so the legend that explains the marks has
  // nothing to explain either. It appears with them and goes away with them.
  const totals = tabs.reduce(
    (sum, t) => {
      for (const { kind } of ACTIONS) sum[kind] += t.todo[kind];
      return sum;
    },
    { equip: 0, hold: 0, destroy: 0, sell: 0 } as TodoCount,
  );
  const marks = ACTIONS.filter(({ kind }) => totals[kind] > 0);

  return (
    <div className="container-panel">
      <div className="tab-strip">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? 'selected' : ''} ${t.lit ? 'lit' : ''}`}
            onClick={() => {
              setTab(t.key);
              setPage(0);
            }}
          >
            {t.label} <span className="tab-count">{t.count}</span>
            {/* One badge per kind of action in here, so "two to equip" and "two
                to keep for later" do not read as the same errand. */}
            {ACTIONS.map(({ kind, title }) =>
              t.todo[kind] > 0 ? (
                <span className={`tab-todo action-${kind}`} key={kind} title={title}>
                  {t.todo[kind]}
                </span>
              ) : null,
            )}
          </button>
        ))}
      </div>

      {/* The marks and the tab counts are the only things in the window that mean
          something without being hovered, so they are the only ones that need
          saying out loud. The same swatch, drawn the same way, in the same
          colours as the marks themselves.

          Each entry is also the control for its own count: hovering "sell or
          salvage 13" lights those thirteen cells. The number answers "is it worth
          opening this tab", and *which thirteen* is the question that comes
          straight after it — previously answerable only by hovering the advice
          table row by row. Scoped to the containers, which is what the legend is
          counting; see `litKind` in `highlight.tsx`. */}
      {marks.length > 0 && (
        <div className="mark-legend">
          {marks.map(({ kind, legend, title }) => (
            <button
              type="button"
              className={`legend-item action-${kind}`}
              key={kind}
              title={`Highlight everything ${title}`}
              onMouseEnter={() => highlightKind(kind)}
              onMouseLeave={() => highlightKind(null)}
              onFocus={() => highlightKind(kind)}
              onBlur={() => highlightKind(null)}
            >
              <span className="legend-flag">{badgeForKind(kind).glyph}</span>
              {legend}
              <span className="legend-count">{totals[kind]}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'inventory' && (
        <div className="bag-strip">
          {snapshot.bags.map((bag, i) => (
            <div className="bag" key={i}>
              <div className="bag-label">{bag.label}</div>
              <ItemGrid grid={bag} />
            </div>
          ))}
          {snapshot.bags.length === 0 && <Empty what="carried bags" />}
        </div>
      )}

      {(tab === 'stash' || tab === 'transfer') && (
        <div className="paged-grid">
          <div className="page-strip">
            {grids.map((grid, i) => (
              <button
                key={i}
                type="button"
                className={`page-tab ${i === page ? 'selected' : ''} ${grid.items.some(marked) ? 'lit' : ''}`}
                onClick={() => setPage(i)}
              >
                {grid.label} <span className="tab-count">{grid.items.length}</span>
              </button>
            ))}
          </div>
          {grids[page] ? <ItemGrid grid={grids[page]!} /> : <Empty what="tabs" />}
        </div>
      )}

      {tab === 'materials' && <MaterialList items={snapshot.materials} />}
    </div>
  );
}

/**
 * The reagent store.
 *
 * Components are sorted ahead of plain crafting materials, because a component
 * is a decision — it goes in a socket and changes the build — while a stack of
 * Aether Crystals is only ever an input. Each row states what its component
 * actually does; a list of names alone makes the reader hover forty times to
 * find the one they want.
 */
function MaterialList({ items }: { items: UiItem[] }): React.ReactNode {
  const tooltip = useTooltip();
  const { isHighlighted, actionFor, adviceFor, highlight, litKind } = useHighlight();
  if (items.length === 0) return <Empty what="materials" />;

  const effect = (item: UiItem): string => item.tooltip.blocks.flatMap((b) => b.lines).join(' · ');
  const sorted = [...items].sort((a, b) => {
    const byKind = Number(effect(b).length > 0) - Number(effect(a).length > 0);
    return byKind !== 0 ? byKind : a.display.localeCompare(b.display);
  });

  return (
    <div className="material-list">
      {sorted.map((item) => {
        const action = actionFor(item.docId);
        const mark = primaryMark(adviceFor(item.docId));
        // Same two ways to be lit as a grid cell: the pointer, or the legend
        // pointing at this whole kind of action.
        const lit = isHighlighted(item.docId) || (action !== undefined && action === litKind);
        return (
          <div
            className={`material-row ${lit ? 'highlighted' : ''} ${action ? `action action-${action}` : ''}`}
            key={item.docId}
            // The whole row is the hover target, not just the icon — the name is
            // what the eye lands on and the icon is 32 px of it.
            onMouseEnter={(e) => {
              tooltip.show(e.currentTarget, item);
              highlight(item.docId);
            }}
            onMouseLeave={() => {
              tooltip.hide();
              highlight(null);
            }}
          >
            <div className="material-art">
              <ItemArt item={item} />
              {mark && <AdviceBadge mark={mark} />}
            </div>
            <div className="material-text">
              <span className={`material-name ${rarityClass(item.rarity)}`}>{item.display}</span>
              {effect(item) && <span className="material-effect">{effect(item)}</span>}
            </div>
            <span className="material-count">×{item.stackCount}</span>
          </div>
        );
      })}
    </div>
  );
}

function Empty({ what }: { what: string }): React.ReactNode {
  return <div className="empty-note">no {what} in this save</div>;
}

function countAll(grids: UiGrid[]): number {
  return grids.reduce((n, g) => n + g.items.length, 0);
}

/** Whether a container holds anything marked — the tab's own dot. */
function holds(grids: UiGrid[], marked: (item: UiItem) => boolean): boolean {
  return grids.some((g) => g.items.some(marked));
}

type TodoCount = Record<ActionKind, number>;

/**
 * `title` is the hover text on a tab's count; `legend` is the same thing said
 * once, under the tabs. Two phrasings because they are read in different
 * places: on a count the subject is the number, in the legend it is the mark.
 */
const ACTIONS: readonly { kind: ActionKind; title: string; legend: string }[] = [
  { kind: 'equip', title: 'to equip now', legend: 'equip now' },
  { kind: 'hold', title: 'to keep for a level or attribute threshold', legend: 'keep for later' },
  { kind: 'destroy', title: 'destroyed by an extraction', legend: 'destroyed by an extraction' },
  { kind: 'sell', title: 'to sell or salvage', legend: 'sell or salvage' },
];

/** How many items in here the plan asks you to act on, by kind of action. */
function todoIn(items: UiItem[], actionFor: (docId: string) => ActionKind | undefined): TodoCount {
  const out: TodoCount = { equip: 0, hold: 0, destroy: 0, sell: 0 };
  for (const item of items) {
    const kind = actionFor(item.docId);
    if (kind) out[kind]++;
  }
  return out;
}
