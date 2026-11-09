// @vitest-environment jsdom
// ABOUTME: Pins the shared three-action close guard, including J2's truthful empty over-cap body.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DirtyCloseGuard } from "./DirtyCloseGuard";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

function attachStyles() {
  const style = document.createElement("style");
  style.textContent = STYLESHEET;
  document.head.append(style);
  return () => style.remove();
}

describe("editor/DirtyCloseGuard", () => {
  it("renders the three actions in order, defaults focus to Cancel, and Esc cancels", () => {
    const onCancel = vi.fn();
    render(
      <DirtyCloseGuard
        label="Untitled — recovered from b.md"
        onSave={() => {}}
        saveLabel="Save As…"
        onDiscard={() => {}}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Save As…",
      "Discard",
      "Cancel",
    ]);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the five close-guard variants' exact body and treatment", () => {
    const cases = [
      [
        "only-copy",
        "Untitled — recovered from b.md holds unsaved work. Closing it without saving discards that work permanently.",
        true,
      ],
      [
        "live-over-cap",
        "This document holds unsaved work that Cowrite can't keep in your session — it's over the 2 MiB per-tab limit. Closing it without saving discards that work permanently.",
        true,
      ],
      [
        "omitted-with-edits",
        "You've written in this document since it was opened, and that work isn't saved anywhere. Closing it without saving discards it permanently. The earlier unsaved work this tab was created to hold was already not preserved, and closing changes nothing about that.",
        true,
      ],
      [
        "restored-omitted-empty",
        "This untitled document is empty now. Earlier unsaved work was not preserved. Closing it discards no current content.",
        false,
      ],
      [
        "preserved-empty",
        "This untitled document is empty and isn't saved anywhere. Closing it discards no content.",
        false,
      ],
    ] as const;

    for (const [variant, body, destructive] of cases) {
      const removeStyles = attachStyles();
      const { unmount } = render(
        <DirtyCloseGuard
          label="Untitled — recovered from b.md"
          onSave={() => {}}
          saveLabel="Save As…"
          recoveryVariant={variant}
          discardLabel="Discard this untitled document"
          onDiscard={() => {}}
          onCancel={() => {}}
        />,
      );

      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveTextContent(body);
      const discard = within(dialog).getByRole("button", {
        name: "Discard this untitled document",
      });
      expect(discard).toHaveClass(
        destructive ? "dirty-close-guard__discard--destructive" : "dirty-close-guard__discard",
      );
      if (!destructive) expect(discard).not.toHaveClass("dirty-close-guard__discard--destructive");
      expect(getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim()).toBe(
        "#ffffff",
      );
      removeStyles();
      unmount();
    }
  });

  it("traps Tab focus within the modal actions", () => {
    render(
      <DirtyCloseGuard
        label="Untitled — recovered from b.md"
        onSave={() => {}}
        saveLabel="Save As…"
        recoveryVariant="only-copy"
        onDiscard={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    const [save, , cancel] = within(dialog).getAllByRole("button");
    cancel.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(save).toHaveFocus();
    save.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it("hosts Save As failure in the modal with reject tokens and disables every exit in flight", () => {
    const removeStyles = attachStyles();
    const { rerender } = render(
      <DirtyCloseGuard
        label="Untitled — recovered from b.md"
        onSave={() => {}}
        saveLabel="Save As…"
        recoveryVariant="only-copy"
        saveError="Couldn’t save to drafts/b.md — permission denied. Nothing was written, and this document is unchanged."
        onDiscard={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    const error = within(dialog).getByRole("status");
    expect(error).toHaveTextContent("Nothing was written, and this document is unchanged.");
    expect(getComputedStyle(error).padding).toBe("8px 11px");
    expect(getComputedStyle(error).borderRadius).toBe("6px");
    expect(STYLESHEET).toContain("border: 1px solid var(--color-reject-border);");
    expect(STYLESHEET).toContain("background: var(--color-reject-bg);");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--color-reject-bg").trim())
      .toBe("#f8efed");
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--color-reject-border").trim(),
    ).toBe("#dcc4bf");

    rerender(
      <DirtyCloseGuard
        label="Untitled — recovered from b.md"
        onSave={() => {}}
        saveLabel="Save As…"
        recoveryVariant="only-copy"
        saving
        onDiscard={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getAllByRole("button").every((button) => button.hasAttribute("disabled")))
      .toBe(true);
    removeStyles();
  });
});
