// ABOUTME: Verifies pathless, toolbar, J9, and D27 browser evidence and capture guards.
// ABOUTME: Reads source-stamped artifacts and checks geometry without replacing app logic.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertProjectOpenCapture, scenarioSelected } from "./capture-design-alignment-state.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(repository, "docs/alignment-refresh20-pathless");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("scenario filter matches by substring, or exactly after the platform with a leading =", () => {
  assert.equal(scenarioSelected(undefined, "win compact toolbar"), true);
  assert.equal(scenarioSelected("toolbar", "win compact toolbar"), true);
  assert.equal(scenarioSelected("=toolbar", "win toolbar"), true);
  assert.equal(scenarioSelected("=toolbar", "mac toolbar"), true);
  assert.equal(scenarioSelected("=toolbar", "win compact toolbar"), false);
  assert.equal(scenarioSelected("=voice", "mac composer voice error"), false);
  assert.equal(scenarioSelected("=voice", "win turn 15 chooser held light"), false);
});

test("turn 15 chooser evidence keeps a one-row toolbar and anchors the narrow panel to visible overflow", () => {
  const chooserOutput = join(repository, "docs/alignment-address-chooser");
  const evidence = JSON.parse(readFileSync(join(chooserOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [1280, 900]) {
        const name = `${platform}-15-chooser-${theme}-${width}`;
        const frame = evidence.captures[name];
        assert.ok(frame, `missing ${name}`);
        assert.deepEqual(readFileSync(join(chooserOutput, `${name}.png`)).subarray(0, 8), pngSignature);
        assert.ok(frame.loadedFontFaces.some((font) => font.includes("IBM Plex Sans")));
        assert.equal(frame.chooser.toolbarRows, 1);
        assert.equal(frame.chooser.panelTop - frame.chooser.invokerBottom, 4);
        assert.ok(Math.abs(frame.chooser.panelRight - frame.chooser.invokerRight) <= 1);
        assert.equal(frame.chooser.panelWidth <= 320, true);
        assert.equal(frame.chooser.micInline, true);
        if (width === 900) {
          assert.equal(frame.chooser.invoker, "overflow");
          assert.equal(frame.chooser.menuClosed, true);
          assert.equal(frame.chooser.overflowPaintedOpen, true);
          assert.equal(frame.chooser.overflowFill,
            theme === "dark" ? "rgb(58, 61, 66)" : "rgb(240, 237, 230)");
        } else {
          assert.equal(frame.chooser.invoker, "Address all");
        }
      }
    }
  }
});

test("turn 15 held chooser evidence shows the em dash, unchecked zero target, and explicit opt-in", () => {
  const chooserOutput = join(repository, "docs/alignment-address-chooser");
  const evidence = JSON.parse(readFileSync(join(chooserOutput, "measurements.json"), "utf8"));
  for (const [platform, theme, width] of [["win", "light", 1280], ["mac", "dark", 900]]) {
    for (const choice of ["unchecked", "checked"]) {
      const name = `${platform}-15-chooser-${theme}-${width}-held-${choice}`;
      const frame = evidence.captures[name];
      assert.ok(frame, `missing ${name}`);
      assert.deepEqual(readFileSync(join(chooserOutput, `${name}.png`)).subarray(0, 8), pngSignature);
      assert.ok(frame.loadedFontFaces.some((font) => font.includes("IBM Plex Sans")));
      assert.equal(frame.chooser.scope, "Address all · 2 open comments · 2 already in an agent run —");
      assert.equal(frame.chooser.includeChecked, choice === "checked");
      assert.equal(frame.chooser.runLabel, choice === "checked" ? "Address 2 comments" : "Address 0 comments");
      assert.equal(frame.chooser.runDisabled, choice === "unchecked");
      assert.equal(frame.chooser.panelTop - frame.chooser.invokerBottom, 4);
      assert.ok(Math.abs(frame.chooser.panelRight - frame.chooser.invokerRight) <= 1);
      assert.equal(frame.chooser.panelBackground,
        theme === "dark" ? "rgb(38, 40, 44)" : "rgb(250, 248, 243)");
      assert.equal(frame.chooser.panelBorder,
        theme === "dark" ? "rgb(58, 61, 66)" : "rgb(227, 223, 214)");
      assert.equal(frame.chooser.selectBackground,
        theme === "dark" ? "rgb(30, 31, 34)" : "rgb(255, 255, 255)");
      assert.equal(frame.chooser.triggerBackground,
        theme === "dark" ? "rgb(58, 61, 66)" : "rgb(240, 237, 230)");
      assert.equal(frame.chooser.checkboxFill,
        choice === "checked" ?
          (theme === "dark" ? "rgb(91, 141, 255)" : "rgb(47, 93, 140)") :
          (theme === "dark" ? "rgb(30, 31, 34)" : "rgb(255, 255, 255)"));
      assert.equal(frame.chooser.runBackground,
        theme === "dark" ? "rgb(91, 141, 255)" : "rgb(47, 93, 140)");
      assert.equal(frame.chooser.checkboxSize, 14);
      assert.ok(frame.chooser.selectWidth >= 132);
      if (width === 900) {
        assert.equal(frame.chooser.menuClosed, true);
        assert.equal(frame.chooser.overflowPaintedOpen, true);
      }
    }
  }
});

