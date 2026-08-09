/**
 * The one modal shape the window has: a titled sheet over a dimmed page.
 *
 * Shared by the settings pane and the context viewer so the two cannot drift
 * into being different kinds of window. Escape and a click on the backdrop both
 * close it — a pane with nothing but a Close button in the corner is a pane
 * people leave open by accident.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({
  title,
  subtitle,
  wide = false,
  actions,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  /** The context document needs the width; a form does not. */
  wide?: boolean;
  /** Controls that belong to the sheet rather than to its contents. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): React.ReactNode {
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus the sheet so the keyboard is inside the modal rather than still on
  // whatever was behind it.
  useEffect(() => sheet.current?.focus(), []);

  return (
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop closes: a
      // selection dragged out of the sheet ends here, and must not count.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={sheet}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle && <span className="modal-subtitle">{subtitle}</span>}
          <div className="header-spacer" />
          {actions}
          <button type="button" className="chrome-button subtle" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
