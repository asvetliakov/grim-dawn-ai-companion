/**
 * A provider that answers from a script instead of a model.
 *
 * It exists so the parts around the model — prompt assembly, plan extraction,
 * the hallucination and legality checks, the CLI's rendering — can be tested
 * without spending a subscription call or depending on a non-deterministic
 * answer. `advise --provider mock` also gives a way to exercise the whole
 * pipeline on a real save with no network and no cost.
 */

import { parseAdvice, type AdvisorProvider, type AdvisorRequest, type AdvisorResult } from './provider.js';

export const MOCK_ID = 'mock';

export interface MockOptions {
  /** Fixed answer. Ignored when `script` is given. */
  text?: string;
  /** Answer computed from the request — for asserting on what was sent. */
  script?: (req: AdvisorRequest) => string;
  available?: boolean;
  /** Throw instead of answering, to exercise the CLI's error path. */
  fail?: Error;
  /** Every request this provider has seen, in order. */
  calls?: AdvisorRequest[];
}

/**
 * A well-formed answer: prose, then exactly one trailing json block. The ids are
 * placeholders — a caller testing against a real document passes its own text.
 */
export const CANNED_ANSWER = `## Per-slot verdicts

- **Head** — KEEP. Nothing in §7 beats it without losing 18 fire resistance.
- **Ring 1** — RE-AUGMENT to *Coven Wendigo Spirit*: the +15 vitality resistance is what closes the shortfall.

## Key moves

Re-augmenting Ring 1 moves vitality from 68 to 83 effective (cap 80), which frees the chest augment
from covering vitality at all — spend it on aether instead, where §3 shows −12 under cap.

## HOLD

- The two-hander stays in the stash until level 84.

## SELL / SALVAGE

- Nothing this run.

## Projected resistances

| | Fire | Cold | Vitality |
|---|---|---|---|
| effective | 82 | 81 | 83 |

\`\`\`json
{
  "verdicts": [
    { "slot": "Head", "itemId": "aaa111", "verdict": "KEEP", "reason": "best fire coverage on hand" },
    {
      "slot": "Ring 1",
      "itemId": "bbb222",
      "verdict": "RE-AUGMENT",
      "target": "Coven Wendigo Spirit",
      "reason": "+15 vitality resistance closes the shortfall"
    }
  ],
  "hold": [{ "itemId": "ccc333", "reason": "level gated", "until": "level 84" }],
  "sell": [],
  "projectedResistances": { "Fire": 82, "Cold": 81, "Vitality": 83 }
}
\`\`\`
`;

export function createMockProvider(opts: MockOptions = {}): AdvisorProvider {
  const calls = opts.calls ?? [];
  return {
    id: MOCK_ID,
    available: async () => opts.available !== false,
    async advise(req: AdvisorRequest): Promise<AdvisorResult> {
      calls.push(req);
      if (opts.fail) throw opts.fail;
      const text = opts.script ? opts.script(req) : (opts.text ?? CANNED_ANSWER);
      const structured = parseAdvice(text);
      return {
        text,
        provider: MOCK_ID,
        model: 'mock',
        ...(structured ? { structured } : {}),
        usage: { inputTokens: Math.ceil(req.contextDoc.length / 4), outputTokens: Math.ceil(text.length / 4) },
      };
    },
  };
}
