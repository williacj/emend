ABOUTME: Asks the owner's design project to draw J15's author-project fallback with its new conditional untitled sentence.
ABOUTME: Hands williacj/emend#107's J15 and §2 delta to the design project without editing generated docs/design files.

# J15 reload and untitled text: visual refresh brief

**Source:** `docs/ux-design.md` J15 and §2 *Render-failure fallback states*, amendment of 2026-11-27 (williacj/emend#107; split out of UXR-Q24 by CJ on 2026-09-07 as #2437). The behaviour and the exact copy are `docs/ux-design.md`'s. This brief asks only for appearance.

**What changed.** The author-project body of the render-failure fallback gains one conditional sentence. It renders only where an untitled document was open:

`Reloading brings back only what Emend last kept of an untitled document, so it may come back with earlier text, come back empty, or not come back.`

It is one sentence for every untitled case, because the fallback cannot tell which one applies, so there is no per-case variant to draw. It sits after `Emend can’t confirm from this screen whether every unsaved edit was kept.` and before the conditional agent-run sentence. No other string changes, and `[Reload window]` stays the only action.

Refresh turn 12 (`docs/design/specs/render-failure-fallback.md` §3) for this sentence, on both the Windows 11 and macOS frames:

1. Add the author-project row with the untitled sentence and no agent-run sentence.
2. Add the author-project row with both conditional sentences, untitled first. This is the longest body the fallback can show, so it fixes the column's tallest measure at both the 1400px window and the 660px study size.
3. Keep the layout, column width, button position and focus treatment exactly as in `12a`–`12d`. The sentence is a body sentence in the existing body style. It gets no icon, colour, emphasis, separate block or warning treatment, because §2 states what a reload does and asserts no confirmed loss. Where a remount brings an untitled document back empty after an omission, it shows J2's existing `restored-omitted-empty` treatment (`9c.2`, `specs/recovered-document.md`), and where it does not bring one back, nothing new is drawn.
4. Correct §3's note that *"sentence three of the author-project body is conditional"*. The body now has two conditional sentences, and their order is untitled, then agent run.

**What does not change.** The status-region answers in the same amendment add no appearance. While the fallback is mounted it shows only its own copy. After a remount the status region shows whatever its owning journey would be showing at that moment, in that journey's existing treatment, or nothing where that journey has cleared it, as J9's *Adopted here* and its run-blocked close refusal do. A project-open outcome held behind the fallback is shown after the remount as J9's existing line for that outcome, with its existing actions and `· N more queued` count (`13a`–`13h`, `specs/project-open-status.md`), so it needs no new drawing either. The dismissal-memory ruling has no visible state. The close refusal, the reload states and the other three copy rows are unchanged.

This is an appearance handoff. Generated `docs/design/` is not edited in this repository, and refreshing it is the owner's to commission.
