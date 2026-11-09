// ABOUTME: Pure layout-state logic for workshop mode (P2b-6b) — the workshop/authoring derivation,
// ABOUTME: independent of `App`'s React wiring.
import { describe, expect, it } from "vitest";
import { isWorkshopMode } from "./workshopMode";

describe("stores/workshopMode — isWorkshopMode", () => {
  it("no open tabs is workshop mode", () => {
    expect(isWorkshopMode(false)).toBe(true);
  });

  it("an open tab is authoring mode — not workshop mode", () => {
    expect(isWorkshopMode(true)).toBe(false);
  });
});
