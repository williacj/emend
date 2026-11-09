// ABOUTME: Shared `rangeOf` test helper — locates a substring's `{from,to}` range in fixture
// ABOUTME: content so tests derive offsets rather than hand-counting them (issue #563).

/** Locates the `occurrence`-th (0-based, default first) instance of `substr` within `content` and
 * returns its `{from,to}` character range. Computed rather than hand-counted so a fixture-string
 * edit can't silently drift an offset out of sync with the text; throws if that occurrence isn't
 * found, so a broken fixture fails loudly instead of miscounting. */
export function rangeOf(
  content: string,
  substr: string,
  occurrence = 0,
): { from: number; to: number } {
  let from = -1;
  for (let i = 0; i <= occurrence; i++) {
    from = content.indexOf(substr, from + 1);
    if (from < 0) {
      throw new Error(`substring ${JSON.stringify(substr)} occurrence ${occurrence} not found`);
    }
  }
  return { from, to: from + substr.length };
}
