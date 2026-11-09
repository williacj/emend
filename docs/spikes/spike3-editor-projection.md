# SPIKE-3: CM6 source-as-model projection prototype

ABOUTME: Throwaway prototype for TD-2 — proves CodeMirror 6 can deliver Typora-grade
ABOUTME: live-preview projection over a raw markdown string, with CriticMarkup redline.

**Status: TD-2 projection approach HOLDS UP.** See verdict at the bottom.

## How to run

```
npm install
npm run dev        # open http://localhost:5173/
```

Requires Node (built and measured with Node 22.23.1 — note: Node was not installed
on the dev machine; a portable zip was used, so don't assume `node` is on PATH).

Extra harnesses (both need local Chrome at the default install path):

```
node verify.mjs    # 12 headless functional checks (dev server must be running)
node measure.mjs   # headless perf capture of ?autoperf (dev server must be running)
```

`http://localhost:5173/?autoperf` auto-loads the 1MB doc and runs the typing
benchmark, logging `SPIKE3_LOAD` / `SPIKE3_BENCH` JSON to the console.

## What's implemented

1. **Live-preview projection** (`src/richMarkdown.js`) — ViewPlugin over the Lezer
   markdown tree (GFM base), viewport-scoped:
   - Headings sized/styled via line decorations; `##` + trailing space hidden.
   - Bold/italic/inline-code styled; `**`/`*`/backtick markers hidden.
   - Bullet list marks → `•` widget; ordered numbers kept (dimmed); task markers
     → real checkboxes (clicking toggles `[ ]`/`[x]` in the source).
   - Blockquotes: `>` hidden, left-border line style.
   - **Reveal-at-cursor**: markers reappear (dimmed, not hidden) when the selection
     touches the construct — line-granularity for headings/lists/quotes,
     node-granularity for inline emphasis/code. Code fences left raw.
2. **CriticMarkup redline** (`src/critic.js`) — StateField holds region ranges
   (regex parse; full scan on load, then **map-through-changes + windowed rescan**
   around each edit — no full-doc re-parse per keystroke). A separate viewport
   ViewPlugin renders: insertions green underline, deletions red strikethrough,
   substitutions as del+ins pair; `{++ ++} {-- --} {~~ ~> ~~}` markers hidden,
   revealed (dimmed purple) when the cursor is inside. Clicking a change opens an
   Accept/Reject popover that performs the real text edit (undoable).
3. **Comment highlights** (`src/comments.js`) — anchored ranges as subtle yellow
   marks, mapped through edits; click logs to console + flashes the range.
   3 hardcoded anchors on the demo doc, 100 generated on the perf doc.
4. **Perf harness** (`src/perf.js`) — 1MB generated doc (500 critic regions,
   100 comment anchors), corner HUD showing initial render, live keystroke latency
   (keydown → post-update frame), and a scripted 200-keystroke benchmark.
5. Bonus: **source view toggle** (projection extensions off via a Compartment) —
   demonstrates TD-2's "source view = decorations off" claim; it is exactly that.

## Measured performance (this machine)

Windows 11 Pro, headless Chrome (stable), vite dev server, Node 22.23.1.
Captured via `node measure.mjs`; stable across 3 runs.

| Metric | Value |
|---|---|
| 1MB doc (1,000,714 B), 500 critic regions, 100 comments — `setState` → painted | **12.6–34.3 ms** |
| Keystroke **dispatch** (CM state + DOM update, 200 keys at doc middle) | **avg 3.5 ms · p50 3.0 · p95 4.8–6.2 · max 22.5 ms** |
| Keystroke end-to-end (dispatch → next frame) | avg 17.7 ms (**vsync-bound**, 60 Hz) · max 25 ms |
| Outliers > 50 ms in 200 keystrokes | **0** |
| Demo doc first-ever load (cold module init) | 50–220 ms |

Reading: the actual editing work is ~3.5 ms/keystroke in a 1MB doc dense with
decorations — latency is dominated by the display's frame rate, not CM. FR-X-4
has comfortable headroom; the 1MB budget is met with roughly 4× margin inside a
single 60 Hz frame.

Why it's fast (and stays fast): everything expensive is viewport-scoped.
CM renders only visible lines; both decoration plugins build only over
`visibleRanges`; the critic StateField never re-scans the whole doc after the
initial load (positions are mapped through edits, only a ~2KB window around each
edit is re-parsed).

Functional checks: `node verify.mjs` — 12/12 pass (round-trip identity,
marker hiding, reveal-at-cursor both directions, checkbox toggle edits source,
accept/reject/substitution edits correct, popover via real mouse click, comment
anchors, fence critic stays literal), zero page errors.

## Honest assessment vs "Typora-grade"

**What felt good / proved out:**

- The projection genuinely reads as a rich document (see it, don't take my word:
  headings, redline, checkboxes, quotes all render; no markup visible until you
  enter a construct). Round-trip fidelity is a non-event — there is no serializer,
  `state.doc.toString()` *is* the file. Verified as check #1.
- Reveal-at-cursor is simple to implement correctly because it's just "decoration
  building consults the selection" — one code path, no mode. Rebuild on selection
  change is viewport-only and unmeasurable in the numbers above.
- Accept/reject as tiny text edits at known ranges (TD-2's core claim) works
  exactly as designed, is undoable for free via CM history, and the region field
  self-heals through arbitrary edits.
- Source view really is "decorations off" — a one-line Compartment reconfigure.

**What felt wrong / needs care (hands-on feel, not measurable headlessly):**

- **Cursor traversal through hidden markers:** hidden ranges are not atomic, so
  arrowing across `**bold**` takes keypresses "through" invisible characters —
  the construct reveals as soon as the selection touches it, which masks most of
  it, but there's a beat where a keypress seems to do nothing. Obsidian behaves
  the same way; still, budget a polish pass (`EditorView.atomicRanges` on the
  *away-from-cursor* hidden ranges is the likely fix).
- **Reveal pop:** entering/leaving a heading line reflows that line (markers
  add/remove width; heading font-size means the line is large). It's local and
  instant, but "text shifts sideways as the cursor enters" is the single biggest
  feel difference from Typora and needs real-hands evaluation by CJ.
- **Substitution rendering** shows old and new adjacent (`daily`~~struck~~ then
  `a daily act` underlined) with no separator glyph — legible but dense; product
  probably wants a thin arrow or spacing.
- **Line-granularity reveal on lists**: cursor anywhere on a list line reveals
  its `-` marker; fine, but with the checkbox widget the line's leading width
  changes. Same class of nit as the reveal pop.

**Spike-scoped shortcuts (production owes real versions):**

- Critic regex windowed rescan can mis-handle a region >~2 KB straddling the
  rescan window, and fence-exclusion depends on the lazily-parsed syntax tree
  (far-offscreen fences in a fresh 1MB doc aren't known yet). Both are owned by
  Rust `textops/` per TD-6 — the frontend model (ranges in, map through changes)
  is the part this spike validates.
- Heading sizes are applied via line decorations from a ViewPlugin. CM6 docs
  advise plugins shouldn't change vertical layout (it costs an extra measure
  cycle); it works and Obsidian ships this pattern, but the sanctioned
  alternative (syntaxHighlighting HighlightStyle for heading tags) should be
  preferred in the real editor. No misbehavior observed.

**CM6 API limitations hit (bearing on TD-2):** none blocking. Everything TD-2
assumes (replace/mark/line/widget decorations, viewport scoping, position mapping,
Compartments for display modes, history integration) exists and behaves. The one
watch-item is the vertical-layout note above.

## Not reached / left for later

- **Table widget feasibility** (TD-2 lists it as follow-on; SPIKE-3 scope
  mentioned it) — untested. Degraded pipe-table editing remains the assumption.
- Real-hands typing feel on this machine (numbers are headless; the HUD shows
  live keystroke latency when a human types — CJ should spend 10 minutes in it).
- Selection across hidden markup was verified programmatically, not by feel.
- IME/composition, clipboard, spellcheck interaction with hidden ranges.
- No tests in the repo suites — this directory is throwaway by design and is
  deliberately not wired into the main app's package.json or CI.
