<!-- ABOUTME: Evidence for #2541's throwaway CM6 dictation ghost mechanism spike. -->
<!-- ABOUTME: Records the browser probe, limits, and smallest production seam under TD-2 and J12. -->
# SPIKE-5: CM6 dictation ghost outside document history (#2541)

## Scope and verdict

**Mechanism feasible on macOS; production integration remains separate work.** A `StateField` that stores only provisional text and caret position can provide a CM6 `Decoration.widget` at the current selection head. Partial updates, caret motion and projection changes dispatch effects or selection transactions without changing the source Markdown or creating history. A final result uses one ordinary document transaction; a cancel or J12 freeze clears the field. This is the frontend/editor half of TD §3.1 and SPIKE-5, FR-ED-5, TD-2/P1, UX §2 Voice states and J12, and the ghost/freeze appearance in `docs/design/specs/authoring-shell.md` `3c.10`/`3c.11`.

The prototype is **throwaway** in gitignored `/spikes/spike5-ghost/`; none of its code is in this change. It uses Cowrite's actual `createDocumentState`, `viewModeExtensions`, `setSourceView`, and `structuralMarkdownExtensions`. The Rich text and Markdown branches are the production source-as-model projection extensions, mounted in a standalone CM6 `EditorView`; the prototype does not mount the React `DocumentSurface`, a real `UntitledDocument`, the Save As coordinator, or a speech backend.

## Gate A and reproduction

- Base: `main` `84d30fde1d352eee67d1e29cb860934bc13e876c`, dedicated `spike/issue-2541-cm6-ghost` worktree.
- Before editing, `npm test` passed: TypeScript plus 128 frontend files, 2,182 tests.
- macOS 27.0 arm64, Node 26.5.0, Playwright 1.61.1 headless Chromium. Start `npm run dev -- --host 127.0.0.1` and run `node spikes/spike5-ghost/run.mjs` from the spike worktree. The ignored directory contains the page, runner, and three raw JSON measurements.
- All 24 corrected browser assertions passed on three repeated runs. No production source file was changed.

## Functional observations

| Operation | Rich text | Markdown |
|---|---|---|
| Two live partials replace the same widget | Pass; exact document bytes and doc-change counter unchanged | Pass; same source bytes and counter |
| Move caret during a partial | Widget moves with the new selection head, no source edit | Same |
| Cancel | Widget removed; `undo()` has no entry | Same |
| Commit | Text enters source in one transaction; one undo restores exact starting text | Same |
| J12 freeze before snapshot | Widget removed; commit and an explicit programmatic edit are refused; unfreeze does not resurrect partial | Same |

The independent technical review found that the first caret-movement probe compared against `null`: it read the ghost position before creating the ghost. The corrected probe captures a rendered widget rectangle at source position 11, moves the caret to position 40, and requires the same widget text at a changed measured rectangle while the document remains exact. Across all three corrected runs, horizontal movement was 218.44 px in Rich text and 243.64 px in Markdown; the vertical coordinate stayed fixed because both positions are on the same line. The runner also asserts both rectangles exist and contain finite coordinates. The ignored raw JSON files contain the rectangles and all assertions.

The prototype's `StateField` derives widget position from `transaction.newSelection.main.head`. It holds no document text until commit. The frozen field exposes `EditorState.readOnly` and `EditorView.editable` for ordinary commands and typing; a `changeFilter` refuses programmatic changes. The prototype's freeze call clears the ghost synchronously before the caller could serialize the state. That demonstrates the J12 ordering seam, **not** that the current product Save As lifecycle already invokes it.

## Latency

The runner measures synchronous `view.dispatch(effect)` through CM6 DOM update and a `.spike-ghost` DOM query. It does not measure microphone capture, inference, IPC, animation frame paint, end-to-end speech latency, or a real Save As operation. Browser `performance.now()` resolution was about 0.1 ms, so sub-millisecond figures are coarse.

| Fixture | Updates per projection | p95, each of 3 runs | Maximum observed across 3 runs |
|---|---:|---:|---:|
| 79-character document, Markdown projection | 1,000 | 0.1 ms | 0.5 ms |
| 1,024,499-character document, 500 heading/bold regions, Rich text | 200 | 0.2 ms | 0.7 ms |
| Same large document, Markdown | 200 | 0.2 ms | 0.3 ms |

All 1,000 small-document partials caused zero document changes. The 1 MB fixture used a separate offscreen mounted editor with the same production projection extensions and 500 repeated Markdown regions. Its results are below the test plan's p95 <16 ms keystroke-work target, but they establish only this browser's effect/DOM cost, not a cross-platform performance guarantee.

## Implementation recommendation and limits

1. Add a dedicated `editor/` ghost extension beside the existing render-only extensions in `DocumentSurface`. Store provisional text and mapped caret/selection target in a `StateField`; render a `Decoration.widget` with the `3c` ghost style. Do not mutate `state.doc`, dirty tracking, autosave, serialization or history on partial updates.
2. Deliver final transcript as one normal CM6 change transaction at the selected target, clearing the ghost in that same transaction. Cancel clears only the field. Use the existing document transaction path so the final text is undoable exactly once and retains TD-2 source fidelity.
3. At the J12 session-finalization freeze boundary, synchronously clear the ghost before composing the durable snapshot and refuse later text transactions. Unfreeze must not replay a stale partial. Apply the same state machine to both projections on the single mounted `EditorView`.
4. Add discriminating production tests for the real `DocumentSurface`/`UntitledDocument` + Save As boundary, user typing/IME while recording, CRLF and Unicode offsets, a selected range, rapid partial/final/cancel ordering, and tab or pane teardown. This spike did not exercise those integrations or run on Windows.

**Later product ruling (CJ, 2026-10-02):** the prototype's follow-caret behavior above is superseded. Production dictation keeps the original insertion point when the caret or selection moves and maps that point through ordinary document edits (`docs/ux-design.md` §2). The prototype's measurements remain evidence for the widget mechanism, not for follow-caret placement. Multiline provisional output still needs a rendering check: the prototype's inline widget uses `white-space: pre-wrap`, but long or multiline ghost text may require a distinct block treatment to keep CM6's measured line geometry stable. SPIKE-5's whisper.cpp binding-freshness half and the local voice pipeline are outside #2541's stated goal and remain unproven here.
