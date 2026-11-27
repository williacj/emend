ABOUTME: On-disk format of `.emend/conversations/` — each conversation's portable record as per-device
ABOUTME: append-only JSONL event logs (FR-CONV-8, TD-4 amended #94), validated by `conversation-event.schema.json`.

# Conversation records (`.emend/conversations/`)

The portable half of a conversation (FR-CONV-8, D15 as amended): its visible history, its
accepted handoff, and stable references to its runs and to the documents they changed. It is a
TD-4 event-log sidecar, built on the comment logs' pattern: append-only JSONL, one file per
writer, and state that is the fold of every file. `conversation-event.schema.json` beside this
file validates one line.

What continues a provider session is not here. A provider resume ID, the revision it has
consumed, and a handoff offered but not yet sent are machine-local, under the app's local data
directory (TD-5 amended #94). Credentials stay in the OS keychain (FR-X-2).

## Directory layout

```
.emend/conversations/
  <conversation-id>/
    <author>-<device-id>.jsonl
    <author>-<device-id>.jsonl
    ...
```

- **One directory per conversation.** `<conversation-id>` is a UUID that Emend mints when the
  conversation is created, and it never changes. A document conversation keeps it through Save
  As, rename and move (FR-CONV-7), because the link to its document is the `document_uuid` in its
  events, never a path.
- **One log per writing device.** Each file holds every event one device wrote for this
  conversation, in the order the device wrote them.
- **Nothing else lives in the directory.** A reader folds every `*.jsonl` file in it and ignores
  any other file.

## Per-device log file naming

`<author>-<device-id>.jsonl`, where:

- `<author>` is the author value of the person using the writing device: the same value TD-4's
  comment logs name their files by (`.emend/comments/<document-uuid>/<author>.jsonl`).
- `<device-id>` is the writing device's id: a lowercase hyphenated UUID, 36 characters long, that
  Emend mints once per installation and keeps in the app's local data directory. It never travels
  with a project except as this file name and the `device` field.

**A device appends only to its own file.** Two devices therefore never write the same file, and
combining their records never conflicts (FR-CONV-8). Every line is one complete JSON event
followed by `\n`, and the writer never rewrites or reorders a line already written. §3.2b's
`merge=union` attribute for `.emend/**/*.jsonl` covers these files as well.

A reader takes identity from each event's `author` and `device` fields, never from the file
name. The name exists so that two devices' files differ; it is not parsed. Because `<device-id>`
has a fixed length, the name stays unambiguous when `<author>` itself contains a hyphen.

## The event envelope

Every event carries the comment-event envelope plus `device`:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | integer | The revision of this contract the event was written under. `1` today. |
| `id` | string | Globally unique, minted by the writer (UUID/ULID). |
| `parent_id` | string, or null | The last event of this conversation the writing device had seen when it wrote this one. Null only for `conversation_created`. Two events sharing a `parent_id` are a divergence point: two devices continued from the same place. |
| `author` | string | Who acted. The person's author value for an act the person took; `agent` for `agent_reply`; `emend` for a fact the app records (`run_ref`, `migrated`, and a `conversation_created` or `renamed` Emend writes itself). |
| `device` | string | The writing device's id, as in the file name. |
| `timestamp` | integer | Milliseconds since the Unix epoch, from the writing device's clock. Clocks are expected to disagree. |
| `type` | string | One of the event types below. |

## Event types

The record holds what a reader needs to see the conversation, and no more.

| `type` | Fields beyond the envelope | Written when |
|---|---|---|
| `conversation_created` | `name` (string); `kind` (`"document"` or `"workshop"`); `document_uuid` (the `docs.json` UUID for a document conversation, null for a Workshop conversation or an untitled document with no identity yet); `origin` (optional: `{conversation_id, run_id}` of the run a document was born from, FR-CONV-5) | The conversation begins: a document's first conversation, a new Workshop conversation, a birth by `create_document`, or migration. |
| `renamed` | `name`; `kind`; `document_uuid` — the same fields, carrying the new values | The conversation's name changes, or a document conversation gains or changes its document identity, as when an untitled document is first saved or a conversation is relinked to a moved document (FR-CONV-7). |
| `user_turn` | `text` (the author's message, exactly as sent); `run_id` (the run it started, absent only on a turn converted by migration); `unsaved_sent` (optional: one `{document_uuid}` entry for each document whose unsaved text the turn sent) | The author sends a turn. |
| `handoff_accepted` | `text` (the exact summary text sent, after any edit); `source_conversation_id`; `source_run_id`; `run_id` (the run that received it) | The author sends a turn that carries a handoff (FR-CONV-6). |
| `agent_reply` | `text` (the run's final reply); `run_id` (absent only on a reply converted by migration) | A run ends with a final reply. |
| `run_ref` | `run_id`; `outcome` (`"completed"`, `"recovered"`, `"failed"` or `"stopped"`); `changed_documents` (the `docs.json` UUIDs of the documents the run changed); `home_conversation_id` (optional, below) | A run ends. In its own conversation the event has no `home_conversation_id`. Emend also writes it into the conversation of each other document the run changed, there carrying `home_conversation_id`, which is FR-CONV-3's link back to the run. |
| `migrated` | `source` (`"project-transcript"`); `imported_count` (how many converted events follow) | Migration converts a project's earlier machine-local history into this record (FR-CONV-10). The converted `user_turn` and `agent_reply` events follow it. |

An event whose `type` is not in this table is skipped by the fold, never rejected (test-plan P5),
so a later revision can add a type without breaking an older reader.

## What the record never holds

- **Unsaved document text.** Where a turn sent unsaved text (FR-CHAT-4, J13), `unsaved_sent`
  records that it did and which document, never the text. Unsaved words therefore never enter the
  project or its version history. An accepted handoff's `text` is the one verbatim exception
  (FR-CONV-6).
- **Progress, the activity feed and permission prompts.** They are temporary and machine-local.
- **Provider session IDs and credentials** (FR-CONV-8, FR-X-2).
- **Tool calls, tool results and the content of deliveries.** `run_ref` names a run's outcome and
  the documents it changed. What changed in them lives in the documents and their change and
  comment sidecars, so a record can never replay a delivery (FR-CONV-9).

## Reading the logs

The visible conversation is the fold of every log in the directory. Its order, where it places
the marker between two devices' histories, and when a record counts as one that could not be
combined are `docs/tech-design.md`'s TD-4 (amended #94). Reading a conversation needs nothing
beyond its own directory and `.emend/docs.json`, which resolves each `document_uuid` to a
current path.

Agents may read these files; only Emend writes them (FR-CONV-8).
