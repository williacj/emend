# Timeline rail

Mocks: `3a` (Windows) / `3b` (macOS). Read `tokens.md` and `platform-variants.md` first.

372px wide, background `#F5F3ED` (Win) / `#F1EEE7` (mac), `display:flex; flex-direction:column`.

## Header

Padding 12px 14px, 1px bottom `#E3DFD6`, gap 8px: `TIMELINE` label (10.5px, 500, `letter-spacing:.1em`, `#8C8779`) · right-aligned `Address all… ▾` chip (12px, padding 4px 9px, white; standalone Timeline host only, see `15c`) · `››` collapse affordance (12px `#A39E92`).

## Facet bar

Padding 10px 14px, 1px bottom `#E3DFD6`, gap 6px, 11.5px. Pills: padding 4px 10px, radius 12px.

`All` (active — `#1F1D1A`, white, 500) · `Chat` · `Comments` · `Changes` · `Findings` (inactive — white, 1px `#D5D0C4` Win / `#E3DFD6` mac, text `#4A463E`).

## Feed

`flex:1; display:flex; flex-direction:column; gap:10px`, padding 14px.

### Collapsed summary row

Padding 8px 11px, radius 7px (Win) / 8px (mac), bg `#EFECE4` (Win) / `#E8E4DB` (mac), 12px `#6B665C`. Leading 9px `▸`, right-aligned timestamp `#A39E92`. Examples: `6 changes decided` · `Thread resolved · headline scope`. Expands in place.

### User message card

White, radius 8px (Win) / 10px (mac), padding 12px, gap 7px; mac adds `0 1px 2px rgba(31,29,26,.07)`. 20px avatar · `You` 12.5px/500 · relative time right, 11.5px `#8C8779`. Body 13px/1.6 `#33302A`.

### Agent message card (`10a` Win / `10b` mac / `10c` workshop) — #1817

**The same shell as the user message card**, not the change-set shell. White, radius 8px (Win) / 10px (mac), padding 12px, gap 7px; Win 1px `#E3DFD6`, mac `0 1px 2px rgba(31,29,26,.07)`. Emphasis in this feed means *something is waiting on you*; a reply carries prose, so it stays at rest.

1. **Attribution row** — 20px **rounded-square** tile, `#4F46E5`, radius 5px (Win) / 6px (mac); the shape distinguishes agent from the user card's round avatar with no icon set. Then the label **`Agent`** 12.5px/500 `#3A362F` — the string `ChatMessageCard`'s `AUTHOR_LABEL` already ships (`{user: "You", agent: "Agent"}`), not a product or model name — and relative time right-aligned 11.5px `#8C8779`. **The tile is new appearance**; the shipped header renders the label alone.
2. **Body** — 13px/1.6 `#33302A`; wraps freely to as many lines as the reply needs. No clamp, no "show more" — none is drawn or implied.
3. **Grounding indicator (footer)** — its own last row: `padding-top:6px`, `border-top:1px solid #F0EDE6`, 11px `#8C8779`, text **right-aligned** (`margin-left:auto`).

This ratifies the interim implementation's own reading. `styles.css`'s `.chat-message-card__refs` is already `display:block; text-align:right` in `--color-muted`, chosen — per its own comment — because "`docs/design/` draws no chat card at all". The treatment stands; the literals here are binding and differ from that placeholder in two ways: **11px `#8C8779`** rather than 12px `--color-muted`, and the footer hairline, for which the interim rule has nothing.

**The indicator is muted text, not a chip.** A chip reads as actionable and would compete with the two chip-shaped things in this feed — the `REVISION` badge and the action pills — both of which are. Grounding is provenance, so it takes the quietest always-visible form; identical row position on every reply makes a run of replies read as one right-hand column rather than repeated interruptions.

| Refs count | Renders |
|---|---|
| 0 | **Nothing** — the footer row *and* its hairline are absent; the card ends on its body |
| 1 | `refs: 1 file read` (singular) |
| N > 1 | `refs: N files read` |

Never `refs: 0`, never "no files read", never an empty row holding the space. An ungrounded reply is legible as ungrounded by the **absence** of the indicator, which is why a zero must never render.

**Workshop mode (`10c`)** uses the same definition at center-stage measure: padding 14px 16px and body 13.5px/1.7 only, because a ~680px column reads badly at rail leading. Card treatment, attribution row, footer placement, hairline and copy are unchanged. `10c` is drawn on **macOS** chrome; the Windows workshop card takes the Windows column of `platform-variants.md` unchanged. Measure and platform are independent.

**No model or provider identity, by ruling.** The card data carries no such field, and **CJ's 2026-08-28 disposition holds that the `Agent` label plus the tile *are* the source attribution #1817 requires: the card must not expose provider or model identity, and no new card field is authorized.** Adding one is out of bounds for both this folder and the implementation (`open-conflicts.md`).

**The quoted-excerpt element is not redrawn.** An agent or user chat card may carry a deep-linking quoted excerpt above its body (`chat-message-card__quote`, P2b-7, Principle 6). Its appearance is unspecified by this folder and stays so; nothing in this pass changes it, and the footer rule above sits below the body whether or not a quote is present.

**Out of scope here.** Whether the indicator discloses *which* files, on what gesture, and how an in-flight run reads are behavior — `../ux-design.md` J2 and **#1391** own them. This section adds no panel, popover or state. An *unknown* count is not the zero case and is not derivable from the absent-footer treatment.

### Change-set (revision) card

