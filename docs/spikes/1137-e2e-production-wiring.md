# Spike #1137 Findings: exercising production UI→backend wiring in e2e

ABOUTME: Measured answer to "how can e2e exercise the production UI→backend join, given native-webview
ABOUTME: automation is not viable on macOS?" — plus the substitution rule the suite can be audited against.

**Status: RECOMMENDATION READY.** The macOS native-webview constraint is **not** what caused the
#1118/#1120/#1121 blind spot, and lifting it is not what closes it. Three probes, all executed:
the existing Vite+Chromium+test-driver rig already reaches the production comment path end to end
(**and, asserted correctly, fails on #1120**); the agent-activity **push** channel can be carried by
a `/run_state` poll without becoming a mock (**proven — a real `RunQueue` phase rendered by
production `foldRunStatus`, no injection hook**); and a ~60-line static check flags the exact
`createCommentCard`-shaped defect at 4 hits across 177 files.

**Date:** 2026-08-04 · **Machine:** macOS (CJ's dev box), Chromium via Playwright 1.61 ·
**Throwaway rig:** `spikes/spike1137-e2e-production-wiring/` (gitignored, TDD-exempt, never merges) ·
**Baseline:** `origin/main` @ `ee041617`

> Report file is issue-numbered (`1137-…`) rather than `spike5-…`: **SPIKE-5 is already claimed** by
> tech-design.md §"spikes" for voice/ghost-text. This follows the `772-`/`776-` convention.

**Evidence tags:** **[MEASURED]** = produced by running the throwaway rig · **[CODE]** = read directly
out of the tree at the cited location · **[DERIVED]** = argued from the above · **[UNVERIFIED]** =
not checked inside this spike, carried as residual risk.

---

## 1. The Question, and the shape of the answer

> Given that native-webview automation is not viable on macOS, how can the acceptance suite exercise
> the production UI→backend wiring — such that a rendering component with no production caller fails
> a test?

**Answer, in one line:** by asserting the *product outcome* of a *user-initiated* action instead of
the outcome of an injected state change — which the existing rig already permits on every surface
routed through `callBackend`, and which a small transport change extends to the push channels.

The brief's framing assumes the coverage gap follows from the macOS constraint. **It does not**, and
that is the single most important result here. Probe A shows the #1120 assertion was reachable on
macOS, today, with zero new infrastructure. The constraint is real and unchanged (§7) — it was simply
never the binding one.

> **Brief-shape note (honest):** the issue body carries a Question and a Deliverable but no explicit
> `Done-when` / `Timebox` headings. I treated the deliverable line — *"if a direction is viable, show
> it catching #1118 or #1120 in a throwaway rig"* — as the Done-when, and stopped when all three
> directions had been costed by execution. That reading is stated here so a reviewer can disagree
> with it explicitly rather than guess at it.

---

## 2. PROBE A — the rig already reaches the production comment path **[MEASURED]**

Two throwaway Playwright tests against the **unmodified** app, the **unmodified** `playwright.config.ts`
webServer pair (Vite dev + `crates/test-driver`), and no new helpers.

| Probe | What it drives | Result |
| --- | --- | --- |
| **A1** | Real `dblclick` selection in CM6 → `selectionWatcherExtension` → `CommentTrigger` → `CommentPopover` (create mode) → `comments/ipc.createComment` → `callBackend` → HTTP → real `commands::comments::create_comment` → sidecar on disk → returned thread list → `commentHighlights` re-seed. Asserts `.cm-commentHighlight` count. | **PASS (8.4 s)** |
| **A2** | Identical, then asserts the comment is visible in the timeline (Principle 5, "one chronological stream"). | **FAIL** — `element(s) not found`. |

**A2 is #1120, caught.** Not by a new rig, not by a native webview — by making the assertion.

**Why the suite missed it [CODE].** `e2e/acceptance.spec.mjs`'s J4 block seeds every thread through
`e2e/support/commentsDriver.mjs` (a direct HTTP call from the Node process, outside the mounted app —
the file's own comment says so, `:871`), then asserts on the **editor** surface (`.cm-commentHighlight`,
the popover dialog). It exercises the UI for *actions on an existing thread* ("Address with AI",
"Accept both" — real clicks, real `callBackend`), but never once creates a thread through the UI and
never once looks at the timeline for one. `createCommentCard` therefore has 5 test callers and 0
production callers, and every test still passes.

That is a test-authorship choice, not a tooling limit. **[DERIVED]**

---

## 3. PROBE B — the push channel, transported without becoming a mock **[MEASURED]**

This is the crux the brief names ("whether that can be done without the transport becoming a mock…
say so explicitly either way"). **It can. Here is the run.**

**The throwaway patch** to `src/timeline/agentActivity.ts` (reverted; tree is clean):

- `startRun` / `stopRun`: `invoke`-or-degrade → `callBackend`, like every other module.
- `listenToAgentActivity`: inside Tauri, unchanged `listen(ACTIVITY_EVENT, …)`. Outside it, poll
  `callBackend("run_state")` and invoke the **same** `onStatus` callback whenever the status changes.

`crates/test-driver` needed **no change at all** — `/start_run`, `/stop_run` and `/run_state` already
exist, and the crate's own doc already states the load-bearing fact [CODE, `lib.rs:396-400`]:

> *"`/run_state` carries the identical `RunStatus` shape either way, so nothing a script could assert
> on is actually missing, only the push cadence."*

**Result.** Submit through the **production** composer (`getByLabel("Message")` → Enter — no test
hook), and the timeline renders:

```
You | Give me an overview of this document.
■ Agent stopped unexpectedly — spawning agent process: No such file or directory (os error 2)
```

Observed backend traffic on the run alone: `start_run`, `run_state` — plus `open_project`,
`load_tab_session`, `save_tab_session`, `set_open_tabs`, `open_document`, `parse_changes`,
`load_comment_threads`, `discover_grounding`, `detect_providers` from the surrounding journey.
`1 passed (4.2 s)`.

Every element of that chain is production or real-backend: the composer, `startRun`, the real
`RunQueue`, its real spawn attempt, its real `Failed` phase with the real OS errno, the poll, the
production `foldRunStatus`, the production `AgentWorkingCard`. **`window.__COWRITE_E2E__.notifyAgentActivity`
is not called anywhere in this test.** The change *deletes* a D23 hook rather than adding one.

The same shape retires `notifyDelivery` and `notifyDocumentBirth` — but **not for free**: `/run_state`
is a *state* query the queue already exposes, whereas delivery and document-birth are *events* with no
state equivalent. Those need a driver-side event log (§6 step 3). Stated plainly so the cost is not
under-quoted.

---

## 4. PROBE C — catching the class statically, at near-zero cost **[MEASURED]**

`spikes/spike1137-e2e-production-wiring/probeC-orphans.mjs`, ~60 lines: flag every exported
function/component whose only references outside its own file come from `*.test.*` (barrel re-exports
don't count as callers; a symbol used inside its own defining file has a caller and is skipped).

```
src/comments/ipc.ts        linkChanges       -> masked (see caveat)
src/settings/ipc.ts        setSettings       (test-only callers)
src/stores/project.ts      closeProject      (test-only callers)
src/timeline/types.ts      createCommentCard (test-only callers)   <-- #1120
src/timeline/virtualListTestUtils.ts mockClientHeight (a named test-util module)

TOTAL: 4 exports flagged, out of 177 files scanned.
```

- **Catches #1120.** Signal-to-noise is excellent: 4 hits, one of which is a self-declared test-utility
  module trivially allowlisted by path.
- **Does not catch #1118.** `createChatMessageCard` *has* a production caller
  (`TimelinePanel.tsx:750`) — it is only ever called with `"user"`. The defect is in the wire contract
  (`RunStatus` has no field for the agent's text), which no caller-graph check can see. Confirms the
  brief's own expectation.
- **Does not catch #1121** (a revision/anchor-seeding bug, not an orphan).

---

## 5. HAZARD found en route — the e2e driver can spawn a **real, billable** provider run **[CODE + MEASURED]**

Blocking, and not previously recorded anywhere I could find.

- `crates/test-driver`'s `serve()` wires the real `spawn_claude_run` [CODE, `lib.rs:365-375`].
- `spawn_claude_run` → `claude_invocation` → **`claude::BINARY`, a hard-coded `pub const BINARY: &str = "claude"`** [CODE, `src-tauri/src/agent/claude.rs:16`]. It is **not** env-overridable.
- `playwright.config.ts`'s `COWRITE_CLAUDE_BIN` redirects only `agent::providers`' *detection* PATH scan [CODE, `providers.rs:37-44`]. It does not touch the spawn.
- `which claude` on this box: `/Users/cjwilliams/.local/bin/claude` **[MEASURED]** — as on any Cowrite dev box.

⇒ **Any e2e that POSTs `/start_run` fires a real `claude` process, costing real tokens and producing
non-deterministic output.** This is precisely the live-call risk `tests/http.rs` avoids by injecting a
`Spawn` double through `serve_with_queue` — the driver *binary* has no equivalent guard. Probe B had to
strip `~/.local/bin` out of the driver's `PATH` to be safe; that is a workaround, not a fix.

It also **blocks the most valuable direction-1 scenario**: a run that actually *completes* (the one
that would catch #1118's "the answer never appears"). Today the only end-to-end run reachable without
billing is a spawn failure. Note the failure at least renders honestly (FR-X-5) — that much is good news.

**Suggested fix** (implementation card's call): a `COWRITE_AGENT_BIN`-style override on
`claude::BINARY`, or a driver flag selecting a `fake-agent`-backed `Spawn`. `fake-agent` already parses
`--mcp-config` as inline JSON *"exactly as the real `claude` CLI takes it"* [CODE,
`crates/fake-agent/src/main.rs:165-172`], so pointing the spawn at it is a short step, not a rewrite.
**[UNVERIFIED]** — not attempted inside this spike.

---

## 6. The rule (this is the durable output)

The brief asks where the line falls between a testability hook and a substitution that hides the
product. Proposed rule, stated so the suite can be audited against it:

> **A test may substitute the TRANSPORT that carries a call. It may never substitute a PARTICIPANT
> that makes or handles one.**

**Operational test** — for each substitution, name the **producer** and the **consumer** of the value:

| Substitution | Producer | Consumer | Verdict |
| --- | --- | --- | --- |
| `callBackend`'s HTTP fallback | real backend command fn | real frontend module | **Legitimate** — only the wire changed |
| Probe B's `/run_state` poll | real `RunQueue` | production `foldRunStatus` | **Legitimate** — only the cadence changed |
| `notifyDelivery` / `notifyAgentActivity` / `notifyDocumentBirth` | **the test script** | production handler | **Not legitimate** — the hook *is* the participant |
| `openProject` / `openProjectFolder` | the test script | production `App.openProjectRoot` | **Legitimate**, narrowly — it stands in for an **OS dialog**, which is outside the app |
| `setAutosaveIntervalMs` / `setExternalChangePollMs` / `setCommentNowMs` | the test script | production clock reader | **Legitimate** — test-plan §7's injectable clock; it substitutes *time*, not a participant |

**Corollary A (the audit rule).** Every test-only hook must name, in one line, the **out-of-process**
actor it stands in for — an OS dialog, a provider CLI, the wall clock, the user's hands. A hook that
stands in for *the app's own code* is a mock, whatever it is called. The three `notify*` hooks fail this
test; the rest pass it.

**Corollary B (the seam rule).** A bare `if (!isTauri()) return <empty>` in a production module is a
**silent coverage hole**: it makes the production path unreachable under the acceptance suite while
every test still passes. **There are 14 such branches across 9 modules today** [MEASURED —
`onboarding/ipc` 1, `timeline/agentActivity` 3, `timeline/ipc` 2, `stores/delivery` 1,
`stores/appLifecycle` 2, `stores/documentBirth` 1, `stores/menu` 2, `settings/ipc` 2; `backend.ts:19`
excluded, it *is* the transport switch]. Each should be either routed through `callBackend` or listed
in a reviewed exemption list with its reason. None is on such a list today.

`callBackend`'s own docstring already argues exactly this line ("*the transport differs; the command
never does, so this is a testability hook, not a mock*"). The rule above generalises that sentence and
makes it checkable.

---

## 7. On the macOS constraint — it stands, unchanged

No evidence found that anything changed since the 2026-07-15 resolution (journal, P2a-2, #142):
`tauri-driver` still supports Linux (WebKitWebDriver) and Windows (Edge/WebView2) only; macOS WKWebView
still has no WebDriver/CDP story. **This spike does not propose reopening it**, and nothing here
depends on it being reopened.

**Direction 2 (asymmetric native lane) — NOT recommended now. [DERIVED]** After steps 1–3 below, the
residual uncovered surface is exactly two thin, rarely-changing seams: the Tauri `invoke`/`listen`
bridge, and the native folder picker. A second rig costs a second CI configuration and a second set of
selectors *and still leaves macOS — the primary dev platform — uncovered*. That is a poor trade against
a per-surface `callBackend` seam that covers all three platforms identically. Revisit only if a defect
is ever actually traced to the IPC bridge itself.

---

## 8. Recommendation — in cost order

**Step 0 — the static orphan check as a CI script. (hours)**
Cheapest thing here, and it fires on the exact #1120 shape. Use a TS-AST tool (`knip` / `ts-prune`) not
my regex, and ship it with a path allowlist from day one or it will be disabled the first week.

**Step 1 — assert timeline outcomes from UI-initiated actions, in the existing rig. (small)**
No new infrastructure. This is the actual fix for the blind spot on every surface already routed
through `callBackend` — comments first (Probe A is the template). Land alongside the #1120 fix so the
test starts red.

**Step 2 — route `agentActivity.ts` through `callBackend` + the `/run_state` poll; delete
`notifyAgentActivity`. (medium)** Proven working (§3). Net **removal** of a test-only hook.

**Step 3 — give the driver an event channel; delete `notifyDelivery` / `notifyDocumentBirth`. (medium)**
A monotonic `/events?since=<cursor>` long-poll over an append-only log is enough, and stays
request/response (no SSE/websocket needed in a loopback test surface). Same producer, same consumer,
different cadence — legitimate by §6's rule.

**Step 4 — fix the real-`claude`-spawn hazard (§5). (small, but BLOCKING)**
Must land before any `/start_run`-driving e2e merges, and before a #1118 regression test is possible at
all. Sequence it with step 2.

**Not recommended:** direction 2 (§7).

---

## 9. Proposals for CJ (DH-7) — **proposed, NOT applied**

Nothing in `docs/` outside this report and the journal verdict was edited.

1. **Record the substitution rule in `docs/test-plan.md` §7**, alongside "never mock in e2e": the
   transport-vs-participant rule plus Corollaries A and B (§6). Rationale: the current suite honours
   the letter of "never mock" while losing its intent, and there is no stated test by which a reviewer
   could have caught that. This is the spike's most durable output and it is exactly a recorded-decision
   change — CJ's alone.
2. **Reconcile `docs/test-plan.md` §1's "Playwright/WebDriver against the real app"** with the
   2026-07-15 resolution. The constraint itself is *not* being reopened (§7); §1's wording simply
   describes a rig that does not exist and cannot on macOS, which is how "drive the real app" keeps
   getting re-litigated. Proposal is wording-only.
3. **Adopt Corollary B's exemption list** for the 14 `if (!isTauri())` no-op branches — each routed, or
   listed with a reason. (Depends on 1.)

---

## 10. Caveats carried to implementation

- **The poll's shape is a spike simplification.** Probe B used `active ?? lastFinished`, `JSON.stringify`
  change detection, and a flat 50 ms cadence. A real implementation must (a) stop polling once the run
  is terminal, (b) handle `last_finished` being overwritten when a run finishes while another is queued
  — `RunQueueState`'s own doc warns about exactly this, and (c) surface the queued list for FR-AGENT-7.
- **Polling can coalesce intermediate updates a real `listen()` would deliver one at a time.**
  `RunStatus.activity` is cumulative, so no *line* is lost — but a test asserting arrival *cadence*
  would be asserting the transport, not the product. **[DERIVED]** Any test that breaks under
  coalescing is testing the wrong thing; say so in the test's own comment.
- **Probe B's PATH-stripping is a workaround, not the fix.** See §5. Do not copy it into a merged config.
- **The timeline panel has no stable test hooks** — zero `data-testid` in `TimelinePanel.tsx`
  [MEASURED]. Probe A/B leaned on text and class selectors. Step 1 will want real hooks first, or it
  will produce brittle tests and get blamed on the approach.
- **Probe C is regex-level, not AST-level**, so a doc-comment mention of a symbol masks it (that is why
  `linkChanges` and `deliveryTransaction` drop out of the refined run). Expect the AST version to flag
  *more*, not fewer. Its output is a **flag for review, not a verdict** — `setSettings` / `closeProject`
  may be legitimately-pending seams rather than defects. **[UNVERIFIED]** — not individually triaged.
- **The patched `agentActivity.ts` was never run against `npm test`.** Removing the degrade-outside-Tauri
  returns changes those functions' unit-test surface. The implementing card TDDs it; this spike did not
  (test-plan §9b, spikes are TDD-exempt).
- **#1118 is caught by none of these directly.** After steps 2 and 4, a test that submits a question and
  asserts an agent reply card *would* catch it — but only once a run can actually complete. Sequencing
  matters; a #1118 regression test written before step 4 will assert against a spawn failure and prove
  nothing.

---

## Verdict

**The blind spot is a substitution-discipline failure, not a platform limitation.** The macOS
native-webview constraint stands and is irrelevant to it. Land the static orphan check (step 0) and
UI-initiated timeline assertions (step 1) immediately — both are cheap, and together they cover the
#1120 shape on every surface already behind `callBackend`. Then transport the push channels (steps 2–3,
proven for `agent://activity`) and fix the billable-spawn hazard (step 4, blocking). Decline the
asymmetric native lane. Ask CJ to ratify the transport-vs-participant rule so the suite has something
auditable to be measured against — that rule, not the tooling, is what would have prevented #1118 and
#1120 from being written as "green".

Spike code throwaway in `spikes/spike1137-e2e-production-wiring/` (gitignored), never merges.
**Independent spike-review pending** (separate agent, DH-13).
