// @vitest-environment jsdom
// ABOUTME: Pins UXR-Q7.2 and FR-ED-7's platform-aware document save readout.
// ABOUTME: Recovery pending/failure stay truthful and accessible through status-bar overflow.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DocumentSaveStatus,
  documentSaveStatusOverflowEntry,
  type DocumentSaveState,
} from "./DocumentSaveStatus";

function installStyles() {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
    "utf8",
  );
  document.head.append(style);
}

describe("editor/DocumentSaveStatus (#2109, FR-ED-7)", () => {
  const saved: DocumentSaveState = { kind: "saved", at: Date.UTC(2026, 8, 3, 19, 14) };

  it("places ordinary saved state in the Windows status bar and macOS title bar only", () => {
    installStyles();
    const rendered = render(<DocumentSaveStatus platform="win" state={saved} />);
    expect(screen.getByText(/^Saved · /)).toBeVisible();

    rendered.rerender(<DocumentSaveStatus platform="mac" state={saved} />);
    expect(screen.queryByText(/^Saved · /)).toBeNull();

    rendered.rerender(<DocumentSaveStatus platform="mac" state={saved} surface="title-bar" />);
    const macTitleReadout = screen.getByText(/^Saved · /);
    expect(macTitleReadout).toBeVisible();
    expect(macTitleReadout).toHaveClass("document-save-status--title-bar");
    expect(getComputedStyle(macTitleReadout).color).toBe("var(--color-app-header-save-fg)");
    expect(getComputedStyle(macTitleReadout).fontSize).toBe("11.5px");
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-app-header-save-fg")
        .trim(),
    ).toBe("#8c8779");

    rendered.rerender(<DocumentSaveStatus platform="win" state={saved} surface="title-bar" />);
    expect(screen.queryByText(/^Saved · /)).toBeNull();
  });

  it("places the paused-write readout in the status bar on both platforms", () => {
    const paused: DocumentSaveState = { kind: "writes-paused" };
    const rendered = render(<DocumentSaveStatus platform="win" state={paused} />);
    expect(screen.getByText("Not saved — writes paused")).toBeVisible();

    rendered.rerender(<DocumentSaveStatus platform="mac" state={paused} />);
    expect(screen.getByText("Not saved — writes paused")).toBeVisible();

    rendered.rerender(<DocumentSaveStatus platform="mac" state={paused} surface="title-bar" />);
    expect(screen.queryByText("Not saved — writes paused")).toBeNull();
    expect(documentSaveStatusOverflowEntry(paused, "mac")).toMatchObject({
      label: "Not saved — writes paused",
      disabled: true,
    });
  });

  it("states the reload-write-pending window on both platforms", () => {
    const { rerender } = render(
      <DocumentSaveStatus platform="win" state={{ kind: "reload-write-pending" }} />,
    );
    expect(screen.getByText("Reloaded from disk · not saved yet")).toBeVisible();

    rerender(<DocumentSaveStatus platform="mac" state={{ kind: "reload-write-pending" }} />);
    expect(screen.getByText("Reloaded from disk · not saved yet")).toBeVisible();

    rerender(
      <DocumentSaveStatus
        platform="mac"
        state={{ kind: "reload-write-pending" }}
        surface="title-bar"
      />,
    );
    expect(screen.queryByText("Reloaded from disk · not saved yet")).toBeNull();
  });

  it("uses the binding Reject-family foreground for a failed recovery write", () => {
    installStyles();
    const rendered = render(
      <DocumentSaveStatus platform="win" state={{ kind: "reload-write-failed" }} />,
    );
    const readout = screen.getByText("Reloaded from disk · not saved yet");
    expect(readout).toHaveClass("document-save-status--failed");
    expect(getComputedStyle(readout).color).toBe("var(--color-document-status-failed)");
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-document-status-failed")
        .trim(),
    ).toBe("#a33a2e");

    rendered.rerender(
      <DocumentSaveStatus
        platform="mac"
        state={{ kind: "reload-write-failed" }}
        surface="title-bar"
      />,
    );
    expect(screen.queryByText("Reloaded from disk · not saved yet")).toBeNull();
  });

  it("keeps an overflowed save readout available as a disabled menu fact, never a fake action", () => {
    const entry = documentSaveStatusOverflowEntry({ kind: "reload-write-failed" }, "win");
    expect(entry).toMatchObject({
      id: "save-state",
      label: "Reloaded from disk · not saved yet",
      disabled: true,
    });
    expect(entry?.onSelect).toBeUndefined();
    expect(documentSaveStatusOverflowEntry(saved, "mac")).toBeNull();
  });
});