White, emphasized — Win: 1px `#C6BFAE` + `0 2px 8px rgba(31,29,26,.07)`, radius 8px. mac: `0 3px 12px rgba(31,29,26,.1), 0 0 0 1px #D8D2C4`, radius 10px. Padding 12px, gap 9px.

Contents in order:

1. **Header** — `REVISION` badge (IBM Plex Mono 10px/500, white on `#1F1D1A`, padding 2px 7px, radius 4px (Win) / 5px (mac)) · `Claude` 11.5px `#4A463E` · relative time right `#A39E92`.
2. **Summary** — 13px/1.6 `#33302A`. One sentence describing the edit in the author's terms.
3. **Metrics** — 11.5px `#6B665C`: `14 changes · 2 sections · no files added`.
4. **Section list** — collapsible rows, 12px `#3A362F`, gap 4px: 9px `▸` chevron `#A39E92` + `§1 Promise` + count `(9)` in `#8C8779`.
5. **Action row** — `display:flex; flex-wrap:wrap; gap:6px`, 12px: `Review 1-by-1` (solid `#4F46E5`, white, 500) · `Accept all` · `Reject all` · `⋯` (padding 6px 9px). Radius 6px (Win) / 7px (mac), padding 6px 11px.

### New-activity chip

Centered pill: `1 new in Chat ↓`, 11.5px `#4F46E5`, padding 5px 12px, radius 12px, bg `#E8E7F9`, border `#B3B0E6`. Appears when activity arrives in a facet that isn't currently in view; click scrolls to it.

## Composer

Pinned at the bottom: 1px top `#E3DFD6`, bg `#F0EDE6` (Win) / `#EDEAE2` (mac), padding 12px 14px 14px, gap 9px.

1. **Quote bar** (only when text was quoted in from the document) — `border-left:3px solid #B8B3A8`, radius `0 6px 6px 0` (Win) / `0 7px 7px 0` (mac), bg `#E8E4DB` (Win) / `#E3DFD6` (mac), padding 7px 10px. Quoted text in Source Serif 4 12.5px `#4A463E`, right-aligned `✕` `#8C8779` to clear.
2. **Input row** (gap 8px, `align-items:flex-end`) — input `flex:1`, min-height 38px, padding 10px 12px, radius 8px (Win) / 9px (mac), white, placeholder `Message Claude…` 13px `#A39E92`; 36×36 attach button `◉`; `Send` 36px tall, padding 0 12px, `#1F1D1A`, white, 12.5px.
3. **Footer** — 11px `#8C8779`, gap 8px: `Claude Sonnet ▾` · `Ctrl+Enter to send` (Win) / `⌘⏎ to send` (mac).

## Interactions

- Facet pills filter the feed; `All` is default.
- Summary rows and section rows expand in place.
- `Review 1-by-1` puts the document into the redline state and jumps to the first change in the set (see `authoring-shell.md`, toolbar redline group).
- Redline stepper `‹`/`›` move the current change and scroll it into view; `Accept`/`Reject` apply to the current change and advance. `Bulk ▾` covers accept/reject by section or by author.
- `Address all… ▾` batches open comments to an agent ([`docs/ux-design.md`](../../ux-design.md) J4). **(26)** In the main app it lives in the editor toolbar, not this header. The header host exists only in the standalone Timeline (`15c`), where the chooser floats and the header stays one row. Spec: `comments.md` → *Address all chooser*.
- `››` collapses the rail; it comes back from the `Timeline ››` toolbar chip.

## Run landing and outbound direction (`4e`, `4g`, refresh (17))

**Auto-expansion** (UXR-Q16.4): a run started outside a persistent comment card while collapsed — `Address all…`, file-backed selection `Ask agent` — expands Timeline at submission. Facet preserved if it shows the run; otherwise `All`. The **owning submitted-turn card** (user chat card where the route makes one, else the run card) lands at the feed bottom with 12px clearance and takes focus on its container: `outline:2px solid #4F46E5; outline-offset:2px`. Never `[Stop]`, `[Cancel]` or a permission decision. **Ruled by CJ, 2026-10-01 (18).** The focus target, and that selection `Ask agent` makes a user card while `Address all…` does not.

**Outbound line — ruled treatment (18)** (the run card itself stays #1391’s undrawn surface): J13’s wording, 11.5px/1.45 `#4A463E`, led by a mono `↑ OUT` marker (10px/500 `#4F46E5`). The inbound count on the collapsed summary is led by `↓ IN` (10px/500 `#8C8779`). On the collapsed card the OUT line takes **its own row** beneath the summary — never a `·` item in it. Clean documents: no line.

**Permission attention** is unchanged by any of this: a later request never expands, changes facet or moves focus; the one nonnumeric Pause badge sits on the Timeline host (on the `Timeline ››` chip while collapsed — 16px `#B5871F` disc with a white pause glyph, **ruled as drawn (18)**).

**Composer mic** (`4f`): the composer input carries the same 28×26 mic chip and states as the editor toolbar (`authoring-shell.md`), right-aligned inside the input. **(22) Provisional text** (`14d`) sits below the 38px input inside the input’s column — 4px under it, 12px inset, wrapping within the input width and never under `Send`; `Send` stays level with the input. An error echo takes the same slot in `#A33A2E`. **Collapsed return control** at 900/1000px: `14a`, `voice.md` §2.

**Keyboard activation of `Timeline ››`** moves focus to the composer input; pointer activation leaves focus where it was. **Ruled by CJ, 2026-10-01 (18).**
