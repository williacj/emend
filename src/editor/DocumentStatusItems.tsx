// ABOUTME: Pure builders for UXR-Q7.2's document status facts: Markdown/counts on the left and
// ABOUTME: the live Claude Code connection fact on the overflow-aware right cluster.
import type { ProviderStatuses } from "../onboarding/types";
import type { DocumentStatusBarItem, DocumentStatusBarTrailingItem } from "./DocumentStatusBar";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${NUMBER_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

export interface DocumentStatusLeadingFacts {
  wordCount: number;
  trackedChangeCount: number;
  /** `null` means this pane has no comment capability; zero means capable, with none open. */
  openCommentCount: number | null;
  resolvedCommentCount?: number;
  /** Binding authoring-shell 4a/4b mode: comments replace the tracked-change fact. */
  commentMode?: boolean;
  /** Pathless CriticMarkup has no TD-4 record to supply an author (#1804). */
  unattributedChanges?: boolean;
}

/** Builds the left cluster in its binding order, omitting conditional facts at zero. */
export function documentStatusLeadingItems({
  wordCount,
  trackedChangeCount,
  openCommentCount,
  resolvedCommentCount = 0,
  commentMode = false,
  unattributedChanges = false,
}: DocumentStatusLeadingFacts): DocumentStatusBarItem[] {
  const items: DocumentStatusBarItem[] = [
    { id: "document-kind", content: "Markdown" },
    { id: "word-count", content: countLabel(wordCount, "word") },
  ];
  if (!commentMode && trackedChangeCount > 0) {
    const count = countLabel(trackedChangeCount, "tracked change");
    items.push({
      id: "tracked-change-count",
      accessibleLabel: unattributedChanges ? `${count} · no author recorded` : count,
      content: unattributedChanges ? (
        <span>
          {count}
          <span className="document-status-unattributed"> · no author recorded</span>
        </span>
      ) : (
        count
      ),
    });
  }
  if (openCommentCount !== null && openCommentCount > 0) {
    items.push({
      id: "open-comment-count",
      content: countLabel(openCommentCount, "open comment"),
    });
  }
  if (commentMode && openCommentCount !== null && resolvedCommentCount > 0) {
    items.push({
      id: "resolved-comment-count",
      content: countLabel(resolvedCommentCount, "resolved", "resolved"),
    });
  }
  return items;
}

function claudeConnectionLabel(entries: ProviderStatuses): string {
  if (entries === null) return "Claude Code · checking connection";
  if (entries === "unavailable") return "Claude Code · connection unavailable";
  const claude = entries.find((entry) => entry.provider === "claude_code");
  if (!claude || claude.state === "not_installed") return "Claude Code · not installed";
  if (claude.state === "installed_signed_out") return "Claude Code · signed out";
  return "Claude Code · connected";
}

/**
 * The production run adapter is Claude Code today, so this reports that actual connection rather
 * than implying that a detected but not-yet-wired Copilot CLI can serve the current conversation.
 */
export function agentConnectionStatusItem(
  entries: ProviderStatuses,
): DocumentStatusBarTrailingItem {
  const label = claudeConnectionLabel(entries);
  return {
    id: "agent-connection",
    content: <span className="document-agent-connection">{label}</span>,
    overflowEntries: [
      {
        id: "agent-connection",
        label,
        disabled: true,
      },
    ],
  };
}
