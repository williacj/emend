# Cowrite (v2)

A cross-platform desktop app (macOS + Windows) providing a Word-like writing and reviewing experience for markdown files, deeply enhanced by LLM agents (Claude Code CLI, GitHub Copilot CLI). The markdown file is always the source of truth; everything Cowrite adds — comments, tracked changes, skills, workflows — lives in portable, repo-owned formats.

## Status

**v2 ground-up rewrite — planning complete, implementation starting.** The v1 application lives on the [`legacy/v1`](../../tree/legacy/v1) branch (tag `v1-legacy`), fully buildable.

## The constitution

All product and engineering decisions are recorded, with IDs, in four documents. Read them before contributing anything:

| Document | Contents |
|---|---|
| [`docs/functional-spec.md`](docs/functional-spec.md) | What the product does — decisions D1–D23, requirements FR-* |
| [`docs/ux-design.md`](docs/ux-design.md) | How it behaves — principles, state inventories, journeys J1–J8 |
| [`docs/tech-design.md`](docs/tech-design.md) | How it's built — decisions TD-1..8, component designs, spikes, build order |
| [`docs/test-plan.md`](docs/test-plan.md) | How it's proven — properties P1–P6, fake-agent parity, release gates |

Supporting: [`docs/journal.md`](docs/journal.md) (engineering journal) · [`docs/spikes/`](docs/spikes/) (executed spike findings) · `spikes/` (untracked throwaway prototypes — never merged, per test plan).

## The three pillars

1. **Brainstorm → Revise → Skill-based review** — a repo-grounded agent that drafts, revises as tracked changes, and reviews documents against repo-owned skills and workflows.
2. **Comment → AI addresses** — anchored comments any provenance, addressed by you or delegated to the agent (tracked changes + explanations).
3. **Collaborative review** — GitHub-backed, git-invisible review: reviewers use Cowrite in a git-free mode, redline and suggest; the author (or the agent) addresses.

## Development

Cowrite is a [Tauri 2](https://tauri.app) desktop app: a Rust backend (`src-tauri/`) with a React + TypeScript + Vite frontend (`src/`). Module homes are defined in [`docs/tech-design.md`](docs/tech-design.md) §3.1.

**Prerequisites:** [Node.js](https://nodejs.org) 20+, the stable [Rust toolchain](https://rustup.rs), and Tauri's [platform prerequisites](https://tauri.app/start/prerequisites/) — on Windows the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) plus the MSVC C++ build tools; on macOS the Xcode Command Line Tools.

```sh
npm install            # install frontend dependencies
npm run tauri dev      # run the app with hot reload
npm run tauri build    # produce a release build
npm run build:rust     # build only the Cowrite package (not every workspace utility)
```

Checks: `npm run build` (frontend type-check + bundle); from `src-tauri/`, `cargo fmt`, `cargo clippy`, and `cargo test`.

The ordinary Windows and macOS app builds include local Whisper inference. Windows builds need CMake, the MSVC C++ build tools, and a Windows `libclang.dll` directory in `LIBCLANG_PATH`; [the CI provisioner](scripts/provision-whisper-windows.ps1) records the pinned, hash-verified CMake and libclang packages used by the exact-head build gate. Leave `WHISPER_DONT_GENERATE_BINDINGS` unset: pinned `whisper-rs-sys 0.15.0` bundles Linux bindings whose structure layouts fail on Windows. A local Windows shell may install equivalent tools and set `LIBCLANG_PATH` before `npm run tauri build`. macOS needs CMake and Xcode Command Line Tools; CI sets `LIBCLANG_PATH` to Xcode's target-native `libclang.dylib`. Set `GGML_CCACHE=OFF` for a local build when no running C/C++ sccache daemon is available; CI sets it explicitly, independently of Cowrite's Rust compiler cache. The build includes inference code but downloads no model: voice readiness still requires verified local model bytes, microphone access, and an enabled setting.

The manual positive transcript gate uses the catalog-pinned [`base.en-q5_1` model](src-tauri/src/voice/catalog.rs) and whisper.cpp's [JFK sample](https://github.com/ggml-org/whisper.cpp/raw/60c0be6ac8fa71b1a2ae2dd938a31a34a508e774/samples/jfk.wav). The sample must be 352,078 bytes with SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`; the model must be 59,721,011 bytes and pass the catalog's BLAKE3 check. Keep both downloads outside Git, then run:

```sh
EMEND_VOICE_FIXTURE_MODEL=/absolute/path/ggml-base.en-q5_1.bin \
EMEND_VOICE_FIXTURE_WAV=/absolute/path/jfk.wav \
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib \
  voice::transcription::whisper_backend::tests::pinned_wav_transcribes_recognizable_jfk_phrase \
  -- --ignored --exact
```

The ignored test reads verified model bytes through Cowrite's registry and exercises the production Whisper transcriber. Normal `cargo test` cannot run it without these external downloads.

### Cached Rust builds and worktrees

The `tauri` and `build:rust` scripts preserve an existing `RUSTC_WRAPPER`; otherwise they
automatically use `sccache` when it is installed. If `sccache` is absent they fall back to plain
Cargo. Set `EMEND_SCCACHE_DISABLE=1` to troubleshoot with the cache disabled — it suppresses that
automatic selection only, so an `RUSTC_WRAPPER` you exported yourself still wins and has to be unset
to build with no wrapper at all. Cache activity is visible with `sccache --show-stats` (and can be
reset before a measurement with `sccache --zero-stats`).

Setting `RUSTC_WRAPPER` is the whole of the cache wiring — no path-normalization configuration is
derived. `sccache`'s cache directory is user-wide rather than repo-scoped, so a fresh worktree's
build already hits it for the third-party dependency graph, which is where the compile time
actually goes. The workspace's own crates are the cheap ones and are built incrementally, which
`sccache` does not cache in either direction.

Ordinary commands keep each worktree's `src-tauri/target` isolated. This is the safe default when
worktrees may build concurrently: `sccache` shares compiled objects without making Cargo processes
contend for one target-directory lock.

For worktrees used strictly one at a time, an explicit shared target avoids repeating Cargo's
worktree-local metadata and link outputs:

```sh
npm run build:rust:shared
npm run tauri:shared -- dev
npm run tauri:shared -- build
```

Shared mode resolves Git's common worktree directory and puts `.emend-cache/rust-target` beside
the checkout — or, when that common directory is not a checkout's `.git` (a bare repo anchoring a
worktree set, or `--separate-git-dir`), inside the Git directory itself, since there is no checkout
to sit beside. Do not run shared-mode commands concurrently in different worktrees; Cargo will
serialize them on the shared target lock. The `.emend-cache` directory is gitignored at the repo
root; the other placement lands inside the Git directory, which is never tracked.

Dev and test builds carry line-table debug info (`[profile.dev] debug = 1` in
`src-tauri/Cargo.toml`, inherited by the `test` profile), which is what keeps the target directory
around a quarter smaller. Backtraces still resolve to file and line; a debugger will not show local
variables. Release builds are unaffected.

`node_modules` intentionally remains worktree-local. Node installation is already fast for this
project, while sharing that mutable dependency tree would couple worktrees and make branch-specific
lockfile changes unsafe.
