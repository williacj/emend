// ABOUTME: Covers `isZeroProviders` (FR-X-7) — the shared predicate `WritingPartnersPanel` and
// ABOUTME: `EditorOnlyStatusChip` both key their zero-provider guidance/chip off of.
import { describe, expect, it } from "vitest";
import { isZeroProviders } from "./types";

describe("isZeroProviders", () => {
  it("is false while still loading (null)", () => {
    expect(isZeroProviders(null)).toBe(false);
  });

  it("is true when every entry is not_installed", () => {
    expect(
      isZeroProviders([
        { provider: "claude_code", state: "not_installed" },
        { provider: "copilot", state: "not_installed" },
      ]),
    ).toBe(true);
  });

  it("is false when at least one provider is installed", () => {
    expect(
      isZeroProviders([
        { provider: "claude_code", state: "installed_signed_out" },
        { provider: "copilot", state: "not_installed" },
      ]),
    ).toBe(false);
  });

  it("is true for an empty entry list — vacuously every() is true, but this shape never occurs in practice (ProviderId::ALL always yields both)", () => {
    expect(isZeroProviders([])).toBe(true);
  });
});
