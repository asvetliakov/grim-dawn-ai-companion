# Stage 6B — Unread containers, component semantics, and advice legibility

> Follow-on prompted by the user's review of the first two live `advise` runs (Stage 6's Outcome has both). Nine findings: one is a missing save parser, three are modelling gaps around components, three are document scope/labelling, and two are about the answer being unambiguous to read. Everything here is verified against the live saves or the produced output — quotes below are from the actual run, not hypotheticals.

Work in the order below. **Part 1 is a parser session and gates nothing else** — Parts 2–5 can land first if the parser stalls, and are worth doing either way. Part 1 changes what §8 *contains*; Part 2 changes what §8 *says about each entry*.

---

## Part 1 — The three unread account-wide save files

### The finding

`~/Library/.../remote/save/` holds five account files. The tool opens two.

```
transfer.gst    6,622 b   block 18   ✔ parsed (Stage 2)
formulas.gst   24,021 b   plaintext  ✔ parsed (Stage 2)
reagents.gst    4,196 b   block 20   ✘ never opened  ← shared crafting materials + components
potions.gst       537 b   block 21   ✘ never opened
transmutes.gst 36,648 b   block 19   ✘ never opened  ← illusionist/transmuted appearances
```

This is the root cause of two visible defects, both in the live run:

- Every loose component in §8 is tagged `[inv]`. That is *correct for what we parse* — the resolved item set contains **zero** `ItemRelic` outside the inventory bags (personal stash: 6 quest items; transfer stash: 47 items, no components). The user's components are in `reagents.gst`.
- `**Crafting materials on hand:** Royal Jelly ×6` for a level-82 character with 1.3M iron. Same cause.

### Format facts (verified this session)

- **Same envelope as `transfer.gst`,** with a different file-kind tag: the first u32 (after the 4-byte seed) decrypts to **1**, where `transfer.gst` has `GST_MAGIC = 2`. Then a normal block header.
- **Framing is confirmed by arithmetic, not by hope:** for all three files `bodyStart + length + 4 === fileSize` exactly, with zero trailing bytes. The block ids (19/20/21) sit immediately after the transfer stash's 18 and are stable per file kind.
- **The body really does contain DBR record paths.** Decoded, `records/items/crafting/...` comes out — so block 20 is the container we want.
- **The cipher desynchronizes with the uniform "every byte advances" rule** that is correct for `player.gdc` and `transfer.gst`. Decoded that way, the plaintext is right only in constant-offset runs, and the offset *jumps between entries*. That signature means one thing: **the body mixes advancing and non-advancing reads**, exactly like the block-length read this codebase already has as `GdReader.readU32NoAdvance`.

### Hypotheses already ruled out — do not re-test these

1. **"No body byte advances"** and **"every body byte advances"** — neither reproduces the stored trailing checksum, under *any* of the 8 header advance-combinations. (The checksum is the oracle: state at body end must equal it.)
2. **Nested blocks.** Reading the body as `version` + repeated `beginBlock` gives an inner length of 4,249,240,415 against a 4,176-byte body. Dead.
3. **Raw single-byte-XOR obfuscated strings.** Scanning the *raw* ciphertext for `records/` under all 256 masks: zero hits in both files. The strings only appear after cipher decryption, so there is no second obfuscation layer.
4. **`version, count, count × (string, u32)`.** The u32 after `version` decodes to 0, and the next is garbage.

### The lead to pull

Brute-forcing header variants found that with **magic advancing, block id *not* advancing, length *not* advancing**, a literal `records/` appears in the decoded stream. That is a concrete alignment to start from.

The technique that will finish it is the one Stage 1 used: **resync-and-backtrack with the checksum as the pass/fail oracle.** Decode field by field; at each field try both the advancing and the non-advancing read; keep the branch that yields a plausible record path (`^records/.*\.dbr$`) and a plausible count; assert at the end that the cipher state equals the stored checksum. A block that checksums is proof the parser consumed it correctly — that rule has held for every block in this project.

### Deliverables (Part 1)

- `src/core/save/gst.ts`: `parseReagents(buf, opts)` → `{ version, entries: { record, quantity }[], blocks, warnings }`, checksum-verified. Same shape for `parsePotions` if it falls out for free; **`transmutes.gst` is cosmetic (illusionist appearances) and is out of scope** — record the block id and move on.
- `src/core/paths.ts`: `reagentsPath(saveDir)` beside `transferStashPath`/`formulasPath`.
- `src/core/resolve.ts`: a new `ResolvedItem.source` value — `'materials'` — so reagent-store contents join `resolved.items` and flow into §8's census and §10's `onHand` map without special-casing. `SOURCE_TAG` in `builder.ts` gains `materials: '[materials]'`.
- CLI: `npm run cli -- reagents [path]` printing the store, mirroring `stash`/`formulas`.
- Tests in `test/gst.test.ts` against the live file, gated by `haveSaves()` like the rest.

