ABOUTME: Records real-route browser evidence for the reachable pathless comments and selection states in design refresh (20).
ABOUTME: Separates measured existing behavior from the collapsed-Timeline and dictation controls that have their own cards.

# Refresh (20): pathless `9g` capture

Run `EMEND_ALIGNMENT_SCENARIO=pathless EMEND_ALIGNMENT_OUTPUT=docs/alignment-refresh20-pathless node scripts/capture-design-alignment.mjs` from the repository root to regenerate [the measurements](./measurements.json) and 16 PNGs. The capture starts the production Vite app with the D23 test driver, restores a real untitled session, creates two anchored comments through the live editor, opens a real thread, and uses the native-picker test seam for Save As. Its only substitutions are `navigator.platform` for Emend's Win32/MacIntel styling and the native picker result. The fixture uses one disposable project and a 1400×900 browser viewport adjusted to produce exact document-column widths. The JSON records the full source revision and scenario failures.

| State | Windows | macOS |
|---|---|---|
| Zero comments, 660 / 420 / 330px column | [660](./win-9g-0-comments-660.png) · [420](./win-9g-0-comments-420.png) · [330](./win-9g-0-comments-330.png) | [660](./mac-9g-0-comments-660.png) · [420](./mac-9g-0-comments-420.png) · [330](./mac-9g-0-comments-330.png) |
| Two anchored comments, 660 / 420 / 330px column | [660](./win-9g-2-comments-660.png) · [420](./win-9g-2-comments-420.png) · [330](./win-9g-2-comments-330.png) | [660](./mac-9g-2-comments-660.png) · [420](./mac-9g-2-comments-420.png) · [330](./mac-9g-2-comments-330.png) |
| Open comment thread | [thread](./win-9g-thread.png) | [thread](./mac-9g-thread.png) |
| Adopted through Save As | [adopted](./win-9g-adopted.png) | [adopted](./mac-9g-adopted.png) |

## Measured comparison

| Reachable fragment | Capture result | Design authority |
|---|---|---|
| Pathless selection | Selecting `Alpha` shows `Comment · Quote to chat` and no `Ask agent` on both platform styles. The same selection returns when the retained CodeMirror editor is focused after Save As; the editor DOM node and both anchored highlights survive adoption. | `specs/recovered-document.md` § Pathless selection popover (`9g`); CJ's pathless-selection ruling |
| Conditional count | Zero-comment status omits an open-comment item. After two comments it reads `2 open comments` at every captured width, including before Save As. | `specs/recovered-document.md` § Anatomy item 8; `specs/authoring-shell.md` § Status bar; `9g.7`/`9g.8` |
| Geometry | Both platform columns measure 660.0, 420.0, and 330.0px. The toolbar is one row at 45px Win / 47px mac. The status bar is 36px at 660px and 39px at 420/330px. | `specs/recovered-document.md` § Anatomy items 2 and 8; `specs/authoring-shell.md` § Toolbar and Status bar |
| Anchors and thread | Two `.cm-commentHighlight` spans with thread IDs remain after Save As. The existing comment-thread popover opens from the first anchor. | `specs/recovered-document.md` § Pathless selection popover; `specs/comments.md` |

The `9g.7`/`9g.8` mocks draw a **collapsed Timeline comments column**, a toolbar comment group, ordinary comment gutter markers, and a toolbar mic. Those controls are not yet present in the captured app. Issues #2537 and the other collapsed-Timeline and dictation cards own that composition. The existing gutter in this route is for severity marks; the ordinary comment anchors are visible as highlights in the text. Accordingly, these screenshots establish the reachable `9g` fragment, not full `9g.7`/`9g.8` parity. The source text and currently selected Markdown mode also differ from the mock's illustrative document.

At 330px with the second anchor selected, the floating selection actions measure 183.6px Win / 181.6px mac. The responsive fit shifts them left by 4.6px Win / 2.6px mac, leaving their right edge at the document-column edge on both platform styles. The real-route capture asserts both edges stay inside the column at 660/420/330px before each screenshot. Recheck this placement when the collapsed comments column and final narrow toolbar are composed.

This is browser evidence for Emend's platform styles, not a native macOS or Windows title-bar check. The saved-at time in adoption screenshots comes from the live fixture and is not a stable pixel oracle. `node --test scripts/capture-design-alignment.test.mjs` checks the named state matrix, exact pane widths, conditional count, selected adopted state, thread presence, PNG signatures, and absence of scenario failures.
