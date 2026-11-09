// ABOUTME: Frontend IPC for the durable omission-aware Save As adoption event lifecycle.
// ABOUTME: Mirrors Rust phases and returns already-persisted D15 projections plus pending paths.

import { callBackend } from "../backend";
import type { TimelineCard, UntitledAdoptionCard } from "../timeline/types";

interface ReconciliationWire {
  published: (UntitledAdoptionCard & { schema_version: number })[];
  pendingDestinations: string[];
  collisions?: AdoptionCollision[];
}

export interface AdoptionCollision {
  destination: string;
  docId: string;
  existingDocId: string;
}

export interface AdoptionReconciliation {
  published: TimelineCard[];
  pendingDestinations: string[];
  collisions: AdoptionCollision[];
}

export interface LandAdoptionReceipt {
  revision: string;
  destination: string;
  pending: boolean;
}

/** Mints an untitled document's path-independent TD-4 identity without creating a path mapping. */
export async function mintUntitledDocId(root: string): Promise<string> {
  return callBackend<string>("mint_untitled_doc_id", { root });
}

export async function prepareAdoption(
  root: string,
  adoptionId: string,
  displacedPath: string,
  destination: string,
  docId: string,
  recoveryContentOmitted: boolean,
  content: string,
  timestamp: string,
): Promise<string> {
  return await callBackend<string>("prepare_adoption", {
    root, adoptionId, displacedPath, destination, docId, recoveryContentOmitted, content, timestamp,
  });
}

export async function commitAdoption(
  root: string,
  adoptionId: string,
  landedRevision: string,
): Promise<void> {
  await callBackend<void>("commit_adoption", { root, adoptionId, landedRevision });
}

/** Atomically revalidates ownership and lands a prepared untitled Save As. */
export async function landAdoption(
  root: string,
  adoptionId: string,
  content: string,
): Promise<LandAdoptionReceipt> {
  return await callBackend<LandAdoptionReceipt>("land_adoption", { root, adoptionId, content });
}

export async function cancelAdoption(root: string, adoptionId: string): Promise<void> {
  await callBackend<void>("cancel_adoption", { root, adoptionId });
}

export async function reconcileAdoptions(root: string): Promise<AdoptionReconciliation> {
  const result = await callBackend<ReconciliationWire>("reconcile_adoptions", { root });
  return {
    pendingDestinations: result.pendingDestinations,
    collisions: result.collisions ?? [],
    published: result.published.map((wire) => {
      const card = { ...wire } as Record<string, unknown>;
      delete card.schema_version;
      return card as unknown as TimelineCard;
    }),
  };
}
