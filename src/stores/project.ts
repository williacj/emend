// ABOUTME: Thin frontend mirrors for TD-20 project routing and TD-17's direct D23 construction seam.
// ABOUTME: Also subscribes to routing and TD-18 project-files announcements without owning policy.
import { callBackend } from "../backend";
import { listenForBackendEvent } from "./driverEvents";

/** Mirrors the document command's FR-ED-9 extension gate for UI projection only. The backend
 * remains authoritative when a path is opened or written. */
export function isSupportedDocumentPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf("/") + 1).split(".").pop()?.toLowerCase() ?? "";
  return ["md", "markdown", "mdown", "mkd", "mkdn", "txt"].includes(extension);
}

/**
 * Directly constructs `root` as the backend's project (TD-17). Product folder choices do not call
 * this seam: TD-20's `routeProjectOpen` owns adoption / stay / focus / launch and never replaces a
 * choosing instance. This direct command remains for startup and the D23 test fixture, where it
 * binds the project's TD-1 MCP server before a scripted document/run action.
 *
 * Outside a Tauri webview this reaches the D23 headless test driver's loopback surface instead —
 * same command, no mocking (`backend.ts`).
 */
export async function openProject(root: string): Promise<void> {
  return callBackend<void>("open_project", { root });
}

/** Why TD-20 could not complete a project route — mirrors Rust `instances::RouteFailure`. */
export type ProjectRouteFailure =
  | "project_unavailable"
  | "open_failed"
  | "deadline_expired"
  | "registry_unavailable"
  | "launch_failed"
  | "owner_unavailable"
  | "activation_refused";

/** Which TD-20 route was in flight when a failed outcome became terminal (J9, #1752). */
export type ProjectFailureRoute = "undetermined" | "raise" | "launch";

/** The choosing instance's terminal J9 result — mirrors Rust `ProjectRouteOutcome`. */
export type ProjectRouteOutcome =
  | { status: "adopted_here"; root: string }
  | { status: "already_open_here"; root: string }
  | { status: "focused_other"; root: string }
  | { status: "opened_new"; root: string }
  | {
      status: "failed";
      root: string;
      reason: ProjectRouteFailure;
      failureRoute: ProjectFailureRoute;
    };

/** Routes a user project choice without giving the frontend ownership or ordering policy (TD-20). */
export async function routeProjectOpen(root: string): Promise<ProjectRouteOutcome> {
  return callBackend<ProjectRouteOutcome>("route_project_open", { root });
}

export const PROJECT_ROUTING_EVENT = "emend://project/routing";

/** One backend-ordered routing transition; the App status layer is display only (TD-20(9)). */
export type ProjectRoutingNotice =
  | { status: "requesting"; request_id: string; root: string; queued: number }
  | { status: "finished"; request_id: string; outcome: ProjectRouteOutcome };

export async function listenForProjectRouting(
  handler: (notice: ProjectRoutingNotice) => void,
): Promise<() => void> {
  return listenForBackendEvent(PROJECT_ROUTING_EVENT, handler);
}

/** The backend-owned project adopted during hidden startup routing, or `null` on a cold start. */
export async function currentProject(): Promise<string | null> {
  return callBackend<string | null>("current_project", {});
}

/**
 * Closes the backend's open project while no run is active: its MCP server is unbound and its
 * per-session bearer token stops being honored (FR-X-2). A live run refuses close; a no-op when
 * nothing is open.
 */
export async function closeProject(): Promise<void> {
  return callBackend<void>("close_project", {});
}

/**
 * The event TD-18's automatic project-files refresh is announced on — the sibling of
 * `stores/delivery.ts`'s `DELIVERY_EVENT`, namespaced the same way. The D23 event envelope carries
 * Rust `commands::project::PROJECT_FILES_EVENT` and this listener rejects any other name, so the
 * browser acceptance edge mechanically binds the two spellings.
 */
export const PROJECT_FILES_EVENT = "emend://project/files";

/** What a project row's filesystem shape is — mirrors Rust `project_files::EntryKind`. */
export type ProjectFileEntryKind =
  "directory" | "file" | "symlink" | "other" | "unknown";

