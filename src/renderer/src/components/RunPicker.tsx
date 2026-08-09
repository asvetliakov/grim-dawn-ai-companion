/**
 * Which stored run is open — one control, in the header and only there.
 *
 * It used to render in the advice panel as well, and the duplication earned
 * nothing: the header is always on screen while the panel scrolls with the
 * loadout, so the copy that was sometimes invisible was also the one nobody
 * needed. One control, one place, always the same place.
 *
 * It is also the **only** way into a stored run. The window opens on the empty
 * state rather than reopening the newest answer, so this is not a convenience —
 * it is the door. Which is why it is **always rendered once any run exists**,
 * whether or not one is open: the first version hid itself when there was
 * "nothing to choose", and with exactly one stored run that meant opening it
 * removed the picker — and with it every way back to the empty state short of
 * restarting the app.
 *
 * The fresh session is a real entry, not a placeholder. `New run` is the state
 * the window opens in, so the list reads as what it is: the fresh session,
 * then every answer already paid for. Picking `New run` does what the button
 * of the same name does — puts the open answer away and selects nothing.
 */

import type { AdviceRunRef } from '../../../shared/ipc.js';

/** Whether the picker has anything to say: any stored run at all. */
export function canPickRun(history: readonly AdviceRunRef[]): boolean {
  return history.length > 0;
}

export function RunPicker({
  history,
  adviceId,
  onSelect,
  onNewRun,
}: {
  history: readonly AdviceRunRef[];
  adviceId?: string;
  onSelect: (id: string) => void;
  /** Called when `New run` is picked while an answer is open. Deletes nothing. */
  onNewRun?: () => void;
}): React.ReactNode {
  if (!canPickRun(history)) return null;
  return (
    <select
      className="advice-runs"
      value={adviceId ?? ''}
      onChange={(e) => {
        if (e.target.value) onSelect(e.target.value);
        // Picking the fresh session while an answer is open is exactly the `New
        // run` button: the answer goes back on the shelf, nothing is deleted.
        else if (adviceId) onNewRun?.();
      }}
      title="Answers already paid for. Every run is kept — each one is minutes of model time and real money."
    >
      <option value="">New run</option>
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
