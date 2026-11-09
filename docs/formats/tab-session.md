<!-- ABOUTME: On-disk format of `.emend/tab-session.json` — FR-ED-3's per-project tab-session -->
<!-- ABOUTME: restore state (TD §3.1, P2a-6); machine-local and gitignored per TD-12 (amended). -->

# Tab-session format (`.emend/tab-session.json`)

The `store::tab_session` sidecar behind FR-ED-3's per-project session restore:
which tabs a project's window had open, in order, which one was active, and
each dirty tab's capped unsaved content, so relaunching Emend restores the
same working set. It also carries untitled recovery documents that exist *only*
here: preserved buffers displaced by an external move (#932, J2) or retained
from a legacy unsupported document tab (#2515, D27). Neither has a file to
restore its current text from.

**Machine-local, not a TD-4 collaboration sidecar.** Unlike `comments/`,
`changes/`, and `docs.json` — repo-owned data committed by default — a tab
session is per-machine UI state: which files *this* window had open, and
in-flight edits nobody has chosen to save yet. It is excluded from
commit/sync via the committed `.emend/.gitignore` (TD-12, amended 2026-07-16
to generalize from lock files to this explicit list), maintained by
`store::gitignore::ensure_pattern` before the very first session write.

## Writer authority and receipts

`tab-session.json` has one logical writer per canonical project root. A renderer
must acquire that writer before it restores or saves, and must release it after
its queued writes drain:

The stable writer identity combines the Tauri window label with a
session-stored nonce, so reload reattaches the same window while a different
window remains a different logical writer. Each renderer module also mints a
fresh attachment id. Reattachment replaces that generation only after the
durable snapshot loads, so delayed saves or releases from the pre-reload module
cannot invalidate the current owner.

1. `begin_tab_session(root, writer_id, attachment_id)` canonicalizes `root`,
   acquires the OS writer lease, and returns the canonical root, accepted
   attachment id, sanitized durable session, and revision in one authoritative
   snapshot. A failed load commits neither a new root nor a replacement
   attachment.
2. `save_tab_session(..., writer_id, attachment_id, expected_revision, session,
   policy)` is accepted only from that exact attachment and only when the
   durable session still has the expected revision. Its receipt carries the
   exact session committed, its new revision, and one outcome per requested
   tab: `restored_from_disk`, `persisted_exact`, or `omitted_over_cap`.
3. `prove_tab_session(..., writer_id, attachment_id, expected_revision,
   session)` is the authoritative no-write close path. It runs on the same
   serialized writer lane, validates and materializes the proposed payload,
   rejects any omitted recovery content, requires byte-for-byte equality with
   the current canonical durable snapshot, and returns that snapshot's receipt
   without writing or advancing its revision. A local equality comparison is
   never a durability proof.
4. `end_tab_session(root, writer_id, attachment_id)` explicitly unlocks and drops
   that root's lease only for the current attachment and only after the renderer's
   save lane drains. Coordinator teardown uses the same owner-drop release, so a
   duplicated or inherited descriptor cannot prolong a cleanly ended writer's lease.
   A stale attachment's release is a no-op. An OS process exit also
   releases the lease automatically.

The lease is machine-local app state, not a project artifact: it lives at
`<app_local_data_dir>/tab-session-writers/<blake3(canonical root)>/lock`, in the
same per-user ownership domain TD-20 establishes and in the same
`<area>/<key>/` shape every per-project app-local-data store resolves through
`store::project_identity::project_dir` (#2245). The file carries no content: its
only state is the OS lock held on the open handle, which the OS releases on
process exit including a crash. Before #2245 the lease was the flat file
`tab-session-writers/<key>.lock`; such a file is a zero-byte artifact of a
development build and is left alone rather than swept, the disposition TD-12's
amendment already records for a pre-relocation `lock*` line. Nothing
adds an `.emend/lock*` file or revives the pre-TD-20 `.cowrite/lock*`; TD-12's project-tree exclusion remains exactly
`tab-session.json`. Holding the OS lease across the complete writer lifetime
makes the fixed-temp atomic writer single-writer across windows and processes.
The revision comparison is a second guard: a stale renderer cannot overwrite a
session changed outside its acknowledged lane.

## File shape

One JSON object, whole-file-rewritten on every save (`store::atomic::write_json`
— write-to-temp + rename, never a torn file):

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | integer | Format revision. Currently `1`. |
| `tabs` | array of `TabSnapshot` | The open tab set, in tab-strip order. |
| `active_path` | string \| `null` | The tab that was focused, or `null` if none was. |

`TabSnapshot`:

| Field | Type | Meaning |
|---|---|---|
| `path` | string | The tab's identity. For an ordinary tab this is its project-relative path (§3.5 confinement). For an untitled recovery document (`recovered_from` non-null) it is an opaque identity the app minted — currently spelled `untitled:<n>:<former path>` — which names no file and is never resolved against the filesystem. Nothing parses it; which of the two kinds a tab is, is `recovered_from` and nothing else. |
| `unsaved_content` | string \| `null` | Content to restore into the tab instead of reading its file. `null` means no content bytes are present in this field; `unsaved_content_omitted` is the sole current-format authority for whether bytes were deliberately omitted over cap. Non-null for a dirty tab, and **also for an untitled recovery document, which is never dirty**: that document has no file to restore from, so this field is the only durable copy of it. |
| `recovered_from` | string \| `null` (optional) | Non-null only on an untitled recovery document (#932/#2515, J2), naming its former project-relative path. That path may have been displaced by an external move or refused on legacy restore because its document type is unsupported. `null`/absent means an ordinary project tab. Absent entirely in files written before this field existed — see the `schema_version` judgment below. |
| `displaced_label_ordinal` | integer \| `null` (optional) | Stable creation-order disambiguator for repeated displacement of the same `recovered_from` path (`9d.3`). Assigned when the recovery document is created, persisted without deriving it from the opaque `path`, and never renumbered when a sibling closes. Legacy absence is assigned fail-soft by the frontend and becomes durable on the next checkpoint. |
| `unsaved_content_omitted` | boolean (optional; default `false`) | `true` when the writer received unsaved content but omitted it because its UTF-8 byte length exceeded the 2 MiB per-tab cap. The fact can coexist with later retained current text and must remain recorded across a D27 conversion. It distinguishes a deliberate cap outcome from `unsaved_content: null`'s ordinary clean-tab meaning. On a recovery document it drives J2's standing over-cap state. |
| `loss_notice_collapsed` | boolean (optional; default `false`) | The author's presentation choice for an over-cap recovery document: `true` shows the persistent one-line statement and Details control instead of the full explanation. It is meaningful only when `recovered_from` is non-null and `unsaved_content_omitted` is true; impossible combinations normalize to `false`. |

### Why `recovered_from` is a field and not a spelling

The app needs to know whether a restored tab is a project document or a
pathless buffer with no file: a project document joins D21's protected set,
is opened, saved, and polled, and marks a row in the project rail; a recovery
document does none of those. That distinction was originally read off the
`path` prefix, which is wrong (CJ, 2026-08-12): any string that survives §3.5
confinement is by construction a possible project-relative path, and
`untitled:1:notes.md` is a legal filename on macOS and Linux. A document
legitimately named that way would have been classified as a recovery document
and silently dropped out of the protected set. Carrying the fact as its own
field makes the classification a record the writer states rather than a guess
the reader makes.

### `schema_version` judgment for optional additive fields (#932 / #1421)

**`schema_version` stays `1`.** The rule this module states for itself is that
the version is bumped whenever the on-wire shape changes; the judgment recorded
here is that it applies to a change a reader could *misinterpret*, and this one
cannot be:

- **Reading an older file** (no `recovered_from`) yields `None`, which means
  "an ordinary project tab" — precisely what every writer of such a file meant,
  since no build that wrote one could produce a recovery document. Nothing is
  guessed.
- **Bumping instead would destroy data.** `parse_or_fresh` deliberately accepts
  only files its own exact version wrote (fail-soft restore, below), so a bump
  discards *every* existing session on the first launch after the upgrade —
  including the unsaved buffers of dirty tabs, which is exactly the loss this
  field was added to prevent. A certain, universal cost to guard a rare one.
- **What a downgrade does:** an older build ignores the unknown field and
  restores the recovery document as an ordinary tab at its `untitled:<n>:`
  identity, holding the buffer and failing to load a file of that name. That is
  degraded, but the work is still on screen and still in the file; bumping would
  have made that same older build discard the whole session instead. This half
  rests on the shape tolerating unknown fields, which a build of the current
  vintage cannot otherwise demonstrate, so it is pinned by execution rather than
  assumed: `a_field_this_build_does_not_know_is_ignored_rather_than_failing_the_restore`.
  Adding `deny_unknown_fields` to these shapes would silently invalidate it, and
  fails that test instead.

A future change that *reinterprets* an existing field, or removes one, does not
have this property and takes the bump.

The #1421 fields follow the same additive rule: the boolean fields default to `false` and
`displaced_label_ordinal` defaults to absent, so a
version-1 file written before they existed keeps every tab and buffer. A legacy
recovery record with non-null `recovered_from` and null `unsaved_content` is
normalized once at the Rust storage boundary to
`unsaved_content_omitted: true`; that pairing was the pre-field representation
of an over-cap J2 recovery document. Current writers persist the outcome
explicitly, so frontend state and later relaunches never depend on re-inferring
it. A missing ordinal is assigned without parsing the opaque identity and is persisted on the next
checkpoint; a present ordinal survives unchanged. Unknown fields remain tolerated in the downgrade direction.

## The per-tab unsaved-content cap

`unsaved_content` is kept only when its UTF-8 byte length is at or under
`UNSAVED_CONTENT_CAP_BYTES` (2 MiB, `store::tab_session::UNSAVED_CONTENT_CAP_BYTES`).
Over-cap content degrades that one tab to `unsaved_content: null` — restore
from the last content actually saved to disk — rather than failing the whole
session save; an ordinary prose chapter is far under the cap, so this only
ever bites a genuinely oversized in-flight edit.

The cap is applied to an untitled recovery document the same way during an
ordinary background save. Because that document has no disk fallback, callers
that are proving a lossless close instead use the `require_untitled_lossless`
policy: any over-cap recovery buffer rejects the whole write with
`UntitledContentOmitted`, changes nothing on disk, and therefore cannot be
mistaken for a durable close receipt (#1421).

The writer records that cap outcome as `unsaved_content_omitted: true`; for a
recovery document the frontend maps it to `recoveryContentOmitted` and persists
the author's `lossNoticeCollapsed` choice. An immediate checkpoint therefore
cannot replace the omitted buffer with an empty string and make the next
relaunch look like a preserved empty document. Legacy version-1 records are
normalized only from the old `recovered_from` + null-content pair in Rust before
IPC, then written back in the explicit shape; an already-normalized empty-content
record is ambiguous and is not classified as omitted. The buffer itself stays unrecoverable
— raising or exempting the cap for this one kind of tab remains a separate,
larger decision — while J2's amber qualifier, tab dot, notice/collapsed line,
permanent conditions strip, and specialized close-guard copy persist for the
life of the untitled tab. A separate live-over-cap state covers bytes still
present in the current process but too large for the next snapshot; it never
claims those bytes have already been lost.

## Fail-soft restore

A tab-session file is disposable, machine-local UI state, not an audit trail —
reading it therefore has exactly two acceptable outcomes: the session it
names, or "no session to restore." It **never** crashes and **never** restores
the wrong content:

- **Missing file** (first open, or the runtime file was never written) restores
  an empty session — the same "missing = fresh" convention `docs_map::load` uses.
- **Truncated/invalid JSON, or a sync-conflict artifact** (e.g. two machines'
  writes concatenated by a non-git sync tool) degrades to a fresh empty
  session (`store::tab_session::load`).
- **An unrecognized `schema_version`** (a build newer or older than the one
  that wrote the file) also degrades to a fresh empty session, rather than
  attempting to interpret fields under an assumption that may not hold.
- **A tab whose `path` fails §3.5 confinement against the project root** — an
  absolute path, a `..` escape, or a path from a *different* project's session
  file synced in via a non-git, non-gitignore-respecting channel (Dropbox-style
  folder sync delivers exactly this) — is dropped individually
  (`commands::tabs::load_tab_session`); `active_path` is cleared if it named a
  dropped tab. The rest of an otherwise-valid session still restores.

Gitignore governs only git; a `.gitignore` entry is inert against non-git sync
channels, which is exactly why the restore path — not just the write path —
must be defensive about this file's contents.
