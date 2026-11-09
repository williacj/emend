ABOUTME: Records source-stamped 900px editor-toolbar captures with the pinned mic and compact Timeline return.
ABOUTME: Separates browser platform styling and bundled-font evidence from native desktop chrome claims.

# Compact 900px toolbar (#2641)

Regenerate from the repository root:

```sh
EMEND_ALIGNMENT_SCENARIO='compact toolbar' EMEND_ALIGNMENT_OUTPUT=docs/alignment-compact-toolbar-900 node scripts/capture-design-alignment.mjs
```

| State | Win32 browser style | MacIntel browser style |
|---|---|---|
| Idle, one row | [capture](./win-voice-compact-900-idle.png) | [capture](./mac-voice-compact-900-idle.png) |
| Keyboard-open `⋯` | [capture](./win-voice-compact-900-menu.png) | [capture](./mac-voice-compact-900-menu.png) |

[`measurements.json`](./measurements.json) records the source revision, viewport, loaded font faces, and measured DOM/CSS geometry. The script uses production Vite, React, CodeMirror, the toolbar, and the D23 project route. D23 has no linked voice owner, so only the typed voice transport is supplied at that boundary. These light browser images do not prove physical microphone behavior, native window controls, or native Windows font metrics.

At a **900px window**, the project rail stays **236px**, the comments column **400px**, and the toolbar measures **263px**. The 28×26px mic, 44×26px Timeline return, and `⋯` fit inside a single toolbar row, 45px high in Win32 styling and 47px in MacIntel styling. The Rich text/Markdown switch follows the formatting group into `⋯` only when the compact row needs the space; the menu lists the switch before formatting in row order. The capture test checks loaded fonts, four PNG signatures, rect containment, overflow state, and one-row heights. Browser tests separately exercise keyboard and pointer view switching, focus transfer when the switch returns inline, and the pending Pause badge on both styles.

CJ approved this narrow overflow exception on 2026-10-02. Generated refresh (23) now draws and specifies it in `14a` and `docs/design/specs/voice.md` §2. [Dark idle, pending and menu captures](../alignment-refresh23-dark/README.md) add the previously missing browser evidence. This Mac-hosted run loaded the app's bundled IBM Plex Sans; the actual toolbar CSS uses that face on both platform styles. Native Windows title-control interaction remains a separate platform check.
