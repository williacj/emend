<!-- ABOUTME: Source-stamped browser evidence for the error mic's hover, pressed and focus cues (14g). -->
<!-- ABOUTME: Records colours, 28x26 geometry, the retry cue and neighbour positions per state. -->

# Error mic interaction evidence

Card #106, `docs/design/specs/voice.md` §1a (`14g`). Source commit: `85ed7fb16abef940911d2df4f4b33b6ae98bcd2c` (also `sourceRevision` in `measurements.json`).

96 production-browser PNGs: Win32 and MacIntel platform styling, light and dark themes, the editor toolbar, the Timeline input and the comment composer, rest/hover/pressed/focus, for one retryable reason (`model_missing`) and one Settings-route reason (`no_device`). `measurements.json` records each chip's computed fill, stroke, glyph, ring, size, `aria-description`, `↻` cue and its neighbours' boxes.

The D23 browser driver has no linked voice owner, so the capture substitutes the typed voice transport while keeping production React, CSS and layout. It does not prove physical microphone capture, native Windows controls or Whisper inference.

Regenerate with `npm run capture:alignment -- "mic error interaction" docs/alignment-voice-error-interaction`, then run `npm run test:scripts`.
