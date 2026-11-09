# Prose alignments pending at export for `../ux-design.md` — recorded 2026-10-01 (20)

**Status: pending at export; applied by issue #2531 alongside this folder.** This folder never edits `docs/ux-design.md` on its own; the issue #2531 import applies both alignments in the same PR. §A gives exact J9 replacements; §B identifies the untitled-comment clauses and replacement directions. Line numbers are against the synced copy of 2026-10-01 and may drift. Before that import merges, `../ux-design.md` wins on behavior; afterward this file remains the alignment record.

## A. J9 — `✕` during an in-flight project-open request (CJ ruling, 2026-10-01)

**Ruling:** `✕` is **present** while a request or retry is in flight. Dismissing hides the band and does not cancel the request. **The band returns with the terminal outcome**, so FR-X-11's visible outcome still lands. Drawn in `13a`, `13e` states 1/2/2′ and `13f.3`/`13f.4`.

| Site | Current text | Replace with |
|---|---|---|
| J9 Phase A (~l.1022) | Dismiss is absent—not disabled—while the request or a retry is in flight, and returns with the terminal outcome. | Dismiss stays available while the request or a retry is in flight; dismissing hides the status line without cancelling the request, and the line returns with the terminal outcome. |
| §2 *Project-open routing states*, **Requesting** row (~l.528) | Dismiss is absent while the request or a retry is in flight and returns with the outcome | Dismiss stays available while the request or a retry is in flight; it hides the line without cancelling, and the line returns with the outcome |
| §4 *Status region* (~l.1624) | On the established welcome/author/workshop surfaces it remains dismissible except while a J9 project-open request or retry is in flight; the control is absent for that interval and returns with the terminal outcome. | On the established welcome/author/workshop surfaces it remains dismissible, including while a J9 project-open request or retry is in flight; dismissing an in-flight request hides the line without cancelling it, and the line returns with the terminal outcome. |

The **retry-pending** `Trying…` control is unchanged: inert but present, focus kept, `aria-busy` on the band.

## B. Untitled documents take comments (CJ ruling, 2026-10-01)

**Ruling:** Emend already anchors comments on an untitled document before Save As (`e2e/acceptance.spec.mjs`, ~l.1797), and that capability is kept. Removing it would be a separate product and code decision. Drawn in `9g` (popover), `9g.7`/`9g.8` (populated), `4c.1`/`4d`/`9h` (empty).

| Site | Current text (abridged to the clause) | Replace with |
|---|---|---|
| Top-of-file amendment, UXR-Q13/Q14.3 (~l.10) | an untitled document whose comments cannot yet attach says `Comments are available after Save As`. | an untitled document says the same `No comments in this document`, under the same load-succeeded condition (amended 2026-10-01: untitled documents take comments). |
| §2 untitled table, **Comments** row (~l.464) | `| Comments | **absent, not zero** | Path-keyed until #1803 |` | `| Comments | **present** — anchored on the buffer, as on a file-backed pane; they move with the document on Save As | Amended 2026-10-01 |` |
| §2 untitled table, **Selection popover** row (~l.465) | `Quote to chat` present; `Ask agent` absent; `Comment` unlisted | `Comment` and `Quote to chat` present; `Ask agent` absent until Save As. The refreshed appearance is drawn in `9g`, so remove the old undrawn-state note. |
| J12 *Travels / Stays* table (~l.1268) | "Path-keyed comments and change records (#1803)" in **Stays** | move "Comments" to **Travels**; "change records" stays |
| J12 Phase E (~l.1337) | **Comment creation, comment anchors, gutter icons, and the comments column's content are out of scope** — … **absent, not zero** … (Principle 7). | **Comments are admitted** (amended 2026-10-01): creation, anchors, gutter icons and the comments column behave as on a file-backed pane. The open-comment count appears at ≥1 and is absent at 0, as the tracked-change count does. |
| J12 Phase E (~l.1338) | **The collapsed rail says why this pane has no comments …** `Comments are available after Save As` rather than … `No comments in this document` | **The collapsed rail behaves as on a file-backed pane:** the comments column keeps its width and, after its comments load succeeds with no threads, says `No comments in this document`. |
| J12 Phase E, `Quote to chat` bullet (~l.1339) and UXR-Q14.4 (~l.1427) | the pathless selection offers `Quote to chat`, not `Comment` | the pathless selection offers `Comment` and `Quote to chat`; only `Ask agent` waits for Save As |
| J12 adoption (~l.1349) | the comment group and `Share ▾` **arrive into the existing row** | `Share ▾` **arrives into the existing row**; the comment group is already present at ≥1 comment and stays put |
| §4 collapsed-rail supplement (~l.1648) | The first rule begins `On an open file-backed document`; the later untitled sentence says `Comments are available after Save As`. | Broaden the first rule to `On an open document`, with the same successful-empty-load condition; delete the untitled exception sentence. |
| §5 UXR-Q13.1 (~l.1739) | The first sentence scopes the empty message to an `open file-backed document`; the last sentence excludes untitled panes. | Broaden the first sentence to `open document`; replace the last with `The same loaded-empty rule applies to an untitled pane (amended 2026-10-01).` |
| §5 UXR-Q14.3 (~l.1746) | Keep the same comments column and show `Comments are available after Save As` for an untitled document. | **Superseded 2026-10-01:** untitled documents take comments, so the column shows the ordinary `No comments in this document`. |
| J2 / J12 cross-reference (~l.672) | "the comment boundary held for #1803" | "comments (admitted 2026-10-01)" |
