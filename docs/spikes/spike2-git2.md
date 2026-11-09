# SPIKE-2 Findings: git2 feasibility (incl. union merge driver)

ABOUTME: Evidence-based go/no-go for TD-3 (embedded git2 sync engine) and TD-4's
ABOUTME: union-merge conflict-freedom; every dimension tagged VERIFIED / REPORTED / UNKNOWN.

**Date:** 2026-07-09 · **Machine:** macOS 15 (Darwin 25.5.0), arm64 (Apple Silicon)
**Versions:** `git2` **0.20.4** → `libgit2-sys` **0.18.5+1.9.4** (libgit2 **1.9.4**, statically vendored) · rustc 1.97.0
**Prototype:** `/spikes/spike2-git2/` (gitignored, throwaway per test-plan §9b — never merges). One binary (`src/main.rs`) probes all eight dimensions of the §0 table; output quoted verbatim below.

**Evidence tags:**
- **VERIFIED** = ran it locally on this macOS box (or read it out of the `libgit2-sys` build script that compiled here).
- **REPORTED** = libgit2/crate source or docs say so, not executed here (mostly the Windows path — I have no Windows box this spike).
- **UNKNOWN** = could not confirm within spike budget.

---

## 0. Verdict — **GO on git2 for TD-3/TD-4**, conditional on a Windows-CI confirmation run (below). No fallback to `gitoxide` or system-git needed.

Every dimension the issue asked about clears **on macOS, verified end-to-end**, and the one that TD-4's conflict-freedom hangs on — the **union merge driver** — works **natively in libgit2 1.9.4 with zero custom-driver registration**, via *both* candidate attribute mechanisms. That was the open risk; it is closed.

**Scope of this verdict / required Windows confirmation.** Windows is a co-equal target (D23, FR-X-1), but I have **no Windows box this spike** — so **0 of the 8** table rows below are Windows-VERIFIED (every row is macOS-verified only): **7 are REPORTED** for Windows (from the platform-agnostic libgit2 C and the `libgit2-sys` build script) and **proxy-on-Windows is UNKNOWN** (7 + 1 = 8). The libgit2 code paths are platform-agnostic so the risk is low, but the GO is **conditional**: before TD-3 ships — and specifically **before TD-3 touches proxy handling** — run this probe (or its equivalent) on the **P0-2 Windows CI matrix** to promote the Windows column from REPORTED to VERIFIED. Treat that CI run as a gate, not a formality; the proxy row in particular (§6) may not survive it unchanged.

| Dimension | macOS (verified here) | Windows (path assessed) | Verdict |
|---|---|---|---|
| Static libgit2, no system-git dependency | VERIFIED — vendored, statically linked | REPORTED — same vendored build | **GO** |
| HTTPS TLS backend | VERIFIED — SecureTransport, live clone | REPORTED — WinHTTP (build script) | **GO** |
| Credentials (token) | VERIFIED — callback surface | REPORTED — identical API | **GO** |
| Worktree create / lock / prune | VERIFIED | REPORTED — same API | **GO** |
| Shallow clone (`depth`) | VERIFIED | REPORTED | **GO** |
| Partial clone (blob filter) | VERIFIED **absent** in libgit2 | same | **GO w/ caveat** (shallow only; §5) |
| System-proxy | Surface VERIFIED; behaviour caveated | **Weak spot — flag** (§6) | **GO w/ caveat** |
| **Union merge driver + attribute propagation** | **VERIFIED — both mechanisms** | REPORTED — driver is platform-agnostic C | **GO** |

**Attribute-mechanism recommendation (headline):** commit a **`.cowrite/.gitattributes`** containing `*.jsonl merge=union`. Committed (not per-clone), and scoped to the `.cowrite/` subtree so it never touches the repo-root `.gitattributes` the user owns. Reasoning + the rejected alternative in §4.

---

## 1. Static libgit2 + TLS backend — **GO**

