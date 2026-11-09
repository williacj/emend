// ABOUTME: Confirms `buildAddressPrompt`/`buildBatchAddressPrompt` name the comment(s) an address
// ABOUTME: run must act on — the content `start_run` actually carries (#1721's missing seam).
import { describe, expect, it } from "vitest";
import { buildAddressPrompt, buildBatchAddressPrompt } from "./addressPrompt";
import { thread } from "./threadFixture";

describe("comments/addressPrompt", () => {
  describe("buildAddressPrompt", () => {
    it("carries the comment body for an unanchored (document-level) thread", () => {
      const prompt = buildAddressPrompt(thread("c1", { body: "please clarify this paragraph" }));
      expect(prompt).toContain("please clarify this paragraph");
      expect(prompt).not.toContain("Quoted passage");
    });

    it("carries the anchored quote alongside the comment body", () => {
      const anchored = thread("c1", {
        body: "prefer a stronger adjective",
        anchor: {
          offset: 6,
          length: 5,
          text_snapshot: "brave",
          context_before: "Hello ",
          context_after: " world",
          base_revision: "blake3:abc",
        },
      });

      const prompt = buildAddressPrompt(anchored);

      expect(prompt).toContain('Quoted passage: "brave"');
      expect(prompt).toContain("prefer a stronger adjective");
    });

    it("omits any guidance line when re-delegating with no note (a first address)", () => {
      const prompt = buildAddressPrompt(thread("c1"), null);
      expect(prompt).not.toContain("Guidance for this attempt");
    });

    it("appends the re-delegation guidance note when given", () => {
      const prompt = buildAddressPrompt(thread("c1"), "use ESV wording throughout");
      expect(prompt).toContain("Guidance for this attempt: use ESV wording throughout");
    });
  });

  describe("buildBatchAddressPrompt", () => {
    it("lists every targeted thread's comment, in order, under one shared instruction", () => {
      const targets = [
        thread("a", { body: "finding A" }),
        thread("b", { body: "finding B" }),
      ];

      const prompt = buildBatchAddressPrompt(targets);

      expect(prompt).toContain("2 comment thread(s)");
      const indexA = prompt.indexOf("finding A");
      const indexB = prompt.indexOf("finding B");
      expect(indexA).toBeGreaterThan(-1);
      expect(indexB).toBeGreaterThan(indexA);
    });

    it("carries each target's anchored quote too", () => {
      const targets = [
        thread("a", {
          body: "finding A",
          anchor: {
            offset: 0,
            length: 5,
            text_snapshot: "brave",
            context_before: "",
            context_after: "",
            base_revision: "blake3:abc",
          },
        }),
      ];

      expect(buildBatchAddressPrompt(targets)).toContain('Quoted passage: "brave"');
    });
  });
});
