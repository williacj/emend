ABOUTME: Records source-stamped browser evidence for turn 15's Address all chooser on both platform styles.
ABOUTME: Separates rendered browser geometry and palette from native desktop window validation.

# Address all chooser, turn 15 (#2679)

Regenerate from the repository root:

```sh
COWRITE_ALIGNMENT_SCENARIO='turn 15 chooser' COWRITE_ALIGNMENT_OUTPUT=docs/alignment-address-chooser node scripts/capture-design-alignment.mjs
```

| Window | Windows light | Windows dark | macOS light | macOS dark |
|---|---|---|---|---|
| 1280px chooser from toolbar | [capture](./win-15-chooser-light-1280.png) | [capture](./win-15-chooser-dark-1280.png) | [capture](./mac-15-chooser-light-1280.png) | [capture](./mac-15-chooser-dark-1280.png) |
| 900px chooser from ⋯ | [capture](./win-15-chooser-light-900.png) | [capture](./win-15-chooser-dark-900.png) | [capture](./mac-15-chooser-light-900.png) | [capture](./mac-15-chooser-dark-900.png) |

Held comments use four focused frames. The D23 production `address_all_with_ai` route marks two open comments as queued targets before the page opens; both remain held without fabricating a run card or changing component props.

| Held state | Windows light, 1280px | macOS dark, 900px |
|---|---|---|
| Both held, opt-in unchecked, Address 0 disabled | [capture](./win-15-chooser-light-1280-held-unchecked.png) | [capture](./mac-15-chooser-dark-900-held-unchecked.png) |
| Both held, opt-in checked, Address 2 enabled | [capture](./win-15-chooser-light-1280-held-checked.png) | [capture](./mac-15-chooser-dark-900-held-checked.png) |

[`measurements.json`](./measurements.json) records the source revision, loaded fonts, viewport, CSS colors and measured geometry, including panel/trigger/select/checkbox/action colors and dimensions. Production Vite, React, CodeMirror, the toolbar, comment column and D23 project/comment routes remain mounted. The fixture creates two real comments. At 900px the chooser opens 4px below the visible ⋯ with its right edge aligned, the overflow menu is closed, ⋯ keeps its open fill, and the mic and Timeline return stay on the single toolbar row. The held frames verify the em dash, wrap, 14px checkbox and explicit opt-in transition. These browser platform styles do not verify native Windows title controls or native font metrics.

Generated refresh (26) records CJ's J4/#2676 accepted-run focus ruling and its implementation in #2678. The design folder remains designer-owned and was imported without hand edits.