/** Why a row is present but cannot be trusted — mirrors Rust `ProjectFileWarning`. */
export interface ProjectFileWarning {
  kind: "unreadable";
  message: string;
}

/** One hierarchical user-visible row — mirrors Rust `project_files::ProjectFileEntry`. Native
 * identity is backend-only evidence and deliberately never crosses this boundary. */
export interface ProjectFileEntry {
  path: string;
  name: string;
  kind: ProjectFileEntryKind;
  children: ProjectFileEntry[];
  warning: ProjectFileWarning | null;
}

/** One confidently correlated path transition — mirrors Rust `project_files::ProjectFileMove`. */
export interface ProjectFileMove {
  old_path: string;
  new_path: string;
  kind: ProjectFileEntryKind;
}

/** A completed immutable generation — mirrors Rust `project_files::ProjectFilesSnapshot`. */
export interface ProjectFilesSnapshot {
  generation: number;
  entries: ProjectFileEntry[];
  moves: ProjectFileMove[];
}

/** A refresh-level failure — mirrors Rust `project_files::ProjectFilesError`. */
export interface ProjectFilesError {
  kind: "ProjectUnavailable" | "UpdateFailed";
  message: string;
}

/**
 * Whether TD-18's backend visibility rule permits `path` to appear in a completed snapshot.
 * Hidden names stay backend-owned: the frontend asks this question instead of mirroring them.
 */
export async function isProjectPathEnumerable(path: string): Promise<boolean> {
  return callBackend<boolean>("project_path_is_enumerable", { path });
}

/**
 * One automatic-refresh transition — mirrors Rust `project_files::ProjectFilesRefreshNotice`.
 *
 * The backend stays the authority throughout: `completed` carries the whole completed generation
 * (nothing is merged client-side), and `failed` means the *previous* completed snapshot is still the
 * one to show — J2's `Update failed`, never an emptied tree.
 */
export type ProjectFilesRefreshNotice =
  | { status: "started" }
  | { status: "completed"; snapshot: ProjectFilesSnapshot }
  | { status: "failed"; error: ProjectFilesError };

/** One event drained from D23's backend-owned announcement queue. Both fields originate in Rust:
 * the name is `commands::project::PROJECT_FILES_EVENT`, and the payload is the same
 * `ProjectFilesRefreshNotice` value the Tauri emitter serializes. */
/**
 * Where `path` ended up, or `null` when the backend proved no move for that exact path (#932).
 *
 * Deliberately an **exact** lookup, never a prefix one: TD-18 emits a directory's move *and* a
 * separate move for each descendant whose own identity it could independently prove, precisely so
 * an ambiguous descendant degrades on its own. A descendant with no move of its own therefore has
 * not been shown to be the same document, and following its parent's move here would manufacture
 * the correlation the backend refused to make — the wrong document's history, tab, and active
 * marker would follow. That degrade is the dependent Missing-on-disk lifecycle's to handle.
 *
 * This is what document *identity* follows. Use `movedSubtreePath` for view state, which has no
 * identity claim to get wrong.
 */
export function movedPath(path: string, moves: readonly ProjectFileMove[]): string | null {
  return moves.find((move) => move.old_path === path)?.new_path ?? null;
}

/**
 * Where `path`'s *position in the tree* ended up: its own proven move, or its position under the
 * nearest proven **directory** move above it — `null` when neither applies.
 *
 * Only for view state that makes no claim about identity (J2's folder expansion): a row under a
 * moved folder is rendered at the new prefix by the very next completed generation whether or not
 * its own identity was provable, so carrying "this folder was open" across is honest. The nearest
 * (longest) matching ancestor wins, so a subtree moved out of a folder that also moved follows the
 * move that actually holds it.
 */
export function movedSubtreePath(
  path: string,
  moves: readonly ProjectFileMove[],
): string | null {
  const own = movedPath(path, moves);
  if (own !== null) return own;
  let nearest: ProjectFileMove | null = null;
  for (const move of moves) {
    if (move.kind !== "directory" || !path.startsWith(`${move.old_path}/`)) continue;
    if (nearest === null || move.old_path.length > nearest.old_path.length) nearest = move;
  }
  return nearest === null ? null : nearest.new_path + path.slice(nearest.old_path.length);
}

