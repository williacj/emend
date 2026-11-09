# Cowrite v2 Implementation Plan

ABOUTME: Phased implementation plan mapping the tech design's build order to GitHub milestones and issue-sized work units.
ABOUTME: Companion to tech-design.md (TD-1..8, build order) and test-plan.md; every unit carries its FR/TD/J/P references.

**Status:** Reviewed (fresh-eyes pass 2026-07-06, 12 findings folded) — ready for GitHub bootstrap.
**Rules (CLAUDE.md):** every unit ≤ ~4h, independently testable, one PR. TDD from Phase 1 onward (spike code exempt, never merges). No unit starts before its references exist in `docs/test-matrix.md`. **Unit numbering within a phase is intended build order; issue bodies state intra-phase dependencies explicitly.**

---

## Principles

1. **Vertical before horizontal.** Phase 2a ends with a *usable writing app* CJ dogfoods daily — the J1/J4 loop with Claude only, zero git. Everything after is built against real usage.
2. **De-risk before hardening.** SPIKE-1/3 done (TD-1/TD-2 confirmed). SPIKE-2 — now including the union-merge-driver verification TD-4's conflict-freedom depends on — gates the git stack from Phase 0. SPIKE-4/5 fold into their phases.
3. **The test rig precedes the features it tests.** Fake agent, fixture corpus, contract schemas, matrix enforcement in Phase 0; the e2e walking skeleton lands immediately after the editor shell, and acceptance scripts accrete per-unit.

## Phase map

| Phase | Milestone | Goal / exit criterion | Depends on |
|---|---|---|---|
| 0 | M0 Foundations | Scaffold + full test rig; SPIKE-2 verdict (incl. union driver) | — |
| 1 | M1 Textops core | All P1–P6 property suites green over the pure core | 0 |
| 2a | M2a **Dogfood gate** | **CJ writes real documents daily:** folder open → document open → type → save — J1/J4 loop, Claude-only, no git | 1 |
| 2b | M2b Authoring complete | J2/J3 flows, batch ops, benchmarks — built while dogfooding | 2a (concurrent) |
| 3 | M3 Agent hardening | Queue, permissions, interruption honest (J7); Copilot at parity | 2a |
| 4 | M4 Collaboration | Full J5/J6 review round-trip, two machines, concurrent reviews | 2a (2b/3 for full AI-addressing) |
| 5 | M5 Voice | Dictation on all three surfaces | 2a (parallel track) |
| 6 | M6 Release | Signed installers, updater, release gates pass | 3, 4, 5 |

**Calendar realism (solo + AI, ~1.5–2 merged units/day):** Phase 0 ≈ 1.5–2 wks · Phase 1 ≈ 2–3 wks · **dogfooding at ~6–7 weeks** · full plan ≈ 5–6 months (~80 units).

---

## Phase 0 — Foundations (M0)

| # | Unit | Refs |
|---|---|---|
| P0-1 | Scaffold Tauri 2.x + React/TS + Vite shell (window, menu skeleton, theme) | TD-2, FR-X-1/6 |
| P0-2 | CI: macOS + Windows runners; fmt/clippy/eslint/test jobs; benchmark job stub | test-plan §1/§6 |
| P0-3 | `textops/` crate skeleton + proptest harness wired into CI | TD §3.1 |
| P0-4 | Fixture corpus: open-source docs (Gutenberg sermons, CommonMark/GFM specs, permissive tech docs) + license manifest | TP-Q3 |
| P0-5 | Provider contract JSON Schemas from SPIKE-1 transcripts (`docs/formats/`) + validation helper | test-plan §1, TD-1 |
| P0-6 | Fake agent (a): spawnable binary + scenario-scripted stream-JSON playback | test-plan §1 |
| P0-7 | Fake agent (b): MCP-call scenarios + schema-validation harness (against a stub tool server; real server arrives P2a-10) | test-plan §1 |
| P0-8 | Fake agent (c): misbehavior repertoire (protected-write w/ events, malformed output, hang, stale revisions, mid-delivery death) | test-plan §1 |
| P0-9 | `docs/test-matrix.md` seed (named-invariant sweep) + CI enforcement script | test-plan §9 |
| P0-10 | **SPIKE-2:** git2 static TLS/credentials both OSes, worktree APIs, shallow clone, proxy, **union merge driver via git2 + attribute-propagation mechanism** (committed `.gitattributes` vs per-clone install) — go/no-go for TD-3/TD-4 merge story | TD-3, TD §3.2b |

