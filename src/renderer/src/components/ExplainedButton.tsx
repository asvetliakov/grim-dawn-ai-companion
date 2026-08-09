import { useTooltip } from '../tooltip.js';

/**
 * A button that explains itself in the window's own panel.
 *
 * The three controls that need explaining are the expensive one, the destructive
 * one and the one whose effect on the other two is the question everybody asks —
 * so the explanation is a paragraph, not a label. Native `title` was carrying it
 * and carrying it badly: about a second to appear, the OS's styling, and it
 * vanishes while being read. This is the same panel the item tooltips use, so it
 * appears on the same schedule and can be read at leisure.
 *
 * **No `title` alongside it.** Both would fire, so a second later the OS's own
 * black box appears on top of the panel saying the same words in a worse typeface
 * — and there is no way to suppress one without suppressing the other, because
 * `title` is the browser's, not ours. The panel is the explanation; a check that
 * wants to read it hovers, exactly as a reader does.
 */
export function ExplainedButton({
  className,
  label,
  note,
  disabled = false,
  onClick,
}: {
  className: string;
  label: string;
  note: { title: string; body: string };
  disabled?: boolean;
  onClick?: () => void;
}): React.ReactNode {
  const tooltip = useTooltip();
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      // `mouseover` rather than `mouseenter`, for the same reason every other
      // hover target in this window uses it: it bubbles, so crossing from the
      // label to the button's padding re-asserts the subject instead of losing it.
      onMouseOver={(e) => tooltip.showNote(e.currentTarget, note.title, note.body)}
      onMouseLeave={tooltip.hide}
    >
      {label}
    </button>
  );
}
