// ABOUTME: IPC bridge to backend document/tab commands (§3.1), including the tab writer-lane facade.
// ABOUTME: Document calls stay thin; tab-session ordering/receipts delegate to sessionPersistence.
// ABOUTME: Outside a Tauri webview (dev-mode e2e per D23, tech-design §3.7) the same calls reach
// ABOUTME: the headless test driver's loopback HTTP surface instead — same commands, no mocking.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { callBackend } from "../backend";
import type { Anchor } from "../comments/types";
import type { ProjectFilesError, ProjectFilesSnapshot } from "../stores/project";
import type { ParsedChange } from "./trackedChanges";
import {
  createPersistentWriterId,
  createSessionPersistence,
  type SessionPayload,
  type SessionSavePolicy,
  type TabSessionReceipt,
  type TabSessionSnapshot,
} from "./sessionPersistence";

export type {
  SessionPayload,
  SessionSavePolicy,
  TabPersistenceOutcome,
  TabPersistenceStatus,
  TabSessionReceipt,
  TabSessionSnapshot,
  TabSnapshotPayload,
} from "./sessionPersistence";

/**
 * Mirrors the Rust `commands::document::DocumentPayload` shape (`src-tauri/src/commands/document.rs`)
 * — cross-boundary types are defined in Rust with `Serialize` and mirrored here per CLAUDE.md.
 */
export interface DocumentPayload {
  content: string;
  revision: string;
}

/** Mirrors `commands::document::CommandError` (`#[serde(tag = "kind", content = "message")]`). */
export interface CommandError {
  kind:
    | "InvalidPath"
    | "InvalidDocument"
    | "Io"
    | "WriterBusy"
    | "WriterLost"
    | "RevisionConflict"
    | "UntitledContentOmitted"
    | "History";
  message: string;
}

/**
 * Mirrors `project_files::RecreateCapability` — whether *this exact path* currently has an adapter
 * that can prove transaction-long confinement (TD-18). Advisory only: `recreateMissingDocument`
 * acquires again at invocation, so a capability that disappeared in between returns
 * `confinement_unavailable` there rather than writing anything.
 */
export interface RecreateCapability {
  path: string;
  status: "available" | "confinement_unavailable";
}

/**
 * Mirrors `project_files::RecreateOutcome` (`#[serde(tag = "status", rename_all = "snake_case")]`)
 * — every exit of J2's capability-gated Recreate. `reappeared` carries nothing by design: the
 * backend neither reads nor overwrites a target that came back, leaving the disk side to FR-ED-7's
 * changed-contents flow.
 */
export type RecreateOutcome =
  | {
      status: "created";
      /**
       * The generation the backend's own post-publication refresh produced, or `null` with
       * `refresh_error` set when that refresh failed *after* the file was created. Carried for
       * fidelity with the Rust shape; the rail learns of the restored row from TD-18's automatic
       * announcement (the same route an external creation takes), so nothing here consumes it.
       */
      snapshot: ProjectFilesSnapshot | null;
      refresh_error: ProjectFilesError | null;
    }
  | { status: "reappeared" }
  | { status: "confinement_unavailable" }
  | { status: "failed"; message: string };

/**
 * Loads `path` (relative to project `root`) and returns its exact text and revision. Thin: this
 * function does nothing but shape the backend call — validation, file I/O, and the
 * `textops::Document` wrapping all happen backend-side (§3.1, §3.5).
 */
export async function openDocument(root: string, path: string): Promise<DocumentPayload> {
  return callBackend<DocumentPayload>("open_document", { root, path });
}

/**
 * Writes `content` to `path` (relative to project `root`). The single save path for autosave,
 * manual save, and Save As alike (FR-ED-2) — the CM6 doc string sent straight through with no
 * serializer in between (TD-2). The backend writes it atomically (crash-safe temp+rename) and,
 * when `normalizeLineEndings` is true, collapses CRLF/lone-CR to LF — the one deliberate exception
 * to byte-for-byte fidelity. Pass `false` for a file the user opted out of via the CRLF banner's
 * "Don't convert this file".
 *
 * Resolves with the revision (TD-6 content hash) of the bytes that actually landed — on a
 * normalizing save, the *normalized* text's revision, not the buffer's. This is the same string
 * `openDocument` would return for the file afterwards, so `EditorShell` can re-declare the buffer's
 * revision to the comment-highlight layer without re-opening the document (#1121): a save is the
 * one moment after a load when the buffer provably *is* a named revision again.
 */
