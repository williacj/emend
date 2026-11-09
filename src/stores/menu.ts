// ABOUTME: Frontend bridges for native File menu Open…/Save As… requests and their document
// ABOUTME: pickers, including project-relative path confinement for chosen native paths.
import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listenForBackendEvent } from "./driverEvents";

/**
 * The event `src-tauri/src/menu.rs`'s `notify_open_document_requested` emits when `File > Open…`
 * fires — carries no payload (see that constant's own doc for why the picker itself stays here on
 * the frontend rather than in the Rust handler).
 */
export const OPEN_DOCUMENT_MENU_EVENT = "cowrite://menu/open-document";
export const SAVE_DOCUMENT_AS_MENU_EVENT = "cowrite://menu/save-document-as";

/**
 * Subscribes `handler` to every `File > Open…` menu fire, returning the unsubscribe function.
 *
 * The shared transport preserves the native Tauri listener and uses D23's cursor-backed event log
 * outside Tauri.
 */
export async function listenForOpenDocumentRequests(
  handler: (notice: undefined) => void,
): Promise<() => void> {
  return listenForBackendEvent(OPEN_DOCUMENT_MENU_EVENT, () => handler(undefined));
}

/** Subscribes to the general `File > Save As…` request. The handler deliberately receives no
 * path: the active editor owns the suggested path and raises the existing native save panel. */
export async function listenForSaveDocumentAsRequests(
  handler: (notice: undefined) => void,
): Promise<() => void> {
  return listenForBackendEvent(SAVE_DOCUMENT_AS_MENU_EVENT, () => handler(undefined));
}

/**
 * Opens the native OS file picker (markdown filter), starting it in the open project's `root` —
 * without this the dialog opens wherever the OS last left the app (Documents/home on first run),
 * inviting a pick the caller's own `relativeToProjectRoot` then silently refuses (review of PR
 * #718, Important: pointing the picker at `root` is what makes the hard "outside root is refused"
 * rule livable rather than a trap for a directory the app never suggested). Resolves the chosen
 * absolute path, or `null` if the user cancelled. Tauri-only, mirroring `pickProjectFolder`'s
 * identical reasoning: outside a webview (dev-mode e2e, D23) there is no native dialog to drive,
 * so this resolves `null` there too — e2e drives `window.__EMEND_E2E__.openProject` directly
 * instead.
 */
// @anchor:test-plan-pick-document-file
export async function pickDocumentFile(root: string): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    defaultPath: root,
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Opens the native OS save panel for `suggestedPath`, started in the open project's `root` — the
 * picker behind J2's Missing-on-disk `[Save As…]` (#933) and the sibling of `pickDocumentFile`
 * above, pointed at the same place for the same reason: the caller refuses any path outside the
 * project (`relativeToProjectRoot`), so suggesting one would be a trap. Resolves the chosen
 * absolute path, or `null` if the user cancelled — the case that must change nothing at all.
 *
 * For a missing document, `suggestedPath` is its original project-relative path. That preserves
 * the familiar name and location, but J2 still makes the destination user-chosen through the
 * native panel. TD-18's confinement gate instead governs Emend's direct `[Recreate]` command;
 * keeping those two interaction boundaries distinct is the constitution-grounded implementation
 * recommendation recorded by #1445, not an additional Recreate capability.
 *
 * Tauri-only, mirroring `pickDocumentFile`'s identical degrade: outside a webview (dev-mode e2e,
 * D23) there is no native dialog, so this resolves `null` and an e2e script drives the save path it
 * wants directly.
 */
// @anchor:test-plan-pick-save-as-path
export async function pickSaveAsPath(root: string, suggestedPath: string): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save({
    defaultPath: absoluteInRoot(root, suggestedPath),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * The filename component of a project-relative path — `"drafts/b.md"` → `"b.md"`. Used to seed
 * `pickSaveAsPath` for an untitled document's `[Save As…]` (D12, FR-ED-8, #1379): that pane's
 * `displacedPath` names the path a *different*, currently-open document now occupies (that is
 * exactly why the buffer is untitled), so seeding the panel with the full path would default to
 * overwriting that other document. The bare filename is still a useful hint — it drops the
 * caller's own directory context, landing the picker at the project root, rather than pre-filling
 * the one full path guaranteed to collide.
 */
export function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** `root` joined with a project-relative path in its platform's separator spelling — the inverse
 * of `relativeToProjectRoot` below. A drive-letter or UNC prefix identifies Windows syntax; a
 * backslash anywhere else may be a legal character in a Unix folder name (#1445). */
function absoluteInRoot(root: string, relativePath: string): string {
  const isWindowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root);
  const separator = isWindowsPath ? "\\" : "/";
  const normalizedRoot = isWindowsPath ? root.replace(/[\\/]+$/, "") : root.replace(/\/+$/, "");
  return `${normalizedRoot}${separator}${relativePath.split("/").join(separator)}`;
}

/**
 * Converts an absolute path the native picker returned into the project-relative spelling every
 * other open route already produces (`OpenRequest.path`, P2a-6). `null` when `absolutePath` does
 * not live under `root` at all — refused rather than opened, since sidecar identity is
 * project-root-relative (`store::service::tracked_paths`): a document outside the root has no
 * sidecar of its own to attach to, and opening it under a path that later fails path confinement
 * (`commands::path_confine::confine`) would be a worse failure mode than a quiet no-op. This
 * mirrors the "refuse honestly rather than act on an out-of-bounds request" precedent `App`'s own
 * `handleChangeSetDecide`/`handleFocusQuote` already use for an equally out-of-bounds routing
 * decision (#697 acceptance).
 */
export function relativeToProjectRoot(root: string, absolutePath: string): string | null {
  // After startup hydration Rust can report a canonical Windows `\\?\C:\...` (or
  // `\\?\UNC\...`) root while the native picker returns the ordinary spelling of the same
  // path. Compare those two admitted absolute forms case-insensitively, then return the picker's
  // relative suffix. The backend still owns the final filesystem confinement decision.
  const windowsPath = (path: string): string | null => {
    const slashes = path.replace(/\//g, "\\");
    const lower = slashes.toLowerCase();
    const plain = lower.startsWith("\\\\?\\unc\\")
      ? `\\\\${slashes.slice(8)}`
      : slashes.startsWith("\\\\?\\")
        ? slashes.slice(4)
        : slashes;
    return /^[A-Za-z]:\\/.test(plain) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(plain)
      ? plain
      : null;
  };
  const windowsRoot = windowsPath(root);
  const windowsPick = windowsPath(absolutePath);
  if (windowsRoot !== null && windowsPick !== null) {
    const prefix = `${windowsRoot.replace(/\\+$/, "")}\\`;
    return windowsPick.toLowerCase().startsWith(prefix.toLowerCase())
      ? windowsPick.slice(prefix.length).replace(/\\/g, "/")
      : null;
  }
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  // Either separator, whichever the OS that produced both paths actually used — a bare equality
  // (the root chosen back as a "file") matches neither prefix below and falls through to `null`.
  for (const separator of ["/", "\\"]) {
    const prefix = `${normalizedRoot}${separator}`;
    if (absolutePath.startsWith(prefix)) {
      return absolutePath.slice(prefix.length).replace(/\\/g, "/");
    }
  }
  return null;
}
