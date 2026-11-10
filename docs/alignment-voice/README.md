ABOUTME: Records source-stamped light-style voice screenshots for the editor, Timeline, and comment composer.
ABOUTME: Separates a typed visual owner fixture from real microphone, native-window, and behavior evidence.

# Voice surface visual evidence (#2627-B)

Regenerate from the repository root with:

```sh
EMEND_ALIGNMENT_SCENARIO='=voice' EMEND_ALIGNMENT_OUTPUT=docs/alignment-voice node scripts/capture-design-alignment.mjs
```

[`measurements.json`](./measurements.json) records the exact Git source revision, browser viewport, loaded fonts, CSS/DOM geometry, and per-image owner phase. The capture runs production Vite, React, CodeMirror, CSS, the overflow toolbar, the comment route and the D23 backend against a disposable document. D23 has **no linked voice owner**. The script supplies typed `get_voice_status`, `start_voice_dictation`, `cancel_voice_dictation`, and `voice://dictation` responses only at that absent transport boundary. The resulting images establish visual composition, not physical microphone capture, a Whisper transcript, native Windows chrome, or end-to-end voice behavior. `Win32` and `MacIntel` navigator overrides select the two browser platform styles; every frame uses light color scheme, 900px height, and device scale 1.

| Reference | Windows browser image | macOS browser image |
|---|---|---|
| `3c` editor idle | [idle](./win-voice-editor-idle.png) | [idle](./mac-voice-editor-idle.png) |
| `3c` 42% download | [download](./win-voice-editor-downloading.png) | [download](./mac-voice-editor-downloading.png) |
| `3c` recording plus editor ghost | [recording](./win-voice-editor-recording-partial.png) | [recording](./mac-voice-editor-recording-partial.png) |
| `3c` transcribing | [transcribing](./win-voice-editor-transcribing.png) | [transcribing](./mac-voice-editor-transcribing.png) |
| `3c` no-device error | [error](./win-voice-editor-error.png) | [error](./mac-voice-editor-error.png) |
| `3c` permission-denied error | [error](./win-voice-editor-error-permission.png) | [error](./mac-voice-editor-error-permission.png) |
| `3c` missing-model error | [error](./win-voice-editor-error-model.png) | [error](./mac-voice-editor-error-model.png) |
| `3c`/`9d.1` J12 frozen Save As | [frozen](./win-voice-editor-frozen.png) | [frozen](./mac-voice-editor-frozen.png) |
| `3d` 330px editor toolbar while recording | [narrow](./win-voice-narrow-330.png) | [narrow](./mac-voice-narrow-330.png) |
| `4f` Timeline composer idle | [idle](./win-voice-timeline-composer.png) | [idle](./mac-voice-timeline-composer.png) |
| `4f` Timeline composer recording/partial | [recording](./win-voice-timeline-recording-partial.png) | [recording](./mac-voice-timeline-recording-partial.png) |
| `14c` comment composer recording/partial | [comment](./win-voice-comment-composer.png) | [comment](./mac-voice-comment-composer.png) |

## Measured comparison and remaining deltas

- The editor, Timeline, and comment controls measure **28×26px** on both browser platform styles. The editor row stays one line (**45px Windows / 47px macOS**) and the mic remains outside the `⋯` menu at a **330px** document column while that menu is visible. The recording label is `Stop dictation — recording`; the download control is `aria-busy` at 42%; the recorded ghost is the typed fixture's `a provisional sentence` in the CodeMirror widget, with `#8C8779` computed ink and the specified 3px left offset. The status echoes use the `3c` strings. These observations agree with `specs/authoring-shell.md` `3c`/`3d` at the measured states.
- The Timeline composer mic sits inside the input's right edge and keeps the 28×26px geometry at idle and while recording. With a provisional line below the 38px input, `Send` stays level with that input (1px top offset) and the partial remains inside its column, matching refresh (22) `14d`.
- The comment composer mic sits at the **left inner edge of the action row** in the 340px popover. The textarea is at least 64px high; Cancel and the 80px ink-primary Comment button stay on the same row, with Comment flush to the right inner edge. The action is disabled on an empty draft and enabled after typed or final speech text. These light platform captures and the mounted draft test cover this `14c` treatment; the later dark-phase and composer-error packages are linked below.
- The first macOS error capture exposed a **neutral `#E3DFD6` visible stroke** because its platform box shadow overrode the `3c` reject border. The CSS correction and final capture now measure `#DCC4BF` on the error stroke while the macOS idle chip retains `#E3DFD6`; the Windows error border also uses `#DCC4BF`.
- All three drawn `3c` error labels and status echoes are asserted separately. CJ ruled that activating a no-device, no-default-device, selected-device-unavailable, or permission-denied mic opens Settings at Voice without retrying Start (#2635). Merged refresh (23) records that route in `specs/state.md`; these source-stamped images predate the interaction ruling and remain visual evidence only.
- The J12 frozen capture holds the real `save_tab_session` close-finalization request in the dev-only D23 harness, after the editor retires its ghost. The mutable pane is inert and has computed opacity **0.55**. The disabled mic has no additional opacity (`1`), so the entire pane, including the toolbar and mic, appears at **55%**. CJ ruled on 2026-10-02 that this whole-pane treatment governs; merged refresh (23) corrects `3c` to agree with `9d.1`.
- Prior [toolbar evidence](../alignment-refresh20-toolbar/README.md) covers the wider `3d` 330/420/660/792px fit compositions. This package adds recording mic pinning at 330px only. Later packages linked below cover dark browser styling; native title controls and physical device/inference remain separate validation needs.

The source-stamped script test rejects missing images, unloaded fonts, moved narrow mic, toolbar wrapping, absent overflow, missing editor ghost, and a Timeline mic outside the input. The regular browser suite checks voice-independent authoring paths against the D23 backend. The fixture does not replace its behavior tests.

## Current design handoff

Merged refresh (23) defines the comment action row, Timeline provisional placement and CJ's 900px overflow ruling. This package remains the light-theme evidence for these surfaces. Separate source-stamped packages now cover the [dark mic phases](../alignment-voice-dark/README.md), [Voice Settings](../alignment-voice-settings-controls/README.md), [model rows](../alignment-voice-model/README.md), [editor ghost](../alignment-editor-ghost/README.md), [composer errors](../alignment-voice-composer-errors/README.md), and [dark 900px toolbar and J12 freeze](../alignment-refresh23-dark/README.md).
