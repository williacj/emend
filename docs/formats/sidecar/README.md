<!-- ABOUTME: Catalog + provenance of the Cowrite sidecar JSON Schemas (comment events, track-changes attribution, doc identity). -->
<!-- ABOUTME: The FR-X-8 portability contract for `.emend/` (TD-4); validated by the `store::schema` conformance module (test-plan §3 stores). -->

# Sidecar schemas

The machine-readable half of TD-4's sidecar portability contract (FR-X-8: "the
sidecar schemas … are documented public formats"). Everything Cowrite writes
under a project's `.emend/` directory is plain JSON/JSONL, committed by
default, and constrained by one of these schemas — so the data outlives Cowrite
itself and other tools can read it.

Every schema is JSON Schema **draft 2020-12** and carries a top-level
`schema_version` (integer) identifying the contract revision, independent of
the draft meta-schema. Every *instance* (comment event, change record, the
`docs.json` file) also carries its own `schema_version` field (TD-4: "every
file carries `schema_version`") — the two are related but distinct: the schema
document's version is the contract revision; the instance's version is which
revision of the contract that particular value was written under.

## Catalog

| File | What it validates | On disk |
|---|---|---|
| `comment-event.schema.json` | One line of a comment event log | `.emend/comments/<doc-hash>/<author>.jsonl` — one JSONL file per document per author, append-only |
| `change-record.schema.json` | One track-changes attribution record | `.emend/changes/<doc-hash>.json` — a single JSON object per document, keyed by change id: `{"<change-id>": ChangeRecord, ...}`; each value conforms to this schema |
| `docs-map.schema.json` | The whole document-identity map file | `.emend/docs.json` — one file per project, mapping a per-doc UUID to its current project-relative path |
| `project-config.schema.json` | The whole project-config override file | `.emend/config.json` — one file per project, overriding the `skills/` module's discovery defaults (FR-SKILL-5); optional, degrades to the ratified defaults when absent/unreadable/malformed (FR-X-5) |

## Grounding & drift tolerance

- **`comment-event.schema.json` is drift-tolerant by design**, matching
  `docs/formats/provider-contract`'s stream-event schemas: an unrecognized
  `type` value still validates (only the envelope fields — `schema_version`,
  `id`, `author`, `timestamp`, `type` — are checked), because the causal fold
  (test-plan P5) is built to skip unknown event kinds rather than reject the
  whole log. A *known* `type` is checked for its load-bearing fields, including
  that `parent_id` is present and non-null for every type except `create` (the
  one that starts a new thread).
- **`publish` is durable evidence of review visibility (D20/J10).** It names a
  root comment in `parent_id` and is appended by review sync when that root
  reaches an external audience. Its effect is permanent: withdrawing the root
  later leaves a bodyless placeholder even when no reply survives. An ordinary
  local `create` or `reply` never implies publication. This build has no review
  sync producer yet, so it writes no `publish` events. An older reader that
  skips `publish` can omit that placeholder; a reader that skips `withdraw`
  instead may still show the original body. The append-only log retains both
  facts for readers that understand them.
- **`change-record.schema.json` is strict** on the fields it declares — this is
  Cowrite's own single-writer attribution format (D19), not a
  forward-compatibility surface, so an unrecognized `kind` is a contract
  violation. The record intentionally carries no range/text of its own: the
  CriticMarkup marker live in the document is the source of truth for *what*
  changed (TD-2); this schema only records *who* changed it and how it's
  grouped/noted.
- **`docs-map.schema.json`'s real producer/consumer is `store::docs_map`**
  (P2a-10, `src-tauri/src/store/docs_map.rs`), wrapped by the sidecar store
  service (`store::service::SidecarStore`) that owns the doc-identity
  lifecycle TD §3.2b describes: mint-at-first-write, rename/move as one map
  update, delete-surfaces-disposition, and scratch-doc adopt-on-save-in
  (FR-ED-8). It still binds to this same published schema in a
  `conformance_tests` module, the way P1-9/P1-10 already do for the other two
  — `examples/docs.example.json` remains the committed fixture the schema
  itself is checked against.
- **`project-config.schema.json`'s real producer/consumer is `skills::config`**
  (P2b-8a-ii, `src-tauri/src/skills/config.rs`), read once per `skills::discover`
  call. Unlike the other three files here, this one is optional and untrusted
  input by construction — every path it names is run through
  `commands::path_confine::confine` (§3.5) before it is ever walked, and the
  whole file degrades to the ratified defaults (`skills` module doc) rather
  than failing project open when it is missing, unreadable, or malformed
  (FR-X-5). Its own `additionalProperties: true` at the top level (vs. `false`
  inside `skills`/`workflows`) is deliberate: an unrecognized top-level key is
  forward-compatible (a later card's own override key), but an unrecognized
  *shape* for a key this schema already owns (e.g. `skills` not an object,
  `workflows.glob` not a `<dir>/*.md` string) is a contract violation, not a
  future extension. `examples/project-config.example.json` is the committed
  fixture checked against it.
- **Shared anchor shape.** Both `comment-event.schema.json` and
  `change-record.schema.json` embed TD-4's shared anchor shape (`offset,
  length, text_snapshot, context_before, context_after, base_revision`) as a
  local `$defs.anchor` — duplicated rather than cross-file `$ref`'d so each
  schema file stays self-contained (the same convention
  `provider-contract/mcp-tool-call.schema.json` uses for its own, simpler,
  agent-facing anchor `$def`). `base_revision` is a content-hash token
  (`"<algorithm>:<hex>"`, TD-6) naming the exact document text the anchor's
  `offset`/`length` were measured against.

## Validation helper

The reusable helper lives in `store::schema` (`src-tauri/src/store/schema.rs`),
test-only (`#[cfg(test)]`) since nothing outside this crate's own test suite
consumes it yet — `store::comments` and `store::changes` bind their own wire
shapes to these schemas in their `conformance_tests` modules. It embeds the
schemas above at build time (`include_str!`) so validation always runs against
the *published* contract (test-plan §3: "the contract *is* a fixture"). API:

```rust
use crate::store::schema::{self, Schema};

// Validate a single decoded value:
schema::validate(Schema::CommentEvent, &value)?;   // Result<(), Vec<String>>
schema::is_valid(Schema::ChangeRecord, &value);     // bool
```

`Schema` variants: `CommentEvent`, `ChangeRecord`, `DocsMap`, `ProjectConfig`.
See the module's rustdoc for details.
