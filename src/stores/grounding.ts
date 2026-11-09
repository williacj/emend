// ABOUTME: The frontend end of the J8 Screen 2 grounding pipe (P2b-8b, #360) — calls the backend's
// ABOUTME: `discover_grounding` once per project open and maps the result into the project card.
import { callBackend } from "../backend";
import { createProjectGroundingCard, type ProjectGroundingCard } from "../timeline/types";
import type { CreateProjectGroundingCardOptions, GroundingSkill, GroundingWorkflow } from "../timeline/types";

/**
 * Mirrors Rust `commands::skills::GroundingPayload` (`#[serde(rename_all = "camelCase")]`) —
 * cross-boundary types are defined in Rust with `Serialize` and mirrored here per CLAUDE.md.
 * `instructionFile` is `null` (not omitted) over the wire, since Rust's `Option<String>` always
 * serializes a JSON key.
 */
export interface GroundingPayload {
  skills: (GroundingSkill & { path: string })[];
  workflows: (GroundingWorkflow & { path: string })[];
  instructionFile: string | null;
}

/**
 * The project card's one call on project open (J8 Screen 2, FR-SKILL-1): discovered skills/
 * workflows plus the repo instruction file, if any. Outside a Tauri webview this reaches the D23
 * headless test driver's loopback surface instead — same command, no mocking (`backend.ts`).
 */
export async function discoverGrounding(root: string): Promise<GroundingPayload> {
  return callBackend<GroundingPayload>("discover_grounding", { root });
}

/** Builds the timeline card for one `discover_grounding` result — a straight mapping, `null` →
 * `undefined` for the optional instruction file (the only shape difference between the wire
 * payload and `ProjectGroundingCard`). */
export function groundingCardFor(
  payload: GroundingPayload,
  options?: CreateProjectGroundingCardOptions,
): ProjectGroundingCard {
  return createProjectGroundingCard(
    payload.skills.map(({ name, description }) => ({ name, description })),
    payload.workflows.map(({ name }) => ({ name })),
    payload.instructionFile ?? undefined,
    options,
  );
}