test("14b model row keeps progress, action, copy and path within wide and narrow Settings", () => {
  const modelOutput = join(repository, "docs/alignment-voice-model");
  const evidence = JSON.parse(readFileSync(join(modelOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "mixed");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const theme of ["light", "dark"]) {
      const frame = (state) => {
        const name = `${platform}-14b-model-${theme}-${state}`;
        const capture = evidence.captures[name];
        assert.ok(capture, `missing ${name}`);
        assert.deepEqual(readFileSync(join(modelOutput, `${name}.png`)).subarray(0, pngSignature.length),
          pngSignature, `${name} is not a PNG`);
        assert.ok(capture.loadedFontFaces.length > 0, `${name} lacks bundled fonts`);
        assert.equal(capture.modelVisual.theme, theme);
        assert.equal(capture.modelVisual.rowFits, true, `${name} model row fits`);
        assert.equal(capture.modelVisual.actionVisible, true, `${name} model action visible`);
        return capture.modelVisual;
      };
      const progress = frame("progress");
      assert.equal(progress.status, "Downloading model: 42%");
      assert.equal(progress.action, "Cancel download");
      assert.equal(progress.bar.width, 180);
      assert.equal(progress.bar.height, 4);
      assert.ok(Math.abs(progress.bar.fillWidth - 75.6) < 1);
      assert.equal(progress.bar.fill,
        theme === "dark" ? "rgb(91, 141, 255)" : "rgb(47, 93, 140)");
      const cancelling = frame("cancelling");
      assert.equal(cancelling.action, "Cancelling…");
      assert.equal(cancelling.actionDisabled, true);
      assert.equal(cancelling.actionBusy, "true");
      assert.equal(cancelling.bar.fill,
        theme === "dark" ? "rgb(154, 160, 166)" : "rgb(163, 158, 146)");
      const cancelled = frame("cancelled");
      assert.equal(cancelled.action, "Resume model download");
      assert.equal(cancelled.status, "Model not downloaded");
      assert.equal(cancelled.bar.width, 180);
      const failed = frame("failed");
      assert.equal(failed.action, "Retry model download");
      assert.equal(failed.alert, "Model download failed: Cowrite couldn’t complete the download over the network.");
      assert.equal(failed.alertVisible, true);
      assert.equal(failed.alertColor,
        theme === "dark" ? "rgb(248, 113, 113)" : "rgb(163, 58, 46)");
      const external = frame("external");
      assert.equal(external.action, "Stop using this file");
      assert.equal(external.note, "External file — Cowrite won’t delete it");
      assert.equal(external.pathEllipsized, true);
      assert.equal(external.pathVisible, true);
      frame("narrow-external");
      const narrowFailed = frame("narrow-failed");
      assert.equal(narrowFailed.alertVisible, true);
      assert.ok(narrowFailed.alertWidth > 180, `${platform}/${theme} narrow failure uses the content width`);
    }
  }
});

