// @vitest-environment jsdom
// ABOUTME: Tests for the external-change integrity banner (FR-ED-7, #2074) — non-modal, exact
// ABOUTME: ux-design copy across every presentation phase (observed/blocked/reloading/failed),
// ABOUTME: Keep mine highlighted only when dirty and only in the observed phase, its absence once
// ABOUTME: Reload has failed (CJ-ratified #1641), and the aria-busy/dimmed-but-mounted treatment.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExternalChangeBanner, type ExternalChangeBannerState } from "./ExternalChangeBanner";

const observed = (blocked = false): ExternalChangeBannerState => ({ kind: "observed", blocked });
const reloading = (): ExternalChangeBannerState => ({ kind: "reloading" });
const failed = (reason = "Permission denied.", retrying = false): ExternalChangeBannerState => ({
  kind: "failed",
  reason,
  retrying,
});

const handlers = () => ({
  onReload: vi.fn(),
  onKeepMine: vi.fn(),
  onCompare: vi.fn(),
  onTryAgain: vi.fn(),
  onSaveAs: vi.fn(),
});

describe("editor/ExternalChangeBanner", () => {
  it("is non-modal — a status banner rather than a dialog", () => {
    render(
      <ExternalChangeBanner path="a.md" state={observed()} isDirty={false} {...handlers()} />,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the exact ux-design copy and all three actions", () => {
    render(
      <ExternalChangeBanner path="a.md" state={observed()} isDirty={false} {...handlers()} />,
    );
    expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare" })).toBeTruthy();
  });

  it("Keep mine is the highlighted default when the tab has unsaved local edits", () => {
    render(<ExternalChangeBanner path="a.md" state={observed()} isDirty {...handlers()} />);
    expect(screen.getByRole("button", { name: "Keep mine" }).className).toContain(
      "integrity-banner__action--default",
    );
    expect(screen.getByRole("button", { name: "Reload" }).className).not.toContain("--default");
  });

  it("neither action is highlighted as the default when the tab is clean", () => {
    render(
      <ExternalChangeBanner path="a.md" state={observed()} isDirty={false} {...handlers()} />,
    );
    expect(screen.getByRole("button", { name: "Keep mine" }).className).not.toContain("--default");
    expect(screen.getByRole("button", { name: "Reload" }).className).not.toContain("--default");
  });

  it("does not steal focus on mount — it appears from a background poll (ux Principle 2 / J1)", () => {
    // The banner mounts from a background disk poll while the user may be mid-sentence; moving
    // keyboard focus to any action button on mount would be a focus steal (ux-design.md line 16,
    // J1 edge state line 132). The buttons stay Tab-reachable via the visual --default highlight.
    for (const dirty of [true, false]) {
      render(
        <ExternalChangeBanner path="a.md" state={observed()} isDirty={dirty} {...handlers()} />,
      );
      for (const name of ["Reload", "Keep mine", "Compare"]) {
        const button = screen.getByRole("button", { name });
        expect(button.hasAttribute("autofocus")).toBe(false);
        expect(document.activeElement).not.toBe(button);
      }
      cleanup();
    }
  });

  it("each action fires its own callback", () => {
    const h = handlers();
    render(<ExternalChangeBanner path="a.md" state={observed()} isDirty={false} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(h.onReload).toHaveBeenCalledTimes(1);
    expect(h.onKeepMine).toHaveBeenCalledTimes(1);
    expect(h.onCompare).toHaveBeenCalledTimes(1);
  });

  // #2074 AC2 — the observed phase's two-line hierarchy (document-integrity.md "Hierarchy", 11a/
  // 11c.1): the ratified heading verbatim, then a consequence line that differs by dirty state and
  // — only while dirty — names the path in italic, exactly as 11a's mock copy reads.
  describe("observed — the two-line hierarchy (AC2)", () => {
    it("names the path in italic in the dirty consequence line", () => {
      render(
        <ExternalChangeBanner path="notes.md" state={observed()} isDirty {...handlers()} />,
      );
      expect(
        screen.getByText((_, node) => node?.textContent === "Someone or something else wrote to notes.md. Cowrite has paused writing to it until you choose. Your unsaved edits are still here."),
      ).toBeTruthy();
      const italic = screen.getByText("notes.md", { selector: "i" });
      expect(italic).toBeTruthy();
    });

    it("the clean consequence line names no path — nothing of the author's can be lost", () => {
      render(
        <ExternalChangeBanner path="notes.md" state={observed()} isDirty={false} {...handlers()} />,
      );
      expect(
        screen.getByText(
          "Nothing of yours is unsaved here, so no choice is safer than the others. Cowrite still won’t write to the file until you pick one.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("notes.md", { selector: "i" })).toBeNull();
    });
  });

  // #2074 AC3 — a blocked Save rewrites both lines exactly and focuses Keep mine. The focus part is
  // EditorShell's own responsibility (imperative `keepMineRef.current.focus()`); this component's
  // contract is the copy and the ref plumbing.
  describe("blocked Save (AC3)", () => {
    it("rewrites both lines to the exact blocked-Save copy", () => {
      render(
        <ExternalChangeBanner path="notes.md" state={observed(true)} isDirty {...handlers()} />,
      );
      expect(screen.getByText("Not saved — this file changed outside the editor")).toBeTruthy();
      expect(
        screen.getByText("Cowrite didn’t write over it. Choose Reload, Keep mine, or Compare."),
      ).toBeTruthy();
      // The ratified sentence never appears twice in the same bar.
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("still offers all three actions, unchanged", () => {
      render(
        <ExternalChangeBanner path="notes.md" state={observed(true)} isDirty {...handlers()} />,
      );
      expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Compare" })).toBeTruthy();
    });
  });

  // #2074 AC4 — Reload in progress: aria-busy, the three actions dimmed-but-mounted (not removed —
  // the row must not reflow) and inert, a quiet "Reloading…", and the progress copy replacing the
  // ordinary consequence line. The heading itself is unchanged from the ordinary observed phase.
  describe("reloading (AC4)", () => {
    it("sets aria-busy and shows the progress copy plus a quiet Reloading… label", () => {
      render(<ExternalChangeBanner path="notes.md" state={reloading()} isDirty {...handlers()} />);
      expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("This file changed outside the editor")).toBeTruthy();
      expect(
        screen.getByText(
          "Bringing in the version from disk and saving it in place. Your earlier text is being replaced.",
        ),
      ).toBeTruthy();
      expect(screen.getByText("Reloading…")).toBeTruthy();
    });

    it("mounts all three actions, dimmed and disabled rather than removed", () => {
      render(<ExternalChangeBanner path="notes.md" state={reloading()} isDirty {...handlers()} />);
      for (const name of ["Reload", "Keep mine", "Compare"]) {
        const button = screen.getByRole("button", { name });
        expect(button).toBeDisabled();
      }
    });

    it("does not highlight Keep mine as the default while busy, even on a dirty tab", () => {
      render(<ExternalChangeBanner path="notes.md" state={reloading()} isDirty {...handlers()} />);
      expect(screen.getByRole("button", { name: "Keep mine" }).className).not.toContain("--default");
    });
  });

  // #2074 AC6/AC7 — the CJ-ratified (2026-08-28, #1641) failed-Reload disposition: the honest
  // heading, the real reason in a distinct Reject-family line, Try again as the highlighted
  // default, Save As… and Compare, and — the point of the ruling — no Keep mine at all.
  describe("failed (AC6)", () => {
    it("shows the honest heading and consequence, not the ordinary one", () => {
      render(<ExternalChangeBanner path="notes.md" state={failed()} isDirty {...handlers()} />);
      expect(screen.getByText("The version from disk is here, but it isn’t saved")).toBeTruthy();
      expect(
        screen.getByText(
          "What you see now is the file as it was on disk. Cowrite couldn’t finish saving it back, so this document is still unsaved.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("This file changed outside the editor")).toBeNull();
    });

    it("carries the real reason in a Reject-family line", () => {
      render(
        <ExternalChangeBanner
          path="notes.md"
          state={failed("Permission denied.")}
          isDirty
          {...handlers()}
        />,
      );
      expect(
        screen.getByText(
          (_, node) =>
            node?.textContent ===
            "Couldn’t save the reloaded file. Permission denied. Nothing was lost — the text on screen is the disk version.",
        ),
      ).toBeTruthy();
    });

    it("a different reason renders verbatim — the real normalized reason, not a fixed string", () => {
      render(
        <ExternalChangeBanner
          path="notes.md"
          state={failed("Disk full.")}
          isDirty
          {...handlers()}
        />,
      );
      expect(screen.getByText(/Disk full\./)).toBeTruthy();
      expect(screen.queryByText(/Permission denied\./)).toBeNull();
    });

    it("offers exactly Try again, Save As…, and Compare — Keep mine is absent", () => {
      render(<ExternalChangeBanner path="notes.md" state={failed()} isDirty {...handlers()} />);
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Compare" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
    });

    it("Try again is the highlighted default", () => {
      render(<ExternalChangeBanner path="notes.md" state={failed()} isDirty {...handlers()} />);
      expect(screen.getByRole("button", { name: "Try again" }).className).toContain("--default");
    });

    it("Try again and Save As… each fire their own callback", () => {
      const h = handlers();
      render(<ExternalChangeBanner path="notes.md" state={failed()} isDirty {...h} />);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
      expect(h.onTryAgain).toHaveBeenCalledTimes(1);
      expect(h.onSaveAs).toHaveBeenCalledTimes(1);
    });

    it("while retrying, dims and disables all three actions but keeps the failed copy mounted", () => {
      render(
        <ExternalChangeBanner
          path="notes.md"
          state={failed("Permission denied.", true)}
          isDirty
          {...handlers()}
        />,
      );
      expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("The version from disk is here, but it isn’t saved")).toBeTruthy();
      for (const name of ["Try again", "Save As…", "Compare"]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    });
  });

  // #2074 AC2 — platform-specific edge/radius treatment (document-integrity.md "Buttons").
  it("carries the requested platform as a data attribute for win/mac chrome", () => {
    render(
      <ExternalChangeBanner
        path="notes.md"
        state={observed()}
        isDirty={false}
        platform="mac"
        {...handlers()}
      />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-platform", "mac");
  });
});
