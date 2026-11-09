// ABOUTME: Public surface of the `editor/` module (§3.1) — the CM6 shell, the P2a-6 tab layer
// ABOUTME: built on it, the pure document-state/autosave/IPC helpers, and (P2a-3+) the structural
// ABOUTME: markdown decoration providers later cards build on, plus (P2b-4a) the comment-anchor
// ABOUTME: highlight layer #259's editor-anchored popover installs and (P2b-4b) the severity margin
// ABOUTME: marks built on it.
export { EditorShell, type EditorShellHandle, type EditorShellProps } from "./EditorShell";
export {
  DocumentSurface,
  type DocumentSurfaceHandle,
  type DocumentSurfaceMountOptions,
  type DocumentSurfaceProps,
} from "./DocumentSurface";
export {
  TabbedEditor,
  type RunActiveCloseRefusal,
  type TabbedEditorHandle,
  type TabbedEditorProps,
} from "./TabbedEditor";
export { TabBar, type TabBarProps } from "./TabBar";
export { DirtyCloseGuard, type DirtyCloseGuardProps } from "./DirtyCloseGuard";
export { createDocumentState, hasNonLfLineEndings, serializeDocumentState } from "./document";
export {
  createAutosaveScheduler,
  createSaveRunner,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  type AutosaveScheduler,
} from "./autosave";
export {
  openDocument,
  saveDocument,
  saveTabSession,
  loadTabSession,
  type DocumentPayload,
  type SessionPayload,
  type TabSnapshotPayload,
} from "./ipc";
export { headingHighlightStyle, markdownLanguage } from "./markdownLanguage";
export {
  commentAnchors,
  commentAnchorsField,
  commentHighlightExtensions,
  commentHighlightsPlugin,
  documentRevisionField,
  setCommentThreads,
  setDocumentRevision,
  severityByThreadField,
  severityOf,
  type CommentAnchor,
  type CommentThreadSeed,
} from "./commentHighlights";
export { buildSeverityMarkers, severityMarginMarks } from "./severityMarginMarks";
export { CommentPopover, type CommentPopoverProps, type CommentPopoverTarget } from "./CommentPopover";
export { CommentTrigger, type CommentTriggerProps } from "./CommentTrigger";
export {
  buildSpellcheckSuppression,
  spellcheckExtensions,
  spellcheckSuppressionPlugin,
} from "./spellcheck";
export {
  buildAtomicMarkupRanges,
  buildStructuralDecorations,
  revealAtCursorEnabledField,
  setRevealAtCursorEnabled,
  structuralDecorationsPlugin,
  structuralMarkdownExtensions,
} from "./structuralDecorations";
