# Adoption provenance — durable, idempotent, exactly once

Ratified by CJ 2026-08-28 (disposition 1). Draws `9f.2` and `9f.3`.

## The record and its projection

> **Persist a durable machine-local scratch-adoption event keyed by a stable adoption id. The timeline card is its visible D15 projection, not the durable record. Publication retries idempotently across relaunch.**

This is what makes the requirement compatible with **D15** itself, which holds that the transcript is machine-local scaffolding and not durable output. The **event** is the record; the **card** is a rendering of it that can be rebuilt if the transcript is lost or rewritten.

| | Durable event | Timeline card |
|---|---|---|
| Owns the fact | **Yes** | No |
| Keyed by | Stable adoption id | The same id, carried through |
| If lost | The provenance is gone | Re-projected from the event |
| Write discipline | Awaited, confirmed | Ordinary D15 append |

## Phases — the event is a state machine, not a flag

| Phase | Meaning | May project? |
|---|---|---|
| `prepared` | Event persisted with its `adoptionId`, displaced path, over-cap outcome and intended destination. **File success is not yet durably confirmed by the event**: the write may not have begun, or it may have succeeded before phase promotion. | **No** |
| `file-committed` | The file Save As succeeded. The adoption is real and irreversible | **Yes — the only phase that may** |
| `published` | The D15 projection is confirmed appended | Already done |
| `cancelled` / `tombstoned` | The adoption did not happen, or its event is superseded. Terminal | **Never** |

**Only `file-committed` events may project.** A `prepared` event has no durably confirmed adoption behind it; publishing directly from one would assert an unverified save. **A file failure, or a failure while cleaning up, must never publish a false adoption** — cleanup failure leaves the event `prepared` or moves it to `tombstoned`, and neither projects.

## Ordering — the event precedes the irreversible boundary

1. Mint a **stable `adoptionId`**.
2. Persist the event as **`prepared`**, and **await it**. If this fails, the adoption does not proceed.
3. Perform the **file** Save As.
4. On success, transition the event to **`file-committed`**, and **await that too** — this is the durability boundary.
5. Publish the D15 card carrying the `adoptionId`.
6. On confirmed append, transition to **`published`** and clear all pending UI state.

Step 2 precedes step 3 so the omission provenance **cannot disappear between file success and card commit**. Step 4 precedes step 5 so a crash after the file write still leaves a durable, projectable record.

## Crash and relaunch recovery, boundary by boundary

On launch, every non-terminal event is reconciled:

| Crash point | On relaunch |
|---|---|
| Before `prepared` is durable | Nothing exists. No adoption, no card |
| `prepared`, before the file write | **Verify the destination.** No file ⇒ **tombstone**; nothing is published, the untitled document is unchanged |
| `prepared`, file written but the phase not promoted | **Authoritative reconciliation**, never a guess. **Verified file success** ⇒ promote to **`file-committed`**, then project **exactly once**. **Not verifiable** ⇒ the event **remains non-projectable** and surfaces as **reconciliation pending**; Emend **neither publishes nor tombstones on a guess** and retries later |
| `file-committed`, before publication | **Publish now.** This is the ordinary pending case (`9f.2`) |
| `file-committed`, publication may or may not have landed | **Deduplicate by `adoptionId`**: if the transcript already holds a card with that id, transition to `published` and append nothing |
| `published` | Nothing to do |

**Idempotent deduplication is by `adoptionId`.** Every projection carries it, every append is matched on it, and a repeat is a **no-op**, not a second card. Retries are unbounded in count and safe in effect; `adoptionId`s are never reused, including after a tombstone.

## Outcomes

| Outcome | Result |
|---|---|
| **Pending-event write fails** | The adoption does not proceed. The untitled document is **unchanged**; the failure renders in the surface that started it (`9d.2`) |
| **File Save As fails** | **The untitled document is unchanged** — same buffer, same notice, same flags. The pending event is discarded and its id never reused |
| **File succeeds, `prepared → file-committed` fails** (same session) | **The file and the adoption succeeded** — the tab is an ordinary project document. Show the **provenance-pending** line, **not** a Save As failure. The event stays **non-projectable** until reconciliation promotes it; reconciliation retries automatically; the card is **never duplicated** |
| **File succeeds, publication fails** (`9f.2`) | The document **is** adopted and saved. An honest **provenance-pending** line shows. The event stays durable and pending |
| **Both succeed** (`9f.3`) | The ratified card is published; pending state clears |
| **Retry or relaunch** | Publication retries from the durable pending event and completes the **same append exactly once**, matched by adoption id. A duplicate attempt is a no-op |

**Only after the D15 append is confirmed may any temporary provenance state clear.** Nothing clears on a timeout, a tab close, or a relaunch.

## Copy

**Provenance-pending line** — non-modal, `role="status"`, Reject family (`#F8EFED` / `#DCC4BF` / `#A33A2E`), directly under the status strip of the newly adopted document:

> Saved to *`<path>`*. Emend hasn't yet recorded that the earlier unsaved work wasn't part of it — it will finish next time it can.

It states what **did** happen before what has not. It offers no retry control: retry is automatic and idempotent, and a manual one would invite duplicate appends.

**The published card** (ratified copy, unchanged):

> Untitled saved as **`<chosen-path>`**. The unsaved work from *`<displaced-path>`* that exceeded the session limit was not part of it.

The second sentence is an **implementation requirement** wherever the adopted tab was an over-cap recovery document.

## Architecture dependency

The **event store, its phase transitions, crash reconciliation and `adoptionId` deduplication are owned by the Architect** (see `state.md`, Architecture ownership). This spec binds the phases, what may project, the recovery outcome at each boundary, and the copy — not the storage mechanism.

**Current `main` has no scratch-adoption card of any kind**, and `appendTranscriptEvent` is best-effort and swallowed (`TimelinePanel.tsx`). Both the new card kind and the awaited, confirmed append are new work, at the TabbedEditor→App seam.

## Accessibility

The pending line is `role="status"`, announced politely once; it does not take focus. On completion it is **removed silently** — nothing is announced, because nothing changed for the author. Focus is never moved by either transition.
