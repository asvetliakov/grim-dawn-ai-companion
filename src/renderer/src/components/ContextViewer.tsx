/**
 * "What did the model actually see?"
 *
 * The context document, as the next run would send it. It exists because every
 * other answer to that question is indirect: the difficulty override and the
 * stash toggle both change what the advisor is told, and nothing else on screen
 * states the difference. Here it is one keystroke (⌘D) and a scroll.
 *
 * **Two views, and both are the point.** *Rendered* is how it is read — thirty
 * thousand tokens of headings and resistance tables are a wall of pipes as plain
 * text, and the answer to "does §12 group the level-84 items together" is a
 * glance away only when the headings are headings. *Raw* is what is actually
 * sent: the document's exact bytes are the contract the whole advice-to-item join
 * rests on, so a viewer that could only show a rendering would be showing
 * something the model never received. Rendered opens first; Raw is one click.
 *
 * The renderer is the same hand-written markdown tree the answer tab uses, whose
 * every leaf is text — so the document cannot inject markup into the window by
 * construction rather than by escaping.
 */

import { useEffect, useState } from 'react';

import type { ContextDocumentView } from '../../../shared/ipc.js';
import { Markdown } from './Markdown.js';
import { Modal } from './Modal.js';

type View = 'rendered' | 'raw';

export function ContextViewer({
  load,
  onClose,
}: {
  load: () => Promise<ContextDocumentView>;
  onClose: () => void;
}): React.ReactNode {
  const [doc, setDoc] = useState<ContextDocumentView>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>('rendered');

  useEffect(() => {
    let cancelled = false;
    void load().then(
      (next) => !cancelled && setDoc(next),
      (err: unknown) => !cancelled && setError((err as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  const subtitle = doc
    ? `${doc.character} · ${doc.difficulty} · ~${doc.tokenEstimate.toLocaleString('en-US')} tokens · ` +
      `${doc.stashIncluded ? `stashes included · sale review ${doc.stashReviewForSale ? 'on' : 'off'}` : 'stashes excluded'}`
    : undefined;

  return (
    <Modal
      title="Context document"
      wide
      {...(subtitle ? { subtitle } : {})}
      onClose={onClose}
      actions={
        doc && (
          <div className="tab-strip view-tabs">
            {(['rendered', 'raw'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`tab ${view === option ? 'selected' : ''}`}
                onClick={() => setView(option)}
              >
                {option === 'rendered' ? 'Rendered' : 'Raw'}
              </button>
            ))}
          </div>
        )
      }
    >
      {error && <p className="settings-warn">{error}</p>}
      {!doc && !error && <p className="settings-hint">Compiling…</p>}
      {doc && view === 'raw' && <pre className="context-document">{doc.markdown}</pre>}
      {doc && view === 'rendered' && (
        <div className="context-rendered">
          <Markdown source={doc.markdown} />
        </div>
      )}
    </Modal>
  );
}