export async function saveDocument(
  root: string,
  path: string,
  content: string,
  normalizeLineEndings: boolean,
): Promise<string> {
  return callBackend<string>("save_document", { root, path, content, normalizeLineEndings });
}

/**
 * Writes `content` to `toPath` and carries the document's history (comments, change records, D21
 * protection) from `fromPath` with it — J2 Missing-on-disk `[Save As…]` (FR-ED-2/FR-ED-8, #933).
 * Both paths are project-relative to `root`; the caller is responsible for having refused a
 * destination outside it (`stores/menu.ts`'s `relativeToProjectRoot`), path confinement being
 * re-enforced backend-side regardless.
 *
 * Rejects — having changed nothing — when the destination is a path another tracked document
 * already claims (`History`) or the write itself fails (`Io`). Resolves with the new file's
 * revision, exactly as `saveDocument` does.
 */
export async function saveDocumentAs(
  root: string,
  fromPath: string,
  toPath: string,
  content: string,
  normalizeLineEndings: boolean,
): Promise<string> {
  return callBackend<string>("save_document_as", {
    root,
    fromPath,
    toPath,
    content,
    normalizeLineEndings,
  });
}

/**
 * Whether TD-18 can currently prove transaction-long confinement for `path` — what decides whether
 * J2's `[Recreate]` is offered at all (it is absent on macOS and on any unsupported filesystem).
 * Advisory: the answer can go stale, so invocation re-acquires and can still refuse.
 */
export async function recreateMissingDocumentCapability(path: string): Promise<RecreateCapability> {
  return callBackend<RecreateCapability>("recreate_missing_document_capability", { path });
}

/**
 * Recreates a missing document at its original `path` from the live buffer, under the same
 * confinement the capability query reports (TD-18, #929/#930). The buffer is sent rather than read
 * from disk — there is no file to read — and the backend acquires confinement *before* it touches
 * that content at all.
 *
 * Never rejects for the lifecycle outcomes: capability loss, a reappeared path, and an ordinary
 * write failure all come back as typed `RecreateOutcome` statuses, because each one leaves the
 * buffer and the Missing-on-disk state deliberately intact.
 */
export async function recreateMissingDocument(
  path: string,
  content: string,
  normalizeLineEndings: boolean,
): Promise<RecreateOutcome> {
  return callBackend<RecreateOutcome>("recreate_missing_document", {
    path,
    content,
    normalizeLineEndings,
  });
}

/**
 * Names the document a parse is joined against — mirrors Rust `commands::changes::DocRef`. Both
 * halves or neither: `root` is where `.emend/docs.json` lives (the record set is unreachable
 * without it) and `path` is the document inside it, project-relative, in the same canonical
 * spelling a tab key and `DeliveryNotice.doc` carry.
 */
export interface DocRef {
  root: string;
  path: string;
}

/** Path-independent TD-4 identity for an untitled document. */
export interface DocIdRef {
  root: string;
  docId: string;
}

/**
 * The single authoritative CriticMarkup parse (`commands::changes::parse_changes`) the interactive
 * redline layer seeds its snapshot from (TD-11 corollary). Offsets come back in UTF-16 units **of
 * `content` itself** — so `content` must be the document in CM6 position space
 * (`document.ts`'s `editorOffsetText`), never the line-ending-preserving serialized/disk text, whose
 * indices diverge by one unit per line break on a CRLF file (#447). The frontend never re-parses (it
 * would duplicate the exclusion-zone logic and drift from the engine accept/reject actually runs
 * against).
 *
 * `doc` is what makes the returned identities durable (TD-16 ruling 3): the backend joins each
 * marker to that document's TD-4 attribution records and reports a joined one under its `chg-` id.
 * Pass `null` only for a buffer that genuinely has no document (a scratch/dev-mode parse) — every
 * change then comes back honestly unrecorded, with a snapshot-scoped id that no change-set card can
 * be triaged against.
 */
export async function parseChanges(doc: DocRef | DocIdRef | null, content: string): Promise<ParsedChange[]> {
  if (doc && "docId" in doc) {
    return callBackend<ParsedChange[]>("parse_changes_by_id", {
      root: doc.root,
      docId: doc.docId,
      content,
    });
  }
  return callBackend<ParsedChange[]>("parse_changes", { doc, content });
}