### Acceptance criteria (Part 1)

1. **Block 20's checksum passes** on the live `reagents.gst`. This is the gate — nothing else counts without it.
2. Every parsed record resolves through `GameDb.getItem` (or is reported, as `resolve` already does).
3. `npm run cli -- context --char _Suchka` shows components tagged `[materials]` in §8, and the "Crafting materials on hand" line grows past the current six Royal Jelly.
4. `parse`, `stash` and `formulas` are byte-for-byte unchanged — no regression in the readers that already work.

---

## Part 2 — Component semantics

### 2a. Loose components have no stats (confirmed defect)

§8 prints name, loose counts and use-on slots — and nothing about what the component *does*. The advisor hit this in the live run and said so:

> ADD-COMPONENT Bristly Fur … (§8 does not print Bristly Fur's stats; any loose "any armor" component beats an empty socket, **verify in-game**.)

That is the model correctly refusing to invent, and it is a straight information loss. **Installed** components already print their stats (`§5`: `component: **Vicious Spikes** … +4 Pierce Damage; +18% Pierce Damage; +4% Crit Damage; Grants: Empowered Impaling Weapons`), so this is one `formatStats` call in the census, not new machinery.

**Deliverable:** every census entry renders its stats via `formatStats`, same as an installed one. Watch the token cost — ~35 components × ~4 stat lines. If §8 becomes the largest section, the existing `compressCensus` trim step is the right place to give it back, not a shorter stat line.

### 2b. Component-granted buffs are named but never followed

`Grants: Empowered Impaling Weapons` is a dead end today: the buff record is never hopped to, so its `+flat pierce` is invisible to the reader and sits in the aggregate's *exclusions* rather than its totals.

`skills.ts` already has the activator→buff hop (`statRecord`) that toggled auras use — this is wiring it into the item path, not new research.

**Deliverable:** where an item or component carries `itemSkillName`, follow the hop and render the buff's stats inline at rank 1, as the skill section already does for modifiers. Keep it *named and shown*, not summed into the resistance matrix — summing item-granted skills is an existing, deliberate backlog item, and quietly changing the totals would break the "every row is separately attributable" property §3 depends on.

### 2c. The stacking rule is stated nowhere

Two swords carrying the same component grant **two** copies of the buff, and they stack. Nothing in §2 says so, so the advisor cannot reason about a second Vicious Spikes being worth anything.

**Deliverable:** one bullet in §2's **Sockets** block. Suggested wording, to be checked against the game before it ships:

> A component that grants a buff grants it **per copy**: two weapons with the same component give two instances of the buff, and their stats add. This is the one case where a duplicate socketable is worth more than the first — unlike set pieces, which count distinct members only.

---

## Part 3 — Document scope and labelling

### 3a. §10 blueprints: components and relics only

Craftable armour and weapons are noise — the character has candidates for those in §7 already. **Keep component blueprints and relic/artifact blueprints; drop plain gear.** Relics are not optional: `Slaughter` is a relic and is one of `_Suchka`'s three dual-wield enablers.

Filter on the *result* item's class: keep `ItemRelic` and `ItemArtifact`, drop `ArmorProtective_*`, `ArmorJewelry_*`, `Weapon*`. The existing material exclusion stays. Faction vendor augments (§9) are already correctly filtered to `ItemEnchantment` — leave them alone.

### 3b. The off-type label is a bare boolean on both sides

Today §7 prints exactly `note: **off-type** for the current build focus` or `note: matches the build focus`, with no statement of *what* matched. Two consequences, both real:

- **Rimespark Cord** is labelled off-type — correctly, its damage is Cold/Lightning/Frostburn/Electrocute against a Pierce+Bleeding build — but the label sits directly above `note: covers a current shortfall in bleeding, chaos` with neither note acknowledging the other. It reads as a verdict when it is one input.
- Items labelled `matches the build focus` often match on a single minor suffix (`of Spines`), while carrying mostly off-type lines. True, but uninformative.

**Deliverable:** make both notes name their evidence, and stop implying a verdict.

```
note: on-type via +45% Pierce Damage, +102% Bleeding Damage
note: off-type — its damage lines are Cold, Lightning, Frostburn, Electrocute; none is in Pierce + Bleeding.
      This is not a rejection: it still covers bleeding, chaos (see above).
```

`matchesBuild()` in `filters.ts` must return *which* keys matched instead of a boolean; `Candidate.onType` becomes `onTypeVia: string[]` (empty = off-type). The ranking weight does not change.

### 3c. Do NOT filter off-type items out

Considered and rejected, with Rimespark as the worked example: off-type, and still possibly the best belt owned because of +20% Bleeding Resistance / +20% Chaos Resistance. The ranking already sinks off-type candidates below shortfall-coverers. Deleting them would remove exactly the trade-offs the advisor exists to weigh. **The `--candidates` cap stays the only thing that drops a candidate, and it stays reported.**

### 3d. Permanent (learned) dual-wield enablers must be distinguished from gear-granted ones

**The data and the dossier are already right; the advice was wrong.** Stage 5A.4 correctly finds enablers among *invested mastery passives* as well as item-granted skills, and §4 printed all three:

> Dual wield is enabled by: Dual Blades (mastery passive); Implements of War (mastery passive); Bloodbath, granted by Slaughter. Any swap must keep at least one of these.

The advisor nonetheless justified its Relic verdict as `+1 all Nightblade and **the** Bloodbath dual-wield enabler`, treating a gear-granted enabler as load-bearing. It is not: Dual Blades and Implements of War are invested skill points and survive **every** gear change, so no swap can end dual wielding for this character. The "keep at least one of these" phrasing invites exactly this error by flattening two very different kinds of enabler into one list.

**Deliverable:** `aggregate.wielding.enablers` already carries `source` (`'skill'` vs the granting item). Derive a `permanentEnablers` count from it and make §4 state the consequence rather than leaving it to be inferred:

> **Wielding:** dual-wield melee — Servitor's Slicer + Bloodborn Sabre.
> Enabled by **2 permanent** sources — Dual Blades and Implements of War (invested mastery passives; they survive any gear change) — and 1 gear-granted: Bloodbath, from Slaughter.
> **Because a permanent enabler exists, no gear swap can end dual wielding.** Do not count an item's dual-wield grant as a reason to keep it.

When `permanentEnablers === 0`, invert it and say so loudly — that is the case where the constraint is real:

> **No permanent enabler.** Dual wielding depends entirely on gear: <items>. A swap that removes the last of these while leaving two one-handers is illegal, not merely weak.

§2's rule text and the system prompt's step 10 both need the same split — today they read "a mastery passive … or an item-granted skill" as if the two were interchangeable.

### 3e. Stop budgeting iron when iron is not a constraint

The live answer spent a whole section on it — `35,500 of 1,315,676` — plus running totals in four Key moves. At 37× the entire spend, that arithmetic is noise, and prompt steps 7/8/9 currently *require* it ("Respect the character's iron on hand", "respect the iron fee", "affordable now").

Blanket removal is wrong, though: iron is genuinely scarce for a low-level character, and Ascension's 250,000 is real money at any level. Make it **conditional and computed**, not assumed either way.

**Deliverable:** in §2, compare iron on hand against a worst-case shopping bill — the most expensive augment listed in §9 × the number of augmentable slots (12), plus the priciest craftable in §10. Then state one of two things:

- Iron ≥ ~5× that bill → `**Iron is not a constraint for this character** (1,315,676 on hand against a worst-case ~48,000 for augmenting every slot). Do not compute iron totals or budget sections; quote a price only when it is genuinely large, such as Ascension's 250,000.`
- Otherwise → keep today's behaviour and say plainly that iron *is* a constraint, with the bill.

The prompt's "respect iron" clauses become conditional on that statement. Prices stay in the §9 and §10 listings either way — they come free from the data, cost ~1 token each, and matter the moment a character is poor.

---

## Part 4 — Advice legibility

Both items below are defects in the **answer**, not in the dossier. The context document is already unambiguous (`+12% Fire Resistance; +12% Lightning Resistance` for Solarstorm Powder; `+8 Cold Damage; +66% Cold Damage` for Rimespark). The model compresses on the way out, and the prompt currently permits it.

### 4a. Bare stat names are ambiguous — and it bites in three directions

Real lines from the live run:

| what it said | what it meant |
|---|---|
| `+12 Fire/+12 Lightning` | resistance |
| `+48 Pierce, **+60 Acid**` | resistance |
| `+99% Pierce, 1083 armour, +22 FCL` | **damage**, armour, **resistance** — three kinds in one clause |
| `but costs 35 Acid` | resistance |

`+99% Pierce` and `+22 FCL` sit four words apart meaning different things. The reader cannot tell without opening the dossier, which defeats the point of the summary.

**Deliverables:**

1. **Prompt rule** (`prompt.ts`, Output format): every stat reference must be fully qualified — `+12% Fire Resistance`, `+99% Pierce Damage`, `+308 Health`, `1083 Armour`, `−35% Acid Resistance`. Never a bare damage-type name. Abbreviations are allowed only if introduced once (`FCL = Fire/Cold/Lightning Resistance`).
2. **Make it enforceable, not hopeful** — a new check in `verify.ts`, matching the existing mechanical-check pattern: scan every `reason` string in the plan (and the answer's markdown) for `[+-]\d+%?\s+<DamageType>` **not** followed by a qualifier (`Resistance|Res|Damage|Dmg|Retaliation`). Report as `PlanWarningKind = 'ambiguous-stat'`. This is decidable, so decide it.
3. **Schema, minimally.** Do *not* invent a typed-effects tree — it would duplicate the dossier. Two changes carry their weight:
   - Document `projectedResistances` in the schema comment as **effective percent after the difficulty penalty**, keys = §3 column labels. Ambiguity there is the same bug at the machine level.
   - Add optional `gains?: string[]` / `costs?: string[]` per verdict, holding fully-qualified stat strings, so the UI can render a delta without re-parsing prose. The `ambiguous-stat` check applies to these too.

### 4b. The per-slot verdict table does not show keep-vs-replace

Today the model is told only "per-slot verdicts with one-line reasons", so it improvises. In the live run the columns were `| Slot | Item | Verdict | Why |`, and exactly one row — the neck — invented an arrow:

```
| Neck | Bloodmoon `#um4r` → **Maiven's Lens `#s1f5`** | **EQUIP `#s1f5`** + ADD-COMPONENT … |
```

Every other row shows only the current item, so at a glance you cannot tell "this slot keeps its item and gains an augment" from "this slot's item is replaced". That distinction is the single most important thing in the table.

**Deliverables:**

1. **Prompt rule:** the table is `| Slot | Current | New | Action | Why |`. `New` is `— (keep)` when the item stays, otherwise the incoming item with its id. Socketable changes go in `Action`, never in `New` — a re-augment is not a new item.
   **The `Action` cell names the socketable and nothing else** — no parenthetical qualifiers. The live run wrote `ADD-COMPONENT Dread Skull (loose)` and `ADD-COMPONENT Soul Shard (loose)`, duplicating sourcing that the reason column already carried in full ("One of two loose Dread Skulls fills the Lens's empty socket"). Where the component comes from belongs in `Why`, once.
2. **Better: render it deterministically.** The CLI already receives a validated `AdvisorPlan`; have `advise` print its *own* verdict table from `structured` after the prose. Formatting then does not depend on the model at all, and it dogfoods the Stage 7 contract — the UI will paint the same grid from the same data. `EQUIP` is the only replacing verdict; everything else keeps the item. Add a tiny exported helper (`isReplacement(verdict)`) so the CLI and the future UI cannot disagree about that.

   This also disposes of the `(loose)` problem structurally: the CLI renders `target` verbatim, and `target` was already clean in the live run (`"target": "Dread Skull"`) — the qualifier existed only in the model's prose table.

3. **Harden the lookup, because the clean `target` was luck.** Nothing in the current prompt forbids a parenthetical in `target`, and `checkPlan` would have raised a spurious `unknown-socketable` for `Dread Skull (loose)` — a false alarm on a correct move, which is worse than no check. `normalizeName` should strip a trailing `(...)` before matching. **Verify the assumption first:** confirm no socketable among the 490 in the database has parentheses in its display name (`db --stats` reports the count; a one-off scan settles it). If any does, match the full name first and only then retry stripped.

---

## Part 5 — The repair loop

`checkPlan` currently warns *the user* about hallucinated ids, illegal sockets and reused extraction hosts. The model never hears about them, so a fixable plan stays broken.

**Deliverable:** when `checkPlan` returns warnings, send **one** follow-up call containing the original answer plus the warning list, asking for a corrected plan; re-validate; keep whichever result is clean (prefer the revision, fall back to the original with warnings shown). One extra call, only when something is actually wrong.

Constraints worth honouring:
- **Exactly one revision.** No loop — a second failure is a signal to the user, not a reason to keep spending. Each call is ~8 minutes and ~$1.
- Surface it: `advise` should say `plan had N warning(s); asked for one revision → clean` (or `→ still N warnings`), and report the total cost of both calls.
- `--no-repair` to opt out.
- The mock provider needs a scripted two-response mode to test this without a live call.

---

## Part 6 — A forward-looking "next levels" section

### The finding

The HOLD list already carries every threshold, but as twelve unordered rows whose `until` values are free text:

```
Scarmakers #66f4                → level 84
Ilgorr's Eternal Vigil #etru    → level 84
Cronley's Signet of Blood #j1mr → level 84
Epaulets of Spines #3o51        → level 84          … 9 rows in total
Venomskin Legwraps #a3vq        → level 84 + 1 attribute point into Physique
Ulraprax's Sting #tbso          → level 84 + 3 attribute points into Spirit
Shadoweave Leggings #i31h       → 3 attribute points into Physique
Sangvinar #zie8                 → blueprint + 12× Ashes of Awakening
```

**Nine of twelve unlock at level 84 — two levels away.** That is the most actionable fact in the whole answer and it is invisible: the reader has to notice the repetition themselves. And `_Suchka` has **0 unspent attribute points**, so "spend your next 3 points on Spirit" is a real, spendable instruction rather than a hypothetical.

### The arithmetic belongs in the document, the judgement in the advisor

This is not only a prompt change. `checkRequirements` already returns typed gaps (`attr`, `have`, `need`, `deficit`), and CLAUDE.md fixes the conversion: **one unspent attribute point = 8 of any one attribute**. So `ceil(deficit / 8)` is the point cost of any held item, and `need - level` is its level cost — both computable, neither currently computed.

Keep the existing seam: the builder emits the *ladder*, the advisor decides what is worth buying. That matches `checkRequirements`' "reports rather than filters" contract and keeps post-swap reasoning where it belongs.

**Caution on levels-per-point:** do **not** hardcode an attribute-points-per-level rate. Check whether the game data states it (the same lesson as the difficulty penalty, which was assumed uniform and was not). If it is not derivable from the archives, express thresholds in **points and levels separately** — "3 attribute points into Spirit" and "level 84" — and never silently convert one into the other. The live answer already wrote "level 84 + 3 attribute points into Spirit (i.e. level 85)"; that parenthetical is exactly the inference that must be earned rather than assumed.

### Deliverables (Part 6)

- **New context-document section, §12 "Unlock ladder"** — every item in §7 that fails a requirement, grouped by threshold and sorted cheapest-first, with the arithmetic done:

  ```
  ### At level 84 (2 levels away) — 9 items unlock
  Scarmakers `#66f4` (+20% Bleeding Resistance, +20% Chaos Resistance, 1014 armour — the weakest body part today is Hands at 945)
  Impervious Ilgorr's Eternal Vigil `#etru` … [7 more]

  ### 3 attribute points into Spirit (24 Spirit: 299 → 323) — 1 item unlocks
  Stanching Ulraprax's Sting of Shadows `#tbso` (+70% Bleeding Resistance)

  ### 1 attribute point into Physique (8 Physique) — 1 item unlocks
  Venomskin Legwraps `#a3vq` — also needs level 84
  ```

  Group by *shared* threshold so the "nine at once" fact is structural, not something the reader must spot. An item with both a level and an attribute gap appears under both, cross-referenced.
- **Attribute allocation is one decision, not one per item.** The section must total the competing demands — "Spirit: 3 points unlocks 1 item; Physique: 1 point unlocks 1 item, 3 points unlocks 2" — because points are near-permanent (Tonic of Reshaping is scarce, per §2) and the advisor has to choose a line, not satisfy every held item.
- **Prompt:** a required **"Next levels"** section in the answer, after HOLD, ordered by cost-to-reach. One line per threshold: what to spend, what it unlocks, and whether it is worth committing to. Explicitly in scope for attributes and farming targets (materials for a named awakening); explicitly **out** of scope for skill and devotion trees — prompt step 12 stays, this is not a build guide.
- **Schema:** `hold[].needs?: { levels?: number; attributePoints?: { attribute: 'physique' | 'cunning' | 'spirit'; points: number } }` alongside the existing free-text `until`, plus a top-level `nextLevels?: { threshold: string; unlocks: string[] /* itemIds */; recommendation: string }[]`. Optional, so an older answer still validates; the CLI's deterministic table (Part 4b) renders it when present.

### Acceptance criteria (Part 6)

9. §12 groups `_Suchka`'s held items by threshold, shows **level 84 unlocking nine items in one group**, and states each attribute cost in both points and raw attribute value.
10. The answer carries a **Next levels** section ordered cheapest-first, naming a specific attribute line to commit to rather than restating each item's gap.
11. No hardcoded attribute-points-per-level constant anywhere; if the rate is not read from the game data, levels and points are reported separately and never interconverted.

---

## Deliverables (summary)

```
src/core/save/gst.ts        parseReagents (+ parsePotions if free); block 20 checksum-verified
src/core/save/types.ts      'materials' source
src/core/paths.ts           reagentsPath
src/core/resolve.ts         reagent store joins resolved.items
src/core/context/builder.ts §8 component stats + granted-buff hop; §2 stacking rule;
                            §10 components/relics only; [materials] source tag;
                            §4 permanent-vs-gear enablers; §2 iron-is-a-constraint verdict;
                            §12 "Unlock ladder" — held items grouped by threshold,
                            attribute costs in points and raw value
src/core/context/filters.ts matchesBuild → onTypeVia: string[]
src/core/context/statfmt.ts itemSkillName follows the buff hop
src/core/mechanics/aggregate.ts  wielding.permanentEnablers (derived from enabler source)
src/core/ai/prompt.ts       qualified-stat rule; Current/New/Action table;
                            enabler split in step 10; iron clauses made conditional;
                            required "Next levels" section
src/core/ai/provider.ts     gains/costs; projectedResistances documented; isReplacement();
                            hold[].needs + top-level nextLevels
src/core/ai/verify.ts       'ambiguous-stat' check
src/cli/index.ts            `reagents` command; deterministic verdict table; repair loop + --no-repair
test/gst.test.ts            reagents parsing, live
test/ai.test.ts             ambiguous-stat, isReplacement, repair loop via scripted mock
test/context.test.ts        census stats, on-type evidence, §10 filter, §12 ladder grouping
```

Note that §12 makes the document twelve sections, not eleven — Stage 5B's gate ("eleven sections, nothing trimmed") and any test asserting the count need updating rather than working around.

## Acceptance criteria

1. **Block 20 checksum passes** on the live `reagents.gst`; its contents appear in §8 as `[materials]`, and the materials line reflects the real stock. *(If Part 1 is deferred, say so explicitly in the Outcome rather than quietly dropping it.)*
2. §8 prints stats for every loose component; no `Grants: <skill>` appears anywhere without the buff's stats beside it; §2 states the per-copy stacking rule.
3. §10 lists only component and relic/artifact blueprints — `Slaughter`'s line still present; craftable armour gone.
4. Every §7 candidate note names its evidence: `on-type via …` with the matching stat, or `off-type — …; not a rejection`. No bare boolean remains.
5. Live `advise --char _Suchka`: **zero `ambiguous-stat` warnings**, and a spot-read finds no bare `+N <DamageType>` in the prose.
5b. §4 reports `2 permanent` enablers for `_Suchka` and states that no gear swap can end dual wielding; the answer's Relic verdict **no longer cites Bloodbath as a reason to keep Slaughter**. Stub-test the inverted case (zero permanent enablers → the loud warning), since no live character exercises it.
5c. §2 declares iron not a constraint for `_Suchka` (1.3M on hand), and the answer contains **no iron totals or budget section** — while §9/§10 still list per-item prices. Stub-test the poor-character branch so the constraint text does not rot.
6. The CLI prints its own `Slot | Current | New | Action` table from the structured plan; a KEEP row and an EQUIP row are distinguishable at a glance. No `Action` cell carries a parenthetical qualifier, and `normalizeName('Dread Skull (loose)')` still matches the real component (unit-tested) rather than raising `unknown-socketable`.
7. Repair loop: forced-failure test via the scripted mock (bad plan → warnings → revision → clean) and a live run where, if warnings fire, exactly one revision is attempted and the cost line covers both calls.
8. No regression: `parse`, `stash`, `formulas`, `aggregates` output unchanged; `npm test` + `npm run typecheck` green.

## Verification

```bash
npm test && npm run typecheck
npm run cli -- reagents                       # Part 1: block 20 checksum
npm run cli -- context --char _Suchka -o /tmp/ctx.md
npm run cli -- advise  --char _Suchka --save-context /tmp/sent.md -o /tmp/advice.md
npm run cli -- advise  --char _Suchka --provider mock   # repair loop, no cost
```

Diff `/tmp/ctx.md` against a pre-change copy: the only changes should be the new component stats, the `[materials]` entries, the narrowed §10, and the reworded notes. Any numeric drift in §3 is a bug — Part 2b is deliberately *named and shown*, never summed.

---

## Outcome

Everything above shipped, plus four things the session found on the way: the levelling rates are in the game data, the reagent store keeps zero-quantity rows, a granted skill's *kind* is derivable, and the `ambiguous-stat` check needed a live run before it was usable. Deviations are itemised at the end.

### Part 1 — the format was solved; block 20 checksums

`reagents.gst` is **`transfer.gst`'s format with one field different**, and the field is the framing: **each entry is a nested block (id 0), exactly like a stash sack.** A nested block's length word and its trailing checksum are both consumed *without* advancing the cipher, which is precisely why a uniform "every byte advances" walk desynchronizes a little more at every entry — the "constant-offset runs whose offset jumps between entries" signature the plan recorded. Two non-advancing reads per entry, and there are 61 of them.

The lead in the plan (magic advancing, id/length not) was a red herring: it produced a literal `records/` by accident. What actually solved it was inverting the search — instead of guessing header variants, **solve for the cipher state that makes a known plaintext decode**. A record path is `^records/.*\.dbr$` with a u32 length prefix, so for a candidate length `n` at offset `o` the state is forced: `state = rawU32(o) ^ n`. Scanning every offset × every plausible length found all 61 entries in one pass, and the gaps between them (16 bytes, uniformly) then read off directly as `[quantity u32][checksum][nested id][nested length]`.

Full layout, checksum-verified:

```
seed, magic u32 = 1
block { id 20, length }
  version u32 = 1
  u32 (non-advancing — the same quirk word transfer.gst carries after its version)
  mod string (empty on vanilla)
  count u32 = 61
  count × block { id 0, length }
      record string
      quantity u32          ← absent in potions.gst; the nested length is what says so
    end (checksum)
end (checksum)
```

`potions.gst` (block 21) fell out for free and is parsed by the same code — its entries simply stop after the record path, which the nested block's own length reports. `transmutes.gst` (block 19) stays out of scope and is reported rather than misread.

**A finding with teeth: the store keeps rows at quantity 0.** Four of `_Suchka`'s 61 entries are zero — a "has held this before" marker, not stock. Passing them through would have read as *one on hand* everywhere downstream, because a save's own `stackCount` is 0 for non-stackables and every consumer floors it at 1. `resolveCharacter` drops them, and §10 went from "missing Manticore Eye **1**/9" to the true `0/9`.

Result: 61 kinds, 3,572 items, block 20 checksum passing. Loose components now read `[materials]`, and "Crafting materials on hand" went from `Royal Jelly ×6` to eighteen materials including `Royal Jelly ×117` and `Ashes of Awakening ×28` — which changes real advice, since the plan's own example HOLD ("Sangvinar — blueprint + 12× Ashes of Awakening") turns out to be affordable twice over.

### The level table is in the game data

The plan's caution — *do not hardcode an attribute-points-per-level rate; check whether the game states it* — was worth following, because it does. `records/creatures/pc/playerlevels.dbr` carries `characterModifierPoints = 1` (attribute points per level), `strengthIncrement`/`dexterityIncrement`/`intelligenceIncrement = 8` (attribute per point), `maxPlayerLevel = 100` and `maxDevotionPoints = 55`. Read via a new `GameDb.levelProgression()` (schema 10), so §12's `ceil(deficit / perPoint)` is derived rather than folklore, and §2 states the rate with its provenance. Levels and points are still reported in their own currencies and never silently interconverted — a level costs XP as well as a point.

### Parts 2–6

- **§8 is now the single component list** (see deviations): owned loose, installed, *and craftable*, each with its stats. `Grants: <skill>` follows the activator→buff hop everywhere and renders the buff at rank 1 — and where it cannot (pet summons, `Skill_SpawnPet`), it says so instead of leaving a bare name, via a new `GameDb.skillClass()`. **No number in §3 moved**: diffed against the pre-change document, the section's only changes are two reworded sentences (the qualified-stat cleanup below). Named and shown, never summed.
- **§2** gained the per-copy stacking rule, the permanent-vs-gear enabler split, and a computed iron verdict.
- **§4** reports `Enabled by **2 permanent** — Dual Blades and Implements of War … and 1 gear-granted — Bloodbath, from Slaughter`, followed by the consequence outright: *no gear swap can end dual wielding*. The zero-permanent branch is stub-tested.
- **§7** notes name their evidence on both sides — `on-type via +45% Pierce Damage, …` / `off-type — its damage lines are Cold, Lightning…; none is in Pierce + Bleeding. This is not a rejection: it still covers bleeding, chaos`.
- **§12** groups 41 failing candidates by shared threshold, cheapest first, with the biggest group (`At level 84 (2 levels away)`) unlocking 28 in one step, and totals the competing attribute demands cumulatively per attribute.
- **`ambiguous-stat`** is decided by regex over the plan's reasons, `gains`/`costs` and the answer prose. The sign is optional because `but costs 35 Acid` — a real line from the first run — carries none.
- **The repair loop** makes exactly one follow-up call and **keeps whichever answer is cleaner**, discarding a revision that came back no better. That last part is not in the plan and is the difference between a repair loop and a coin flip.
- **`verdictRows`** lives in `provider.ts`, not the CLI, so Stage 7's grid and the CLI cannot disagree about which rows are swaps.

### Also added, from the user mid-session

**A granted skill now states its kind.** Part 2b made `Grants: <skill>` show the buff's stats, but a passive, a toggle, an activated skill and a proc still looked identical — the user asked whether the model was expected to infer "buff" from an *Energy Reserved* line. It should not have to, and the game says so directly: the record's template class partitions cleanly into `passive — always on`, `toggle — stays on until switched off`, `activated — you have to cast it`, `auto-cast <trigger>`, `weapon-pool proc` and `summons a pet`. Two of the classes are conditional passives (`Skill_PassiveOnLife…` at low health, `Skill_PassiveOnHit…` when hit) and would have read as unconditional under any simpler rule. §2 states how to read the label; energy reservation stays where it already was, in the skill's own stats, because `characterManaLimitReserve` is present on many toggles but not all.

### The `ambiguous-stat` check needed the live run to be usable

Its first live outing produced **six warnings, every one a false alarm** — which is the failure mode the plan itself names for `unknown-socketable` ("worse than no check"). Two causes, both fixed:

1. **The game's own compound stat names.** `+24% Fire, Cold and Lightning Resistance` is one qualifier covering three types; the check demanded one immediately after each. A `TYPE_LINK` now lets the lookahead step over further type names, list punctuation, `and`/`to`, a conversion arrow, and the second word of a two-word type (`Vitality Decay`, `Internal Trauma`) — but nothing else, which is what keeps `+48 Pierce, +60 Acid Resistance` flagged on its first half. Listing `Vitality Decay` among the type names instead does *not* work: the engine backtracks out of the longer alternative when the lookahead rejects it, matches the bare `Vitality`, and finds `Decay` where it wanted a qualifier.
2. **The dossier broke its own rule, and the model copied it.** The answer's `57% pierce · 32% bleeding · 10% frostburn · 1% cold` is §4's weapon-attack composition line, verbatim. Four places were unqualified — that composition line, the per-skill damage lines, the §2 difficulty-penalty list and the §3 under-cap list (the last two only via comma-joining, where `Pierce -50, Fire -50` reads as "-50, Fire") — plus the materials list, where `×8, Aether Shard` looked like a stat. All now qualified or `·`-separated, and **`test/context.test.ts` asserts the document is clean under its own detector**, so it cannot drift back.

Re-judging the same saved answer with the fixed check drops it from nine distinct bare references to four — and those four are the composition line whose source is now fixed.

### Live verification

Two live runs on `_Suchka`, both `opus` / `high` against the ~53k-token dossier.

**Run 1** (before the detector fixes above): 6 warnings, all `ambiguous-stat`, all false alarms; the repair loop fired, the revision was no cleaner, and the original was kept and shown — the `revisionRejected` path, working as intended. 2 calls, 200,850 in / 69,343 out, $3.85, 784s.

**Run 2** (after): `plan had 1 warning(s); asked for one revision → clean`, and then

```
plan checks: every item id exists, no illegal socket, no destroyed host reused, every stat qualified
claude-cli / opus (effort high) · 2 calls · 203,457 in · 61,603 out · $3.6826 · 681.8s
```

Against the acceptance criteria: **zero `ambiguous-stat` warnings** and zero bare references on a re-scan of the whole answer; 18 verdicts of which exactly one is an `EQUIP`, so the deterministic table's `New` column distinguishes it from the seventeen `— (keep)` rows at a glance; **no `target` carries a parenthetical**; 16 of 18 verdicts supply `gains`/`costs`; 10 of 13 holds supply machine-readable `needs`; and the required **Next levels** section is ordered cheapest-first and commits to a line rather than restating gaps — "Commit the point to Physique", against "Not worth it: 15 near-permanent points for +4% Physical Resistance".

Both parts of the repair loop are therefore exercised live: a revision that helped, and one that did not.

Per-call time is ~340s, *down* from Stage 6's 496s despite a dossier half again as large, so the 900s ceiling still has room and is left alone.

### Deviations from the plan

1. **§10 is relics only; components moved into §8.** The plan said "keep component *and* relic blueprints" in §10. Mid-session the user pointed out that a craftable component is just another way of *having* that component, and that the choice between "loose", "installed" and "craftable" is one decision — so splitting it across two sections was the wrong shape. §8 is now the single component authority (61 reachable, 13 craftable now) and §10 keeps relics, blueprint purchases and awakening paths. Craftable relics gained their stat lines for the same reason components did.
2. **Reagent chains are resolved transitively** (also from the user, mid-session). A component recipe's reagents are often other components the character holds a blueprint for; reporting "missing Ballistic Plating 0/4" when four are two clicks away is a false negative that costs a real move. `recipeView` now crafts what it can from one shared material pool as it descends — so `Haunted Steel` reads *craftable now, after first crafting 3× Vengeful Wraith* rather than *missing Vengeful Wraith 1/4*. Cycles are broken by an in-progress set and a depth cap; a sub-craft that runs the shared materials dry rolls back rather than pretending the first success repeats. The prompt now says a listed shortfall really is one.
3. **The iron bill excludes the priciest craft.** The plan's formula sentence said "augment bill **plus** the priciest craftable"; its own worked example (`~48,000 for augmenting every slot`) and acceptance criterion 5c (iron *not* a constraint at 1.3M) both say otherwise, and including a 250,000 relic craft flips a millionaire to "constrained". The craft price is reported beside the bill instead, and the "quote a genuinely large price" clause is what covers it.
4. **§12 sits after §11.** The plan numbers the ladder twelfth and the task is §11; renumbering the task would break every `§11 asks for` cross-reference in the document and the prompt. The task now points forward at §12.
5. **Acceptance criterion 9's "nine items at level 84" reads 28.** Same grouping, more candidates: the live per-slot cap is 40, not the smaller set the plan was written against. The structural fact — one heading, one threshold, the largest group named in the lead line — is what the criterion is for.
6. **`resolveCharacter` takes an `AccountFiles` object** rather than a fourth positional parameter. Three optional account-wide files in a row was already the readability limit at two.
