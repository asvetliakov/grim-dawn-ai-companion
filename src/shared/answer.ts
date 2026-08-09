/**
 * The human half of an answer, separated from the machine half.
 *
 * The prompt asks for the plan as "the final element of your answer and nothing
 * after it", as one fenced `json` block. That block is then parsed, validated,
 * and rendered as the Plan tab, the verdict table, the badges on the gear and the
 * projection column — so by the time a reader opens "Full answer" every field in
 * it has already been shown to them, in a form they can hover and click. Printing
 * it again as 17k characters of raw JSON — more than half the answer's length on
 * the first live run — buries the two thousand words of argument that are the
 * actual product of a twelve-minute call.
 *
 * Removed on the way *out*, never on the way in: the stored envelope keeps the
 * model's exact words, because it is the record of what was said and because the
 * plan is re-parsed from it. This is a presentation rule, so it lives where both
 * presenters — the window's Full answer tab and the CLI's printed answer — can
 * share one implementation.
 *
 * Pure and dependency-free: it is in the renderer's type graph.
 */

/** A fence line, with the info string it opens (`json`) or `''` for a bare one. */
const FENCE = /^```(\w*)\s*$/;

/**
 * The answer with its trailing plan block removed.
 *
 * Conservative by design — it removes a block only when that block is genuinely
 * the last thing in the answer, so prose that quotes JSON mid-argument survives
 * untouched, exactly as `parseAdvice`'s "the last fenced block wins" rule
 * assumes. An **unclosed** trailing fence is dropped too: a truncated answer ends
 * in half a JSON object, which is the one case where showing the raw text helps
 * nobody.
 */
export function answerProse(answer: string): string {
  const lines = answer.split('\n');

  // Every fence, in order. Pairing them from the top is the only way to tell
  // "prose after a closed block" from "inside a block that never closed" — a
  // backwards scan cannot, because the closing fence of a block and the opening
  // fence of an unterminated one are the same three characters.
  const fences: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i]!)) fences.push(i);
  }
  if (fences.length === 0) return answer;

  const unclosed = fences.length % 2 === 1;
  const open = fences[unclosed ? fences.length - 1 : fences.length - 2]!;

  // A closed final block only counts as trailing if nothing but whitespace
  // follows it. An unclosed one runs to the end by definition.
  if (!unclosed) {
    const close = fences[fences.length - 1]!;
    if (lines.slice(close + 1).some((line) => line.trim() !== '')) return answer;
  }

  // Whether this block is *the plan*, decided by looking inside it rather than by
  // its info string alone. `parseAdvice` accepts a bare fence as well as a `json`
  // one, so mirroring only the tag would strip any trailing code block an answer
  // happened to end on — a record path, a stat dump, a table — and those are prose
  // the reader wants. An unclosed block cannot be parsed, so there the `json` tag
  // is all there is to go on: a truncated answer ending mid-object is the one case
  // where showing the raw text helps nobody.
  const info = lines[open]!.match(FENCE)?.[1] ?? '';
  if (unclosed) return info === 'json' ? lines.slice(0, open).join('\n').trimEnd() : answer;
  if (info !== 'json' && info !== '') return answer;
  if (!isPlanBlock(lines.slice(open + 1, fences[fences.length - 1]!).join('\n'))) return answer;
  return lines.slice(0, open).join('\n').trimEnd();
}

/**
 * Whether a fenced block's body is the machine-readable plan.
 *
 * A JSON *object*, which is the shape `advisorPlanSchema` parses. Deliberately not
 * the schema itself: this module is in the renderer's type graph and takes no
 * dependencies, and the question here is only "is this the block the Plan tab
 * already rendered" — a plan that fails validation is still not prose, and the tab
 * will have said so in its own words.
 */
function isPlanBlock(body: string): boolean {
  if (!body.trimStart().startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
