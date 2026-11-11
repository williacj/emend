ABOUTME: Source-stamped dark browser evidence for refresh (23) compact-toolbar and J12 freeze states.
ABOUTME: Records the measured match, design ambiguity, and limits of the controlled fixtures.

# Refresh (23) dark parity evidence

Regenerate from the repository root:

```sh
EMEND_ALIGNMENT_SCENARIO='refresh23 dark' EMEND_ALIGNMENT_OUTPUT=docs/alignment-refresh23-dark node scripts/capture-design-alignment.mjs
node --test --test-name-pattern='refresh \(23\) dark' scripts/capture-design-alignment.test.mjs
```

The [manifest](./measurements.json) records production source revision `6df9ac1ae2068eca914e5f36dbfb45a771c49ee3`, loaded fonts, computed geometry and state for ten PNGs. The real Vite/React/CSS, CodeMirror, D23 project and J12 close routes run in headless Chromium. The D23 driver uses the deterministic `permission-provider` for the pending Bash request; a typed voice owner supplies only the microphone transport absent from D23.

| `docs/design/` reference | Windows browser style | macOS browser style |
|---|---|---|
| `14a` dark idle | [idle](./win-voice-compact-900-dark-idle.png) | [idle](./mac-voice-compact-900-dark-idle.png) |
| `14a` dark keyboard-open menu | [menu](./win-voice-compact-900-dark-menu.png) | [menu](./mac-voice-compact-900-dark-menu.png) |
| `14a` dark pending Pause badge | [pending](./win-voice-compact-900-dark-pending.png) | [pending](./mac-voice-compact-900-dark-pending.png) |
| `14a` dark pending with menu open | [pending menu](./win-voice-compact-900-dark-pending-menu.png) | [pending menu](./mac-voice-compact-900-dark-pending-menu.png) |
| `14f` dark untitled J12 freeze | [frozen](./win-voice-dark-editor-frozen.png) | [frozen](./mac-voice-dark-editor-frozen.png) |

At 900px, both styles measure a 236px project rail, 400px comments column and 263px toolbar. The mic is 28×26px, the Timeline return stays 44×26px before and during permission, and the row stays 45px Windows / 47px macOS with no wrapping. The view switch remains reachable in the keyboard-open `⋯` menu. The pending badge comes from a real D23 run and remains visible while the menu opens. These measurements and the inspected images match the `14a` dark compact treatment.

For `14f`, the fixture reopens an editable untitled document, starts editor dictation, then holds the actual final session write after the guarded close decision. Both captures show the ghost retired, an inert document pane at **0.55 opacity**, a disabled mic at **1** child opacity, the full collapsed Timeline return, and `Saving your session…` outside the pane at **1** opacity. This matches the one-layer J12 rule and the dark composition. One detail needs a designer ruling ([#2661](../../../../issues/2661)): the `14f.3`/`.4` mock paints the active Rich text segment with a neutral `#E6E7EA` fill before the pane opacity, while `voice.md` §2 specifies the dark active switch as blue `#5B8DFF` and Emend uses that blue. The capture does not declare that conflicting pixel matched.

These are browser platform styles. They do not verify a physical microphone, live model download or Whisper inference, or native Windows title-control interaction.