test("14d editor ghost wraps inline and holds the original selected range on both platform styles", () => {
  const ghostOutput = join(repository, "docs/alignment-editor-ghost");
  const evidence = JSON.parse(readFileSync(join(ghostOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "mixed");
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.fixture.kind, "typed test-only voice transport over D23");
  for (const platform of ["win", "mac"]) {
    for (const theme of ["light", "dark"]) {
      const collapsedName = `${platform}-14d-editor-ghost-${theme}-collapsed`;
      const selectedName = `${platform}-14d-editor-ghost-${theme}-selected`;
      const compactName = `${platform}-14d-editor-ghost-${theme}-compact`;
      for (const name of [collapsedName, selectedName]) {
        const frame = evidence.captures[name];
        assert.ok(frame, `missing ${name}`);
        assert.deepEqual(readFileSync(join(ghostOutput, `${name}.png`)).subarray(0, pngSignature.length),
          pngSignature, `${name} is not a PNG`);
        assert.ok(frame.loadedFontFaces.length > 0, `${name} lacks bundled fonts`);
        assert.equal(frame.ghostVisual.theme, theme, `${name} mounted theme`);
        assert.equal(frame.ghostVisual.display, "inline");
        assert.equal(frame.ghostVisual.whiteSpace, "pre-wrap");
        assert.equal(frame.ghostVisual.marginLeft, "3px");
        assert.equal(frame.ghostVisual.underlineOffset, "3px");
        assert.ok(frame.ghostVisual.lineBoxes >= 2, `${name} long ghost must wrap`);
      }
      const collapsed = evidence.captures[collapsedName].ghostVisual;
      assert.equal(collapsed.heldText, null);
      assert.equal(collapsed.ghostAfterHeld, false);
      const selected = evidence.captures[selectedName].ghostVisual;
      assert.equal(selected.heldText, "the first only sets it up");
      assert.equal(selected.ghostAfterHeld, true);
      assert.equal(selected.heldBackground, theme === "dark" ? "rgb(38, 50, 74)" : "rgb(228, 235, 244)");
      assert.match(selected.heldBoxShadow,
        theme === "dark" ? /rgb\(91, 141, 255\)/ : /rgb\(169, 192, 220\)/);
      const compact = evidence.captures[compactName];
      assert.ok(compact, `missing ${compactName}`);
      assert.deepEqual(readFileSync(join(ghostOutput, `${compactName}.png`)).subarray(0, pngSignature.length),
        pngSignature, `${compactName} is not a PNG`);
      assert.ok(Math.abs(compact.compact.toolbarWidth - 330) <= 2);
      assert.equal(compact.compact.toolbarWrap, "nowrap");
      assert.equal(compact.compact.micWidth, 28);
      assert.equal(compact.compact.micHeight, 26);
      assert.equal(compact.compact.micInsideToolbar, true);
      assert.equal(compact.compact.overflowVisible, true);
      assert.equal(compact.compact.theme, theme, `${compactName} mounted theme`);
    }
  }
});

test("refresh (22) composer voice errors replace wrapped provisional lines in their existing slots", () => {
  const folder = join(repository, "docs/alignment-voice-composer-errors");
  const evidence = JSON.parse(readFileSync(join(folder, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "mixed");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const theme of ["light", "dark"]) {
      for (const surface of ["timeline", "comment"]) {
        const frame = (phase) => {
          const name = `${platform}-${theme}-voice-${surface}-${phase}`;
          const capture = evidence.captures[name];
          assert.ok(capture, `missing ${name}`);
          assert.deepEqual(readFileSync(join(folder, `${name}.png`)).subarray(0, pngSignature.length), pngSignature);
          assert.ok(capture.loadedFontFaces.length > 0, `${name}: bundled fonts loaded`);
          return capture.echo;
        };
        const partial = frame("partial-wrap");
        const error = frame("error");
        assert.equal(partial.provisional, "true");
        assert.equal(partial.error, "false");
        assert.ok(partial.slot.height > Number.parseFloat(partial.lineHeight) * 1.5,
          `${platform}/${theme}/${surface}: provisional text wraps inside its slot`);
        assert.equal(error.provisional, "false");
        assert.equal(error.error, "true");
        assert.equal(error.text, surface === "timeline" ? "Dictation error: Dictation failed" : "Dictation error: Recording could not be read");
        assert.equal(error.draft, surface === "timeline" ? "Keep this message" : "Keep this comment");
        assert.equal(error.ariaLive, "assertive");
        assert.equal(error.color, theme === "light" ? "rgb(163, 58, 46)" : "rgb(248, 113, 113)");
        assert.equal(error.fontSize, "12px");
        assert.equal(error.textDecoration, "none");
        assert.equal(error.slot.y - error.input.y, partial.slot.y - partial.input.y,
          `${platform}/${theme}/${surface}: feedback stays in the same slot below the input`);
        if (surface === "timeline") {
          assert.ok(Math.abs(error.input.y - error.action.y) <= 2, `${platform}/${theme}: Send stays level with input`);
          assert.ok(error.slot.right <= error.input.right, `${platform}/${theme}: feedback stays inside input column`);
        } else {
          assert.ok(error.action.y >= error.slot.y + error.slot.height, `${platform}/${theme}: actions follow feedback`);
        }
      }
    }
  }
});

test("refresh (22) dark mic phases use the specified palette on all three surfaces and both platform styles", () => {
  const darkOutput = join(repository, "docs/alignment-voice-dark");
  const evidence = JSON.parse(readFileSync(join(darkOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "dark");
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.fixture.kind, "typed test-only voice transport over D23");
  for (const platform of ["win", "mac"]) {
    for (const surface of ["editor", "timeline", "comment"]) {
      const frame = (state) => {
        const name = `${platform}-dark-voice-${surface}-${state}`;
        const capture = evidence.captures[name];
        assert.ok(capture, `missing ${name}`);
        assert.deepEqual(readFileSync(join(darkOutput, `${name}.png`)).subarray(0, pngSignature.length),
          pngSignature, `${name} is not a PNG`);
        assert.ok(capture.loadedFontFaces.length > 0, `${name} lacks bundled fonts`);
        assert.equal(capture.micStyle.theme, "dark");
        assert.equal(capture.micStyle.width, 28);
        assert.equal(capture.micStyle.height, 26);
        return capture.micStyle;
      };
      const idle = frame("idle");
      assert.equal(idle.background, "rgb(30, 31, 34)");
      assert.equal(idle.color, "rgb(230, 231, 234)");
      assert.equal(idle.outlineColor, "rgb(91, 141, 255)");
      assert.equal(idle.outlineWidth, "2px");
      if (platform === "win") assert.equal(idle.border, "rgb(58, 61, 66)");
      else assert.match(idle.boxShadow, /rgb\(58, 61, 66\)/);

      const downloading = frame("downloading");
      assert.equal(downloading.trackBackground, "rgb(58, 61, 66)");
      assert.equal(downloading.progressBackground, "rgb(91, 141, 255)");
      const cancelling = frame("cancelling");
      assert.equal(cancelling.background, "rgb(38, 40, 44)");
      assert.equal(cancelling.color, "rgb(154, 160, 166)");
      assert.equal(cancelling.childBackground, "rgb(154, 160, 166)");
      const cancelled = frame("download_cancelled");
      assert.equal(cancelled.color, "rgb(154, 160, 166)");
      assert.equal(cancelled.trackBackground, "rgb(58, 61, 66)");
      assert.equal(cancelled.progressBackground, "rgb(154, 160, 166)");
      const recording = frame("recording");
      assert.equal(recording.background, "rgb(230, 231, 234)");
      assert.equal(recording.color, "rgb(30, 31, 34)");
      assert.equal(recording.childFill, "rgb(30, 31, 34)");
      const transcribing = frame("transcribing");
      assert.equal(transcribing.background, "rgb(38, 40, 44)");
      assert.equal(transcribing.color, "rgb(230, 231, 234)");
      assert.equal(transcribing.childBackground, "rgb(230, 231, 234)");
      const error = frame("error");
      assert.equal(error.background, "rgb(38, 40, 44)");
      assert.equal(error.color, "rgb(248, 113, 113)");
      if (platform === "win") assert.equal(error.border, "rgb(248, 113, 113)");
      else assert.match(error.boxShadow, /rgb\(248, 113, 113\)/);
    }
  }
});

test("14b Voice Settings controls keep switch, error, and heading geometry on both platform styles", () => {
  const folder = join(repository, "docs/alignment-voice-settings-controls");
  const evidence = JSON.parse(readFileSync(join(folder, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "mixed");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const state of ["light-on", "light-capture-active", "light-off", "light-device-error", "light-selected-unavailable", "dark-device-error", "dark-narrow-device-error"]) {
      const name = `${platform}-14b-controls-${state}`;
      const frame = evidence.captures[name];
      assert.ok(frame, `missing ${name}`);
      assert.deepEqual(readFileSync(join(folder, `${name}.png`)).subarray(0, pngSignature.length), pngSignature);
      assert.ok(frame.loadedFontFaces.length > 0, `${name}: bundled fonts loaded`);
      assert.equal(frame.measured[".voice-settings__switch"].width, 30);
      assert.equal(frame.measured[".voice-settings__switch"].height, 18);
      const heading = frame.measured["#settings-voice-heading"];
      const refresh = frame.measured[".voice-settings__heading-row button"];
      assert.ok(Math.abs((heading.y + heading.height / 2) - (refresh.y + refresh.height / 2)) <= 2,
        `${name}: Voice and Refresh share a heading row`);
      const device = frame.measured[".voice-settings__device-control select"];
      assert.ok(device.width <= 260, `${name}: device picker stays within 260px`);
    }
    const on = evidence.captures[`${platform}-14b-controls-light-on`];
    assert.equal(on.measured[".voice-settings__switch"].background, "rgb(47, 93, 140)");
    assert.equal(on.measured[".voice-settings__switch-state"].text, "On");
    const active = evidence.captures[`${platform}-14b-controls-light-capture-active`];
    assert.equal(active.measured[".voice-settings__switch-control"].opacity, "0.55");
    assert.equal(active.measured[".voice-settings__switch"].opacity, "1");
    const off = evidence.captures[`${platform}-14b-controls-light-off`];
    assert.equal(off.measured[".voice-settings__switch-state"].text, "Off");
    assert.match(off.measured[".voice-settings__off-note"].text, /Each mic shows as unavailable/);
    const error = evidence.captures[`${platform}-14b-controls-light-device-error`];
    assert.equal(error.measured[".voice-settings__device-control select"].border, "rgb(220, 196, 191)");
    assert.equal(error.measured[".voice-settings__device-issue"].color, "rgb(163, 58, 46)");
    assert.ok(Math.abs(error.measured[".voice-settings__device-issue"].y -
      (error.measured[".voice-settings__device-control select"].y +
       error.measured[".voice-settings__device-control select"].height) - 5) < 1,
    `${platform}: device issue stays 5px under the picker`);
    if (platform === "mac") assert.match(error.measured[".voice-settings__device-control select"].boxShadow, /rgb\(220, 196, 191\)/);
    const remembered = evidence.captures[`${platform}-14b-controls-light-selected-unavailable`];
    assert.equal(remembered.selectedOption, "Unavailable: Travel USB microphone");
    const dark = evidence.captures[`${platform}-14b-controls-dark-device-error`];
    assert.equal(dark.measured[".voice-settings__switch"].background, "rgb(91, 141, 255)");
    assert.equal(dark.measured[".voice-settings__switch"].border, "rgb(91, 141, 255)");
    assert.equal(dark.measured[".voice-settings__device-control select"].border, "rgb(248, 113, 113)");
    assert.equal(dark.measured[".voice-settings__device-issue"].color, "rgb(248, 113, 113)");
    if (platform === "mac") assert.match(dark.measured[".voice-settings__device-control select"].boxShadow, /rgb\(248, 113, 113\)/);
    const narrow = evidence.captures[`${platform}-14b-controls-dark-narrow-device-error`];
    const label = narrow.measured[".voice-settings__device-row .settings-dialog__setting-label"];
    const picker = narrow.measured[".voice-settings__device-control select"];
    assert.ok(label.y + label.height <= picker.y, `${platform}: narrow label stacks above control`);
    const dialog = narrow.measured[".settings-dialog"];
    const issue = narrow.measured[".voice-settings__device-issue"];
    assert.ok(issue.y >= dialog.y && issue.y + issue.height <= dialog.y + dialog.height,
      `${platform}: narrow device issue is visible inside Settings`);
  }
});

test("voice evidence covers pinned editor mic, provisional text, and composer surfaces on both platform styles", () => {
  const voiceOutput = join(repository, "docs/alignment-voice");
  const evidence = JSON.parse(readFileSync(join(voiceOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.fixture.kind, "typed test-only voice transport over D23");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const state of ["editor-idle", "editor-downloading", "editor-recording-partial",
      "editor-transcribing", "editor-error", "editor-error-permission", "editor-error-model", "editor-frozen",
      "timeline-composer", "timeline-recording-partial", "comment-composer", "narrow-330"]) {
      const name = `${platform}-voice-${state}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.deepEqual(readFileSync(join(voiceOutput, `${name}.png`)).subarray(0, pngSignature.length),
        pngSignature, `${name} is not a PNG`);
      assert.ok(capture.loadedFontFaces.length > 0, `${name} did not load bundled fonts`);
      assert.equal(capture.voice?.micWidth, 28, `${name} mic width`);
      assert.equal(capture.voice?.micHeight, 26, `${name} mic height`);
    }
    const narrow = evidence.captures[`${platform}-voice-narrow-330`];
    assert.ok(Math.abs(narrow.voice.toolbarWidth - 330) <= 2);
    assert.equal(narrow.voice.toolbarWrap, "nowrap");
    assert.equal(narrow.voice.micInOverflow, false);
    assert.equal(narrow.voice.overflowVisible, true);
    const ghost = evidence.captures[`${platform}-voice-editor-recording-partial`];
    assert.equal(ghost.voice.ghostText, "a provisional sentence");
    assert.equal(ghost.voice.micLabel, "Stop dictation — recording");
    assert.equal(ghost.measured[".dictation-status-echo"]?.text, "Recording · 0:07");
    const download = evidence.captures[`${platform}-voice-editor-downloading`];
    assert.equal(download.voice.micLabel, "Dictate — downloading voice model, 42%");
    assert.equal(download.measured[".dictation-mic"]?.ariaBusy, "true");
    assert.equal(download.measured[".dictation-status-echo"]?.text, "Downloading voice model · 42%");
    const transcribing = evidence.captures[`${platform}-voice-editor-transcribing`];
    assert.equal(transcribing.voice.micLabel, "Dictation — transcribing");
    assert.equal(transcribing.measured[".dictation-mic"]?.ariaBusy, "true");
    assert.equal(transcribing.measured[".dictation-status-echo"]?.text, "Transcribing…");
    assert.equal(evidence.captures[`${platform}-voice-timeline-composer`].voice.micInsideInput, true);
    const chat = evidence.captures[`${platform}-voice-timeline-recording-partial`];
    assert.equal(chat.voice.micLabel, "Stop dictation — recording");
    assert.equal(chat.voice.partialText, "Provisional dictation: spoken chat draft");
    const input = chat.measured[".message-input__field"];
    const send = chat.measured[".message-input__send"];
    const partial = chat.measured[".composer-dictation-partial"];
    assert.ok(Math.abs(send.y - input.y - 1) <= 1, `${platform} Send stays level with input`);
    assert.ok(partial.y >= input.y + input.height + 4, `${platform} partial follows input`);
    assert.ok(partial.x + partial.width <= input.x + input.width, `${platform} partial stays in input column`);
    const comment = evidence.captures[`${platform}-voice-comment-composer`];
    assert.equal(comment.voice.micLabel, "Stop dictation — recording");
    assert.equal(comment.voice.partialText, "Provisional dictation: spoken comment draft");
    const body = comment.measured[".comment-composer__body"];
    const commentMic = comment.measured[".comment-composer .dictation-mic"];
    const cancel = comment.measured[".comment-composer__cancel"];
    const submit = comment.measured[".comment-composer__submit"];
    assert.equal(submit.background, "rgb(31, 29, 26)", `${platform} Comment primary fill`);
    assert.equal(submit.color, "rgb(255, 255, 255)", `${platform} Comment primary ink`);
    assert.ok(body.height >= 64, `${platform} comment textarea minimum height`);
    assert.ok(Math.abs(commentMic.x - body.x) <= 1, `${platform} mic aligns with textarea left`);
    assert.ok(Math.abs(submit.x + submit.width - body.x - body.width) <= 1,
      `${platform} Comment aligns with textarea right`);
    assert.ok(Math.abs(cancel.y - submit.y) <= 1 && Math.abs(commentMic.y - submit.y) <= 1,
      `${platform} actions stay on one row`);
    for (const [state, label, echo] of [
      ["editor-error", "Dictate — no microphone found", "No microphone found"],
      ["editor-error-permission", "Dictate — microphone permission denied", "Microphone access is off"],
      ["editor-error-model", "Dictate — voice model missing", "Voice model is missing"],
    ]) {
      const frame = evidence.captures[`${platform}-voice-${state}`];
      assert.equal(frame.voice.micLabel, label);
      assert.equal(frame.measured[".dictation-status-echo"]?.text, echo);
    }
    const frozen = evidence.captures[`${platform}-voice-editor-frozen`];
    assert.equal(frozen.voice.micLabel, "Dictate — unavailable while saving");
    assert.equal(frozen.voice.micDisabled, true);
    assert.equal(frozen.voice.ghostText, null);
    assert.equal(frozen.voice.mutableInert, true);
    assert.equal(frozen.voice.mutableOpacity, "0.55");
    assert.equal(frozen.voice.micOpacity, "1");
    assert.equal(Number(frozen.voice.mutableOpacity) * Number(frozen.voice.micOpacity), 0.55);
    assert.equal(frozen.voice.sessionOperation, "save_tab_session");
    if (platform === "mac") {
      const idleStroke = evidence.captures["mac-voice-editor-idle"].measured[".dictation-mic"].boxShadow;
      const errorStroke = evidence.captures["mac-voice-editor-error"].measured[".dictation-mic"].boxShadow;
      assert.match(idleStroke, /rgb\(227, 223, 214\)/, "idle keeps the macOS neutral stroke");
      assert.match(errorStroke, /rgb\(220, 196, 191\)/, "macOS error uses the 3c reject stroke");
    }
  }
});

test("compact 900px toolbar evidence keeps mic, Timeline and view switch reachable on both platform styles", () => {
  const compactOutput = join(repository, "docs/alignment-compact-toolbar-900");
  const evidence = JSON.parse(readFileSync(join(compactOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);
  assert.equal(evidence.fixture.kind, "typed test-only voice transport over D23");
  for (const platform of ["win", "mac"]) {
    for (const state of ["compact-900-idle", "compact-900-menu"]) {
      const name = `${platform}-voice-${state}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.deepEqual(readFileSync(join(compactOutput, `${name}.png`)).subarray(0, pngSignature.length),
        pngSignature, `${name} is not a PNG`);
      assert.ok(capture.loadedFontFaces.length > 0, `${name} did not load bundled fonts`);
      assert.equal(capture.viewport.width, 900);
      assert.ok(Math.abs(capture.voice.toolbarWidth - 263) <= 1);
      assert.equal(capture.voice.toolbarWrap, "nowrap");
      assert.equal(capture.voice.micWidth, 28);
      assert.equal(capture.voice.micHeight, 26);
      assert.equal(capture.voice.micInOverflow, false);
      assert.equal(capture.voice.micInsideToolbar, true);
      assert.equal(capture.voice.timelineWidth, 44);
      assert.equal(capture.voice.editorViewOverflowed, true);
      assert.equal(capture.voice.overflowVisible, true);
      assert.equal(capture.voice.toolbarHeight, platform === "mac" ? 47 : 45);
    }
  }
});

test("refresh (23) dark compact toolbar keeps pinned controls and view menu on both platform styles", () => {
  const folder = join(repository, "docs/alignment-refresh23-dark");
  const evidence = JSON.parse(readFileSync(join(folder, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "dark");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    for (const state of ["idle", "menu"]) {
      const name = `${platform}-voice-compact-900-dark-${state}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.deepEqual(readFileSync(join(folder, `${name}.png`)).subarray(0, pngSignature.length), pngSignature);
      assert.ok(capture.loadedFontFaces.length > 0, `${name}: bundled fonts`);
      assert.equal(capture.voice.theme, "dark");
      assert.equal(capture.viewport.width, 900);
      assert.equal(capture.measured[".view-mode-toolbar"].background, "rgb(38, 40, 44)");
      assert.ok(Math.abs(capture.voice.toolbarWidth - 263) <= 1);
      assert.equal(capture.voice.toolbarHeight, platform === "win" ? 45 : 47);
      assert.equal(capture.voice.toolbarWrap, "nowrap");
      assert.equal(capture.voice.micWidth, 28);
      assert.equal(capture.voice.micHeight, 26);
      assert.equal(capture.voice.micInsideToolbar, true);
      assert.equal(capture.voice.micInOverflow, false);
      assert.equal(capture.voice.timelineWidth, 44);
      assert.equal(capture.voice.editorViewOverflowed, true);
      assert.equal(capture.voice.overflowVisible, true);
    }
  }
});

test("refresh (23) dark pending compact toolbar keeps the Pause return pinned beside the mic", () => {
  const folder = join(repository, "docs/alignment-refresh23-dark");
  const evidence = JSON.parse(readFileSync(join(folder, "measurements.json"), "utf8"));
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    const idle = evidence.captures[`${platform}-voice-compact-900-dark-idle`];
    for (const state of ["pending", "pending-menu"]) {
      const name = `${platform}-voice-compact-900-dark-${state}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.deepEqual(readFileSync(join(folder, `${name}.png`)).subarray(0, pngSignature.length), pngSignature);
      assert.equal(capture.voice.theme, "dark");
      assert.equal(capture.voice.projectRailWidth, 236);
      assert.equal(capture.voice.commentsWidth, 400);
      assert.equal(capture.voice.toolbarWidth, idle.voice.toolbarWidth);
      assert.equal(capture.voice.toolbarHeight, idle.voice.toolbarHeight);
      assert.equal(capture.voice.timelineWidth, idle.voice.timelineWidth);
      assert.equal(capture.voice.timelineWidth, 44);
      assert.equal(capture.voice.timelineLabel, "Show permission request in Timeline");
      assert.equal(capture.voice.permissionBadgeVisible, true);
      assert.equal(capture.voice.micInsideToolbar, true);
      assert.equal(capture.voice.micInOverflow, false);
      assert.equal(capture.voice.editorViewOverflowed, true);
      assert.equal(capture.voice.overflowVisible, true);
    }
  }
});

test("refresh (23) dark J12 freeze dims the pane once and keeps its status row full contrast", () => {
  const folder = join(repository, "docs/alignment-refresh23-dark");
  const evidence = JSON.parse(readFileSync(join(folder, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(evidence.colorScheme, "dark");
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    const name = `${platform}-voice-dark-editor-frozen`;
    const capture = evidence.captures[name];
    assert.ok(capture, `missing ${name}`);
    assert.deepEqual(readFileSync(join(folder, `${name}.png`)).subarray(0, pngSignature.length), pngSignature);
    assert.ok(capture.loadedFontFaces.length > 0, `${name}: bundled fonts`);
    assert.equal(capture.voice.theme, "dark");
    assert.equal(capture.voice.mutableInert, true);
    assert.equal(capture.voice.mutableOpacity, "0.55");
    assert.equal(capture.voice.micOpacity, "1");
    assert.equal(capture.voice.micDisabled, true);
    assert.equal(capture.voice.ghostText, null);
    assert.ok(capture.voice.timelineWidth >= 100, `${name}: full collapsed Timeline return`);
    assert.match(capture.voice.sessionOperation, /^(prove_tab_session|save_tab_session)$/);
    assert.ok(capture.measured[".untitled-document"], `${name}: editable untitled pane from 14f`);
    assert.match(capture.measured[".tab-bar"].text, /UNTITLED/);
    assert.equal(capture.measured[".tabbed-editor__session-status"].opacity, "1");
    assert.match(capture.measured[".tabbed-editor__session-status"].text, /Saving your session/);
  }
});

test("refresh (20) pathless evidence covers both platform styles and three pane widths at zero and two comments", () => {
  const evidence = JSON.parse(readFileSync(join(output, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);

  for (const platform of ["win", "mac"]) {
    for (const count of [0, 2]) {
      for (const width of [660, 420, 330]) {
        const name = `${platform}-9g-${count}-comments-${width}`;
        const capture = evidence.captures[name];
        assert.ok(capture, `missing ${name}`);
        const pane = capture.measured[".untitled-document"];
        assert.ok(pane, `missing pane geometry for ${name}`);
        assert.ok(Math.abs(pane.width - width) <= 2, `${name}: measured pane ${pane.width}px`);
        const actions = capture.measured[".editor-shell__selection-affordances"];
        assert.ok(actions, `missing selection actions for ${name}`);
        assert.ok(actions.x >= pane.x - 0.25
          && actions.x + actions.width <= pane.x + pane.width + 0.25,
        `${name}: selection actions leave the document column`);
        const status = capture.measured[".document-status-bar"]?.text ?? "";
        if (count === 0) assert.doesNotMatch(status, /open comments?/);
        else assert.match(status, /2 open comments/);
        assert.deepEqual(
          readFileSync(join(output, `${name}.png`)).subarray(0, pngSignature.length),
          pngSignature,
          `${name} is not a PNG`,
        );
      }
    }
    const thread = evidence.captures[`${platform}-9g-thread`];
    assert.ok(thread?.measured[".comment-popover"], `missing ${platform} thread popover`);
    const adopted = evidence.captures[`${platform}-9g-adopted`];
    assert.ok(adopted, `missing ${platform} adoption capture`);
    assert.match(adopted.measured[".editor-shell__selection-affordances"]?.text ?? "", /Comment Quote to chat/);
    assert.match(adopted.measured[".document-status-bar"]?.text ?? "", /2 open comments/);
    for (const name of [`${platform}-9g-thread`, `${platform}-9g-adopted`]) {
      assert.deepEqual(
        readFileSync(join(output, `${name}.png`)).subarray(0, pngSignature.length),
        pngSignature,
        `${name} is not a PNG`,
      );
    }
  }
});

test("refresh (20) toolbar evidence covers atomic format overflow in clean, redline, and pathless rows", () => {
  const toolbarOutput = join(repository, "docs/alignment-refresh20-toolbar");
  const evidence = JSON.parse(readFileSync(join(toolbarOutput, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);
  assert.equal(Object.keys(evidence.captures).length, 30);

  for (const platform of ["win", "mac"]) {
    for (const state of ["clean", "redline", "pathless"]) {
      for (const width of [792, 660, 420, 330]) {
        const name = `${platform}-3d-${state}-${width}`;
        const capture = evidence.captures[name];
        assert.ok(capture, `missing ${name}`);
        const row = capture.measured[".view-mode-toolbar"];
        assert.ok(row, `missing toolbar geometry for ${name}`);
        assert.ok(Math.abs(row.width - width) <= 2, `${name}: measured row ${row.width}px`);
        assert.ok(row.scrollWidth <= row.clientWidth, `${name}: toolbar overflowed its row`);
        assert.equal(row.height, platform === "win" ? 45 : 47);
        assert.ok(row.fontFamily, `${name}: missing computed font family`);
        assert.ok(capture.loadedFontFaces?.length > 0, `${name}: no loaded runtime font faces`);
        assert.deepEqual(
          readFileSync(join(toolbarOutput, `${name}.png`)).subarray(0, pngSignature.length),
          pngSignature,
          `${name} is not a PNG`,
        );
      }
    }
    for (const state of ["keyboard-menu", "moved-bold-executed", "moved-italic-executed"]) {
      const name = `${platform}-3d-redline-${state}-330`;
      assert.ok(evidence.captures[name], `missing ${name}`);
      assert.deepEqual(
        readFileSync(join(toolbarOutput, `${name}.png`)).subarray(0, pngSignature.length),
        pngSignature,
        `${name} is not a PNG`,
      );
    }
  }
});

const requesting = {
  text: "Opening partner-launch…",
  bandHeight: 46,
  messageWhiteSpace: "nowrap",
  messageHeight: 18,
  dismissVisible: true,
  dismissFocusable: true,
  actionCount: 0,
  actionLabel: null,
  actionFocusable: false,
  actionAriaDisabled: false,
  actionFocused: false,
  actionOutlineWidth: "0px",
  ariaBusy: false,
};

test("J9 capture guard requires the real requesting line and focusable Dismiss", () => {
  assert.doesNotThrow(() => assertProjectOpenCapture(requesting, {
    state: "requesting", text: "Opening partner-launch…",
  }));
  assert.throws(() => assertProjectOpenCapture({ ...requesting, text: "partner-launch is already open here." }, {
    state: "requesting", text: "Opening partner-launch…",
  }), /requesting line/);
  assert.throws(() => assertProjectOpenCapture({ ...requesting, dismissFocusable: false }, {
    state: "requesting", text: "Opening partner-launch…",
  }), /Dismiss/);
});

test("J9 capture guard requires retry-pending busy and a focusable inert Trying control", () => {
  const retry = {
    ...requesting,
    text: "Cowrite couldn’t open partner-launch. That folder isn’t available to Cowrite.",
    actionCount: 1,
    actionLabel: "Trying…",
    actionFocusable: true,
    actionAriaDisabled: true,
    actionFocused: true,
    actionOutlineWidth: "2px",
    ariaBusy: true,
  };
  assert.doesNotThrow(() => assertProjectOpenCapture(retry, {
    state: "retry-pending", text: retry.text,
  }));
  assert.throws(() => assertProjectOpenCapture({ ...retry, actionLabel: "Try again" }, {
    state: "retry-pending", text: retry.text,
  }), /Trying/);
  assert.throws(() => assertProjectOpenCapture({ ...retry, ariaBusy: false }, {
    state: "retry-pending", text: retry.text,
  }), /busy/);
  assert.throws(() => assertProjectOpenCapture({ ...retry, actionFocused: false }, {
    state: "retry-pending", text: retry.text,
  }), /focus/);
  assert.throws(() => assertProjectOpenCapture({ ...retry, bandHeight: 64 }, {
    state: "retry-pending", text: retry.text,
  }), /46px/);
});
test("J9 refreshed 700px captures retain a visible failure-reason gap on both platform styles", () => {
  const evidence = JSON.parse(readFileSync(join(repository, "docs/alignment-after/measurements.json"), "utf8"));
  assert.deepEqual(evidence.failures, []);
  for (const platform of ["win", "mac"]) {
    const capture = evidence.captures[`${platform}-13f-retry-pending-700`];
    assert.ok(capture, `missing ${platform} retry-pending frame`);
    assert.ok(capture.verifiedState.suffixToReasonGap > 2);
    assert.ok(capture.verifiedState.suffixToReasonGap < 7);
    assert.equal(capture.measured[".shell-status--project-open"].height, 46);
  }
});

test("refresh (20) D27 evidence distinguishes retained text, clean refusal, omission-only refusal, and composed loss", () => {
  const d27Output = join(repository, "docs/alignment-refresh20-d27");
  const evidence = JSON.parse(readFileSync(join(d27Output, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);
  assert.equal(Object.keys(evidence.captures).length, 24);

  for (const platform of ["win", "mac"]) {
    for (const paneWidth of [660, 440, 330]) {
      const name = `${platform}-9h-retained-${paneWidth}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.ok(Math.abs(capture.measured[".untitled-document"].width - paneWidth) <= 2);
      assert.match(capture.measured[".untitled-document__source-notice"].text, /unsaved text this tab held is here/);
    }
    for (const paneWidth of [440, 330]) {
      const name = `${platform}-9h-composed-${paneWidth}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      assert.ok(Math.abs(capture.measured[".untitled-document"].width - paneWidth) <= 2);
      const source = capture.measured[".untitled-document__source-notice"];
      const loss = capture.measured[".untitled-document__loss-notice"];
      const standing = capture.measured[".untitled-document__conditions"];
      assert.ok(source.y + source.height <= loss.y + 1, `${name}: source notice precedes loss`);
      assert.ok(loss.y + loss.height <= standing.y + 1, `${name}: loss precedes standing strip`);
      assert.match(loss.text, /earlier unsaved work/);
    }
    for (const state of ["clean-refusal", "omission-refusal"]) {
      for (const width of [1400, 430]) {
        const name = `${platform}-9h-${state}-${width}`;
        const capture = evidence.captures[name];
        assert.ok(capture, `missing ${name}`);
        const band = capture.measured[".shell-status--unsupported-refusal"];
        assert.ok(band, `${name}: refusal is absent`);
        assert.equal(band.height, 46);
        assert.match(band.text, /can’t open as a Cowrite document/);
      }
    }
    const clean = evidence.captures[`${platform}-9h-clean-refusal-1400`];
    assert.match(clean.measured[".shell-status--unsupported-refusal"].text, /Its tab was closed/);
    assert.equal(clean.measured[".tab-bar__tab[data-recovery-content-omitted='true']"], undefined);
    const markerSelector = ".tab-bar__tab[data-recovery-content-omitted='true'] .tab-bar__recovery-dot";
    assert.equal(clean.measured[markerSelector], undefined);
    const omission = evidence.captures[`${platform}-9h-omission-refusal-1400`];
    assert.match(omission.measured[".shell-status--unsupported-refusal"].text, /wasn’t kept/);
    assert.ok(omission.measured[".tab-bar__tab[data-recovery-content-omitted='true']"],
      `${platform}: omission-only tab did not retain its omission attribute`);
    const marker = omission.measured[markerSelector];
    assert.ok(marker, `${platform}: omission-only tab has no visible loss marker`);
    assert.equal(marker.width, 6);
    assert.equal(marker.height, 6);
    assert.equal(marker.background, "rgb(181, 135, 31)");
    for (const name of [
      `${platform}-9h-retained-1400`, `${platform}-9h-retained-660`,
      `${platform}-9h-retained-440`, `${platform}-9h-retained-330`,
      `${platform}-9h-adopted-1400`, `${platform}-9h-composed-1400`,
      `${platform}-9h-composed-440`, `${platform}-9h-composed-330`,
      `${platform}-9h-clean-refusal-1400`, `${platform}-9h-clean-refusal-430`,
      `${platform}-9h-omission-refusal-1400`, `${platform}-9h-omission-refusal-430`,
    ]) {
      assert.deepEqual(
        readFileSync(join(d27Output, `${name}.png`)).subarray(0, pngSignature.length),
        pngSignature,
        `${name} is not a PNG`,
      );
    }
  }
});
