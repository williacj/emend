ABOUTME: Records real restored-session browser evidence for D27's unsupported legacy-tab states in refresh (20) `9h`.
ABOUTME: Separates measured implementation from the generated mock's omission-only tab closure error.

# Refresh (20): D27 legacy unsupported-tab capture

Run `EMEND_ALIGNMENT_SCENARIO='D27 legacy' EMEND_ALIGNMENT_OUTPUT=docs/alignment-refresh20-d27 node scripts/capture-design-alignment.mjs` from the repository root to regenerate [the measurements](./measurements.json) and 24 PNGs. This capture writes a real version-1 `.emend/tab-session.json` with `research/survey-export.csv` as the active unsupported tab, opens its disposable project through Emend's production route, and observes the Rust refusal and restored-session presentation. It substitutes only `navigator.platform` for Win32/MacIntel styling and the native Save As picker result. The JSON records source revision `c0d20e96942c7d2798c28ec2fbc050af6bcdeaf3`, fixture path, observed state, CSS boxes, and scenario failures (none).

| State | Windows | macOS |
|---|---|---|
| Retained text: full window and 660 / 440 / 330px pane | [full](./win-9h-retained-1400.png) · [660](./win-9h-retained-660.png) · [440](./win-9h-retained-440.png) · [330](./win-9h-retained-330.png) | [full](./mac-9h-retained-1400.png) · [660](./mac-9h-retained-660.png) · [440](./mac-9h-retained-440.png) · [330](./mac-9h-retained-330.png) |
| After Save As adoption | [adopted](./win-9h-adopted-1400.png) | [adopted](./mac-9h-adopted-1400.png) |
| Retained text plus earlier omission: full and 440 / 330px pane | [full](./win-9h-composed-1400.png) · [440](./win-9h-composed-440.png) · [330](./win-9h-composed-330.png) | [full](./mac-9h-composed-1400.png) · [440](./mac-9h-composed-440.png) · [330](./mac-9h-composed-330.png) |
| Clean refusal: full and 430px status crop | [full](./win-9h-clean-refusal-1400.png) · [430](./win-9h-clean-refusal-430.png) | [full](./mac-9h-clean-refusal-1400.png) · [430](./mac-9h-clean-refusal-430.png) |
| Omission-only refusal: full and 430px status crop | [full](./win-9h-omission-refusal-1400.png) · [430](./win-9h-omission-refusal-430.png) | [full](./mac-9h-omission-refusal-1400.png) · [430](./mac-9h-omission-refusal-430.png) |

## Measured comparison

| Route | Observed result | Design authority or gap |
|---|---|---|
| Retained text | The full window title is `Untitled — from research/survey-export.csv` (prefixed `Cowrite —` in Windows style). The tab names the former path. A neutral source notice follows the toolbar, then the untitled standing strip and exact retained editor buffer. The notice background is `rgb(240, 237, 230)` Win / `rgb(237, 234, 226)` mac. Its measured height grows from 77.6 / 76.6px at the full width to 164.8 / 163.8px at 330px. | `docs/ux-design.md` J2 D27 amendment; `docs/d27-legacy-unsupported-recovery-visual-refresh-brief.md`; refresh (20) `9h.1`. |
| Save As | The picker route adopts to `recovered.md`, changes the title to that path, removes the source notice, writes the exact retained text, and leaves the original `.csv` bytes unchanged. | J2/J12 Save As adoption. |
| Earlier omission plus retained text | The neutral source notice precedes a separate amber loss notice, followed by the standing strip. At 440px their measured heights are 130.2 + 93.8px Win / 129.2 + 92.8px mac; at 330px they are 164.8 + 131.0px Win / 163.8 + 130.0px mac. The omission never claims missing bytes were recovered. | Refresh (20) `9h.3`; the separate facts are binding. |
| Clean refusal | The unsupported tab closes, `notes.md` becomes active, and the visible 46px status band says its tab was closed. `Dismiss` is focusable. The 430px crop stays one line. | Refresh (20) `9h.2` clean branch. |
| Omission-only refusal | The 46px band truthfully says the earlier unsaved work was not kept. CJ ruled that the unsupported tab and loss marker remain after this refusal; the direct tab remains selected with `data-recovery-content-omitted=true`, a visible 6×6px amber dot (`rgb(181, 135, 31)`) in both platform styles, and an accessible loss statement. No editable recovered buffer is invented. | Merged [#2579](https://github.com/williacj/cowrite/pull/2579) supplies the marker. CJ's D27 ruling overrides generated `9h.2`, which incorrectly closes this tab; the visual mock must be updated to show the retained omission-only tab and marker. |

These are Chromium browser captures of Emend's platform styles, not native Windows or macOS title-bar validation. The full-window fixture is 1400×900; pane-width files crop the actual document pane after adjusting the viewport, and refusal-width files crop the status band at a 430px viewport. The folder basename and Save As timestamp come from the disposable live fixture. `node --test scripts/capture-design-alignment.test.mjs` checks the named state matrix, source stamp, exact pane widths, notice ordering, 46px refusal geometry, visible tab marker, PNG signatures, and absence of scenario failures. The capture script also asserts the real Save As bytes and source-file preservation before recording adoption.
