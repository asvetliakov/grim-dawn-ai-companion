/**
 * Which stored run is open — one control, rendered in two places.
 *
 * The header carries it because the advice panel is below the loadout and scrolls
 * with it: on a fourteen-slot character the panel can be entirely off screen while
 * the marks it produced are still painted on the gear, and "which run am I looking
 * at" is exactly the question that arises then. The panel carries it because that
 * is where the answer is being read.
 *
 * It is also the **only** way into a stored run. The window opens on the empty
 * state rather than reopening the newest answer, so this is not a convenience — it
 * is the door, which is why the empty state shows it with a placeholder that says
 * how many there are rather than hiding until something is selected.
 */

import type { AdviceRunRef } from '../../../shared/ipc.js';

/**
 * Whether there is anything to choose between.
 *
 * A `<select>` with one option that cannot change is a control that reads as
 * broken, so with a single stored run *already open* the caller prints its date
 * instead. With nothing open, that same single run is a real choice — the
 * placeholder is the other option — and the picker appears.
 */
export function canPickRun(history: readonly AdviceRunRef[], adviceId: string | undefined): boolean {
  return history.length > (adviceId ? 1 : 0);
}

export function RunPicker({
  history,
  adviceId,
  onSelect,
}: {
  history: readonly AdviceRunRef[];
  adviceId?: string;
  onSelect: (id: string) => void;
}): React.ReactNode {
  if (!canPickRun(history, adviceId)) return null;
  return (
    <select
      className="advice-runs"
      value={adviceId ?? ''}
      onChange={(e) => {
        // The placeholder is not a destination: going back to the empty state is
        // `New run`, and having two controls do it would make one of them a
        // mystery.
        if (e.target.value) onSelect(e.target.value);
      }}
      title="Answers already paid for. Every run is kept — each one is minutes of model time and real money."
    >
      {!adviceId && (
        <option value="">
          {history.length} saved answer{history.length === 1 ? '' : 's'} — open one
        </option>
      )}
      {history.map((ref, i) => (
        <option key={ref.id} value={ref.id}>
          {runLabel(ref, i === 0)}
        </option>
      ))}
    </select>
  );
}

/**
 * One line in the picker.
 *
 * The question first when there was one: two runs on the same save differ by what
 * was asked far more usefully than by two timestamps half an hour apart. The cost
 * is there because it is what makes a stored answer worth reopening rather than
 * re-asking.
 */
export function runLabel(ref: AdviceRunRef, newest: boolean): string {
  const bits = [
    ref.question ? `“${ref.question}”` : `${ref.verdicts} verdicts`,
    new Date(ref.generatedAt).toLocaleString(),
    ref.costUsd > 0 ? `$${ref.costUsd.toFixed(2)}` : '',
    ref.warnings > 0 ? `${ref.warnings} warning(s)` : '',
    newest ? 'newest' : '',
  ];
  return bits.filter(Boolean).join(' · ');
}
