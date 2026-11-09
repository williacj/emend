ABOUTME: Records source-stamped Voice Settings control captures against refresh (22) `14b`.
ABOUTME: Browser platform styles and typed voice status do not prove physical device or native window behavior.

# Voice Settings controls (#2646)

Regenerate from the repository root with:

```sh
EMEND_ALIGNMENT_SCENARIO='14b settings controls' EMEND_ALIGNMENT_OUTPUT=docs/alignment-voice-settings-controls node scripts/capture-design-alignment.mjs
```

The script runs the production Vite/React/CSS tree against D23. D23 has no linked voice owner, so the capture substitutes `get_voice_status` at that absent transport boundary. It opens a real document, then the production Settings dialog. The measured manifest records the exact source commit, geometry, computed colors, loaded fonts, and capture failures. `Win32` and `MacIntel` navigator overrides choose the two browser platform styles; these are not native Windows/macOS title-control captures.

| State | Windows | macOS |
|---|---|---|
| Light, voice on | [image](./win-14b-controls-light-on.png) | [image](./mac-14b-controls-light-on.png) |
| Light, recording active | [image](./win-14b-controls-light-capture-active.png) | [image](./mac-14b-controls-light-capture-active.png) |
| Light, voice off | [image](./win-14b-controls-light-off.png) | [image](./mac-14b-controls-light-off.png) |
| Light, no device | [image](./win-14b-controls-light-device-error.png) | [image](./mac-14b-controls-light-device-error.png) |
| Light, disconnected selected microphone | [image](./win-14b-controls-light-selected-unavailable.png) | [image](./mac-14b-controls-light-selected-unavailable.png) |
| Dark, no device | [image](./win-14b-controls-dark-device-error.png) | [image](./mac-14b-controls-dark-device-error.png) |
| Dark, 520px narrow no device | [image](./win-14b-controls-dark-narrow-device-error.png) | [image](./mac-14b-controls-dark-narrow-device-error.png) |

The capture guard checks the 30×18 switch, one Voice/Refresh heading row, 260px maximum picker, light/dark reject colors, narrow stacked device label, and the remembered name of a disconnected selected microphone. Mounted tests separately check backend-confirmed On/Off, enabled controls while voice is off, the four named device/permission issue associations, and a generic unavailable label when migrated settings have no saved device name. Model progress/cancellation/failure copy and external origin are separate cards. #2652 supplies the persisted backend/IPC name consumed here.
