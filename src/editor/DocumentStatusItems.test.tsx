// @vitest-environment jsdom
// ABOUTME: Pins #2119's concrete status-bar facts: document counts, pathless absence rules, and
// ABOUTME: the live Claude Code connection readout that rides the shell's existing overflow.
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentStatusBar } from "./DocumentStatusBar";
import { agentConnectionStatusItem, documentStatusLeadingItems } from "./DocumentStatusItems";

const STYLESHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

describe("editor/DocumentStatusItems (#2119, UXR-Q7.2)", () => {
  it("always names Markdown and words, while zero optional counts are absent", () => {
    render(
      <DocumentStatusBar
        leadingItems={documentStatusLeadingItems({
          wordCount: 2,
          trackedChangeCount: 0,
          openCommentCount: 0,
        })}
      />,
    );

    const status = screen.getByRole("region", { name: "Document status" });
    expect(within(status).getByText("Markdown")).toBeVisible();
    expect(within(status).getByText("2 words")).toBeVisible();
    expect(
      within(status).queryByText(/tracked change/),
      "zero tracked-change status must be absent",
    ).toBeNull();
    expect(
      within(status).queryByText(/open comment/),
      "zero open-comment status must be absent",
    ).toBeNull();
  });

  it("pluralizes and groups each positive document count", () => {
    render(
      <DocumentStatusBar
        leadingItems={documentStatusLeadingItems({
          wordCount: 1_208,
          trackedChangeCount: 14,
          openCommentCount: 2,
        })}
      />,
    );

    const status = screen.getByRole("region", { name: "Document status" });
    expect(within(status).getByText("1,208 words")).toBeVisible();
    expect(within(status).getByText("14 tracked changes")).toBeVisible();
    expect(within(status).getByText("2 open comments")).toBeVisible();
  });

  it("uses the binding comment-mode sequence and suppresses tracked changes", () => {
    render(
      <DocumentStatusBar
        leadingItems={documentStatusLeadingItems({
          wordCount: 2,
          trackedChangeCount: 14,
          openCommentCount: 6,
          resolvedCommentCount: 2,
          commentMode: true,
        })}
      />,
    );

    const status = screen.getByRole("region", { name: "Document status" });
    expect(status).toHaveTextContent("Markdown2 words6 open comments2 resolved");
    expect(
      within(status).queryByText(/tracked change/),
      "comment mode must suppress the tracked-change fact",
    ).toBeNull();
  });

  it("qualifies a pathless tracked-change count and can omit comments entirely", () => {
    render(
      <DocumentStatusBar
        leadingItems={documentStatusLeadingItems({
          wordCount: 2,
          trackedChangeCount: 1,
          openCommentCount: null,
          unattributedChanges: true,
        })}
      />,
    );

    const status = screen.getByRole("region", { name: "Document status" });
    expect(status).toHaveTextContent("1 tracked change · no author recorded");
    const qualifier = within(status).getByText("· no author recorded");
    expect(qualifier).toHaveClass("document-status-unattributed");
    expect(
      within(status).queryByText(/open comment/),
      "pathless status must omit comment capability",
    ).toBeNull();
  });

  it("uses the binding amber text token for the unattributed qualifier", () => {
    const style = document.createElement("style");
    style.textContent = STYLESHEET;
    document.head.append(style);
    render(
      <DocumentStatusBar
        leadingItems={documentStatusLeadingItems({
          wordCount: 1,
          trackedChangeCount: 1,
          openCommentCount: null,
          unattributedChanges: true,
        })}
      />,
    );

    const qualifier = screen.getByText("· no author recorded");
    expect(getComputedStyle(qualifier).color).toBe("var(--color-document-status-unattributed)");
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--color-document-status-unattributed").trim(),
    ).toBe("#8a6614");
    style.remove();
  });

  it("renders the honest Claude connection fact", () => {
    const cases = [
      [null, "Claude Code · checking connection"],
      [
        [{ provider: "claude_code", state: "signed_in", account: null }] as const,
        "Claude Code · connected",
      ],
      [
        [{ provider: "claude_code", state: "installed_signed_out" }] as const,
        "Claude Code · signed out",
      ],
      [
        [{ provider: "claude_code", state: "not_installed" }] as const,
        "Claude Code · not installed",
      ],
      ["unavailable", "Claude Code · connection unavailable"],
    ] as const;

    for (const [entries, expected] of cases) {
      const { unmount } = render(
        <DocumentStatusBar trailingItems={[agentConnectionStatusItem(entries)]} />,
      );
      expect(
        within(screen.getByRole("region", { name: "Document status" })).getByText(expected),
      ).toBeVisible();
      unmount();
    }
  });
});
