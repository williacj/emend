<!-- ABOUTME: Source-stamped dark dictation mic captures for refresh (22) voice.md §1. -->
<!-- ABOUTME: Explains the browser-only evidence boundary and how to regenerate it. -->

# Dark dictation mic evidence

`measurements.json` and 42 PNGs cover Win32 and MacIntel browser platform styling for editor, Timeline and comment mic states: Idle focus, Downloading, Cancelling, Download cancelled, Error, Recording and Transcribing. The script mounts production React and CSS against the D23 backend. A typed test-only voice transport supplies owner status because D23 has no linked microphone owner. Its `sourceRevision` is the source commit used for the capture.

Run from the repo root:

```sh
EMEND_ALIGNMENT_SCENARIO='dark voice' EMEND_ALIGNMENT_OUTPUT=docs/alignment-voice-dark node scripts/capture-design-alignment.mjs
node --test --test-name-pattern 'refresh \(22\) dark mic' scripts/capture-design-alignment.test.mjs
```

These captures establish computed dark colors, chip geometry and browser composition on two platform styles. They do not establish physical microphone operation, native Windows title controls or Whisper inference.
