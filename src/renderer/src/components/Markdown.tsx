/**
 * The advisor's own prose, painted.
 *
 * Deliberately a painter over `parseMarkdown`'s tree and nothing more: every
 * leaf is text and React puts text in a text node, so an answer cannot inject
 * markup into the window however it is written.
 *
 * Type colour is applied to **table cells only**. `statColors` recognises a
 * type from a finished *stat line*; a paragraph of prose that happens to say
 * "Bleeding" once is not one, and colouring the whole sentence red made an
 * argument look like a warning. A table cell is tabular stat data — the same
 * thing the character sheet colours — so there the rule holds.
 */

import type { MdBlock, MdInline } from '../markdown.js';
import { parseMarkdown } from '../markdown.js';
import { statClass } from '../statColors.js';

export function Markdown({ source }: { source: string }): React.ReactNode {
  const blocks = parseMarkdown(source);
  return <div className="markdown">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}

function renderBlock(block: MdBlock, key: number): React.ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = (`h${Math.min(block.level + 1, 6)}` as 'h2');
      return (
        <Tag className={`md-h md-h${block.level}`} key={key}>
          <Spans content={block.content} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className="md-p" key={key}>
          <Spans content={block.content} />
        </p>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className="md-list" key={key}>
          {block.items.map((itemContent, i) => (
            <li key={i}>
              <Spans content={itemContent} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>
                    <Spans content={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className={statClass(plain(cell))} key={j}>
                      <Spans content={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'quote':
      return (
        <blockquote className="md-quote" key={key}>
          <Spans content={block.content} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="md-code" key={key}>
          {block.text}
        </pre>
      );
    case 'rule':
      return <hr className="md-rule" key={key} />;
  }
}

function Spans({ content }: { content: MdInline[] }): React.ReactNode {
  return (
    <>
      {content.map((span, i) => {
        if (span.code) return <code key={i}>{span.text}</code>;
        // A link is rendered as its label with the target on hover: the window
        // has no browser to open one in, and the answers cite the dossier
        // rather than the web.
        if (span.href)
          return (
            <span className="md-link" title={span.href} key={i}>
              {span.text}
            </span>
          );
        if (span.bold) return <b key={i}>{span.text}</b>;
        if (span.italic) return <i key={i}>{span.text}</i>;
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

/** The line as the colour rule reads it — markers removed, words intact. */
function plain(content: MdInline[]): string {
  return content.map((s) => s.text).join('');
}
