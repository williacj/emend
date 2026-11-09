// ABOUTME: The one cancellation dance every backend push pipe's mount effect uses (deliveries,
// ABOUTME: document births, native File menu signals, and TD-18 project-files refreshes).

/**
 * Subscribes `handler` through `listen` (the `listenForDeliveries`/`listenForDocumentBirths`/
 * `listenForProjectFilesRefreshes`/native File menu shape: async "subscribe, get back an
 * unsubscribe fn") for as long as the caller's effect stays mounted, and returns that effect's
 * own cleanup.
 *
 * Shared by every backend-push pipe in the app (#346, #420, #697, #932) so this cancellation dance
 * — and the subtlety it exists for — isn't duplicated, and re-verified, per pipe: a listener is
 * bound to one project's session, so a project switch/teardown must not leave it live, or a later
 * notice lands against a surface that has moved on; a subscription that never came up has nothing
 * to tear down, which must not itself break unmount.
 *
 * `handler` is handed `isCancelled` rather than being skipped outright once torn down, because a
 * handler that itself awaits something (the delivery pipe's `parseChanges`) needs to re-check after
 * *its own* async gap, not just at the notice's arrival — cleanup can land while that inner await
 * is still in flight. Each handler therefore consults it at the point where *acting* would be
 * wrong, which is not the same point for all of them: birth, project-files, and Save As act on
 * arrival and check there, while `File > Open…` raises a native picker first and checks after it
 * returns. Nothing is skipped for a handler automatically — that is the caller's call to make.
 */
export function subscribeWhileMounted<T>(
  listen: (handler: (notice: T) => void) => Promise<() => void>,
  handler: (notice: T, isCancelled: () => boolean) => void,
): () => void {
  let cancelled = false;
  const subscription = listen((notice) => handler(notice, () => cancelled));
  return () => {
    cancelled = true;
    void Promise.resolve(subscription)
      .then((unlisten) => unlisten?.())
      .catch(() => {});
  };
}
