ABOUTME: Records the measured Gate A baseline for aligning currently working Cowrite surfaces to the design mocks.
ABOUTME: Separates captured defects, already matching treatments, and states still requiring native or fixture evidence.

# Current-feature design alignment baseline

Captured 2026-09-30 from `main` at `abc57b012`. Browser screenshots use the current Vite frontend, D23 test driver, a disposable project, light theme, and a 1400×900 viewport unless a narrow width is named. `Win32` and `MacIntel` browser platform overrides select Cowrite's platform styling; they do **not** reproduce native Tauri chrome. Representative current-build screenshots are beside this inventory. Capture scripts, full computed geometry and additional states are under `/private/tmp/cowrite-alignment-a1a-b/` and `/private/tmp/cowrite-alignment-a1c-d/`; A1e/A2 observations and computed values are under `/private/tmp/cowrite-alignment-a1e-a2/`. The temporary files are working evidence; recapture at E1.

## Difference inventory

| Mock / expected | Current capture and measurement | Owner / bounded card |
|---|---|
| `3a/3b`, `timeline-rail.md`: 372px rail, warm `#F5F3ED` Windows / `#F1EEE7` macOS. | [win-authoring.png](./win-authoring.png), [mac-authoring.png](./mac-authoring.png): `.timeline-panel` 320px, white. Document lane is correspondingly 52px wider. | `.timeline-panel`, C1a |
| `3a/3b`: five separate 11.5px facet pills, 6px gaps, padded bar, ink active fill. | Same captures: `.timeline-panel__facets` 31px contiguous strip, blue `#2F6FEB` active cell. | `.timeline-panel__facets`, `.timeline-panel__facet`, C1a |
| `3a/3b`, `tokens.md`: warm app-owned chrome and `#2F5D8C` blue. | Same captures: global surface `#F4F5F7`, background white, accent `#2F6FEB`; `.app-header` is 48px. Mock's 38/44px row includes OS controls, so title-row geometry awaits A2 decision. | Root tokens and `.app-header`, B1; title row gated by A2 |
| `3a/3b`, `timeline-rail.md`: warm padded pinned composer, 38px input. | Same captures: `.message-composer` transparent, 53px total, 35px textarea. Mock-only attach/provider/voice controls are excluded. | `MessageComposer`, C3 |
| `1a`, `13a/13b`: hi-fi warm welcome composition. | [win-welcome.png](./win-welcome.png), [mac-welcome.png](./mac-welcome.png): `.welcome-screen` 480px column on white. Recent empty and deferred GitHub wording are truthful. | `WelcomeScreen`, D5 |
| `10c`: center-stage workshop conversation measure. | [win-workshop.png](./win-workshop.png), [mac-workshop.png](./mac-workshop.png): existing workshop removes document chrome correctly but the conversation fills 1164px after the rail. The drawn project-home strip may imply a separate unbuilt capability and is excluded pending scope evidence. | Workshop timeline layout, C1b |
| `9c.2/9c.6`, `recovered-document.md`: narrow loss copy starts “That work was larger than…” and keeps its final caution; Hide message moves below the copy. | [9c2-current-420.png](./9c2-current-420.png), [9c2-current-330.png](./9c2-current-330.png): full provenance copy remains and Hide message stays beside it, reducing text widths to 261.9/155.9px. | `UntitledDocument`, narrow notice CSS, D1 |
| `9c.6`, `9e.2`: 11.5px/1.5 Save As failure line; `#E9D8AC` composed divider. | Source and `9c.2` captures: `.untitled-document__error` is 13px; loss divider is `#E0C98C`. Failed Save As and composed state still need direct capture. | Untitled CSS, D1 |
| `9c.1–9c.6`: footer sentence ends with a period. | [9c2-current-660.png](./9c2-current-660.png): mounted footer copy omits the final period; 329px capture shows footer wrapping while visible. | `UntitledDocument`, D1 |
| `13a/13e`: queued suffix is a muted second run on the same line. | Source: queue text is inside `.project-open-status__fixed` and takes body ink. Queue state needs direct capture. | `ProjectOpenStatusRegion`, D4 |
| `13g`: reason clips first, then name to 160px floor, then fixed words; actions stay visible; band stays 46px. | [13g-failure-current-520.png](./13g-failure-current-520.png), [13g-failure-current-430.png](./13g-failure-current-430.png): fixed outcome suffix disappears while name still uses 246.8/156.8px. Reason is already 0px. Band remains 46px. | Status message flex layout, D4 |
| `6a/6b/6c`: retained rail rows at .55 opacity during update/failure and platform retry radii. | [mac updating](./mac-updating-browser.png), [mac update failed](./mac-update-failed-browser.png): retained active row stays fully saturated; generic retry radius is 6px. | `ProjectRail` CSS, B2 |
| `1m`: General Settings hierarchy and currently working controls. | [Windows browser](./win-settings-browser-emulation.png), [macOS browser](./mac-settings-browser.png): 720×460 card, 180px nav, 8/12px platform radii match. Theme currently lives in shell header instead of General; moving it needs scope/interaction review. | `SettingsDialog`, D5 |
| `3a/3b`: unified title row with platform system controls. | Actual older macOS Tauri app and current `tauri.conf.json`: native title bar is above web `.app-header`. Native Windows runtime unavailable. | A2 architectural choice; do not change window decorations until CJ decides |

## Already aligned or correctly conditional

- `3a/3b`: project rail is 236px with exact platform warm fills and active-row treatments; tab strip, toolbar, and status bar already use warm surface literals. The `FILES` header remains until the separate Documents/Skills rail feature owns its replacement.
- `10a/10b`: captured user and agent card shells, agent tile and `refs: 2 files read` footer match the specified colors, radius, border/shadow and type. C2 must use a different reachable state before changing these.
- `9c.3/9c.5`: mounted collapsed notice and close guard exist; toolbar remains above the notice. `11` external-change phases, `12` author/neutral fallback, and `13` band state/action structure are implemented and covered by focused tests; appearance for uncaptured states is not yet certified.
- `1m`: General Settings already uses the 720×460 dialog and 180px navigation hierarchy. Its wireframe supplies hierarchy rather than literal styling.

## Evidence limits and remaining capture

The A1a/A1b fixture did not reach redline, comment/gutter, change-set, working-agent, quote, or project-open queue states. A1c/A1d reached narrow untitled, guard, and two project-open outcomes, but not Save As failure, write-pending external change, Compare, all render-fallback modes, or active-run refusal. A1e captured loading, ready, updating, failed-update, unavailable and General Settings in browser platform branches; native chrome is still outstanding. Browser platform emulation cannot certify macOS or Windows native title controls; the available packaged macOS build predates current frontend code, and no Windows runtime was available. E1 must recapture every applicable reachable state after implementation and record any remaining gap rather than claim complete visual parity.

The mock's comments column, Documents/Skills split, correction flow, Share, attach, voice, and provider switch are separate unbuilt features. `project-open-status.md` §11 and portions of J15 remain proposals, not behavioral authority for this pass. `state.md` keeps toolbar-overflow menu details open; B4b waits for CJ's disposition.
