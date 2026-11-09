# SPIKE-4 Findings: Fuzzy Re-Anchor Algorithm Profiling

ABOUTME: Evidence-based recommendation for the D17/TD-6/P2 fuzzy re-anchor path — algorithm,
ABOUTME: parameters, and the deterministic orphan rule — measured over a harvested edit-pattern corpus.

**Status: RECOMMENDATION READY for P1-5b (#103).** A two-stage, token-level, exact-first +
context-blended fuzzy matcher with **non-maximum suppression before the ambiguity test** meets P2
("never a wrong silent position, never a dropped comment") on the harvested edit-pattern corpus.
See verdict at the bottom. **No recorded-decision change is proposed** — the findings *confirm* and
*parameterize* D17 / TD-6 / P2; they do not alter them.

**Date:** 2026-07-12 · **Machine:** macOS (CJ's dev box) · **Runtime:** Python 3.9 (throwaway harness,
`spikes/spike4-fuzzy-reanchor/profile.py`, gitignored — never merges)

**Evidence tags:**
- **MEASURED** = produced by the harness over the committed corpus (numbers below are reproducible with a fixed RNG seed).
- **DERIVED** = a design conclusion argued from the measured behavior.
- **UNVERIFIED** = could not be checked within this spike (carried as residual risk).

---

## 1. The Question (from the brief)

What fuzzy re-anchor algorithm reliably re-locates an anchor when exact offset-mapping (P1-4,
`Anchor::map_through` → `Mapped::Touched`) fails, across the edit patterns real writing sessions
produce? Cover (a) the snapshot+context matching strategy, (b) the similarity threshold, and (c) the
deterministic **orphan** rule when no equal text exists — tuned so we **never** silently place an anchor
at the wrong position and **never** drop a comment (P2 / D17).

The seam is precise: P1-4 already does exact offset mapping when the edit list between two revisions is
known and doesn't touch the anchor. This spike owns the *other* path — TD-6's first-class case: a
cross-machine / cross-revision anchor where we hold only the old anchor (`{offset, length,
text_snapshot, context_before, context_after, base_revision}`, TD-4) and the *new* document text, with
no edit list to replay.

## 2. The constraint that shaped the method (and why it's faithful to the plan)

The brief names "real `biblical_writing` sessions." That repo is **private and local to CJ's Windows
box** (`C:\…\biblical_writing`); its prose cannot be committed, and it is not reachable from this
worktree. This is not an obstacle the plan overlooked — it is the plan:

> test-plan §2 (TP-Q3): *"Edit histories synthesized against these docs from SPIKE-4's real-session
> edit patterns (**patterns travel; prose doesn't**). Real `biblical_writing` zero-drift check remains
> a **local-only release-gate step on CJ's machine**."*

So the spike's job is to **harvest the edit-pattern taxonomy** a long-form writing/review session
produces, encode each pattern as a parametric transform, and profile candidate algorithms by applying
those transforms to the **committed public-domain sermon corpus** (`fixtures/corpus/prose/` —
Spurgeon / Wesley / Edwards + homiletic prose), which test-plan §2 states *structurally matches the
target workload*. Ground truth is known because the harness *is* the edit generator. **[MEASURED]**
corpus: 6 prose docs, up to 20 sampled anchors/doc, 12-token anchor spans, 13 patterns = **1,560
trials** per configuration.

The residual — "does this pattern taxonomy actually cover what CJ's real sessions do?" — is carried as
the top caveat (§8) and is exactly what the test-plan's local zero-drift gate exists to catch.

## 3. The edit-pattern harvest (the taxonomy)

Each pattern is a transform `(doc, anchor) → (new_doc, ground_truth)` where ground truth is either a
target span or **orphan**. The taxonomy is grouped by what it does to the anchored text:

| # | Pattern | What a real session does | Snapshot after edit | Correct outcome |
|---|---------|--------------------------|---------------------|-----------------|
| 1 | `insert_before` | add a sentence/para above the anchor | intact, shifted | re-anchor (shifted) |
| 2 | `insert_after` | add text below the anchor | intact | re-anchor (same) |
| 3 | `delete_elsewhere` | cut an unrelated paragraph | intact, shifted | re-anchor (shifted) |
| 4 | `typo_in_snapshot` | fix 1–3 characters inside the quote | ~equal | re-anchor (edited span) |
| 5 | `word_swap` | replace a word with another | near-equal | re-anchor (edited span) |
| 6 | `local_reflow` | rewrap lines (newline↔space) | whitespace-only diff | re-anchor (same) |
| 7 | `sentence_split` | split the quoted sentence in two | near-equal +punct | re-anchor (edited span) |
| 8 | `rewrite_snapshot` | paraphrase the sentence entirely | **gone** | **orphan** |
| 9 | `delete_snapshot` | delete the quoted text | **gone** | **orphan** |
| 10 | `move_paragraph` | cut the para, paste it elsewhere | intact, relocated | re-anchor (moved) |
| 11 | `duplicate_distinct_ctx` | copy the para elsewhere; original context intact | 2 exact copies, different neighbours | re-anchor **original** (via context) |
| 12 | `duplicate_ambiguous` | duplicate a *block* so snapshot **and** context repeat | 2 identical copies | **orphan** (indistinguishable → must not guess) |
| 13 | `find_replace_term` | global rename of a recurring term (e.g. "God"→"the Almighty") | snapshot/context mutate | re-anchor (mapped) |

Patterns 8/9/12 are the **orphan-boundary cases** the brief asked for — the ones where placing an
anchor *anywhere* would be a P2 violation.

## 4. Algorithms evaluated

**Baseline A — exact-snapshot only.** Search the new doc for the exact snapshot. 1 hit → place; 0 or
>1 → orphan. (Simplest possible; the safety floor.)

**Algorithm C — exact-first + token-window fuzzy + context blend** (the candidate):
1. **Tokenize** the doc into word tokens carrying char offsets. Token-level matching is what makes
   whitespace/reflow tolerance free (pattern 6) and gives a natural, stable window unit.
2. **Stage 1 — exact snapshot (token-sequence) search.** Exactly one hit → place. Multiple hits →
   disambiguate by context similarity; place the best *only if* it beats the runner-up by `tie_margin`,
   else **orphan**.
3. **Stage 2 — fuzzy scan.** Slide a snapshot-length token window; score each candidate
   `0.7·sim(snapshot) + 0.3·sim(context)` (`sim` = deterministic `difflib.SequenceMatcher` token ratio;
   context = 8 tokens each side). **Non-maximum suppression** collapses overlapping windows to their
   local peak, then place the top peak **only if** `score ≥ threshold` **and** it beats the best
   *distinct* peak by `tie_margin`; otherwise **orphan**.

## 5. Measured results

All numbers **[MEASURED]**, 1,560 trials, fixed seed (reproducible). "WRONG" = the P2-fatal outcome
(placed where ground truth was a *different* position, or placed when it should have orphaned).

### 5.1 Baseline A (exact-only) — safe-ish but blunt

```
correct 496 · correct_orphan 359 · false_orphan 704 · WRONG 1
```
Every fuzzy pattern (typo, word_swap, sentence_split, reflow) orphans wholesale (snapshot no longer
exact) → 704 false orphans, i.e. **~45% of anchors an author would expect to survive get dropped to
document level**. And it is **not even safe**: 1 WRONG (a duplicate whose exact search collapsed to a
single char-level hit). Exact-only is rejected.

### 5.2 Algorithm C — threshold × tie_margin sweep (with NMS)

```
 thresh   tie  WRONG  correct corr_orph false_orph
   0.70  0.00    407      951       202          0     ← tie=0 is unsafe
   0.70  0.05      3      933       357        267
   0.70  0.10      2      931       358        269
   0.75  0.10      2      930       358        270     ← recommended point
   0.80  0.10      2      930       358        270
   0.85  0.10      2      844       358        356     ← over-tight: real matches start orphaning
```

Two results dominate:

- **The `tie_margin`, not the threshold, is the P2 safety mechanism. [DERIVED]** With `tie_margin = 0`
  the algorithm force-places every orphan case (rewrite / delete / ambiguous-duplicate) onto whatever
  window scores highest → **407 WRONG**. Any `tie_margin ≥ 0.05` collapses that to ~2–3. The threshold
  only trades *correct* placements against *false orphans* for genuinely-edited snapshots; it does
  almost nothing for safety.

- **Non-maximum suppression is mandatory, and its absence is a silent catastrophe. [DERIVED]** Before
  adding NMS, the runner-up to a true fuzzy match was *the same match shifted by one token* (it shares
  n−1 tokens, so it scores ~0.9 too); the tie test then saw `best − second < margin` and **orphaned
  every real fuzzy match** (typo/word_swap/sentence_split: 120/120 false-orphaned). Adding NMS — score
  all windows, suppress overlapping ones, compare against the best *distinct* peak — lifted `correct`
  from **596 → 930** and dropped `false_orphan` **604 → 270**, with WRONG unchanged. **This is the
  single most important thing P1-5b must get right.**

### 5.3 Per-pattern behavior at the recommended point (threshold 0.75, tie_margin 0.10)

| Pattern | correct | correct_orphan | false_orphan | **WRONG** |
|---------|:-:|:-:|:-:|:-:|
| insert_before / after | 101 | – | 19 | 0 |
| delete_elsewhere | 101 | – | 19 | 0 |
| typo_in_snapshot | 101 | – | 19 | 0 |
| word_swap | 101 | – | 19 | 0 |
| sentence_split | 101 | – | 19 | 0 |
| local_reflow | 101 | – | 19 | 0 |
| move_paragraph | 101 | – | 19 | 0 |
| find_replace_term | 100 | – | 20 | 0 |
| rewrite_snapshot | – | **120** | – | 0 |
| delete_snapshot | – | **120** | – | 0 |
| duplicate_distinct_ctx | 22 | – | 98 | 0 |
| duplicate_ambiguous | – | 118 | – | **2** |

Reading it: the two "text is gone" orphan cases (rewrite, delete) are handled **perfectly** (120/120
orphan). Every placement pattern lands correctly ~84% of the time (101/120) with the remaining ~16%
conservatively *orphaned, never misplaced*. Two blemishes, both analyzed in §7.

## 6. Recommendation for P1-5b (#103)

Implement **Algorithm C** in `textops` as the `Mapped::Touched` continuation of P1-4:

1. **Token-level matching**, not char-level. Free whitespace/reflow tolerance; stable window unit;
   recovers char offsets from token spans for the final placed anchor.
2. **Two stages, exact-first.** Exact token-sequence hit is the cheap fast path (the overwhelmingly
   common case) and also the correct path for `move_paragraph`; fall to the fuzzy scan only when no
   exact hit exists. This keeps the O(N·L) scan off the hot path.
3. **Blend weights `W_snapshot = 0.7`, `W_context = 0.3`.** Snapshot dominates (it *is* the quoted
   text); context disambiguates duplicates.
4. **Context window = 8 tokens each side.** (P1-4 left `CONTEXT_WINDOW = 40 bytes` provisional; 8 word
   tokens ≈ 40–60 bytes of prose and is the unit that actually matched — P1-5b should store/compare
   context by token, and this reconciles the two.)
5. **Similarity threshold = 0.75** on the snapshot ratio. The `[0.70, 0.80]` band is a flat plateau
   (identical WRONG/correct); 0.75 is the middle with headroom. Above 0.85 real matches begin orphaning.
6. **`tie_margin = 0.10`** — the non-negotiable safety gate. Place only when the best candidate beats
   the best **distinct** alternative by ≥ 0.10.
7. **Non-maximum suppression BEFORE the tie test.** Suppress candidates overlapping an
   already-accepted peak (within one snapshot-length) so the ambiguity comparison is against a
   genuinely different location, not a shifted copy. *Skipping this orphans nearly everything — with
   no error message.*

### The deterministic orphan rule (P2 / D17)

Orphan — preserving `text_snapshot` as the visible original quote (D17) — **iff any** of:
- **(a) No candidate reaches `threshold`** (no sufficiently-equal text exists), **or**
- **(b) The best distinct candidate does not beat the second distinct candidate by `tie_margin`**
  (genuinely ambiguous — two places are ~equally good; guessing would risk a wrong silent position), **or**
- **(c) The snapshot is empty/degenerate.**

This rule is total and deterministic (fixed weights, fixed thresholds, `SequenceMatcher` is
deterministic) — the same old-anchor + new-doc always yields the same decision, satisfying P2's "never a
wrong silent position, never a dropped comment": placement is gated, and the fallback is always a
*counted, quote-preserving orphan*, never a drop.

## 7. Orphan-boundary cases — the two blemishes, explained

- **`duplicate_ambiguous`: 2/120 placed (a P2 near-miss). [MEASURED]** When the duplicated block sits
  at the very **end of the document**, one copy's trailing context is the doc boundary (short/empty)
  while the other's is real text — so the two sites are *not* perfectly symmetric and the context
  difference squeaks past `tie_margin`, placing one. **P1-5b fix (DERIVED):** a *missing or truncated*
  context side must **lower** confidence, never raise distinctiveness — require both context sides
  present to earn a disambiguation win, and treat a boundary-truncated side as neutral (score 0), not
  as evidence. Add a targeted property test: *duplicated block at a document edge must orphan.* This is
  the one place the current parameters are not yet provably P2-clean, and it is the highest-priority
  test to write first.

- **`duplicate_distinct_ctx`: only 22/120 placed, 98 orphaned. [MEASURED]** When an exact copy is added
  elsewhere but the original's neighbourhood is untouched, context *should* re-anchor to the original;
  the algorithm mostly orphans instead. This is **conservative-safe** (it never *mis*-placed — 0 WRONG)
  but costs recall. It's a tuning opportunity for P1-5b, not a correctness bug: widen or asymmetrically
  weight the context comparison so a fully-intact original neighbourhood wins decisively. Erring toward
  orphan here is the correct direction under P2.

## 8. Residual risks / caveats carried into P1-5b

1. **Pattern-taxonomy fidelity [UNVERIFIED].** The 13 patterns are a *plausible, structured* model of
   long-form writing/review edits, not a measured distribution of CJ's real sessions (which are private
   and unreachable — §2). The *relative frequency* of patterns in reality is unknown, so the aggregate
   correct/orphan **rates** are indicative, not predictive. The per-pattern *correctness* (WRONG = 0
   except the boundary case) is the robust result. **This is exactly what the test-plan's local-only
   `biblical_writing` zero-drift gate exists to validate** — P1-5b's acceptance should include running
   the shipped algorithm against real sessions on CJ's machine before the property is called green.
2. **`duplicate_ambiguous` doc-edge placement (§7)** — must be closed by the boundary rule + test above
   before P2 can be asserted clean.
3. **Performance [DERIVED].** Stage-2 is O(N·L) per anchor (the full corpus sweep took ~3 min for
   1,560 trials × 20 configs across a ~200 KB doc). Fine because Stage-1 exact handles the common case
   and fuzzy only runs on genuine misses — but P1-5b should **prefilter** fuzzy candidates (e.g. index
   rare snapshot tokens and scan only their neighbourhoods) rather than scanning every offset, and keep
   the whole thing in pure `textops` Rust where it's cheap and property-tested.
4. **Adversarial global rename [DERIVED].** `find_replace_term` was handled well (100/120), but a rename
   that mutates *most* tokens of a snapshot can push similarity below threshold → orphan. That is the
   safe direction (quote preserved) but worth a note in the P1-5b docs.
5. **Metric choice.** `SequenceMatcher` token-ratio was sufficient and is deterministic. P1-5b need not
   adopt Python's algorithm specifically, but must pick a **deterministic** similarity (P2 forbids
   nondeterministic orphaning). A token-trigram Dice coefficient is a reasonable Rust-native equivalent
   if `SequenceMatcher`'s ratio is awkward to port; if P1-5b changes the metric it should re-run this
   harness's shape to reconfirm the threshold/tie plateau.