## Phase 1 — Textops core (M1) — TDD begins

| # | Unit | Refs |
|---|---|---|
| P1-1 | Raw-text document model + content-hash revisions | TD-6 |
| P1-2 | CriticMarkup parser (fence/frontmatter exclusion) + P4a generators | FR-ED-4, P4a |
| P1-3 | Accept/reject apply ops + group atomicity | P4b, FR-ED-4 |
| P1-4 | Anchor model + exact offset mapping through edits | TD-4/6, P2 |
| P1-5 | **SPIKE-4 + impl:** snapshot/context fuzzy re-anchor + orphan semantics | D17, P2 |
| P1-6 | Coordinate transforms raw↔clean↔displayed + position-mapping policy | TD-6, P3 |
| P1-7 | Display-mode transforms (All/Simple/None/Original) | FR-ED-4, P1 |
| P1-8 | Diff→edit-list (revision support for agent deliveries) | FR-REV-1 |
| P1-9 | Comment event log: schema, causal fold (buffer-until-parent), incremental-sync invariant | TD-4, P5 |
| P1-10 | Track-changes attribution store: schema + fold | TD-4 |
| P1-11 | Delivery rebasing: per-edit context validation, partial-stale partition | TD-7, P6 |
| P1-12 | D22 importer (old sidecars → events) + counted-invariant tests | D22 |
| P1-13 | Publish sidecar JSON Schemas to `docs/formats/` + conformance tests | FR-X-8 |

## Phase 2a — Dogfood gate (M2a) — exit: CJ writes daily

**Exit correction (2026-07-26): UNMET.** Phase 2a had no unit that owned a user-facing document-open path, so completing P2a-1..22 could not satisfy “CJ writes daily.” P2a-23 now owns the missing path: #697 shipped the `File > Open…` stopgap; #698 owns the designed J2 left rail and remains gated on its UX-design delta.

**Blocker cleared (2026-08-14).** P2a-23 has shipped: #697's `File > Open…` stopgap, and #698's designed J2 left rail across eight reviewed merges (#926–#933, TD-18). A user can now find and open a document through the designed surface, with live refresh, correlated rename/move, and the Missing-on-disk recovery lifecycle. The **exit itself remains CJ's call** — “CJ writes daily” is a dogfooding judgment, not a merge count — and is unasserted here until CJ records it. Residual coverage obligations from #698 are carded (#1513–#1519) and do not gate the exit; the `NI-project-files-*` and `NI-project-rail-*` matrix rows name each one.

