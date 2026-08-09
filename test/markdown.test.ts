/**
 * The advisor's prose, parsed.
 *
 * `answer` is the human product of a run and the window renders it, so the
 * parser is worth checking directly: an answer that renders as one long
 * paragraph is a silent failure, and the one thing it must never do is turn a
 * model's text into markup — every leaf here is text, which is what makes that
 * true by construction rather than by escaping.
 */

import { describe, expect, it } from 'vitest';

import { inline, parseMarkdown, type MdBlock } from '../src/renderer/src/markdown.js';

const kinds = (blocks: MdBlock[]): string[] => blocks.map((b) => b.kind);
const text = (block: MdBlock): string =>
  'content' in block ? block.content.map((s) => s.text).join('') : '';

describe('parseMarkdown', () => {
  it('reads the block shapes an answer actually uses', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'A paragraph that runs',
        'across two source lines.',
        '',
        '## Moves',
        '',
        '1. First',
        '2. Second',
        '',
        '- a bullet',
        '- another',
        '',
        '> a caveat',
        '',
        '---',
        '',
        '```json',
        '{"a":1}',
        '```',
      ].join('\n'),
    );

    expect(kinds(blocks)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'quote',
      'rule',
      'code',
    ]);
    // A paragraph is joined, not split: a hard-wrapped answer must not become
    // one block per source line.
    expect(text(blocks[1]!)).toBe('A paragraph that runs across two source lines.');
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[7]).toMatchObject({ kind: 'code', lang: 'json', text: '{"a":1}' });
  });

  it('keeps a wrapped list item in the list', () => {
    // A model writing at 80 columns wraps half its numbered items. Without
    // this, the tail of each one breaks out and becomes its own paragraph.
    const blocks = parseMarkdown('1. Re-augment the ring, because you are\n   74 points over cap.\n2. Second\n');
    expect(kinds(blocks)).toEqual(['list']);
    if (blocks[0]?.kind === 'list') {
      expect(blocks[0].items).toHaveLength(2);
      expect(blocks[0].items[0]!.map((s) => s.text).join('')).toBe(
        'Re-augment the ring, because you are 74 points over cap.',
      );
    }
  });

  it('needs the separator row before it calls something a table', () => {
    const table = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ kind: 'table' });
    if (table[0]?.kind === 'table') {
      expect(table[0].head.map((c) => c[0]?.text)).toEqual(['A', 'B']);
      expect(table[0].rows).toHaveLength(1);
    }

    // Prose about a stat has pipes in it far more often than it has tables.
    const prose = parseMarkdown('Fire | Cold resistance is the pair to watch.');
    expect(kinds(prose)).toEqual(['paragraph']);
  });

  it('reads emphasis, code and links inline', () => {
    expect(inline('a **bold** and *italic* and `code`')).toEqual([
      { text: 'a ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: ' and ' },
      { text: 'code', code: true },
    ]);
    expect(inline('[label](https://example.test/x)')).toEqual([
      { text: 'label', href: 'https://example.test/x' },
    ]);
  });

  it('leaves markup inside code spans alone', () => {
    // `**` in a stat string is not emphasis, and reading it as such would eat
    // the characters either side of it.
    expect(inline('`a ** b`')).toEqual([{ text: 'a ** b', code: true }]);
  });

  it('never loses text and never spins', () => {
    const odd = '#not a heading\n\n*unclosed\n\n|||\n\n   \n\nplain';
    const blocks = parseMarkdown(odd);
    expect(blocks.length).toBeGreaterThan(0);
    const rendered = blocks.map(text).join(' ');
    expect(rendered).toContain('not a heading');
    expect(rendered).toContain('plain');
  });

  it('produces text leaves only — nothing that could be markup', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n# <b>x</b>');
    const all = blocks.flatMap((b) => ('content' in b ? b.content : []));
    // The angle brackets survive as characters. They are text in the tree and
    // React puts text in a text node; there is no path to innerHTML.
    expect(all.map((s) => s.text).join('')).toContain('<script>alert(1)</script>');
  });
});
