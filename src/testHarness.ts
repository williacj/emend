// ABOUTME: Dev-only e2e hooks (D23, tech-design §3.7) for app mode, project, and document edges
// ABOUTME: that a browser script cannot reach through native Tauri entry points.
// ABOUTME: Only wired when `import.meta.env.DEV` is true, so it never ships in a production build.

/**
 * One `openProject` call, turned into a request `TabbedEditor` processes exactly once. `id` is
 * what makes repeated identical-looking calls (e.g. re-opening the same path) distinguishable as
 * *separate* requests; `App` retains them in order until `TabbedEditor` acknowledges each one, so
 * React batching cannot replace an unconsumed call with a later one (#1486).
 */
export interface OpenRequest {
  root: string;
  path: string | null;
  id: number;
}

/**
 * `App` registers its setters here on mount; the dev-only `window.__COWRITE_E2E__` global below
 * calls through them. Indirection (rather than reading `window` from `App` directly) keeps this
 * module the single place that knows about the global, and keeps `App` test-hook-agnostic.
 *
 * `setAutosaveIntervalMs` is the injectable-clock seam for autosave (test-plan §7): an e2e that
 * asserts a tab stays dirty/unsaved across a multi-step interaction sets a large interval first so
 * the always-on autosave provably can't fire mid-scenario, instead of racing the 1 s default.
 *
 * `setExternalChangePollMs` is the same seam for the FR-ED-7 external-change poll: a scenario that
 * needs the banner to appear (a delivery landing on disk under a dirty tab, then Reload) drives the
 * poll small so it resolves on a condition rather than waiting out the 5 s default.
 *
 * `setCommentNowMs` is the same seam for comment-thread event timestamps (P2b-11c): every
 * create/reply/resolve/reopen/re-anchor/address-with-AI/re-delegate/decide-linked-changes call the
 * comment surfaces make stamps its event with `Date.now()` by default — indistinguishable, from an
 * e2e script's own process, from the *real* wall clock it would otherwise have to race to keep a
 * script-driven "the agent's delivery landed after the click" ordering correct under
 * `store::comments`'s causal `(timestamp, id)` fold (test-plan P5). Setting a fixed value here lets
 * a script own that whole timeline itself instead.
 *
 * `openProjectFolder` is the J2/P2b-6b sibling of `openProject` above: it drives the *same*
 * project-open transition a real "Open a folder…" click does (`App.openProjectRoot`, tab-session
 * restore included) rather than `openProject`'s direct D23 construction seam. `openProject` may
 * omit a path only when a test needs a backend-bound workshop shell without exercising J9; product
 * choices always use `openProjectFolder` and its route IPC.
 *
 * `showReviewerWorkspace` is #1515's boundary-only stand-in for the P4-9/P4-10 review-opening
 * route that does not exist yet. It selects reviewer mode at the root composition edge so the
 * browser acceptance can prove J2's entire author workspace is unmounted there; it supplies no
 * reviewer data or behavior of its own.
 *
 * `triggerRenderFailure` is TD-28's prescribed D23 fault injector: it stands in only for the
 * JavaScript runtime delivering a synchronous exception while React renders. The production
 * boundary, capture, diagnostic, fallback, and remount participants remain unchanged.
 *
 * `setNextSaveAsDialogResult` substitutes only the native OS save panel that Playwright's plain
 * Chromium process cannot drive (test-plan §7b's explicit native-dialog exemption). The next real
 * `[Save As…]` click consumes the absolute chosen path, or `null` for Cancel; every in-process
 * participant after that boundary — project confinement, TD-4 history move, atomic write, tab/rail
 * transition, and resumed autosave — stays production code. With no queued result, even a dev
 * Tauri window falls through to the real native panel rather than changing developer behavior.
 *
 * `requestCoordinatedClose` crosses only the native-close entry boundary in a D23 browser. It
 * invokes the mounted editor's existing close coordinator so a visual capture can hold its real
 * terminal session operation and inspect J12's transient freeze without closing an OS window.
 */
export const testHarness: {
  openProject: ((root: string, path: string | null) => Promise<void>) | null;
  openProjectFolder: ((root: string) => Promise<void>) | null;
  setAutosaveIntervalMs: ((ms: number) => void) | null;
  setExternalChangePollMs: ((ms: number) => void) | null;
  setCommentNowMs: ((ms: number) => void) | null;
  showReviewerWorkspace: (() => void) | null;
  triggerRenderFailure: (() => void) | null;
  setNextOpenDocumentDialogResult: ((path: string | null) => void) | null;
  setNextSaveAsDialogResult: ((path: string | null) => void) | null;
  requestCoordinatedClose: (() => void) | null;
} = {
  openProject: null,
  openProjectFolder: null,
  setAutosaveIntervalMs: null,
  setExternalChangePollMs: null,
  setCommentNowMs: null,
  showReviewerWorkspace: null,
  triggerRenderFailure: null,
  setNextOpenDocumentDialogResult: null,
  setNextSaveAsDialogResult: null,
  requestCoordinatedClose: null,
};

declare global {
  interface Window {
    __COWRITE_E2E__?: {
      openProject: (root: string, path: string | null) => Promise<void>;
      openProjectFolder: (root: string) => Promise<void>;
      setAutosaveIntervalMs: (ms: number) => void;
      setExternalChangePollMs: (ms: number) => void;
      setCommentNowMs: (ms: number) => void;
      showReviewerWorkspace: () => void;
      triggerRenderFailure: () => void;
      setNextOpenDocumentDialogResult: (path: string | null) => void;
      setNextSaveAsDialogResult: (path: string | null) => void;
      requestCoordinatedClose: () => void;
    };
  }
}

if (import.meta.env.DEV) {
  window.__COWRITE_E2E__ = {
    // Both project-open hooks resolve only once the backend has bound the project's MCP server
    // (TD-17, #472) — `page.evaluate` awaits the returned promise, so a script that starts a run
    // straight after opening cannot race the bind.
    // @anchor:test-plan-open-project
    openProject: async (root, path) => {
      await testHarness.openProject?.(root, path);
    },
    // @anchor:test-plan-open-project-folder
    openProjectFolder: async (root) => {
      await testHarness.openProjectFolder?.(root);
    },
    // @anchor:test-plan-set-autosave-interval-ms
    setAutosaveIntervalMs: (ms) => testHarness.setAutosaveIntervalMs?.(ms),
    // @anchor:test-plan-set-external-change-poll-ms
    setExternalChangePollMs: (ms) => testHarness.setExternalChangePollMs?.(ms),
    // @anchor:test-plan-set-comment-now-ms
    setCommentNowMs: (ms) => testHarness.setCommentNowMs?.(ms),
    showReviewerWorkspace: () => testHarness.showReviewerWorkspace?.(),
    triggerRenderFailure: () => testHarness.triggerRenderFailure?.(),
    setNextOpenDocumentDialogResult: (path) => testHarness.setNextOpenDocumentDialogResult?.(path),
    setNextSaveAsDialogResult: (path) => testHarness.setNextSaveAsDialogResult?.(path),
    requestCoordinatedClose: () => testHarness.requestCoordinatedClose?.(),
  };
}
