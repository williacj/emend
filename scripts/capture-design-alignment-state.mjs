// ABOUTME: Pure capture-gate helpers: scenario selection and live J9 project-open DOM checks.
// ABOUTME: Keeps the capture gate independent of timing and of the image file's existence.
import { strict as assert } from "node:assert";

// A filter selects scenarios whose name contains it; "=name" selects exactly "<platform> name".
export function scenarioSelected(filter, name) {
  if (!filter) return true;
  if (filter.startsWith("=")) return name.slice(name.indexOf(" ") + 1) === filter.slice(1);
  return name.includes(filter);
}

export function assertProjectOpenCapture(observed, expected) {
  assert.equal(observed.text, expected.text, `${expected.state} line differs from the backend state`);
  assert.ok(Math.abs(observed.bandHeight - 46) <= 0.5, "project-open band must be 46px high");
  assert.equal(observed.messageWhiteSpace, "nowrap", "project-open message must stay on one line");
  assert.ok(observed.messageHeight <= 21, "project-open message must stay on one line");
  assert.ok(observed.dismissVisible && observed.dismissFocusable, "Dismiss must be visible and focusable");
  if (expected.state === "requesting") {
    assert.equal(observed.actionCount, 0, "requesting must not show a contextual action");
    assert.equal(observed.ariaBusy, false, "initial requesting must not be retry busy");
  } else if (expected.state === "retry-pending") {
    assert.equal(observed.actionCount, 1, "retry pending needs one contextual action");
    assert.equal(observed.actionLabel, "Trying…", "retry pending must show Trying…");
    assert.ok(observed.actionFocusable && observed.actionAriaDisabled,
      "Trying… must remain focusable while inert");
    assert.ok(observed.actionFocused && observed.actionOutlineWidth === "2px",
      "Trying… must keep keyboard focus and its 2px ring");
    assert.equal(observed.ariaBusy, true, "retry pending must be aria-busy");
  } else {
    throw new Error(`Unknown J9 capture state: ${expected.state}`);
  }
}