| # | Unit | Refs |
|---|---|---|
| P2a-1 | CM6 editor shell: doc load/save + textops wiring (source-as-model) | TD-2 |
| P2a-2 | **e2e walking skeleton:** Playwright rig + D23 headless driver — launch, open, type, save, fake-agent handshake. Acceptance scripts accrete per-unit from here | test-plan §4 |
| P2a-3 | Projection decoration providers: headings (HighlightStyle), emphasis, lists, blockquotes | TD-2, J1 |
| P2a-4 | Reveal-at-cursor + atomicRanges traversal polish | SPIKE-3 residuals |
| P2a-5 | Redline decorations + accept/reject popover + keyboard triage (Cmd/Ctrl+Enter/Backspace); apply queued decisions against a single parse snapshot / stable change identity, never re-parse-then-index (TD-11 corollary) | J1, FR-ED-4, TD-11 |
| P2a-6 | Tabs + per-project session restore + dirty guards | FR-ED-3 |
| P2a-7 | Autosave + atomic writes + LF normalization | FR-ED-2 |
| P2a-8 | Source-view toggle + display-modes UI | FR-ED-1/4 |
| P2a-9 | Settings store + `schema_version` + migration test (consumers: autosave, provider default, notifications) | FR-X-7, test-plan §3 |
| P2a-10 | Sidecar store service: fold/append/watch + docs.json identity + rename/delete/adopt | FR-ED-8, TD §3.2b |
| P2a-11 | Per-project lock + focus-existing-instance | TD §3.5 |
| P2a-12 | MCP server: loopback + bearer; `get_document_state`, `list_documents` | TD-1, §3.2 |
| P2a-13 | `propose_changes` + TD-7 rebase + atomic apply + TD-11 whole-set round-trip validation (refuse-unrepresentable: payload→agent-reword, existing-text→honest hard-fail; named test under P6) (backend, fake-agent-tested) | J1, FR-REV-1, P6, TD-11 |
| P2a-14 | Change-set card + triage entry points (1-by-1 / accept-all / per-section) | J1 |
| P2a-15 | Claude Code adapter: spawn/stream/resume + activity feed (MCP config auto-wiring) | TD-5, J1 |
| P2a-16 | Timeline (a): virtualized stream + base cards + message input | UX §4 |
| P2a-17 | Local transcript store (D15) + timeline persistence | D15 |
| P2a-18 | Comment UI: create/reply/resolve + orphan card + [Re-anchor] | J4, FR-CMT-1/6 |
| P2a-19 | Address-with-AI single: pending state, accept⇒resolve, re-delegate w/ guidance, defense | J4, FR-CMT-2..4/7 |
| P2a-20 | Protection watchdog + attribution precedence + detect-and-convert | D21, FR-AGENT-2/5 |
| P2a-21 | Integrity banners (external change, CRLF) + undo policy wiring | FR-ED-7, TD §3.3 |
| P2a-22 | Minimal onboarding: folder open, provider detect + auth-state chips (signed-out ≠ not-installed), zero-provider editor-only mode | J8, FR-X-5/7 (review H1) |
| P2a-23 | **Document-open surface:** `File > Open…` stopgap (#697) + designed J2 left rail (#698 → #926–#933, TD-18) — shipped 2026-08-14 | FR-X-1, UX §4, J2 Phase A |

## Phase 2b — Authoring complete (M2b, concurrent with dogfooding)

| # | Unit | Refs |
|---|---|---|
| P2b-1 | Timeline (b): facets + collapse rules + facet-jump (+ correctness tests) | UX §4 |
| P2b-2 | Type-filtered bulk ops (accept all insertions/deletions) | J1 |
| P2b-3 | Batch address: filters + grouped-by-comment card + distinct defenses | J4, FR-CMT-5 |
| P2b-4 | Comment highlights + severity margin (color + letter chips) | J3, UX §2 |
| P2b-5 | `add_comments` / `reply_to_comment` + findings rendering + report card | J3, FR-REVIEW-1..3 |
| P2b-6 | `create_document` + J2 birth flow + workshop mode | J2, FR-CHAT-1/2 |
| P2b-7 | Quote-bar selection→anchored message | UX P6 |
| P2b-8 | Skills/workflow discovery + project card + `.cowrite/config.json` schema publication | FR-SKILL-1/5 |
| P2b-9 | Spellcheck (suppressed in markup/frontmatter) + keymap module | FR-ED-3, FR-X-1 |
| P2b-10 | Benchmark suite (§6 budgets) + dedicated-runner baseline | FR-X-4, test-plan §6 (review M8) |
| P2b-11 | J1/J2/J4 acceptance scripts complete (incl. delivery-while-typing) | test-plan §4 |

## Phase 3 — Agent hardening + Copilot (M3)

| # | Unit | Refs |
|---|---|---|
| P3-1 | Run queue + queued/cancellable cards | FR-AGENT-7, UX §2 |
| P3-2 | Permission flow: `permission_request` tool + Claude delegation wiring + J7 card UI | FR-AGENT-3, J7 |
| P3-3 | Interruption: kill, watchdog, honest partial/failure cards + [Retry from here] | FR-AGENT-6, J7 |
| P3-4 | Copilot adapter: hooks-file injection, `--additional-mcp-config`, `COPILOT_AUTO_UPDATE=false`; paid adapter tests #1/#2 | TD §3.4 |
| P3-5 | Provider switch: condensed-transcript seed + provider chip | TD-5, FR-X-7 |
| P3-6 | OS notifications (blocked/broken on; completions off, toggleable) | J7 |
| P3-7 | J7/J8 e2e + misbehavior-repertoire coverage + capability-matrix tests | test-plan §4 |

## Phase 4 — Collaboration (M4)

| # | Unit | Refs |
|---|---|---|
| P4-1 | **Chore (open at phase start): procure signing certs** (Windows cert + Apple Developer ID — lead time) | TD §3.6 (review M10) |
| P4-2 | git2 foundation: detect/init, D12 light-up, auto-checkpoint + race matrix; **machine-commit identity synthesis** (GitHub account → fallback `Cowrite <noreply@…>`, tested on config-less repos) | TD-8 (review M6) |
| P4-3 | GitHub device flow + keychain | FR-X-9 |
| P4-4 | Worktree manager: create/mirror/prune/crash-repair (+ identity, + attribute install per SPIKE-2 mechanism) | TD-3 |
| P4-5 | Union merge driver: install + sidecar branch-merge tests | TD §3.2b |
| P4-6 | Review create: sheet, branch/worktree/PR/invites, pre-flight chips | J5, FR-COLLAB-7/8 |
| P4-7 | Sync (a): debounced push worker + mirror/commit | TD-3, D20 |
| P4-8 | Sync (b): pull (focus/poll/manual) + persistent offline queue | TD-3, FR-X-5 |
| P4-9 | Reviewer (a): reviews-waiting discovery + auto-clone (+ attribute install, identity) | J6, FR-COLLAB-2 |
| P4-10 | Reviewer (b): reduced workspace UI + doc-set dropdown | J6 |
| P4-11 | Suggestions: reviewer composer + mini-diff; author apply → attributed change | D19, FR-COLLAB-2b |
| P4-12 | PR-lane import: single importer, idempotent IDs, line→offset mapping | FR-COLLAB-5 |
| P4-13 | Review complete/cancel: per-doc gates, human-terms cancel, cleanup | D18, J5 |
| P4-14 | Review bar + sync dot (click = refresh) + multi-review switcher | J5, FR-COLLAB-9 |
| P4-15 | Two-instance e2e round-trip + headless second-concurrent-review case | test-plan §4, D18 |

## Phase 5 — Voice (M5, parallel after 2a)

| # | Unit | Refs |
|---|---|---|
| P5-1 | Port voice crate (cpal→rubato→whisper) behind device/capture traits | FR-ED-5 |
| P5-2 | Model registry + download (resume/corrupt recovery) + Settings section | FR-ED-5 |
| P5-3 | **SPIKE-5 + impl:** ghost-text CM6 decoration outside undo history; three surfaces | TD §3.1, UX §2 |
| P5-4 | Voice fixtures (WAV→pinned model→tolerance transcript) + error-matrix cells | test-plan §3/§7 |

## Phase 6 — Release (M6)

| # | Unit | Refs |
|---|---|---|
| P6-1 | Windows signing + installer | TD §3.6 |
| P6-2 | macOS notarization + installer | TD §3.6 |
| P6-3 | Updater channel + upgrade-from-previous test | TD §3.6 |
| P6-4 | Logging discipline + support bundle ("reveal logs") | TD §3.6 |
| P6-5 | Settings panel complete (inventory per UX §4) + theme | FR-X-6/7 |
| P6-6 | Onboarding polish: welcome copy, provider live-refresh | J8 |
| P6-7 | Feedback→GitHub-issue flow | FR-X-6 |
| P6-8 | Release-gate execution: live smoke both providers, corpus zero-drift (local), J6 cold-start timing, real-repo migration | test-plan §8 |

**Descoped from v1 (deliberate):** FR-COLLAB-6 read-only HTML export (COULD) — revisit post-release.

---

## GitHub bootstrap & backlog convention (CJ, 2026-07-06)

- **This document is the canonical backlog.** GitHub issues are the execution surface for the *active* phase only: issues are batch-created from the plan at each phase boundary, incorporating what dogfooding/implementation taught us. Un-issued phases live here, not as stale GitHub issues.
- **Bootstrapped now:** all milestones (M0–M6 incl. M2a/M2b) + labels + **issues for M0 and M1 only** (~23).
- **Labels:** `phase:0..6`, `area:editor|agent|textops|sync|voice|infra|ux`, `type:feature|test|spike|chore`, `blocked`.
- **Issues:** one per unit, titled `P<phase>-<n>: <unit>`, body = goal, refs, acceptance criteria, intra-phase dependencies, test-matrix rows touched.
- Branch protection on `main` optional until collaboration work begins.

---

## Current-feature design alignment (refresh (20) delta, 2026-10-01)

**Scope.** Bring product surfaces that already work on `main` into alignment with their applicable `docs/design/` mocks. This is an appearance and presentation pass over existing journeys, not authorization to implement the remainder of this plan. The original Gate A–E browser alignment pass produced the [78-state after-state baseline](alignment-after/README.md) at `60d7a84ef`; its card descriptions are historical scope, not a fresh list of unbuilt features. Native Windows title controls remain outside that browser evidence. [The refresh (20) inventory](design-alignment-refresh20.md) records current code evidence, remaining bounded differences, and the new capture matrix. Each new card remains one independently testable PR of roughly four hours or less. Do not edit `docs/design/`, which is generated by CJ's design project.

**Authority.** `docs/ux-design.md` governs behavior, `docs/design/` governs appearance, and the hi-fi options take precedence over the lo-fi wireframes for appearance. Compare the real app before editing: the handoff describes some code as absent or incomplete even though newer implementations now exist. In particular, the current tree already has `UntitledDocument`, `ExternalChangeBanner` recovery phases, `RenderFailureFallback`, `ProjectOpenStatusRegion`, the agent chat attribution tile, and tests for them. A handoff's old implementation-status sentence is not evidence that work remains.

**Boundary.** This track may restyle or rearrange controls used by an existing working flow. It does not add a new product capability merely because a mock includes it. The comment correction flow, pathless comments, D27 retained-text recovery, the Documents/Skills rail split, and measured toolbar overflow have since shipped; inspect their current implementation before opening a delta card. The `4c`–`4g` collapsed Timeline and working dictation remain separate feature cards. Review sharing/reviewer mode, workflow-review summary, GitHub connection, and unbuilt Share, attach, provider-switch, and `Ask agent` actions stay in their own feature tracks. Do not add decorative controls that cannot perform their named action.

### Gate A — establish a measured baseline

| Card | Work and acceptance | Sources / likely owners |
|---|---|---|
| A1a | Capture comparable light-theme welcome, workshop, and file-backed authoring states at 1400px on Windows and macOS. | `1a`, `3a/3b`, `10c`, `13a/13b/13d`; `src/App.tsx`, `src/styles.css` |
| A1b | Capture the existing timeline, composer, redline, comment-card, and agent-card states at 1400px on both platforms. Include only cards and controls reachable in the app today. | `3a/3b`, `4a/4b` fragments, `10a–10c`; `src/timeline/`, `src/editor/`, `src/comments/` |
| A1c | The browser baseline captured selected `9c.2`–`9c.6` recovery states: 660/420/330px document columns, collapsed and edited notices, two close guards, and failed Save As. It did not capture every `9a`–`9f` option. Refresh (20) adds `9g`/`9h` fixtures to the delta matrix. | Captured `9c.2`–`9c.6`; target `9g`/`9h`; `recovered-document.md`, `authoring-shell.md`; `src/editor/UntitledDocument.tsx`, `src/styles.css` |
| A1d | Capture observed/blocked/reloading/**write-pending**/failed external-change states and the read-only Compare destination; the reachable **author and neutral** render-fallback states; and the reachable project-open states. Capture project-open clipping at the widths shown in `13g`. The fallback's reviewer copy row is excluded because no production reviewer workspace exists yet. | `11a–11c`, `1n`, `12a–12f` author/neutral rows, `13a–13h`; `src/editor/ExternalChangeBanner.tsx`, `ExternalChangeCompare.tsx`, `src/renderRecovery/`, `src/ProjectOpenStatusRegion.tsx` |
| A1e | Capture the reachable project-rail loading/updating/error/footer variants and the existing General Settings panel on both platforms. This supplies the specific before-state evidence for B2 and D5. | `3a/3b`, `6a/6b` shared rail treatment, `1m`; `src/projectRail/ProjectRail.tsx`, `src/settings/SettingsDialog.tsx` |
| A1f | Consolidate A1a–A1e into a difference inventory: `mock option → current screenshot → affected selector/component → expected value`, marking already-matching states verified. Hi-fi options supply literals; wireframes supply hierarchy only. No implementation card begins from a handoff sentence about old code alone. | `docs/design/README.md`, `screen-map.md`, `specs/state.md`; `e2e/acceptance.spec.mjs` |
| A2 | Check actual Tauri window chrome on both platforms against `platform-variants.md` before planning title-bar changes. Record which pixels belong to the OS and which to the app's `.app-header`; propose any change to native decorations or window controls as an architectural decision for CJ before implementation. Acceptance: the subsequent shell cards refer only to app-owned pixels or an approved chrome decision. | `3a/3b`, `platform-variants.md`; `src-tauri/tauri.conf.json`, `src/App.tsx` |

### Gate B — shared authoring composition

| Card | Work and acceptance | Sources / likely owners |
|---|---|---|
| B1 | Align the app-owned light palette, typography, header height/spacing, column fills and dividers, and document canvas measure. Keep the existing light/dark/system theme contract intact; the mocks specify light appearance only. Acceptance: 1400px authoring and workshop captures show the intended hierarchy and widths, and dark theme remains legible. | `3a/3b`, `10c`, `tokens.md`, `platform-variants.md`, `authoring-shell.md`; `src/styles.css`, `src/App.tsx`, `src/editor/editorTheme.ts` |
| B2 | Baseline aligned the then-existing project rail's header, rows, active/focus state, collapse control, loading/updating/error presentation, and footer. D27 subsequently shipped the Documents/Skills split; any refresh (20) rail comparison must use that current structure. | `3a/3b`, `6a/6b`, `authoring-shell.md`; `src/projectRail/ProjectRail.tsx`, `src/styles.css` |
| B3 | Verify tab-strip geometry and the already-implemented untitled tab states, then correct any measured differences in size, spacing, clipping, dots, and platform shape. Acceptance: tabs still open/switch/close and the untitled qualifier never reads as a dirty-file dot. | `3a/3b`, `9a–9f`, `platform-variants.md`, `recovered-document.md`; `src/editor/TabBar.tsx`, `src/styles.css` |
| B4a | Baseline aligned the controls **already present** in the editor toolbar: Rich text/Markdown, formatting, redline action/stepper/bulk group, and their zero-change absence. The editor mic belongs to the separate dictation feature card. | `3a/3b`, `9a–9f`, `authoring-shell.md`; `src/editor/ViewModeToolbar.tsx`, `RedlineToolbar.tsx`, `src/styles.css` |
| B4b | The existing toolbar controls now use measured `⋯` overflow: after context controls leave, `B I H1 ≔` moves as one group at `9g.5`/`9g.6`. The 30-state capture verifies one row, existing-action order, working moved actions and focus recovery at 792/660/420/330px. Remeasure the 253/255px floor with native platform fonts when the pinned mic lands. | `3d`, `9g.5/9g.6`, `authoring-shell.md` toolbar rule; `src/editor/ViewModeToolbar.tsx`, `src/styles.css` |
| B5 | Align the existing CM6 document projection, tracked-change marks, anchored comment highlights, severity gutter marks for findings, and selection affordances for Comment and Quote. Ordinary comment gutter icons and their reciprocal navigation remain in collapsed-Timeline card #2537. Keep the existing actions working; do not add the mock's unimplemented Ask agent action or a comments-column navigation target. Acceptance: decoration and anchor position remain stable through editing, resizing and tab switching. | `3a/3b`, applicable `4a/4b` fragments, `authoring-shell.md`, `comments.md`; `src/editor/DocumentSurface.tsx`, `trackedChanges.ts`, `commentHighlights.ts`, `severityMarginMarks.ts`, `QuoteAffordance.tsx`, `CommentTrigger.tsx`, `src/styles.css` |
| B6 | Align the existing document status bar's typography, groups, save-state platform placement, and measured overflow. Preserve truthful pathless and failed-save variants. Acceptance: no wrapping, clipped text stays accessible, and no status implies a path or autosave on an untitled pane. | `3a/3b`, `9a–9f`, `authoring-shell.md`; `src/editor/DocumentStatusBar.tsx`, `DocumentSaveStatus.tsx`, `src/styles.css` |

### Gate C — existing timeline and comment surfaces

| Card | Work and acceptance | Sources / likely owners |
|---|---|---|
| C1 | Change the **existing** timeline rail's 320px white shell to the specified 372px warm shell; align its existing header label/action geometry, five facets, feed spacing, card containers, and workshop measure. Preserve virtualization, facet state, tail-follow and scroll position. The mock's `››` header control and collapsed comments-rail mode are one unbuilt capability and are excluded; do not add an inert collapse button or declare the complete mock header matched. | `3a/3b`, `10c`, `timeline-rail.md`; `src/timeline/TimelinePanel.tsx`, `FacetBar.tsx`, `VirtualList.tsx`, `src/styles.css` |
| C2 | Compare existing user/agent message, working, change-set, document-birth and project-grounding cards against their applicable drawn states. Apply only measured differences, especially the agent attribution tile, `refs: N files read` row, revision emphasis and action hierarchy. Do not infer the in-flight run card's appearance from illustrative `13c/13h`. | `3a/3b`, `10a–10c`, `1d/1f/1l`, `timeline-rail.md`, `state.md`; `src/timeline/*Card.tsx`, `src/styles.css` |
| C3 | Align the existing message composer and quote bar's light appearance and focus states. Keep its current send behavior and disabled mic honest; exclude attach, voice, model selection and provider switching. Acceptance: composing and sending in workshop and rail layouts still work at the designed measures. | `3a/3b`, `10c`, `timeline-rail.md`; `src/timeline/MessageComposer.tsx`, `MessageInput.tsx`, `QuoteBar.tsx`, `src/styles.css` |
| C4 | Baseline aligned the then-existing comment card. Edit/delete correction and child-first refusal have since shipped in the timeline card and editor popover; compare those reachable states with `5d` and correct only measured differences. The 400px comments column, sort chip and hidden-thread chip belong to the separate collapsed-Timeline card. | `4a/4b`, `5d`, `comments.md`; `src/comments/CommentThreadCard.tsx`, `src/editor/CommentPopover.tsx`, `src/styles.css` |

### Gate D — reachable lifecycle and entry states

| Card | Work and acceptance | Sources / likely owners |
|---|---|---|
| D1 | Baseline compared selected `9c.2`–`9c.6` editable recovery states; it made no pixel-parity claim for every `9a`–`9f` option. Refresh (20) adds existing pathless comments/selection in `9g` and D27 retained-text recovery in `9h`; compare those as new states, including narrow widths, without reworking the persistence state machine absent a reproducible mismatch. | Captured `9c.2`–`9c.6`; target `9g`/`9h`; `recovered-document.md`, `adoption-provenance.md`; `src/editor/UntitledDocument.tsx`, `TabbedEditor.tsx`, `src/styles.css` |
| D2 | Audit and correct the existing changed-on-disk banner's observed, blocked-save, reloading, write-pending, failed-reload and Compare states. Compare has **wireframe-only** visual authority; keep the current read-only two-pane structure and return-to-banner behavior without inventing hi-fi typography or diff markers. Missing-on-disk and CRLF banners are not drawn, so exclude their appearance. | `11a–11c`, `1n`, `document-integrity.md`, `state.md`; `src/editor/ExternalChangeBanner.tsx`, `ExternalChangeCompare.tsx`, `EditorShell.tsx`, `src/styles.css` |
| D3 | Audit and correct the mounted render-failure fallback's **reachable author-project, author-no-project, and unestablished** copy modes, platform-light surface, one control, pending/failure states, and guarded native-close presentation. The implemented reviewer copy branch is excluded from this alignment track because the production reviewer workspace is not yet built. `docs/ux-design.md` J15 records CJ's core rulings and remaining proposals more precisely than the older handoff summary; do not use a proposed detail to revise behavior without its decision. | applicable `12a–12f` author/neutral rows, `render-failure-fallback.md`, J15; `src/renderRecovery/*`, `src/styles.css` |
| D4 | Baseline captured the existing one-line project-open region, including its 46px height and `13g` clipping. Refresh (20) changes J9 behavior: `Dismiss` remains available in flight; a non-adopted terminal outcome restores the band, while `Adopted here` clears it because the opened project is the outcome. The collapsed-comments-rail frame of `13h` waits for the separate collapsed-Timeline feature. | `13a–13h`, `project-open-status.md` §4/§11, J9; `src/ProjectOpenStatusRegion.tsx`, `src/stores/projectOpenStatus.ts`, `src/App.tsx`, `src/styles.css` |
| D5 | Align the existing welcome page to the hi-fi welcome composition in `13a/13b` and the `1a` hierarchy; align General Settings to `1m`'s **lo-fi hierarchy**, using shared hi-fi tokens where available. Preserve the truthful `Recent` empty state and existing deferred GitHub control; do not build those missing flows. | `13a/13b`, `1a/1m`, `wireframes.md`, `tokens.md`; `src/onboarding/WelcomeScreen.tsx`, `src/settings/SettingsDialog.tsx`, `src/styles.css` |

### Gate E — verification and handoff

| Card | Work and acceptance | Sources / likely owners |
|---|---|---|
| E1 | The merged-source real Vite+D23 pass captured 218 states on Win32/MacIntel browser styles with zero scenario failures, including the 9-series narrow carve-outs and `13g` clipping. The artifact checks and separately reviewed implementation cards cover one-row toolbar/status behavior, keyboard focus, truthful status and scroll stability. The [refresh (20) inventory](design-alignment-refresh20.md) records the generated mock corrections, composed unbuilt features, two remaining transient capture gaps, and the native Windows title-control gate. | `docs/design/`, `docs/test-plan.md`; [integrated capture](alignment-after/README.md), `e2e/acceptance.spec.mjs` |

**Refresh (20) disposition.** The [code-evidenced inventory](design-alignment-refresh20.md) and 218-state integrated capture close the existing-feature alignment pass on the reachable fragments. Collapsed Timeline and working dictation have their own feature cards and supply the currently unreachable full `4c`–`4g` and pinned-mic `3d` compositions. The final visual gate covers browser platform styles and narrow widths; native Windows title controls require an interactive desktop session. For any implementation PR, run the affected-layer suites prescribed by `CLAUDE.md`; a docs-only plan change does not require them.
