/**
 * Just enough Markdown for one advisor answer.
 *
 * The envelope carries `answer` — the model's own prose, and the human product
 * of a run; the plan JSON beside it is what the tool reasons over. Showing it as
 * a wall of raw text throws away the structure the model wrote, and the repo
 * takes no runtime dependencies, so this is a parser for exactly the subset the
 * prompt asks for: ATX headings, unordered and ordered lists, pipe tables,
 * blockquotes, fenced code, thematic breaks, paragraphs, and inline emphasis /
 * code / links.
 *
 * It is a **tokenizer, not a renderer** — it returns a tree the React component
 * paints. Nothing here produces HTML, which is what makes "the model cannot
 * inject markup into the window" true by construction rather than by escaping:
 * every leaf is text, and React puts text in a text node.
 *
 * What it deliberately does not do: nested lists (the prompt's answers are
 * flat), reference links, HTML blocks, and setext headings. An unrecognised
 * line is a paragraph, never an error — a model that writes something odd must
 * still be readable.
 */

export interface MdInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Present on a link; the text stays the label. */
  href?: string;
}

export type MdBlock =
  | { kind: 'heading'; level: number; content: MdInline[] }
  | { kind: 'paragraph'; content: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'table'; head: MdInline[][]; rows: MdInline[][][] }
  | { kind: 'quote'; content: MdInline[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'rule' };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```(\w*)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
/** An indented, non-blank line under a list item: its wrapped remainder. */
const CONTINUATION = /^\s{2,}\S/;
/** A separator row is what turns two pipe lines into a table rather than prose. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence, or the end of the document
      out.push({ kind: 'code', text: body.join('\n'), ...(fence[1] ? { lang: fence[1] } : {}) });
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, content: inline(heading[2]!) });
      i++;
      continue;
    }

    // A table is only a table once the separator row confirms it; a lone line
    // with pipes in it is far more often prose about a stat.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ kind: 'table', head, rows });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const texts: string[] = [];
      while (i < lines.length) {
        const m = ordered ? ORDERED.exec(lines[i]!) : BULLET.exec(lines[i]!);
        if (!m) break;
        texts.push(m[1]!);
        i++;
        // A wrapped item continues on the next line, indented under its own
        // marker. Without this, the tail of every hard-wrapped list item breaks
        // out of the list and becomes a paragraph of its own — which is what a
        // model's numbered list actually looks like at 80 columns.
        while (i < lines.length && CONTINUATION.test(lines[i]!) && !startsBlock(lines[i]!)) {
          texts[texts.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        }
      }
      out.push({ kind: 'list', ordered, items: texts.map(inline) });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        body.push(m[1]!);
        i++;
      }
      out.push({ kind: 'quote', content: inline(body.join(' ')) });
      continue;
    }

    // A paragraph runs until a blank line or the start of any other block.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) para.push(lines[i++]!);
    if (para.length === 0) para.push(lines[i++]!); // never spin on a line nothing claimed
    out.push({ kind: 'paragraph', content: inline(para.join(' ')) });
  }

  return out;
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line) || FENCE.test(line) || RULE.test(line)
  );
}

function cells(line: string): MdInline[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => inline(cell.trim()));
}

/**
 * Inline spans, in one pass.
 *
 * Code first and unconditionally: inside backticks nothing else is markup, and
 * that is what keeps a stat string like `**` from being read as emphasis.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

export function inline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;

  while (rest) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) out.push({ text: rest.slice(0, match.index) });
    const token = match[0];

    if (token.startsWith('`')) out.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('**') || token.startsWith('__')) out.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('*')) out.push({ text: token.slice(1, -1), italic: true });
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) out.push({ text: link[1]!, href: link[2]! });
      else out.push({ text: token });
    }

    rest = rest.slice(match.index + token.length);
  }

  if (rest) out.push({ text: rest });
  return out.length ? out : [{ text }];
}