/**
 * Captures a `textops::Anchor` (TD-4's shared anchor shape) at `[utf16Offset, utf16Offset +
 * utf16Length)` of `content` — the quote-bar's selection→anchored-message flow (P2b-7, UX
 * Principle 6, `commands::document::capture_anchor`). `content` is the live editor text (the same
 * "content, not path" shape `parseChanges` uses), so a selection is captured against exactly what
 * the buffer holds right now, dirty or not — and, for the same reason as `parseChanges` above, in
 * CM6 position space (`editorOffsetText`), the space the offsets below are already in (#447).
 * Offsets are CodeMirror's own UTF-16 code-unit space;
 * the backend converts to `textops`' byte-indexed canonical space and builds the anchor itself —
 * this bridge never hand-rolls that arithmetic (CLAUDE.md: anchor construction stays in `textops`).
 */
export async function captureAnchor(
  content: string,
  utf16Offset: number,
  utf16Length: number,
): Promise<Anchor> {
  return callBackend<Anchor>("capture_anchor", { content, utf16Offset, utf16Length });
}

/**
 * Mirrors the Rust `commands::document::AnchorPosition` shape — a resolved anchor's `{from, to}`
 * in CM6's own UTF-16 coordinate space, ready to select/scroll to (`view.dispatch`).
 */
export interface AnchorPosition {
  from: number;
  to: number;
}

/**
 * Resolves `anchor` (as `captureAnchor` minted it) against `content` — the *live* editor text, in
 * the same CM6 position space `captureAnchor`/`parseChanges` already use — to the UTF-16 range
 * CodeMirror can select and scroll to (the quote-bar's deep-link-back half, P2b-7 follow-up #492).
 * `null` when the anchor's recorded text no longer sits there (the document moved on since it was
 * captured): an honest "can't place this" rather than a guess (D17/P2) — never re-indexed or
 * fuzzy-matched here, that arithmetic stays in `textops` (`commands::document::resolve_anchor`).
 */
export async function resolveAnchor(content: string, anchor: Anchor): Promise<AnchorPosition | null> {
  return callBackend<AnchorPosition | null>("resolve_anchor", { content, anchor });
}

/**
 * Persists `session` — `root`'s whole open-tab set, plus which tab was active — as the P2a-6
 * tab-session snapshot (`store::tab_session`, TD §3.1). Thin: the per-tab unsaved-content cap and
 * path confinement are enforced backend-side, not here.
 */
function rendererSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function rendererWindowScope(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "browser";
  }
}

const tabSessionPersistence = createSessionPersistence({
  begin(root, writerId, attachmentId) {
    return callBackend<TabSessionSnapshot>("begin_tab_session", {
      root,
      writerId,
      attachmentId,
    });
  },
  save(root, writerId, attachmentId, expectedRevision, session, policy) {
    return callBackend<TabSessionReceipt>("save_tab_session", {
      root,
      writerId,
      attachmentId,
      expectedRevision,
      session,
      policy,
    });
  },
  prove(root, writerId, attachmentId, expectedRevision, session) {
    return callBackend<TabSessionReceipt>("prove_tab_session", {
      root,
      writerId,
      attachmentId,
      expectedRevision,
      session,
    });
  },
  end(root, writerId, attachmentId) {
    return callBackend<void>("end_tab_session", { root, writerId, attachmentId });
  },
}, createPersistentWriterId(rendererSessionStorage(), undefined, rendererWindowScope()));

/** Acquires this renderer's sole revisioned write lane and returns the durable session. */
export async function beginTabSession(root: string): Promise<SessionPayload> {
  return tabSessionPersistence.begin(root);
}

/** Queues a save behind prior writes and returns the backend's canonical committed receipt. */
export async function saveTabSession(
  root: string,
  session: SessionPayload,
  policy: SessionSavePolicy = "background",
): Promise<TabSessionReceipt> {
  return tabSessionPersistence.save(root, session, policy);
}

/** Queues an authoritative losslessness proof against the current durable snapshot without writing. */
export async function proveTabSession(
  root: string,
  session: SessionPayload,
): Promise<TabSessionReceipt> {
  return tabSessionPersistence.prove(root, session);
}

/** Drains pending writes before releasing this renderer's backend writer authority. */
export async function endTabSession(root: string): Promise<void> {
  return tabSessionPersistence.end(root);
}

/**
 * Loads `root`'s persisted tab session (empty — no tabs, no active path — for a project that has
 * never had one saved).
 */
export async function loadTabSession(root: string): Promise<SessionPayload> {
  return callBackend<SessionPayload>("load_tab_session", { root });
}

/**
 * Replaces the backend watchdog's runtime open-tab source (D21/FR-AGENT-2) and identifies which
 * member is active so the native Save As item follows the document the action would target.
 */
export async function setOpenTabs(
  root: string,
  paths: string[],
  activePath: string | null,
): Promise<void> {
  await callBackend("set_open_tabs", { root, paths, activePath });
}