The `git2` crate's default `vendored-libgit2` compiles libgit2 **from source, statically** — no `libgit2.dylib`/system-git on the box, protecting J6's "install Cowrite only" onboarding (TD-3's stated reason for rejecting shell-out-to-git).

Probe §1 output (from the committed `spikes/spike2-git2/Cargo.toml`, `features = ["https"]` — `ssh` dropped per §1a's recommendation):
```
git2 crate wraps libgit2 1.9.4
features: https=true ssh=false threads=true nsec=true
```
(`ssh=false` is the deliberate final state: Cowrite authenticates over HTTPS with a token, not SSH keys, so libssh2 is excluded. An earlier iteration with `features = ["https", "ssh"]` reported `ssh=true` and pulled in libssh2 → openssl-sys — the reason §1a recommends dropping it.)

**TLS backend is OS-native, chosen at compile time by `libgit2-sys/build.rs` (read verbatim here):**
```
if https {
    if windows      -> #define GIT_WINHTTP 1
    else if apple    -> #define GIT_SECURE_TRANSPORT 1
    else             -> #define GIT_OPENSSL 1
}
// SHA256 backend, same branch: windows->Win32 CNG, apple->CommonCrypto, else->OpenSSL
```
So **macOS TLS = SecureTransport**, **Windows TLS = WinHTTP** — both shipped with the OS, both static from Cowrite's POV, neither needs OpenSSL. On Windows the build links only system DLLs (`winhttp, rpcrt4, ole32, crypt32, secur32, advapi32`) — REPORTED from the same build script. (VERIFIED macOS, REPORTED Windows.)

### 1a. macOS packaging gotcha — the `https` feature drags in `openssl-sys` **even though libgit2 uses SecureTransport**

`libgit2-sys` declares `https = ["openssl-sys"]` with `openssl-sys` gated at **`cfg(unix)`** — which includes macOS. libgit2 doesn't *call* OpenSSL on Apple (it uses SecureTransport), but `openssl-sys` still compiles and emits link directives, so a naive `features=["https"]` build dynamically links a dev-only dylib:
```
otool -L probe  ->  .../opt/homebrew/opt/openssl@3/lib/libssl.3.dylib   ← absent on end-user Macs
```
That dylib is **not** present on a user's Mac → the app would fail to launch. **Fix (VERIFIED):** add the **`vendored-openssl`** feature on the macOS build — it statically vendors OpenSSL into the binary (used for nothing TLS-wise, but satisfies the link), yielding a self-contained binary:
```
otool -L probe (with vendored-openssl)  ->  only Security.framework + CoreFoundation   ✅
```
Windows is unaffected — `openssl-sys` is `cfg(unix)`-gated, so it's never pulled there (WinHTTP path is clean). **Action for TD-3:** macOS build = `features = ["https", "vendored-openssl"]`; Windows/Linux = `["https"]` (Linux genuinely uses OpenSSL for TLS). Dropping the `ssh` feature entirely (we auth over HTTPS with a token, not SSH keys) also removes libssh2 — recommended, keeps the dependency surface minimal.

## 2. HTTPS clone + credentials — **GO**

Live anonymous HTTPS clone over SecureTransport succeeded (proves the TLS backend actually negotiates, not just links):
```
PASS: cloned octocat/Hello-World, HEAD=7fd1a60b01f91b314f59955a4e4d4e80d8edf11d
```
Credential wiring is exactly TD-3's shape — `RemoteCallbacks::credentials(|url, user, allowed| …)` returning `Cred::userpass_plaintext("x-access-token", <github_token>)` for a PAT/installation token (the octocrab token reused for git transport). `Cred::ssh_key`, `Cred::default` (proxy/NTLM), `Cred::credential_helper` also available. (Callback surface VERIFIED; a live *authenticated* push not exercised — no throwaway remote — but the API is the same one octocrab-adjacent code uses and is low-risk. First `gitops/` test should do a real token push.)

## 3. Worktree API — **GO**

TD-3 keeps one worktree per review in app data. All lifecycle calls exist and work:
```
PASS: created worktree 'review-1' at <tmp>; lock_status=Locked(Some("in use by review"));
      prunable_after_dir_removed=true; prune()->ok; worktrees_now=0
```
`Repository::worktree(name, path, opts)` (create), `Worktree::lock/is_locked/unlock`, `is_prunable`, `prune(WorktreePruneOptions)`, `Repository::worktrees()` (enumerate). Covers TD §3.2b's crash-repair needs (stale-lock detection via `is_prunable` + `prune`). VERIFIED.

## 4. Union merge driver + attribute propagation — **GO (the critical result)**

**libgit2 1.9.4 honours the `merge=union` gitattribute natively — no `git_merge_driver_register` needed** (which matters because the `git2` Rust crate does **not** expose driver registration; if union weren't built in, pure-git2 union would be impossible). Verified with a real 3-way merge that *conflicts* under the default text driver (both branches append a different line at EOF) and is *auto-unioned* with the attribute set. Probe §7:
```
7a committed .gitattributes           has_conflicts=false -> UNION APPLIED
     merged data.jsonl = {"base":1}\n{"a":1}\n{"b":1}\n
7b per-clone .git/info/attributes     has_conflicts=false -> UNION APPLIED
7c NO attribute (control)             has_conflicts=true  -> EXPECTED CONFLICT   ← proves the test is real
7d subdir .cowrite/.gitattributes     has_conflicts=false -> UNION APPLIED
     governing .cowrite/comments/author.jsonl
```
The control (7c) conflicting confirms the union result isn't an artifact of a trivially-mergeable diff. All three attribute placements — committed root, per-clone `info/attributes`, and committed subdir — drive the union. Test used in-memory `merge_commits` (what a sync worker computes); attribute lookup reads workdir/index `.gitattributes` + `$GIT_DIR/info/attributes`, both present in a real worktree merge. VERIFIED.

### Recommendation: **committed `.cowrite/.gitattributes`** (mechanism 7d), not per-clone install

| | Committed `.cowrite/.gitattributes` (RECOMMENDED) | Per-clone `.git/info/attributes` |
|---|---|---|
| Propagation | **Automatic** — travels with the repo to every clone, worktree, and reviewer, zero install step | Cowrite must write it on **every** clone/worktree, on every machine; a reviewer who clones outside Cowrite has no protection |
| Constitution fit | Matches "everything on disk is portable and documented" + D1 "collaboration data is repo-owned"; TD-4 already commits `.cowrite/` by default | Invisible, machine-local — *contradicts* the portability invariant |
| Repo-root pollution | **None** — scoped inside `.cowrite/`, never collides with a user's own root `.gitattributes` | None (it's in `.git/`), but at the cost of portability |
| Failure mode if absent | Degrades to a normal conflict (which TD-4's per-author-file format already makes near-impossible) — safe | Same |

Committed wins decisively on propagation and constitution fit; sub-directory scoping removes its only real downside (touching the user's root file). Recommend Cowrite writes `.cowrite/.gitattributes` = `*.jsonl merge=union` at repo init / `.cowrite/` creation (P4-4 "attribute install per SPIKE-2 mechanism" → this). Keep `.git/info/attributes` as a **belt-and-braces** install too if cheap, but the committed file is the contract. This closes review-finding M5's "committed vs per-clone" question in favour of committed.

**Caveat worth stating for TD-4:** union merge concatenates both sides' added lines but does **not** dedupe or order them. TD-4's conflict-freedom is *primarily* by format (append-only, one JSONL file per author per doc → different machines touch different files, never the same one); union is the **secondary** safety net for the narrow case of the *same* author's file diverging across two machines/branches. In that case union yields both appended events with no loss — correct for an append-only event log, though it can produce a duplicate event if the exact same line was appended on both sides (the fold over events must be idempotent / dedupe by event id, which the D22/TD-4 event model should already assume). Flag for the `store/` fold implementation.

## 5. Shallow clone — **GO**; partial (blob-filter) clone — **absent, GO with caveat**

Shallow verified:
```
PASS: depth(1) clone done; repo.is_shallow()=true
```
`FetchOptions::depth(n)` + `RepoBuilder` gives reviewers a shallow clone of a heavy repo (TD-3's concern). **Partial clone** (`--filter=blob:none`, blobless/treeless) is a **separate** protocol feature and libgit2 has **no `--filter` support** (VERIFIED absent — no filter API on `FetchOptions`; REPORTED that libgit2 doesn't implement the partial-clone protocol). Impact: reviewers get *shallow* (bounded history) but not *blobless* (bounded blob download). For markdown-doc repos this is a non-issue; only matters if a repo carries large binaries in history. Acceptable for v1; note it if a "clone huge repo" complaint ever surfaces.

## 6. System proxy — **GO with a flagged caveat** (libgit2's known weak spot)

`ProxyOptions::auto()` / `.url("http://host:port")` exist and attach to `FetchOptions` (VERIFIED surface). **Behaviour caveat (important for corporate reviewers, the issue called this out):**
- `auto()` consults **git config `http.proxy` / `remote.<name>.proxy` only**. libgit2 does **not** read `HTTP_PROXY`/`HTTPS_PROXY` environment variables itself, and does **not** do WPAD/PAC auto-detection. (REPORTED from libgit2 behaviour; the env-var non-reading is well established.)
- On **Windows**, whether libgit2's WinHTTP transport picks up the system/IE proxy config via `auto()` is **UNKNOWN** here (no Windows box). Historically this was libgit2's weak spot; do **not** assume it works.

**Recommendation for TD-3:** don't rely on `auto()`. Cowrite should read the OS proxy configuration itself (macOS `scutil --proxy` / SystemConfiguration; Windows `WinHttpGetIEProxyConfigForCurrentUser` or the `HTTP(S)_PROXY` env) and pass it **explicitly** via `ProxyOptions::url(...)` (+ `Cred::default` for proxy auth). This turns a libgit2 soft spot into Cowrite-controlled behaviour. Make "corporate proxy reviewer" an explicit `gitops/` test case (can't be a pure unit test — needs a proxy fixture; note for the integration matrix).

---

## 7. Risks / follow-ups carried into TD-3/TD-4 implementation

1. **[macOS packaging] `vendored-openssl` required on the macOS build** (§1a) or the app links a dev-only homebrew dylib and won't launch on user Macs. Bake into the Cargo manifest's platform feature selection; add a smoke check (`otool -L` has no non-system dylib) to release gating.
2. **[proxy] Do not trust `ProxyOptions::auto()`** (§6). Read OS proxy config and pass explicit `url()`. Windows system-proxy pickup UNKNOWN — verify on a Windows box before claiming corporate-network support.
3. **[Windows] Whole Windows path is REPORTED, not run.** SecureTransport→WinHTTP swap, worktree APIs, and union driver are all platform-agnostic in libgit2's C, so risk is low, but the first CI run on the Windows matrix (P0-2 already has it) should execute an equivalent probe. Attach this spike's binary as a Windows CI smoke if cheap.
4. **[auth] No live authenticated push/fetch exercised** (no throwaway remote). API is standard; make a real token round-trip a **manual / live-smoke** item (parallel to SPIKE-1's live-CLI runs), **not** a CI-gated test. The property suite must stay hermetic against **local bare repos** per tech-design §3.7 — this follow-up is not license to add a network dependency to CI.
5. **[union semantics] Union doesn't dedupe** (§4 caveat). The `store/` event fold must be idempotent / dedupe by event id — union can duplicate an identical line appended on two sides. Confirm TD-4's fold assumes this.
6. **[partial clone] libgit2 has no blob-filter** (§5). Shallow only. Fine for doc repos; document the limit.
7. **`git2` 0.20.4 / libgit2 1.9.4** pinned for these results; re-verify union behaviour on any libgit2 major bump (it's a built-in-driver behaviour that could in principle change — low risk, it's long-standing git semantics).

## 8. Source list
- Local (VERIFIED): `/spikes/spike2-git2/` probe binary — full run output quoted in §1–§5, §7-of-code; `otool -L` on the built binary with and without `vendored-openssl`; `libgit2-sys-0.18.5/build.rs` and `Cargo.toml` read from `~/.cargo` (TLS/SHA backend branches, `https=["openssl-sys"]` `cfg(unix)` gate); `cargo tree -i openssl-sys`.
- REPORTED: libgit2 1.9.4 Windows WinHTTP/CNG backend selection (same build script, other branch); libgit2 partial-clone/`--filter` absence; libgit2 proxy env-var non-reading.
