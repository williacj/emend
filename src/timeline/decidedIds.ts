// ABOUTME: Shared folds for reconciling decided change ids into timeline state: decisions add ids,
// ABOUTME: while Ctrl+Z reversals remove them without mutating the caller's existing Set.

/**
 * Folds `ids` into `prev`, returning `prev` itself (same reference) when nothing new was added —
 * so a caller storing the result in React state via a setter (`setDecided((prev) =>
 * mergeDecidedIds(prev, ids))`) skips the re-render entirely on a no-op merge, exactly as each call
 * site's own hand-written version did before this was factored out. Never removes an id merely
 * because a later decision batch is smaller; only an explicit reversal event may do that, through
 * `removeDecidedIds` below.
 */
export function mergeDecidedIds(prev: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  let changed = false;
  const next = new Set(prev);
  for (const id of ids) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  return changed ? next : (prev as Set<string>);
}

/** Removes `ids` from `prev`, preserving the original reference when none were present. */
export function removeDecidedIds(prev: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  let changed = false;
  const next = new Set(prev);
  for (const id of ids) {
    if (next.delete(id)) changed = true;
  }
  return changed ? next : (prev as Set<string>);
}
