# Voice surfaces, Voice Settings and the collapsed-host fit (refresh (24))

Mocks: `14g` (retryable error mic cues, (24)), `14a` (900px row with the switch in `⋯`, 1000px chip), `14b` (Voice Settings), `14c` (comment-composer mic), `14d` (Timeline provisional text, editor multiline ghost, 330px pinned mic), `14e` (error routes), `14f` (J12 freeze at 55%). Earlier voice mocks still bind: `3c` (editor chip states), `3d` (measured fit), `4f` (Timeline input placement). Read `tokens.md` and `platform-variants.md` first.

Behavior sources, not redefined here: `../ux-design.md` §2 *Voice / dictation states* (editor target, chat/comment draft placement, device and permission recovery — CJ 2026-10-02, #2635), the UXR-Q23 collapsed-host fit supplement (CJ 2026-10-02, #2540), §4 *Settings* inventory, J12 freeze; `../functional-spec.md` FR-ED-5. Issues: #2602 (`14a`), #2611 (`14b`), #2613 (`14c`/`14d`), #2635 (`14e`).

Comparison evidence, by surface (all source-stamped **browser** captures, Win32 / MacIntel styles):
- 900px toolbar and menu — `docs/alignment-compact-toolbar-900/`, **light only**.
- J12 frozen pane — `docs/alignment-voice/`, **light only**.
- Editor, Timeline and comment-composer mic, light — `docs/alignment-voice/`; dark mic chip (all states, three surfaces) — `docs/alignment-voice-dark/`.
- Editor ghost: original caret, held selected range, 330px — `docs/alignment-editor-ghost/`, light and dark.
- Timeline and comment composer provisional and error states — `docs/alignment-voice-composer-errors/`, light and dark.
- Voice Settings and model states — `docs/alignment-voice-settings-controls/`, `docs/alignment-voice-model/`, light and dark.

None of these establishes physical microphone capture, live download or Whisper inference, or native Windows title-control interaction.

---

## 1. The shared mic chip

Unchanged from `3c`: 28×26, platform chip edge (Win 1px `#D5D0C4` r6 · mac 1px `#E3DFD6` hairline r7), white, 12×15 glyph. **Fixed size in every state on all three surfaces.**

| State | Light | Dark |
|---|---|---|
| Idle | outline, glyph `#3A362F` | `#1E1F22`, edge `#3A3D42`, glyph `#E6E7EA` |
| Downloading | glyph `#6B665C`, 18×2 hairline (`#E3DFD6` track, `#4F46E5` fill) | track `#3A3D42`, fill `#A5B0FF` |
| Cancelling | `#EDEAE2`, three static `#6B665C` dots | `#26282C`, dots `#9AA0A6` |
| Download cancelled | glyph `#6B665C`, hairline held in `#A39E92` | fill `#9AA0A6` |
| Recording | solid `#1F1D1A`, filled `#FCFBF8` capsule | solid `#E6E7EA`, filled `#1E1F22` capsule |
| Transcribing | `#EDEAE2`, three `#3A362F` dots | `#26282C`, dots `#E6E7EA` |
| Error (all ten reasons) | `#F8EFED` / **`#DCC4BF`** stroke (mac as a 1px hairline) / `#A33A2E` slashed glyph | `#26282C` / `#F87171` / `#F87171` |
| Unavailable (voice off, build, owner) | idle at 45% | idle at 45% |
| Frozen (J12) | **idle treatment, no opacity of its own** — the pane supplies 55% (§7) | same |

Focus ring 2px `#4F46E5` (dark `#A5B0FF`) at 2px offset. Accessible names and status echoes are Emend's (`DictationMic.tsx`, `voicePresentation.ts`) and are not restated here.


### 1a. Retryable error cues (`14g`, #2613, (24))

Same 28×26 chip, platform edge and slashed glyph in every state. Applies identically to the editor toolbar, the Timeline input and the comment-composer action row.

| State | Light fill / stroke / glyph | Dark fill / stroke / glyph |
|---|---|---|
| Rest (all ten reasons) | `#F8EFED` / `#DCC4BF` / `#A33A2E` | `#26282C` / `#F87171` / `#F87171` |
| Hover | `#F3E4E0` / `#CFA9A1` / `#A33A2E` | `#33292B` / `#F87171` / `#F87171` |
| Pressed | `#ECD7D2` / `#C29890` / `#8E2F25`, inset `0 1px 1px rgba(31,29,26,.10)` | `#3D2C2E` / `#FCA5A5` / `#FCA5A5`, inset `0 1px 1px rgba(0,0,0,.35)` |
| Keyboard focus | rest + 2px `#4F46E5` ring, 2px offset | rest + 2px `#A5B0FF` ring, 2px offset |

Windows strokes are a 1px border; macOS strokes are the 1px hairline (box-shadow), with the pressed inset appended.

**Distinction.** On hover, press and keyboard focus, **retryable** errors add a `↻` cue (9px/600, glyph colour, inside the chip at right 1px, bottom 0). Settings-route errors (no_device, no_default_device, selected_unavailable, permission_denied) take the same fills and ring **without** the cue and keep `aria-description="Opens Voice Settings"`. At rest all ten look identical.

**Accessible labels (retryable).** Name `Dictate — <echo, sentence case>`. Description: model_missing / model_corrupt — `Downloads the voice model, then starts dictation`; download_failed — `Retries the voice model download, then starts dictation`; backend_unavailable / invalid_audio / inference_failed — `Retries dictation`. Activation is unchanged (`14e`).

**Remaining gap.** Emend ships only the rest colours and focus ring (`.dictation-mic--error`, `:focus-visible`): no hover or pressed rule, no `↻` cue, no description on retryable errors. No capture shows these states. The three descriptions are approved by CJ. The implementation gap remains.

## 2. Collapsed-host fit (`14a`, #2602 / #2641)

**Ruling (CJ 2026-10-02, #2641).** At a 900px window the project rail stays 236px and the comments column 400px; the editor toolbar is 263px. The **mic and the Timeline return stay in the row**; the **Rich text / Markdown switch follows the format group into `⋯`** when the row needs the space. Ordinary toolbar spacing is kept (padding 9px 14px, group gap 10px, right-cluster gap 8px) — the (22) compact-spacing proposal is withdrawn.

**Row at 900px.** `mic 28 · return 44 · ⋯ 28`, right-aligned at the 14px padding, gap 8px, one row: 45px Windows / 47px macOS. `⋯` is always last.

**Return control.** A stable **44×26** button, platform chip edge: `››` (12px `#A39E92`, dark `#9AA0A6`) plus, while a permission is pending, the **16px nonnumeric Pause badge** (`#B5871F` disc, two 2×7 white bars; dark `#FCD34D` / `#1E1F22`); padding `0 4px`, gap 4px. Name `Show Timeline` / `Show permission request in Timeline`. One physical button: the badge arriving or clearing never changes its width or position, never moves focus, and never opens, closes or reflows the menu.

**The `⋯` menu.** Opens 4px below `⋯` with right edges aligned. Min-width 180px, padding 6px, 5px between rows. Win 1px `#D5D0C4` r7; mac r9 hairline; both `0 8px 22px rgba(31,29,26,.16)` (dark `rgba(0,0,0,.35)`). Rows in row order: **the switch first**, then the format group as one row of bordered 27/27/31/31 buttons. Keyboard open focuses `Rich text`; `⋯` keeps its `#F0EDE6` open fill. When width returns, the switch goes back inline before the format group, and focus moves with it.

**At 1000px** (editor column 364): the switch is inline, the full `Timeline ››` chip shows with its 16px badge space reserved (same width idle and pending), and the format group stays in `⋯`.

**States.** Hover `#F0EDE6` · pressed `#E8E4DB` (mac adds a 1px inner shade) · keyboard focus 2px `#4F46E5` at 2px. Dark hover/pressed `#3A3D42`, ring `#A5B0FF`.

**Switch geometry (shipped).** Height 26, segments `padding 0 8px`. Win: 1px `#D5D0C4` r6, white track, active `#1F1D1A` / white 500 (dark `#A5B0FF` / `#10131A`). mac: `#E8E4DB` track, 2px inset, r8; active white pill r6 with `0 1px 2px rgba(31,29,26,.12)` (dark `#3A3D42` track, `#1E1F22` pill).

**Fonts.** The toolbar uses bundled IBM Plex Sans on both platform styles, so these figures are the shipped ones and need no per-platform re-measurement.

| Width | IBM Plex Sans (bundled) |
|---|---|
| 900 inline row: 14 + 28 + 8 + 44 + 8 + 28 + 14 | 144 / 263 |
| Menu switch row | ≈ 125 |
| Menu format row | 122 |
| Menu width (min 180) | 180 |
| 1000 row: 14 + switch + 10 + 28 + 8 + chip + 8 + 28 + 14 | 335 / 364 |

**Window frames.** `14a` draws the binding shell title bars: Windows 38px, macOS 44px (`platform-variants.md` §1; Emend's browser gate `e2e/acceptance.spec.mjs`).

## 3. Voice Settings (`14b`, #2611 / #2646)

**Shell.** Settings dialog 720×460: header 48px (`Settings` 15/600 · `Close Settings`), nav 180px (`General`), content padding 20px. Win 1px `#E3DFD6` r8 + `0 18px 44px rgba(31,29,26,.18)`; mac r12 + `0 22px 54px rgba(31,29,26,.22)`. Controls Win 1px `#D5D0C4` r6 · mac 1px `#DCD7CC` hairline r7. Voice sits in General below a 1px `#E3DFD6` rule.

**Heading row.** `Voice` 13/600 at left (`tabindex=-1`), `Refresh voice status` at right, on one row. Opened at Voice, the content scrolls the heading to the top and it takes focus (2px ring, 1px offset). Close returns focus to the initiating mic if it is still visible and available, otherwise to the Settings trigger.

**Rows.** Label column 150px `#6B665C`, 10px to the control, 14px between rows.

| Row | Shipped treatment |
|---|---|
| Enable voice | **30×18 switch**: 1px edge, r9, 12px knob inset 2px. Off: control fill, knob `#6B665C`. On: `#4F46E5` fill and edge, white knob (dark `#A5B0FF` / `#10131A`). `On` / `Off` 8px after it in secondary ink. **While recording, the whole control — switch and label — is at 55%.** Voice off adds `Each mic shows as unavailable — Dictate — voice is off in Settings — until voice is on.` (12px secondary, 6px below, at the 160px indent) |
| Input device | Picker 260px max, ellipsis; `System default` first. After disconnection the selection reads **`Unavailable: <saved device name>`**; older settings with no saved name read **`Unavailable selected microphone`**. A device or permission issue gives the picker the reject stroke (`#DCC4BF`; mac as a hairline; dark `#F87171`) and adds one 12.5px `#A33A2E` line **5px below the picker**, led by `⊘`: `No microphone is available.` · `No default microphone is available. Choose an input device.` · `Selected microphone is unavailable. Choose another input device.` · `Microphone permission was denied. Check system permissions.` `backend_unavailable` shows `Microphone access is unavailable in this build or on this system.` in secondary ink with no glyph and no reject stroke. The picker is at 55% while recording |
| Recording lock | `Recording is active. Stop recording before changing voice or input device.` (secondary) |
| Local model | Label · state column (min 180px: status text, then **a 180×4 bar 6px below** — `#E3DFD6` track, `#4F46E5` fill while moving, **`#A39E92` held** when cancelling or cancelled; dark track `#3A3D42`, held `#9AA0A6`) · **one action at the right**. Primary actions are accent-filled |

**Model states** (status · action · line below):
- Not downloaded · `Download model` (primary).
- Downloading · `Downloading model: 42%` + bar · `Cancel download`.
- Cancelling · `Cancelling model download…` + held bar · **`Cancelling…` disabled (55%), `aria-busy`**.
- Cancelled · `Model not downloaded` + held bar · `Resume model download` (primary) · `Model download cancelled. The partial download can resume.`
- Failed · `Model not downloaded` · `Retry model download` (primary) · the failure sentence (§8) in `#A33A2E`.
- Missing / corrupt · `Model file missing` / `Model file corrupt` · `Download model`.
- Ready, managed · `Model ready` · `Remove local model`.
- Ready, external · `Model ready` · **`Stop using this file`** · **`External file — Emend won’t delete it`** (12px secondary), then **the external-file path** (Plex Mono 11px secondary, max 180px, ellipsis, full path in the title).
- Ready, origin unknown · `Model ready` · `Stop using this model` · `Emend can’t verify this model’s location.`

Notes, path and messages sit **8px below the row at the 160px indent** (12.5px for messages). While recording or transcribing, the ready action is disabled.

**Failures elsewhere.** A refused change: `Voice setting was not changed. <detail>`. Section-wide: `Voice settings are unavailable. <detail>` + `Try again`.

**Narrow** (viewport under 560px): nav 108px; each label takes its own line above its control; the model action wraps right-aligned below the state; notes, path and messages lose the indent (path max `min(180px, 100%)`).

**Dark.** Emend's `--color-settings-*` dark set: dialog `#1E1F22`, nav `#26282C`, active nav `#3A3D42`, rule `#3A3D42`, controls `#26282C`, secondary `#9AA0A6`, errors `#F87171`, focus and accent `#A5B0FF`.

## 4. Comment-composer mic (`14c`, #2613)

| Part | Geometry |
|---|---|
| Popover | 340px outer · 12px padding · 8px vertical gap · Win 1px `#D5D0C4` r8 `0 6px 18px rgba(31,29,26,.14)` · mac r10 shadow + hairline |
| Textarea | full inner width (316px), min-height 64px, padding 9px 11px |
| Provisional slot | **below the textarea**, full inner width, 12.5/1.5 ghost `#8C8779` with dotted `#BDB8AC` underline (offset 3px); wraps; absent when empty; outside the editable draft |
| Error echo | same slot, 12px `#A33A2E`, the shared echo string |
| Action row | 10px below the last block. **Mic at the left inner edge (x = 12px, flush with the textarea)**; `Cancel` · `Comment` right-aligned, gap 8px, `Comment` flush with the right inner edge (x = 328px). Mic 28 + Cancel 62 + 8 + Comment 80 = 178 of 316px; never wraps |

`Comment` is the ink primary and disabled while the draft is empty; a Final fills the draft and never submits it. States drawn: idle, recording + provisional (short and wrapping), transcribing, error → Settings, error → retry, on both platforms, light and dark.

## 5. Timeline provisional text (`14d`, #2613)

Mic unchanged from `4f` (inside the input's right edge, 6px top/right; input right padding 44px). The provisional line sits **below the 38px input, inside the input's column**: 4px under it, 12px inset (aligned with the input's text), wrapping within the input width and **never under `Send`**. `Send` stays level with the input (36px, 1px top offset). The provider row and J13 standing line move down with the partial. An error echo takes the same slot in `#A33A2E`.

## 6. Editor multiline ghost (`14d`)

Inline at the **original** target, wrapping as ordinary text — no box, no width. Collapsed caret: 3px left offset; the live caret is drawn where the author left it. Selected range: the range keeps a held `#E1E0F8` tint with a 1px `#A19CE9` underline (dark `#23284D` / `#A5B0FF`) for the life of the recording, and the ghost follows it. Final replaces the range. Later caret moves retarget neither.

**330px.** The mic stays in the row while `⋯` is visible (`3d` rule retained); error stroke `#DCC4BF` on both platforms.

## 7. J12 close finalization (`14f`)

**The entire inert document pane** — tab strip, toolbar (mic included), strip, buffer, footer — renders through **one 55% layer**, `pointer-events:none`. No child carries its own opacity; the mic is drawn idle and reaches 55% only through the pane. Only the shell-level status row stays full contrast. The ghost is removed before the freeze (`3c.10`). This corrects `3c`'s former 45% rule to agree with `9d.1`.


**Dark (#2661, (24)).** In `14f.3`/`14f.4` every control is drawn in its ordinary dark treatment first — the selected `Rich text` segment is `#A5B0FF` with a `#10131A` label — and only then does the one 55% pane layer apply. There is no frozen-specific segment colour. The mic has no second fade, no dictation ghost is present, and `Saving your session…` stays at full contrast.

## 8. Shipped copy (verbatim, `src/settings/VoiceSettingsSection.tsx`)

Download failure by `VoiceDownloadIssue`:
- `transport` — Model download failed: Emend couldn’t complete the download over the network.
- `storage` — Model download failed: Emend couldn’t save the model on this device.
- `registry` — Model download failed: Emend couldn’t finish setting up the model.
- `protocol` · `truncated` · `oversized` · `corrupt` — Model download failed: The file received wasn’t the expected voice model.
- `cancelled` — Model download failed: Emend stopped the download.

External and origin: `External file — Emend won’t delete it` · `Stop using this file` · `Stop using this model` · `Emend can’t verify this model’s location.` Disconnected device: `Unavailable: <saved device name>` / `Unavailable selected microphone`. Voice off: `Each mic shows as unavailable — Dictate — voice is off in Settings — until voice is on.` The (22) proposed sentences are withdrawn in favour of these.

## 9. Parity against the alignment captures

Evidence: the per-surface list at the top of this file. Two drawn surfaces lack source-stamped dark captures: the **900px toolbar** (`14a`) and the **J12 frozen pane** (`14f`), which has light captures (`docs/alignment-voice/`). Every other voice surface is captured in light and dark.

**Now matched — removed from the difference list:** the 900px row with mic and return inline, the switch and format group in `⋯` in row order, and the pending badge; the 30×18 switch and its 55% recording lock; the Voice / Refresh heading row; the 260px picker, reject stroke and `⊘` error line 5px below it; the disconnected-device labels; the model bar, held bar and disabled `Cancelling…`; the external-file note, path and `Stop using this file`; the verbatim failure sentences; the managed/external origin field; dark Settings and dark model-row colours; Timeline `Send` level with the input; the ink-primary `Comment` button; the dark mic chip in every state on all three surfaces; the editor ghost at the original caret and the held selected range (light and dark, and at 330px); and the composer and Timeline error echoes and wrapped provisionals (light and dark).

**Still different (implementation vs this package):** retryable error hover, pressed and focus cues (§1a, `14g`) are not shipped.

**Evidence boundary:** the 900px toolbar (`14a`) and the J12 frozen pane (`14f`) are evidenced in light only; their dark frames are drawn from Emend's dark palette.

**Validation gaps (no capture can close these):** physical microphone capture and device hot-plug; live network download and Whisper inference; **native Windows title-control interaction**; nothing else.

