# SPIKE-1 Findings: Provider Contract (Claude Code CLI + GitHub Copilot CLI)

ABOUTME: Evidence-based verification of the TD-1/TD-5 provider-contract assumptions for both agentic CLIs.
ABOUTME: Answers §3.4's open questions (FR-PROV-1); every claim tagged VERIFIED / REPORTED / UNKNOWN.

**Date:** 2026-07-05 · **Machine:** Windows 11 (CJ's dev box)
**Versions tested:** Claude Code CLI **2.1.200** (on PATH) · GitHub Copilot CLI **1.0.68** (standalone `copilot.exe` from `github/copilot-cli` release v1.0.68, run from scratchpad — *not* installed on this machine; winget has `GitHub.Copilot` v1.0.68 when we want it on PATH)

**Evidence tags:**
- **VERIFIED** = ran it locally, or quoted from official docs (docs.github.com / code.claude.com)
- **REPORTED** = official-adjacent (repo README, search summaries) but not run locally
- **UNKNOWN** = could not confirm within spike budget

---

## 1. Executive summary — does TD-1's shape survive?

**Yes. TD-1 and TD-5 survive intact, and the Copilot side is *stronger* than the design assumed.** No architecture reshape needed. Specifics:

1. **Copilot CLI is a full MCP client** with a **per-invocation config injection flag** (`--additional-mcp-config <json|@file>`), stdio *and* HTTP transports, and per-server `headers` (bearer token) support — TD-1's "loopback HTTP + per-session bearer token" design maps 1:1 onto Copilot's config schema (schema captured empirically, §4.3). The "config surface: spike" question in §3.4 is answered.
2. **Copilot has a real permission-gating mechanism** — a hooks framework with `preToolUse` (returns `allow|deny|ask`, fail-closed on error) and a `permissionRequest` event that fires in the CLI. TD-5's assumed fallback (allowlist flags only) is no longer the ceiling; the fallback flags also exist and are rich (§4.4). Caveat: hooks are injected via *files/settings*, not a CLI flag — a small adapter-shape difference from Claude's `--permission-prompt-tool`.
3. **Both CLIs stream structured JSONL in headless mode and support session resume by ID.** Claude: `-p --output-format stream-json` (**`--verbose` still required** — verified by exact error). Copilot: `-p --output-format json` emits typed JSONL events; sessions persist under `~/.copilot/session-state/<uuid>/` (verified on disk); `--session-id` can *mint* a Cowrite-chosen UUID for a new session or resume an existing one.
4. **§3.4 Skills row is outdated in our favor:** Copilot CLI 1.0.68 natively discovers `SKILL.md` files — including from **`.claude/skills/`** — via `copilot skill`. "Body injected as context; frontmatter ignored" undersells current reality (frontmatter *semantics* parity still UNKNOWN).
5. **Bonus:** Copilot CLI ships `--acp` (Agent Client Protocol server mode) — TD-1's "watched alternative" is already shipping in Copilot — and an official SDK (`@github/copilot-sdk`, TS/Python) that drives the CLI as a JSON-RPC server. Neither changes our v1 plan (spawn-per-request JSONL is sufficient), but both are real upgrade paths.

**Forced changes to the design: none.** Two adapter-level notes: (a) Copilot permission hooks are file-configured, so Cowrite writes a hooks/settings file (or uses `COPILOT_HOME`) instead of passing a flag; (b) Copilot auto-updates itself by default — the adapter must pin/disable that (§6).

---

## 2. Capability matrix (fills §3.4's ?s)

| Capability | Claude Code CLI 2.1.200 | Copilot CLI 1.0.68 | Evidence |
|---|---|---|---|
| Headless run | ✓ `-p/--print` | ✓ `-p/--prompt "<text>"` (exits after completion); `-i` for interactive-with-prompt | VERIFIED: `--help` both; live runs both |
| Structured streaming output | ✓ `--output-format stream-json` (**requires `--verbose`**); `--include-partial-messages` for deltas; `json` for single blob | ✓ `--output-format json` = "JSONL, one JSON object per line"; deltas included by default (`ephemeral` events); `--stream on\|off`; `-s/--silent` for text mode | VERIFIED: live transcripts §5 |
| MCP client | ✓ `--mcp-config <files-or-JSON-strings...>` + `--strict-mcp-config` | ✓ User `~/.copilot/mcp-config.json`; workspace `.mcp.json` / `.github/mcp.json`; **per-invocation `--additional-mcp-config <json>` (or `@file`, repeatable, augments)**; `--disable-builtin-mcps`, `--disable-mcp-server <name>` | VERIFIED: `--help` + `copilot mcp` output; Copilot config schema captured empirically §4.3. Copilot flag's *session-time effect* not observed live (would cost a premium request) — see Gaps |
| MCP transports | stdio, HTTP, SSE | stdio ("local"), HTTP, SSE; per-server `headers` (bearer) + `timeout` + `tools` filter | VERIFIED (Copilot: generated config §4.3; Claude: docs) |
| Permission delegation to a tool | ✓ `--permission-prompt-tool <mcp-tool>` — **still supported at 2.1.200 but hidden from `--help`**; officially documented. Caveat (v2.1.199+): an `allow` for an MCP tool marked "requires user interaction" is converted to deny | ◐ No MCP-tool delegation flag. Instead: **hooks** — `preToolUse` (`allow\|deny\|ask` + `modifiedArgs`, fail-closed on error, fail-open on timeout) and `permissionRequest` event (fires in CLI, can deny). Configured via files, not flags | VERIFIED: flag parses cleanly at 2.1.200 (unknown flags error; this one doesn't) + code.claude.com/docs/en/cli-reference quote; Copilot: docs.github.com/en/copilot/reference/hooks-configuration |
| Tool allow/deny flags | ✓ `--allowedTools/--disallowedTools` (permission-rule syntax), `--tools` (availability), `--permission-mode` | ✓ `--allow-tool/--deny-tool` patterns: `shell(git:*)`, `write`, `<mcp-server>(tool)`, `url(...)`; deny > allow always (even `--allow-all-tools`); `--available-tools/--excluded-tools` (model visibility) | VERIFIED: `--help` + `copilot help permissions` |
| Session resume | ✓ `--resume <id>`, `-c/--continue`, `--fork-session`, `--session-id <uuid>` (set specific UUID), `--no-session-persistence` | ✓ `--resume[=id\|name\|7+hex-prefix]`, `--continue`, `--session-id <id>` ("Resume an existing session or task by ID, **or set the UUID for a new session**") | VERIFIED: `--help` both; Copilot on-disk state confirmed: `~/.copilot/session-state/<uuid>/{events.jsonl, session.db, workspace.yaml, checkpoints/, files/}` + `session-store.db` appeared after the live run. Resume *in `-p` mode* not exercised for either (Gaps) |
| Model selection | ✓ `--model <alias\|full-name>`, `--fallback-model` (print-only) | ✓ `--model` (`auto` = Copilot picks); catalog includes claude-*, gpt-*, gemini-*; `COPILOT_MODEL` env | VERIFIED: `--help` / `copilot help config` |
| Cost/budget guardrail | ✓ `--max-budget-usd` (print-only) | ✓ `--max-ai-credits` (min 30); `result` event reports `usage.premiumRequests` | VERIFIED: `--help`; Copilot live `result` event |
| Skills | ✓ native (`SKILL.md` incl. frontmatter semantics) | ✓ `copilot skill` — discovers project `.github/skills/`, `.agents/skills/`, **`.claude/skills/`**; personal `~/.copilot/skills/`, `~/.agents/skills/`; frontmatter *semantics* parity UNKNOWN | VERIFIED: `copilot skill --help` |
| Working-dir / path confinement | `--add-dir` | `-C <dir>` (chdir before anything), `--add-dir`, default confinement = cwd + temp dir; `--allow-all-paths`, `--disallow-temp-dir` | VERIFIED: `--help` both |
| Auth for spawned child | Uses user's Claude auth (keychain/OAuth); `--bare` restricts to API-key only (not usable for subscription auth) | `copilot login` stored creds; **`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` env takes precedence** — live run succeeded with gh's keyring token (scopes: gist, read:org, repo, workflow) | VERIFIED: live runs |
| Kill-safety (TD-5 stop = kill) | Safe: deliveries only via our MCP tools | Same reasoning; Copilot also snapshots session state continuously (events.jsonl on disk) | VERIFIED by architecture; Copilot disk behavior observed |
| ACP | — (not in `--help`) | ✓ `--acp` "Start as Agent Client Protocol server" | VERIFIED: `--help` |
| Programmatic SDK | Claude Agent SDK (TS/Python) | `@github/copilot-sdk` (TS) + `github-copilot-sdk` (PyPI): spawns CLI in server mode, JSON-RPC over stdio/TCP | REPORTED: github.com/github/copilot-sdk README via search; not run |

---

## 3. Claude Code CLI (2.1.200) — details

All VERIFIED locally unless noted.

### 3.1 Headless + streaming
- `claude -p "<prompt>" --output-format stream-json` **fails** without verbose: exact error `Error: When using --print, --output-format=stream-json requires --verbose` (captured live, §5.1). Adapter must always pass `--verbose`.
- Docs (code.claude.com/docs/en/cli-reference, fetched 2026-07-05) additionally note `--verbose` gates `--prompt-suggestions`, `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages`.
- Stream shape (§5.2): `system/init` (session_id, tools, mcp_servers with per-server status, model, permissionMode, slash_commands, agents, skills, claude_code_version) → `rate_limit_event` → `system/thinking_tokens` ticks → `assistant` message envelopes (full API Message JSON incl. usage) → terminal `result` event with `subtype: success|…`, `is_error`, `result` text, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials[]`, `num_turns`, `session_id`, `terminal_reason`.
- `--input-format stream-json` exists for realtime streaming *input* (multi-turn over one process) — an alternative to spawn-per-request we're not taking (TD-5 stands).
- `--json-schema <schema>` for structured final output — could be useful for non-MCP fallback flows; noted, not needed for TD-1.

### 3.2 Permission delegation
- `--permission-prompt-tool <mcp-tool-name>` is **absent from `--help` but still parses and is officially documented** (docs example: `claude -p --permission-prompt-tool mcp_auth_tool "query"`). Doc quote: "Specify an MCP tool to handle permission prompts in non-interactive mode. As of v2.1.199, the prompt tool can't approve an MCP tool marked as requiring user interaction: an `allow` result for one is converted to a deny."
  - Impact: none for us as long as Cowrite's own tools aren't marked "requires user interaction" — but it means our permission tool **cannot self-approve interactive-marked third-party MCP tools**. Matrix note added.
  - Risk note: hidden-from-help sometimes precedes deprecation (UNKNOWN). The Agent SDK exposes the same mechanism (`permission_prompt_tool_name`), which argues for stability. Version-detect on spawn (already a TD risk item) covers us.
- `--permission-mode` choices at 2.1.200: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` (`manual` = the old `default`).

### 3.3 MCP injection & sessions
- `--mcp-config <configs...>` accepts **JSON files or raw JSON strings** (space-separated) — Cowrite can inject its loopback server inline, no temp file needed. `--strict-mcp-config` makes the run hermetic (ignores user/project servers). Product decision for later: hermetic vs. respecting the user's own MCP servers; flag exists for either.
- Sessions: `--resume <id>` (docs: ID search scoped to current project dir + its git worktrees — fits cwd=project spawning), `--continue` (most recent in cwd), `--fork-session`, `--session-id <uuid>` (must be valid UUID → Cowrite can mint IDs for new sessions), `--no-session-persistence` (print mode).
- `--bare` mode exists (skips hooks/CLAUDE.md/keychain; auth = `ANTHROPIC_API_KEY` only) — **not usable** for CJ-style subscription auth; do not use in adapter.

---

## 4. GitHub Copilot CLI (1.0.68) — details

All VERIFIED locally (binary run from scratchpad) unless noted.

### 4.1 Install / distribution reality on this machine
- `copilot` was **not on PATH**; no npm available. `gh` 2.96.0 includes a preview `gh copilot` launcher that auto-downloads the CLI to `%LOCALAPPDATA%\GitHub CLI\copilot` — but the non-interactive first run just prints `! Copilot CLI not installed` (needs an interactive confirm). Distribution options for Cowrite users: winget `GitHub.Copilot` (v1.0.68), direct release download (`github/copilot-cli` releases: per-OS zips + MSIs), npm `@github/copilot`. Adapter should locate the binary across these installs (PATH, `%LOCALAPPDATA%\GitHub CLI\copilot`, winget links).
- `~/.copilot/config.json` already existed here (firstLaunchAt 2026-07-03) — CJ has touched it before; no stored auth was present, env-token auth worked regardless.

### 4.2 Headless + streaming (live-verified)
- `copilot -p "<prompt>" --output-format json` → JSONL, one object per line. Every event: `{type, data, id, timestamp, parentId, ephemeral?}` — a **parent-linked event tree**, with `ephemeral: true` on transient/delta events.
- Event types observed live (§5.3): `session.mcp_server_status_changed`, `session.mcp_servers_loaded` (fired 3×, dedupe by `id`), `session.skills_loaded`, `session.tools_updated`, `user.message` (includes the *transformed* prompt with injected context), `assistant.turn_start`, `assistant.message_start`*, `assistant.message_delta`* (streaming text), `assistant.message` (final; model, content, toolRequests[], outputTokens, requestId), `assistant.turn_end`, `assistant.idle`*, terminal `result` (`sessionId`, `exitCode`, `usage.premiumRequests`, `usage.codeChanges{linesAdded, linesRemoved, filesModified[]}`). (* = ephemeral.)
  - `usage.codeChanges` in `result` is a gift for the FR-AGENT-5 attribution watchdog (positive attribution of file writes).
  - Tool-call event types not observed (prompt used no tools) — REPORTED to exist as `toolRequests` on `assistant.message` + follow-up events; capture during adapter work.
- `--allow-all-tools` is described as "required for non-interactive mode", but a **no-tool prompt ran fine without it** (VERIFIED) — it gates tool *approval*, not the run. Non-interactive tool-permission behavior without allow flags: presumably auto-deny (help implies prompting is impossible headless) — UNKNOWN, test in adapter work.
- Exit code 0 on success; `result.exitCode` also present. Copilot's own exit-code table not enumerated this spike.

### 4.3 MCP client (the FR-PROV-1 headline)
- Config sources (from `copilot mcp --help`): **User** `~/.copilot/mcp-config.json` · **Workspace** `.mcp.json` or `.github/mcp.json` · **Plugin**. Plus per-invocation: `--additional-mcp-config <json-or-@file>` — "can be used multiple times; **augments** config from ~/.copilot/mcp-config.json for this session".
- Config schema captured empirically (via sandboxed `COPILOT_HOME` + `copilot mcp add`; no user config touched):

```json
{
  "mcpServers": {
    "cowrite": {
      "tools": ["*"],
      "timeout": 5000,
      "type": "http",
      "url": "http://127.0.0.1:39999/mcp",
      "headers": { "Authorization": "Bearer test-token-123" }
    },
    "cowrite-stdio": {
      "tools": ["*"],
      "type": "local",
      "command": "node",
      "args": ["server.js", "--port", "1234"],
      "env": { "FOO": "bar" }
    }
  }
}
```

- `type`: `local` (stdio) | `http` | `sse`; per-server `tools` filter (`"*"`, list, or none), `timeout`, `headers`, `env`. **HTTP + Authorization header on 127.0.0.1 accepted by config** → TD-1's loopback-with-bearer design works verbatim. (Whether Copilot enforces https at *connect* time for non-localhost is untested; localhost is our case.)
- `session.mcp_servers_loaded` / `session.mcp_server_status_changed` events (live-verified for the builtin `github-mcp-server`, transport http) give Cowrite a **spawn-time assertion hook**: after spawn, require our server to appear as `connected` before treating the run as wired.
- Note: one important nuance vs Claude — there is **no `--strict-mcp-config` equivalent**; `--additional-mcp-config` *augments*. To suppress extras: `--disable-builtin-mcps` (kills the builtin GitHub MCP server) and `--disable-mcp-server <name>` (repeatable). Fully hermetic runs would need `COPILOT_HOME` pointing at a Cowrite-managed home (VERIFIED that `COPILOT_HOME` relocates config/state wholesale).

### 4.4 Permissions & gating
- Flags (from `copilot help permissions`, VERIFIED): `--allow-tool` / `--deny-tool` with pattern kinds `shell(command:*?)`, `write`, `<mcp-server-name>(tool-name?)`, `url(domain-or-url?)`. "Denial rules always take precedence over allow rules, even `--allow-all-tools`." Visibility filters `--available-tools` / `--excluded-tools` are separate from approval. `--allow-all-paths`, `--allow-url/--deny-url`, `--allow-all` / `--yolo` umbrella flags. Env: `COPILOT_ALLOW_ALL`.
  - So Cowrite can e.g. `--allow-tool "cowrite"` (all Cowrite MCP tools) while denying `shell(git push)` etc. — the TD-5 fallback plan, fully confirmed.
- Hooks (docs.github.com/en/copilot/reference/hooks-configuration, VERIFIED doc fetch): events `sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, postToolUseFailure, preCompact, agentStop, subagentStart, subagentStop, errorOccurred, permissionRequest, notification`. `preToolUse` decision schema:

```typescript
{ permissionDecision: "allow" | "deny" | "ask"; permissionDecisionReason?: string; modifiedArgs?: object }
```

  - Fail semantics: "Command preToolUse hooks are fail-closed on errors — a crash or non-zero exit denies the tool call." Timeouts (default 30s) fail-open into the normal permission flow. `permissionRequest` fires in the CLI and can deny tool calls.
  - Locations: repo `.github/hooks/*.json`, inline `hooks` block in `.github/copilot/settings.json` / `settings.local.json`; user `~/.copilot/hooks/` or `~/.copilot/settings.json`; policy dirs. Load order: policy → user → project → plugins. Format `{ "version": 1, "hooks": { ... } }`.
  - **No per-invocation CLI flag for hooks** (checked `--help`; only `disableAllHooks` config). Cowrite injection path: write hooks into a Cowrite-managed `COPILOT_HOME`, or the project's `.github/copilot/settings.local.json` (gitignored). Doc note: CLI hooks that call URLs require `https://` with a **localhost exemption via env var** — exact env var name UNKNOWN (matters if we want the hook to call the Cowrite loopback server for J7 interactive gating).
  - `ask` decision in *non-interactive* mode: behavior UNKNOWN (likely deny-or-hang; must test).

### 4.5 Sessions & state
- `--session-id <id>` doubles as "resume by ID" and "**set the UUID for a new session**" — Cowrite can mint session IDs up front (nice for the D15 transcript store keying). `--resume` accepts ID, exact name, or 7+ hex-char prefix; `--continue` = most recent. Combining `--resume` with `-p` for headless continuation: flag coexistence documented in examples (`copilot --allow-all-tools --resume`) but **not exercised headless this spike** (UNKNOWN → first adapter test).
- On-disk (VERIFIED, appeared after one run): `~/.copilot/session-state/<session-uuid>/` containing `events.jsonl` (full event log — same shapes as the JSONL stream), `session.db`, `workspace.yaml`, `checkpoints/`, `files/`; plus global `session-store.db` (SQLite). `COPILOT_HOME` relocates all of it.
- Memory: cross-session agentic memory exists (`memory` config, default true; `--enable-memory` needed in `-p` mode where it's off by default).

### 4.6 Auth
- Precedence (from `copilot help environment`, VERIFIED): `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > stored `copilot login` credentials. Live run authenticated via `GH_TOKEN=$(gh auth token)` (gh keyring OAuth token, scopes gist/read:org/repo/workflow) — worked, consumed 1 premium request on CJ's Copilot plan.
- For Cowrite: FR-X-9 says provider auth never touches Cowrite — default to the user's own `copilot login` state; env-token is a break-glass option. `GH_HOST`/`COPILOT_GH_HOST` cover enterprise. BYOK (`COPILOT_PROVIDER_*`) exists; out of scope.

---

## 5. Captured transcript samples

### 5.1 Claude Code: `--verbose` requirement (VERIFIED, exact stderr)

```
$ claude -p "Reply with exactly: ok" --output-format stream-json --model haiku
Error: When using --print, --output-format=stream-json requires --verbose
(exit 1)
```

### 5.2 Claude Code 2.1.200 stream-json (abridged; 8 lines total for a 1-turn run)

```json
{"type":"system","subtype":"init","cwd":"...","session_id":"e6639704-0d4d-497d-8898-ef5a938ef849","tools":["Task","Bash","...","Write"],"mcp_servers":[{"name":"claude.ai Google Calendar","status":"needs-auth"},{"name":"claude.ai Google Drive","status":"pending"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.200","agents":["claude","Explore","..."],"skills":["..."],"uuid":"..."}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1783309200,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false},"session_id":"..."}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":5,"estimated_tokens_delta":5,"session_id":"..."}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_018mUEjspp2UoaSPNpbCQNWm","role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"..."}],"usage":{"input_tokens":10,"cache_read_input_tokens":21171,"output_tokens":4}},"parent_tool_use_id":null,"session_id":"...","uuid":"...","request_id":"req_011Ccjr4TXqvpXJfd1ZapGfe"}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"usage":{}},"session_id":"..."}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1609,"num_turns":1,"result":"ok","stop_reason":"end_turn","session_id":"e6639704-0d4d-497d-8898-ef5a938ef849","total_cost_usd":0.0172301,"usage":{},"modelUsage":{"claude-haiku-4-5-20251001":{"costUSD":0.0172301,"contextWindow":200000}},"permission_denials":[],"terminal_reason":"completed","uuid":"..."}
```

### 5.3 Copilot CLI 1.0.68 `--output-format json` (abridged; full run was 14 lines)

```json
{"type":"session.mcp_server_status_changed","data":{"serverName":"github-mcp-server","status":"connected"},"id":"5efff570-...","timestamp":"2026-07-06T00:20:45.820Z","parentId":"7014f6e2-...","ephemeral":true}
{"type":"session.mcp_servers_loaded","data":{"servers":[{"name":"github-mcp-server","status":"connected","source":"builtin","transport":"http"}]},"id":"c09dcb4e-...","parentId":"36fd5295-...","ephemeral":true}
{"type":"session.skills_loaded","data":{"skills":[{"name":"customize-cloud-agent","source":"builtin","userInvocable":false,"enabled":true,"path":"C:\\...\\builtin\\customize-cloud-agent\\SKILL.md"}]},"id":"..."}
{"type":"session.tools_updated","data":{"model":"claude-sonnet-5"},"id":"..."}
{"type":"user.message","data":{"content":"Reply with exactly: ok","transformedContent":"<current_datetime>...</current_datetime>\n\nReply with exactly: ok\n\n<system_reminder>...</system_reminder>","attachments":[],"delivery":"idle","interactionId":"8a60fc52-..."},"id":"af71972f-..."}
{"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"8a60fc52-..."},"id":"78ffb44d-...","parentId":"af71972f-..."}
{"type":"assistant.message_start","data":{"messageId":"49263494-..."},"ephemeral":true}
{"type":"assistant.message_delta","data":{"messageId":"49263494-...","deltaContent":"ok"},"ephemeral":true}
{"type":"assistant.message","data":{"messageId":"49263494-...","model":"claude-sonnet-5","content":"ok","toolRequests":[],"turnId":"0","outputTokens":4,"requestId":"CFB6:...","apiCallId":"msg_01Lqkh..."},"id":"f26a1b74-...","parentId":"78ffb44d-..."}
{"type":"assistant.turn_end","data":{"turnId":"0"},"id":"3bdfc007-..."}
{"type":"assistant.idle","data":{},"ephemeral":true}
{"type":"result","timestamp":"2026-07-06T00:20:48.239Z","sessionId":"3b568d03-c868-4116-a0b2-4a3bff284a40","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":1274,"sessionDurationMs":4045,"codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]}}}
```

Raw captures live in the session scratchpad (`claude-stream.jsonl`, `copilot-stream.jsonl`); not committed.

---

## 6. Gaps / risks

1. **[Top follow-up, 1 premium request]** `--additional-mcp-config` session-time effect not observed live: `copilot mcp list` only reads *persisted* config (verified — injected config didn't appear), so proof requires one spawned session asserting our server shows up in `session.mcp_servers_loaded`. Flag + semantics are documented in `--help`; risk of it not working: low. Spike budget capped live invocations at one per CLI.
2. **Headless resume untested for both** (`claude -p --resume <id>`, `copilot -p --resume=<id>`). Flags documented; behavior with `-p` unexercised. D4 continuity depends on this — make it adapter test #1.
3. **Copilot permission gating headless:** `preToolUse` `ask` decision and `permissionRequest` hook behavior in `-p` mode UNKNOWN. If `ask` can't reach a human headless, our J7 flow must resolve to allow/deny inside the hook itself (the hook can call Cowrite's loopback server — but note the hooks-network https-requirement with a **localhost exemption env var whose name we haven't confirmed**). Fallback (allow/deny flags) fully confirmed regardless.
4. **Copilot auto-updates by default** (except in CI). Version drift under Cowrite's feet mid-product. Adapter must set `COPILOT_AUTO_UPDATE=false` (or `--no-auto-update`) on every spawn + version-detect (existing TD risk item). Same class of risk as the TD's "CLI output-format drift" note — Copilot ships fast (1.0.68 stable, 1.0.69 prerelease same week).
5. **Claude `--permission-prompt-tool` hidden from `--help`** at 2.1.200 while remaining documented + functional. Could signal future rework (Agent SDK parity argues against removal). Version-detect on spawn covers it; keep the §3.4 matrix row annotated.
6. **Copilot event duplication/ephemerals:** `session.mcp_servers_loaded` fired 3× in one run; deltas and finals both stream. Adapter must dedupe by event `id` and key UI off non-ephemeral events (`assistant.message`, `result`), using ephemerals only for live-typing display.
7. **Copilot tool-call event shapes unobserved** (no tools ran). `assistant.message.toolRequests[]` exists; the approval/execution event sequence needs capture before the J1 activity feed rendering is finalized.
8. **`user.message.transformedContent` reveals prompt wrapping:** Copilot wraps prompts with its own context (datetime, system reminders). Harmless, but transcripts stored per D15 should record `content`, not `transformedContent`, as "what Cowrite sent".
9. **No `--strict-mcp-config` equivalent on Copilot** — hermetic runs need `COPILOT_HOME` isolation (which also isolates auth/stored login — tradeoff: a Cowrite-managed home would force env-token auth or a one-time re-login). Decide during adapter work; default posture "augment, don't isolate" is fine for v1.
10. **Copilot distribution/locating:** not on PATH for users who use the `gh` launcher (binary lands in `%LOCALAPPDATA%\GitHub CLI\copilot`) vs winget vs npm. Adapter needs a small binary-discovery routine + minimum-version check.

---

## 7. Recommended adapter differences (input to `agent/` provider adapters)

**Common shape (both providers):** spawn per request, cwd = project, JSONL on stdout, parse line-by-line, watchdog on silence, kill process group on Stop, version-detect on first spawn.

| Concern | Claude adapter | Copilot adapter |
|---|---|---|
| Spawn | `claude -p <prompt> --output-format stream-json --verbose [--include-partial-messages]` | `copilot -p <prompt> --output-format json` (deltas already included) |
| MCP injection | `--mcp-config '<inline JSON>'` (+ optionally `--strict-mcp-config`) | `--additional-mcp-config @<per-session-file>` (inline JSON also works); assert our server in `session.mcp_servers_loaded` before trusting the run |
| Cowrite server auth | http loopback + `Authorization: Bearer <session-token>` header in server config | identical (`headers` field verified in schema) |
| Permission gating (J7) | `--permission-prompt-tool mcp__cowrite__permission_request` (native; mind the v2.1.199 interactive-tool caveat) | hooks file (`permissionRequest`/`preToolUse` with allow/deny) written to Cowrite-managed location; **plus** belt-and-braces `--allow-tool "cowrite" --deny-tool ...` flags; pure-flag mode is the degraded fallback per TD-5 |
| Session identity | mint UUID, pass `--session-id <uuid>` on first run; `--resume <uuid>` after | mint UUID, pass `--session-id <uuid>` (creates); `--resume=<uuid>` or `--session-id` after |
| Model | `--model <alias or full name>` | `--model <catalog-name>` (or `auto`) |
| Budget guard | `--max-budget-usd` | `--max-ai-credits` (min 30) |
| Env hygiene | — | `COPILOT_AUTO_UPDATE=false`; consider `--no-remote-export`; leave auth to user's `copilot login` (env-token = fallback) |
| Attribution feed (FR-AGENT-5) | tool-use events in stream | `result.usage.codeChanges.filesModified[]` + tool events |
| Cost surface | `result.total_cost_usd`, `modelUsage` | `result.usage.premiumRequests` |
| Dedupe | events carry `uuid` | events carry `id`/`parentId`; skip `ephemeral` for authoritative state |

**§3.4 matrix corrections to fold into tech-design.md:** Copilot rows: Headless+streaming ✓ (verified, granularity documented above) · MCP client ✓ (per-invocation injection, config schema known) · Permission delegation ◐ hooks-based (file-configured, not flag) with confirmed flag fallback · Session resume ✓ (disk-verified; headless-resume test pending) · Skills row: Copilot natively discovers `SKILL.md` (incl. `.claude/skills/`); frontmatter semantics parity unknown.

---

## 8. Source list

- Local: `claude --version/--help` (2.1.200); `copilot --version/--help`, `copilot help permissions|config|environment`, `copilot mcp --help`, `copilot mcp add --help`, `copilot skill --help` (1.0.68); live headless runs of both (transcripts §5); `~/.copilot/` on-disk inspection; sandboxed `COPILOT_HOME` MCP-config generation; `gh copilot --help` (gh 2.96.0); winget search.
- Docs (fetched 2026-07-05): code.claude.com/docs/en/cli-reference · docs.github.com/en/copilot/reference/hooks-configuration · docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference (thin).
- REPORTED-grade: github.com/github/copilot-sdk README (SDK-to-CLI JSON-RPC server relationship), search summaries of docs.github.com CLI pages.
