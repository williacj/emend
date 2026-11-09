<!-- ABOUTME: Catalog + provenance of the Cowrite provider-contract JSON Schemas (stream-JSON grammar + MCP payloads). -->
<!-- ABOUTME: The machine-readable half of TD-1's contract; validated by the `provider-contract` crate and consumed by the fake agent (test-plan §1). -->

# Provider contract schemas

Machine-readable half of the TD-1 provider contract. These schemas let the test
rig keep the **fake agent honest** (test-plan §1, "contract parity"): fake-agent
output is schema-validated in every e2e run, and live-smoke recordings validate
against the *same* schemas — the version-drift canary is "a recorded real session
still parses under the schema the fake is built from".

Every schema is JSON Schema **draft 2020-12** and carries a top-level
`schema_version` (integer) identifying the contract revision, independent of the
draft meta-schema.

## Catalog

| File | What it validates | Provenance |
|---|---|---|
| `stream-event.claude.schema.json` | One event from Claude Code CLI `-p --output-format stream-json --verbose` | SPIKE-1 recorded transcript §5.2 + §3.1 |
| `stream-event.copilot.schema.json` | One event from GitHub Copilot CLI `-p --output-format json` (JSONL) | SPIKE-1 recorded transcript §5.3 + §4.2 |
| `mcp-server-config.schema.json` | The `mcpServers` config Cowrite auto-wires into a spawned CLI | SPIKE-1 §4.3 (empirically captured) |
| `permission-hook-decision.schema.json` | A Copilot `preToolUse` hook decision (`allow`/`deny`/`ask`) | SPIKE-1 §4.4 |
| `permission-callback.claude.schema.json` | Native Claude permission callback arguments before TD-1 adaptation | Claude 2.1.263 live callback, 2026-09-07 |
| `mcp-tool-call.schema.json` | Arguments for a Cowrite-hosted MCP tool call (`{name, arguments}`) | TD-1 §3.2 tool surface (design contract) |

## Grounding & drift tolerance

- **Stream-event schemas are drift-tolerant by design.** An unknown `type` value
  validates (so a newer CLI build still parses — the canary); a *known* event
  type is checked for its load-bearing fields. Providers add fields freely, so
  additional properties are allowed on stream events.
- **`mcp-tool-call.schema.json` is strict** (`additionalProperties: false` on each
  tool's arguments) — these are *our own* tools, so unknown keys are a contract
  violation, not forward-compat. Argument shapes come from the binding TD-1 §3.2
  table. The tool-*call*/*result* stream-event framing was **not** exercised in
  SPIKE-1 (gap #7); it is captured during adapter work (P2a/P3). Protection (D21)
  and revision-token staleness (TD-7) are enforced by the tool implementation, not
  these schemas.

## Validation helper

The reusable helper lives in the `provider-contract` Rust crate
(`src-tauri/crates/provider-contract/`). It embeds the schemas above at build time
so validation always runs against the *published* contract (the contract is a
fixture — test-plan §3). API:

```rust
use provider_contract::Schema;

// Validate a single decoded event / payload:
provider_contract::validate(Schema::ClaudeStreamEvent, &value)?;   // Result<(), Vec<String>>
provider_contract::is_valid(Schema::McpToolCall, &value);          // bool

// Validate a whole JSONL transcript, line by line (stream schemas):
provider_contract::validate_transcript(Schema::CopilotStreamEvent, jsonl)?; // reports the failing line
```

`Schema` variants: `ClaudeStreamEvent`, `CopilotStreamEvent`, `McpServerConfig`,
`PermissionHookDecision`, `McpToolCall`. See the crate rustdoc for details.


### Claude permission callback adapter (#2399)

The native `--permission-prompt-tool` callback uses `tool_name`, object `input`, and optional
`tool_use_id`. `permission-callback.claude.schema.json` publishes that provider-owned wire
shape for discovery and edge validation. `mcp-tool-call.schema.json` retains the canonical
TD-1 §3.2 `action/detail/why` request. The adapter maps tool name, command (or input JSON),
and description onto those service fields. A provider that supplies no description gets no
invented rationale. The broker returns the canonical `allow`, `allow_always`, or
`deny { reason }` decision; the native adapter alone maps that decision into Claude JSON.

The MCP result's first text item contains JSON: `{"behavior":"allow","updatedInput":<original input>}`
or `{"behavior":"deny","message":<guidance>}`. This callback returns text content only:
Claude 2.1.263 rejected the duplicate `structuredContent` envelope as an invalid permission
result. Other Cowrite tools retain their structured results.
Cowrite retains exact-command allowlisting itself for the current run. Its execution key excludes
display-only `description` but binds the complete command and every other input field, including
unknown execution controls. A changed command or sandbox flag asks again. It does not return
`allow_always` as though that were a Claude response or write provider settings.

J7's script scope is also run-local (CJ, 2026-09-07, #2399). The matcher accepts a
literal absolute script invocation with a shebang, or a bare `python`, `python3`, `node`,
`ruby`, `perl`, `sh`, or `bash` followed immediately by an absolute script path. It supports
single/double quoted literal words, including spaces, but refuses escapes, shell operators,
expansions, interpreter flags, unclosed quotes and unknown invocation forms. A relative script
path is never resolved from an assumed cwd. The canonical target must be a readable regular
file within the canonical project root and at most 1 MiB; other requests have no script scope.

A script grant binds the canonical path, a BLAKE3 digest of its contents, the interpreter spelling
(or direct invocation), and every execution-key field except `command`. Literal script arguments
may change. The initial identity is checked again at the user's decision and each later callback;
a mismatch requires a new decision. A changed script while waiting cannot receive a script grant
from the stale card. All grants clear when the run ends. These are callback-time checks: Cowrite
does not freeze the file between approval and the provider's later execution, nor claim to bind
imported dependencies or ambient interpreter resolution. The original callback input still passes
through unchanged after approval; no script content or grant is persisted in D15 or provider settings.

The injected `X-Cowrite-Run` header binds the callback to the backend-created run in addition
to the existing project bearer token. An absent, ended, or different run is denied before a
permission card is created. Permission snapshots also carry an opaque project-lifetime identity
and a project-local revision, so delayed events from a displaced project cannot replace a new
project's live requests. Stop, provider exit, and project teardown release pending requests
as denials. A run-bound MCP cancellation denies only its matching pending request. The original input stays in the backend until decision and is returned unchanged
only after approval. Permission decisions do not change the D21 protected set or the delivery
contract.

Published references: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
(`--permission-prompt-tool`, including the interaction-requiring-tool limitation) and
[Agent SDK approval response contract](https://code.claude.com/docs/en/agent-sdk/user-input).
Actual MCP callback observed with Claude **2.1.263**, 2026-09-07: `Bash` input carried `command`
and `description`, `tool_use_id` was present, and JSON-RPC params also carried `_meta` with
`claudecode/toolUseId` and `progressToken`. The provider followed denial guidance and the
synthetic requested file remained absent. A second production-backend smoke confirmed Allow once
created its synthetic file and denial returned the exact requested witness message; both terminal
paths cleared pending controls. Earlier provider allow/deny settings can settle an
action before this callback; delegation does not bypass or override that policy.
