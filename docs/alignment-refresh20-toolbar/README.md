ABOUTME: Records real-route browser evidence for the existing toolbar controls in design refresh (20).
ABOUTME: Limits the comparison to reachable clean, redline, and pathless rows before dictation and collapsed Timeline arrive.

# Refresh (20): reachable `3d` toolbar capture

Run `COWRITE_ALIGNMENT_SCENARIO=toolbar COWRITE_ALIGNMENT_OUTPUT=docs/alignment-refresh20-toolbar node scripts/capture-design-alignment.mjs` from the repository root to regenerate [the measurements](./measurements.json) and 30 PNGs. The harness starts production Vite and the D23 backend, opens a disposable document, reopens it with a tracked insertion, then restores an untitled tab. It changes the real document-column width inside the shell after `document.fonts.ready`. `Win32` and `MacIntel` browser platform overrides select Cowrite's platform styles. The JSON names the full source revision, loaded font faces, computed font family, and any failed scenario.

| State | Windows | macOS |
|---|---|---|
| Clean, 792 / 660 / 420 / 330px | [792](./win-3d-clean-792.png) · [660](./win-3d-clean-660.png) · [420](./win-3d-clean-420.png) · [330](./win-3d-clean-330.png) | [792](./mac-3d-clean-792.png) · [660](./mac-3d-clean-660.png) · [420](./mac-3d-clean-420.png) · [330](./mac-3d-clean-330.png) |
| One tracked change, same widths | [792](./win-3d-redline-792.png) · [660](./win-3d-redline-660.png) · [420](./win-3d-redline-420.png) · [330](./win-3d-redline-330.png) | [792](./mac-3d-redline-792.png) · [660](./mac-3d-redline-660.png) · [420](./mac-3d-redline-420.png) · [330](./mac-3d-redline-330.png) |
| Pathless, same widths | [792](./win-3d-pathless-792.png) · [660](./win-3d-pathless-660.png) · [420](./win-3d-pathless-420.png) · [330](./win-3d-pathless-330.png) | [792](./mac-3d-pathless-792.png) · [660](./mac-3d-pathless-660.png) · [420](./mac-3d-pathless-420.png) · [330](./mac-3d-pathless-330.png) |
| Narrow redline `⋯` opened by keyboard | [menu](./win-3d-redline-keyboard-menu-330.png) | [menu](./mac-3d-redline-keyboard-menu-330.png) |
| Moved Bold executed by keyboard | [result](./win-3d-redline-moved-bold-executed-330.png) | [result](./mac-3d-redline-moved-bold-executed-330.png) |
| Moved Italic executed by pointer | [result](./win-3d-redline-moved-italic-executed-330.png) | [result](./mac-3d-redline-moved-italic-executed-330.png) |

## Measured comparison

| Reachable rule | Capture result | Design authority |
|---|---|---|
| One row | All 24 width/state/platform rows measure their target 792, 660, 420, or 330px document width within 2px, with no toolbar scroll overflow. Row height is 45px Windows / 47px macOS. | `specs/authoring-shell.md` § Editor toolbar, `3d` |
| Atomic format group | At each width, all four `B I H1 ≔` buttons are inline or all four move into `⋯`. The 330px tracked-change menu shows the review controls before the format row, in existing-action order. The 330px clean row can still keep all four inline. | `specs/authoring-shell.md` § (19) Narrow limit, `9g.5`/`9g.6` |
| Working moved actions | The harness selects `word` in Markdown, opens `⋯` with Arrow Down, runs moved Bold with Enter, waits for `**word**`, and verifies menu closure and focus return to More. It then opens `⋯` by pointer, runs moved Italic by pointer, waits for `***word***`, and verifies closure. Both results have after-state screenshots. | CJ's B4b menu ruling; `specs/authoring-shell.md` § one-row popover |
| Context | The clean and pathless rows have no review group. The redline row has one tracked change and its live review controls. | `specs/authoring-shell.md` § context group |
| Runtime font | The harness awaits font loading before every width loop. Each measurement records the toolbar's computed `font-family` and the browser's loaded `FontFace` entries; these runs use the app's IBM Plex Sans font, including the Win32 style override. | `specs/authoring-shell.md` § (18)/(19) threshold remeasurement |

I visually inspected the clean 330px, redline 420px, pathless 420px, redline keyboard menu, and executed-action captures in both platform styles against the applicable `3d`/`9g` rules. The mock's pinned editor mic, `Timeline ››`, Share control, comment context group, and 253/255px final floor require working dictation and collapsed Timeline; these captures do not claim that full composition. This Mac-hosted Chromium run does not provide native Windows Segoe UI Variable metrics or certify the final Segoe/SF breakpoints. The narrow pathless comment selection and status states are documented separately in [the `9g` capture](../alignment-refresh20-pathless/README.md). The selected-text action popover visible after Bold is an editor selection control, not an open toolbar menu.

This is browser evidence for platform styling, not a native OS title-bar test. `node --test scripts/capture-design-alignment.test.mjs` checks the named capture matrix, PNG signatures, measured widths/heights, and absence of scenario failures. The capture harness additionally asserts the atomic group, live action result, focus return, and one-row geometry while running the real route.
