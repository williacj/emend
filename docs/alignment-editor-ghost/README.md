<!-- ABOUTME: Records source-stamped `14d` editor ghost captures for both authoring platform styles. -->
<!-- ABOUTME: Distinguishes browser visual composition from physical microphone and native window evidence. -->

# Editor dictation ghost visual evidence (#2650)

Regenerate from the repository root with:

```sh
EMEND_ALIGNMENT_SCENARIO='14d editor ghost' EMEND_ALIGNMENT_OUTPUT=docs/alignment-editor-ghost node scripts/capture-design-alignment.mjs
```

[`measurements.json`](./measurements.json) records the exact source revision, loaded fonts, mounted theme for each frame, and measured CSS/DOM state for twelve browser screenshots. Its `colorScheme` is `mixed` because the scenario contains light and dark frames. Production Vite, React, CodeMirror and CSS run against a disposable D23 project. D23 has no linked voice owner, so the capture supplies typed voice status, Start and Partial events at that missing transport boundary. These images establish appearance and target placement, not physical microphone capture, Whisper output or native Windows title controls.

| `14d` target | Windows light | Windows dark | macOS light | macOS dark |
|---|---|---|---|---|
| Original caret, long wrapping ghost | [image](./win-14d-editor-ghost-light-collapsed.png) | [image](./win-14d-editor-ghost-dark-collapsed.png) | [image](./mac-14d-editor-ghost-light-collapsed.png) | [image](./mac-14d-editor-ghost-dark-collapsed.png) |
| Original selected range, held tint and following ghost | [image](./win-14d-editor-ghost-light-selected.png) | [image](./win-14d-editor-ghost-dark-selected.png) | [image](./mac-14d-editor-ghost-light-selected.png) | [image](./mac-14d-editor-ghost-dark-selected.png) |
| 330px editor column, pinned mic and visible overflow | [image](./win-14d-editor-ghost-light-compact.png) | [image](./win-14d-editor-ghost-dark-compact.png) | [image](./mac-14d-editor-ghost-light-compact.png) | [image](./mac-14d-editor-ghost-dark-compact.png) |

The ghost is an inline element with `pre-wrap`, a 3px left offset and a 3px dotted underline offset. The long Partial spans at least three visual line boxes in each wide capture without a fixed-width box. The original selected phrase, `the first only sets it up`, remains marked after moving the caret elsewhere. Its computed light fill and underline are `#E4EBF4` and `#A9C0DC`; dark uses `#26324A` and `#5B8DFF`. The ghost follows the range in DOM order. At 330px the mic remains 28×26 inside the one-row toolbar while `⋯` is visible. The mounted CM6 test separately checks that Final replaces the original range and retires the mark.
