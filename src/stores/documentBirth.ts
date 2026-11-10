// ABOUTME: The frontend end of the J2 document-birth pipe (#420) — subscribes to the backend's
// ABOUTME: landed-`create_document` event and maps one notice into the birth card the timeline renders.
import { createDocumentBirthCard, type DocumentBirthCard } from "../timeline/types";
import { listenForBackendEvent } from "./driverEvents";

/**
 * The event a completed `create_document` is announced on — the birth-pipe sibling of
 * `stores/delivery.ts`'s `DELIVERY_EVENT`, namespaced the same way for the same reason.
 */
export const DOCUMENT_BIRTH_EVENT = "emend://agent/document-birth";

/** A completed document birth — mirrors Rust `agent::birth::DocumentBirthNotice`. */
export interface DocumentBirthNotice {
  /** The created document, project-relative — what the app opens as a tab (P2a-6). */
  path: string;
  /** The written content's size in bytes. */
  size: number;
}

/**
 * Subscribes `handler` to every landed `create_document`, returning the unsubscribe function.
 *
 * The shared transport preserves the native Tauri listener and uses D23's cursor-backed event log
 * outside Tauri.
 */
export async function listenForDocumentBirths(
  handler: (notice: DocumentBirthNotice) => void,
): Promise<() => void> {
  return listenForBackendEvent(DOCUMENT_BIRTH_EVENT, handler);
}

export interface DocumentBirthCardOptions {
  id?: string;
  timestamp?: string;
}

/** Builds the timeline card for one document birth — a straight mapping, since (unlike a
 * `propose_changes` delivery) there is no parse/geometry to join against: the notice already
 * carries exactly what the card shows. */
export function documentBirthCardFor(
  notice: DocumentBirthNotice,
  { id, timestamp }: DocumentBirthCardOptions = {},
): DocumentBirthCard {
  return createDocumentBirthCard(notice.path, notice.size, { id, timestamp });
}