## 9. What this unblocks

- **P1-5b / #103 (fuzzy re-anchor impl + orphan semantics)** — has a concrete algorithm, a parameter
  set (`W=0.7/0.3`, `ctx=8 tokens`, `threshold=0.75`, `tie_margin=0.10`, NMS), a deterministic orphan
  rule, the two boundary cases to guard, and a first property test to write.
- **P2 property matrix row** — the re-anchor/orphan half of P2 (P1-4 landed the exact-mapping half as
  `partial`) now has a specified, measured algorithm to implement and property-test against this
  taxonomy.

## 10. No recorded-decision change

The findings **confirm** the existing decisions and only *parameterize* them: D17 (orphan-never-drop,
quote preserved), TD-6 (fuzzy re-anchor is the first-class cross-machine path), TD-4 (anchor shape),
P2 (never wrong-silent, never dropped). Nothing in `functional-spec.md` / `tech-design.md` /
`test-plan.md` needs to change. The one constitution-adjacent note — reconciling P1-4's provisional
`CONTEXT_WINDOW = 40 bytes` with this spike's `8 tokens` — is an *implementation* detail for P1-5b, not
a decision-log edit.

---

## Verdict

**GO for P1-5b with Algorithm C.** A token-level, exact-first + context-blended fuzzy matcher with
`threshold 0.75 / tie_margin 0.10 / weights 0.7-0.3 / 8-token context` and **non-maximum suppression
before the ambiguity test** re-anchors the realistic edit patterns correctly (~84% placement, remainder
conservatively orphaned) and handles the "text is gone" orphan cases perfectly (120/120), with **zero
wrong-silent placements except one doc-edge duplicate case** that a stated boundary rule + property test
closes. The `tie_margin` and NMS are the two load-bearing, easy-to-miss pieces — without either, the
algorithm is either unsafe (force-places orphans) or useless (orphans everything). The absolute
pattern-frequency realism is the one thing this spike could not measure (private corpus); the
test-plan's local `biblical_writing` zero-drift gate is the designated place to close it. Spike code is
throwaway in `spikes/spike4-fuzzy-reanchor/` (gitignored) and never merges.
