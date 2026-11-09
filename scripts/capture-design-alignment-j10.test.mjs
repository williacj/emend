// ABOUTME: Checks the committed refresh (20) J10 visual evidence for complete real-route states.
// ABOUTME: Verifies both platform styles, timeline and popover geometry, source stamp, and PNG payloads.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(repository, "docs/alignment-refresh20-j10");
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const states = [
  "root-blocked-timeline", "root-blocked-popover", "nested-blocked-timeline", "nested-blocked-popover",
  "eligible-timeline", "eligible-popover", "commit-refusal-timeline",
  "commit-refusal-popover", "withdrawn-timeline", "linked-timeline",
  "linked-popover", "linked-reason-timeline", "linked-reason-popover",
  "run-held-timeline", "run-held-popover", "run-held-status-timeline", "run-held-status-popover",
];

test("refresh (20) J10 evidence covers child-first states on both platform styles", () => {
  const evidence = JSON.parse(readFileSync(join(output, "measurements.json"), "utf8"));
  assert.match(evidence.sourceRevision, /^[0-9a-f]{40}$/);
  assert.deepEqual(evidence.failures, []);

  for (const platform of ["win", "mac"]) {
    for (const state of states) {
      const name = `${platform}-5d-${state}`;
      const capture = evidence.captures[name];
      assert.ok(capture, `missing ${name}`);
      const target = state.endsWith("popover") ? ".comment-popover" : '[data-card-kind="comment"]';
      const geometry = capture.measured[target];
      assert.ok(geometry, `missing ${target} geometry for ${name}`);
      if (state.endsWith("popover")) assert.equal(geometry.width, 340, `${name}: popover width`);
      if (state.startsWith("eligible-")) {
        assert.match(geometry.text, /Delete this comment\?/);
        assert.match(geometry.text, /deleted a reply/);
        assert.doesNotMatch(geometry.text, /Address with AI/);
        assert.deepEqual(capture.confirmationControls, { replyTextboxes: 0, addressButtons: 0 },
          `${name}: ordinary reply/address controls remain during Delete confirmation`);
      }
      if (state === "withdrawn-timeline") {
        assert.match(geometry.text, /Go to passage/, `${name}: withdrawn route label`);
        assert.doesNotMatch(geometry.text, /selected phrase/, `${name}: withdrawn body stays private`);
      }
      assert.deepEqual(readFileSync(join(output, `${name}.png`)).subarray(0, signature.length), signature);
    }
  }
});
