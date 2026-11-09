# Wireframes (lo-fi)

File: `mocks/Emend Wireframes.dc.html`, options `1a`–`1n`. Built from `docs/ux-design.md` journeys J1–J8 plus settings.

**Fidelity: low.** Use these for layout, information hierarchy, and flow only. Style everything from `specs/tokens.md` and the hi-fi specs. Where a wireframe and a hi-fi mock cover the same surface, the hi-fi mock wins.

| Option | Screen | Journey / source |
|---|---|---|
| `1a` | Welcome / first launch | J8; `src/onboarding/WelcomeScreen.tsx`, `WritingPartnersPanel.tsx`, `ProviderChip.tsx` |
| `1b` | Workshop mode | J2 Phase A; §2 "Project rail states" (as amended for #1720 — the rail shows `DOCUMENTS` + `SKILLS`; hi-fi treatment in `6a`/`6b`/`6c`) |
| `1c` | **Authoring shell** | §4 — **superseded by the hi-fi specs**; its rail carries the same two sections, with `Updating documents…` on the Documents group; see `authoring-shell.md`, `comments.md`, `timeline-rail.md` |
| `1d` | Agent working / queued / permission-waiting | §2 "Agent states", "Agent concurrency", J7; `src/timeline/AgentWorkingCard.tsx` |
| `1e` | 1-by-1 triage + changes-as-list | J1 Phase C; `src/editor/RedlineToolbar.tsx`, `RedlinePopover.tsx`, `RedlineReview.tsx` |
| `1f` | Change-set card states | §2 UXR-Q5; `src/timeline/ChangeSetCard.tsx` |
| `1g` | Workflow run + findings | J3; `src/comments/severity.ts` |
| `1h` | Comment addressing | J4; `src/comments/CommentThreadCard.tsx`, `BatchAddressTrigger.tsx` |
| `1i` | Start review sheet | J5 |
| `1j` | Review live + completion gate | J5; §2 "Review states" |
| `1k` | Reviewer mode | J6 |
| `1l` | Project opened / birth cards | J8 Screen 2, J2 Phase B; `src/timeline/ProjectGroundingCard.tsx`, `DocumentBirthCard.tsx` |
| `1m` | Settings | §4 "Settings (inventory only)" |
| `1n` | **FR-ED-7 changed on disk** — five frames: detection, blocked Save, Reload + the honest gap after it, Compare, Reload failure; plus the Missing-on-disk distinction | FR-ED-7; §"Document integrity & lifecycle moments"; `src/editor/ExternalChangeBanner.tsx`, `ExternalChangeCompare.tsx`. **Hi-fi in `11a`–`11c` / `document-integrity.md`** — except frame 4 (Compare), which stays the only drawing of that destination |

`1c` and `1n` have hi-fi counterparts (`1n` except its Compare frame). The obvious next candidates are `1d` (agent states inside the shell) and `1e` (triage), since both live in the shell that is now specified.