/**
 * Every path a completed generation lists as something other than a folder — the set an open
 * document's path must be in for that document to still have a file (J2 Missing on disk, #933).
 *
 * Directories are excluded because a path that is now a folder is a path this document no longer
 * has: it cannot be opened, saved, or recreated there. Everything else counts as present, including
 * an `unreadable`-warned row and a non-Markdown one — the question here is only whether the path is
 * still occupied by this document's file, which the rail's own warning and openability rules answer
 * separately. Absence is therefore evidence from the backend's completed enumeration rather than a
 * failed read, which is what makes it safe to act on (a transient read failure is not a deletion).
 */
export function presentFilePaths(entries: readonly ProjectFileEntry[]): Set<string> {
  const paths = new Set<string>();
  const walk = (rows: readonly ProjectFileEntry[]) => {
    for (const row of rows) {
      if (row.kind === "directory") walk(row.children);
      else paths.add(row.path);
    }
  };
  walk(entries);
  return paths;
}

/**
 * Every row a completed generation listed without enumerating what is beneath it — the prefixes
 * under which absence proves nothing (J2 Missing on disk, #933).
 *
 * A completed generation is deliberately not an exhaustive listing of the project. The backend
 * descends exactly one kind of row (`project_files::scan_directory`): a directory it could read.
 * A directory whose `read_dir` failed is still published — present, carrying its typed
 * `unreadable` warning, with no children — and a `symlink`, `other`, or `unknown` row (the last is
 * one whose metadata could not be read at all, so its shape is not even known) is listed as
 * context and never walked. Any of those can still hold an open document's file, so a document
 * beneath one is *unenumerated*, not proved missing, and `missingTabPaths` must not claim it is.
 *
 * A `file` row is not here: nothing can live beneath a file, so its empty children are proof
 * rather than ignorance — including an unreadable one, whose warning is about opening it, not
 * about listing it. Nor is a *deleted* directory, which is absent from the generation altogether:
 * that absence is exactly the evidence the documents under it really are gone, which is why this
 * is a set of listed rows rather than "every ancestor the generation did not list".
 *
 * A hidden tooling component produces no row at all, so this set cannot name it. The tab layer asks
 * the backend's `isProjectPathEnumerable` before treating an otherwise absent path as deleted.
 */
export function undescendedPaths(entries: readonly ProjectFileEntry[]): Set<string> {
  const paths = new Set<string>();
  const walk = (rows: readonly ProjectFileEntry[]) => {
    for (const row of rows) {
      if (row.kind === "directory") {
        if (row.warning === null) walk(row.children);
        else paths.add(row.path);
      } else if (row.kind !== "file") {
        paths.add(row.path);
      }
    }
  };
  walk(entries);
  return paths;
}

/**
 * Every ancestor folder path of `path`, outermost first — the rows J2 must have expanded for
 * `path`'s own row to be reachable. Paths are project-root-relative and `/`-separated on both
 * shipped platforms (the backend builds them, `project_files::ProjectFileEntry`).
 */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const ancestors: string[] = [];
  for (const segment of segments) {
    ancestors.push(ancestors.length === 0 ? segment : `${ancestors[ancestors.length - 1]}/${segment}`);
  }
  return ancestors;
}

/**
 * Subscribes `handler` to every automatic project-files refresh transition, returning the
 * unsubscribe function. Refreshes are scheduled by the backend from its own native watch (TD-18);
 * this is a notification channel only, never a request for one.
 *
 * Outside a Tauri webview, D23 polls the driver's backend-owned event queue. That substitutes only
 * the cadence/transport: the real native watcher produces each notice, and this same production
 * handler consumes it (test-plan §7b).
 *
 * `ProjectRail` is the app's sole consumer (#932): it owns the displayed generation and funnels
 * each one's `moves` on to the tab layer, so every completed generation — automatic or explicitly
 * refreshed — reaches document identity through exactly one path.
 */
export async function listenForProjectFilesRefreshes(
  handler: (notice: ProjectFilesRefreshNotice) => void,
): Promise<() => void> {
  return listenForBackendEvent(PROJECT_FILES_EVENT, handler);
}
