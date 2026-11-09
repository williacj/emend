// ABOUTME: Public surface of the `timeline/` module (§3.1) — the virtualized stream, base card
// ABOUTME: contract, chat-message variant, message input, and facet bar other timeline units build on.
export {
  TimelinePanel,
  type TimelinePanelProps,
  type TimelineRunRevealRequest,
} from "./TimelinePanel";
export { TimelineCard, type TimelineCardProps } from "./TimelineCard";
export { batchChangeSetCardFor, type BatchChangeSetCardOptions } from "./batchChangeSetCard";
export { ChatMessageCard, type ChatMessageCardProps } from "./ChatMessageCard";
export { CommentCard, type CommentCardProps } from "./CommentCard";
export { ChangeSetCard, type ChangeSetCardProps } from "./ChangeSetCard";
export { UntitledAdoptionCard } from "./UntitledAdoptionCard";
export { MessageInput, type MessageInputProps } from "./MessageInput";
export { FacetBar, type FacetBarProps } from "./FacetBar";
export { NewInFacetAffordance, type NewInFacetAffordanceProps } from "./NewInFacetAffordance";
export {
  TimelineHostAction,
  type TimelineHostActionProps,
  type TimelineHostMode,
} from "./TimelineHostAction";
export { ALL_FACET_ID, FACETS, facetForCard, facetJumpIndex, filterCardsByFacet, type Facet } from "./facets";
// FR-CHAT-4's open-document vocabulary (#1724). Declared here because `editor/` produces the
// snapshot this module's agent wire consumes, so it is genuinely part of this module's surface
// rather than an internal of `agentActivity.ts`.
export {
  NO_OPEN_DOCUMENTS,
  NO_OPEN_DOCUMENTS_READER,
  isUnsaved,
  type OpenDocument,
  type OpenDocumentsSnapshot,
  type TurnContext,
} from "./referenceData";
export { VirtualList, type VirtualListProps, type VirtualListScrollRequest } from "./VirtualList";
export {
  computeVisibleRangeFromOffsets,
  computeVisibleRangeVariable,
  cumulativeOffsets,
  totalContentHeightVariable,
  type VisibleRange,
  type VisibleRangeFromOffsetsParams,
  type VisibleRangeVariableParams,
} from "./virtualization";
export {
  COLLAPSED_ITEM_HEIGHT,
  isCardCollapsedByDefault,
  isChangeSetCollapsedByDefault,
  itemHeightFor,
} from "./collapse";
export {
  createChatMessageCard,
  createCommentCard,
  createChangeSetCard,
  type ChangeSetCard as ChangeSetCardData,
  type ChangeSetChange,
  type ChangeSetChangeKind,
  type ChangeSetCommentGroup,
  type ChangeSetDecision,
  type ChangeSetDefense,
  type ChangeSetSeverity,
  type ChatMessageCard as ChatMessageCardData,
  type CommentCard as CommentCardData,
  type CreateChangeSetCardOptions,
  type CreateChatMessageCardOptions,
  type CreateCommentCardOptions,
  type TimelineCard as TimelineCardData,
  type TimelineCardBase,
  type UntitledAdoptionCard as UntitledAdoptionCardData,
} from "./types";
