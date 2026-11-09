// ABOUTME: The rail's call into TD-18's one backend refresh seam (first load and explicit refresh).
// ABOUTME: Snapshot/error shapes are re-exported from `stores/project`, the single mirror of Rust.
import { callBackend } from "../backend";

// One mirror of the Rust types, not two. `stores/project.ts` already defines them beside the
// automatic-refresh notice that carries the very same snapshot (#928), and the rail's own copy had
// already drifted — it predated `ProjectFilesSnapshot.moves`, which this card's path transitions
// are built on. Re-exported here so the rail module's public surface (`index.ts`) is unchanged.
export type {
  ProjectFileEntry,
  ProjectFileEntryKind,
  ProjectFileMove,
  ProjectFilesError,
  ProjectFilesSnapshot,
  ProjectFileWarning,
} from "../stores/project";

import type { ProjectFilesSnapshot } from "../stores/project";

/** Returns one complete generation. Failure leaves the backend's last completed snapshot intact. */
export async function refreshProjectFiles(): Promise<ProjectFilesSnapshot> {
  return callBackend<ProjectFilesSnapshot>("refresh_project_files", {});
}
