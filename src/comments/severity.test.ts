// ABOUTME: Tests for the free-form severity string → display letter mapping (P2b-5b, FR-REVIEW-2)
// ABOUTME: `CommentThreadCard`'s severity chip renders — kept separate from `batchAddress.ts`'s
// ABOUTME: `severityRank`, whose ranking deliberately excludes "critical" (a different question).
import { describe, expect, it } from "vitest";
import { isFindingProvenance, ratifiedSeverityLetter, severityLetter } from "./severity";

describe("comments/severity severityLetter", () => {
  it("maps the long-form spellings to their ux-design.md §2 letter", () => {
    expect(severityLetter("critical")).toBe("C");
    expect(severityLetter("high")).toBe("H");
    expect(severityLetter("medium")).toBe("M");
    expect(severityLetter("low")).toBe("L");
  });

  it("is case-insensitive", () => {
    expect(severityLetter("CRITICAL")).toBe("C");
    expect(severityLetter("High")).toBe("H");
  });

  it("passes an already-single-letter severity through uppercased", () => {
    expect(severityLetter("h")).toBe("H");
    expect(severityLetter("C")).toBe("C");
  });

  // Severity is a free-form string with no ratified vocabulary (batchAddress.ts's own docs) — an
  // unrecognized value must still render *something* honest rather than silently going blank, so
  // the accessibility rule ("never colour alone") isn't accidentally satisfied by an empty chip.
  it("falls back to the first letter uppercased for an unrecognized severity", () => {
    expect(severityLetter("spicy")).toBe("S");
  });

  // An empty string has no first letter to uppercase — falling back to "" here would let a chip
  // render with neither colour nor letter, silently defeating the "never colour alone" rule the
  // chip exists to satisfy (review-gate finding on #443: the wire's severity is an unvalidated
  // Option<String>, so "" is reachable, not just theoretical).
  it("falls back to a non-empty placeholder letter for an empty severity", () => {
    expect(severityLetter("")).toBe("?");
  });

  it("falls back to a non-empty placeholder letter for a whitespace-only severity", () => {
    expect(severityLetter("   ")).toBe("?");
  });

  // An Object.prototype key is just another unrecognized severity: it takes the first-letter fallback
  // like any other, and must stay a plain string. A lookup table that inherits from Object.prototype
  // returns a builtin here instead, which React refuses to render as a child (review finding, #537).
  it("takes the first-letter fallback for an Object.prototype key instead of an inherited builtin", () => {
    expect(severityLetter("__proto__")).toBe("_");
    expect(severityLetter("constructor")).toBe("C");
    expect(severityLetter("toString")).toBe("T");
  });
});

describe("comments/severity ratifiedSeverityLetter", () => {
  it("maps the same ratified spellings severityLetter does case-insensitively", () => {
    expect(ratifiedSeverityLetter("critical")).toBe("C");
    expect(ratifiedSeverityLetter("High")).toBe("H");
    expect(ratifiedSeverityLetter("m")).toBe("M");
    expect(ratifiedSeverityLetter("low")).toBe("L");
  });

  // The whole reason this function exists (review finding, #537): severityLetter's guessing
  // fallback would let these leak through as a match for Critical/High. A no-guessing lookup must
  // return undefined instead.
  it("returns undefined for an unranked severity that merely starts with a ratified letter", () => {
    expect(ratifiedSeverityLetter("cosmetic")).toBeUndefined();
    expect(ratifiedSeverityLetter("housekeeping")).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only severity", () => {
    expect(ratifiedSeverityLetter("")).toBeUndefined();
    expect(ratifiedSeverityLetter("   ")).toBeUndefined();
  });

  // Severity crosses the agent trust boundary as an unvalidated Option<String>, so an Object.prototype
  // key is representable on the wire. A table lookup that inherits from Object.prototype answers these
  // with a builtin (Object.prototype / the Object constructor) instead of undefined, and a non-string
  // chip value throws in React's render ("Objects are not valid as a React child"), unmounting the
  // tree (review finding, #537).
  it("returns undefined for an Object.prototype key rather than an inherited builtin", () => {
    expect(ratifiedSeverityLetter("__proto__")).toBeUndefined();
    expect(ratifiedSeverityLetter("constructor")).toBeUndefined();
    expect(ratifiedSeverityLetter("toString")).toBeUndefined();
    expect(ratifiedSeverityLetter("  Constructor  ")).toBeUndefined();
  });
});

describe("comments/severity isFindingProvenance", () => {
  it("is true when severity is set", () => {
    expect(isFindingProvenance({ severity: "high", skill: null })).toBe(true);
  });

  it("is true when skill is set", () => {
    expect(isFindingProvenance({ severity: null, skill: "style" })).toBe(true);
  });

  it("is false when neither is set — D6's ordinary human comment", () => {
    expect(isFindingProvenance({ severity: null, skill: null })).toBe(false);
  });
});
