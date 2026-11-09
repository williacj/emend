<!-- ABOUTME: Source-stamped Voice Settings model-row captures for refresh (22) mock 14b. -->
<!-- ABOUTME: States the browser evidence boundary and regeneration command. -->

# Voice Settings model-row evidence

`measurements.json` and 28 PNGs cover Downloading, Cancelling, Cancelled, Failed, and external Ready model states, plus narrow external and failure views, for Win32 and MacIntel browser styles in light and dark themes. Production React and CSS run against D23; a typed test-only status response supplies the missing voice owner at that boundary. The manifest's `sourceRevision` names the committed source used for the final capture.

Run from the repository root:

```sh
EMEND_ALIGNMENT_SCENARIO='14b model row' EMEND_ALIGNMENT_OUTPUT=docs/alignment-voice-model node scripts/capture-design-alignment.mjs
node --test --test-name-pattern='14b model row' scripts/capture-design-alignment.test.mjs
```

The captures establish rendered geometry and styling. They do not establish microphone capture, live network downloads, Whisper inference, or native Windows title-control interaction.
