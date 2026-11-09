// ABOUTME: Public surface of the `comments/` module (P2a-18) — thread types/state derivation, the
// ABOUTME: create composer, the thread card, and the backend IPC bridge other units build on.
export { CommentComposer, type CommentComposerProps, type CommentComposerSelection } from "./CommentComposer";
export {
  CommentThreadCard,
  type CommentThreadCardProps,
  type PendingReAnchorSelection,
} from "./CommentThreadCard";
export { BatchAddressTrigger, type BatchAddressTriggerProps } from "./BatchAddressTrigger";
export { BatchAddressStatus, type BatchAddressStatusProps } from "./BatchAddressStatus";
export {
  HUMAN_SOURCE,
  NO_BATCH_FILTER,
  canBatchAddress,
  openThreads,
  reviewPassesIn,
  selectBatchTargets,
  severityRank,
  sourcesIn,
  type BatchAddressFilter,
} from "./batchAddress";
export {
  commentCounts,
  deriveLadderRung,
  deriveThreadState,
  isHeldByRun,
  isThreadCollapsedByDefault,
  unrunBatch,
  type AcknowledgmentRung,
  type Anchor,
  type BatchAddressOutcome,
  type CommentReply,
  type CommentThread,
  type CommentDocumentOwner,
  type ThreadState,
} from "./types";
export {
  loadCommentThreads,
  createComment,
  replyToComment,
  reviseComment,
  withdrawComment,
  resolveComment,
  reopenComment,
  reAnchorComment,
  addressAllWithAI,
  type AnchorRange,
} from "./ipc";
