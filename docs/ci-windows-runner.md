ABOUTME: Operate the self-hosted Windows Actions runners used by Cowrite CI.
ABOUTME: Covers runner admission, service control, and the shared Rust compiler cache.

# Self-hosted Windows Actions runner

The [Windows workflow](../.github/workflows/windows-self-hosted.yml) runs Cowrite checks on real Windows hardware. Its job selects `[self-hosted, Windows, cowrite-required]`. Registration alone does not admit a runner: the operator adds `cowrite-required` only after qualifying its host. The workflow runs for pull requests to `main` and has a daily full-suite backstop.

## Before merging a pull request

The maintainer checks that Windows CI and any other checks that ran are green for the **current PR head** before merging. If a new commit changes the head, check the Windows result and every other check that ran again. This private repository has no branch protection that mechanically blocks a merge when the Windows result is missing or red, or another check is red; the maintainer owns this prerequisite.

## On-demand unsigned NSIS evidence (#2612)

The existing Windows workflow has an operator-only `unsigned-nsis` dispatch mode. It builds the normal default-feature Tauri app on an admitted self-hosted Windows runner, without signing, and checks both `emend.exe` and one new NSIS `*-setup.exe`. The installer is uploaded as a seven-day artifact named for the exact commit. This job has a different check name from `Suites (Windows, self-hosted)` and does not run for pull requests, the daily schedule, or the ordinary `suites` dispatch. Keep it separate until its compilation time and runner contention are measured; it does not replace the required current-head Windows suites.

After the branch containing this workflow mode is pushed, dispatch the exact PR commit (not a mutable branch name as the target):

```sh
gh workflow run windows-self-hosted.yml --ref feature/issue-2612-whisper-shipped -f windows_mode=unsigned-nsis -f target_sha=<40-character-PR-head-SHA>
```

Inspect the `Unsigned NSIS (Windows, self-hosted)` job result, its printed checkout SHA and executable/installer SHA-256 hashes, and the uploaded artifact. Record the run ID, job duration and any overlap with ordinary Windows suites before considering this packaging job for a recurring gate. The local unsigned macOS `.app` check supplies the separate macOS packaging evidence; neither unsigned artifact proves signing or a pinned-model WAV transcript.

## Current runner inventory

Confirm the live inventory with `gh api repos/williacj/cowrite/actions/runners` before changing a service or label. The last recorded layout is:

| Host | Runner | Directory | Service account | Required eligibility |
|---|---|---|---|---|
| WILLIACJ-01 | `cowrite-windows` (id 22) | `C:\actions-runner` | `williacj` | quarantined; offline; no capability label |
| WILLIACJ-01 | `cowrite-windows-2` (id 24) | `C:\actions-runner-2` | `williacj` | quarantined; offline; no capability label |
| FINN-PC10 | `cowrite-windows-3` (id 27) | `C:\actions-runner-3` | `ghrunner` | `cowrite-required` |
| FINN-PC10 | `cowrite-windows-4` (id 28) | `C:\actions-runner-4` | `ghrunner` | `cowrite-required` |

Two services on one host need distinct physical `_work` roots. They share the host's user-scoped `sccache` daemon. A job must not start or stop that daemon, because another job may be compiling through it.

## Qualify and admit a host

1. Install Node 20, Git, the pinned Rust toolchain, PowerShell and the Cowrite app's Windows C++ build prerequisites. The ordinary Cowrite app build now compiles vendored whisper.cpp through CMake; the required self-hosted workflow provisions a SHA-256-verified Kitware 3.31.12 ZIP before every normal-feature Rust compile and adds its `bin` directory to PATH. It also provisions a verified Windows `libclang.runtime.win-x64` 22.1.8 DLL and publishes `LIBCLANG_PATH` so `whisper-rs-sys 0.15.0` generates Windows-specific bindings. Hosted CI and the operator benchmark use `scripts/provision-whisper-windows.ps1` with the same pinned digests. CI sets `GGML_CCACHE=OFF` so ggml's native CMake compilation does not auto-select an ambient sccache daemon; Cowrite's separate Rust `RUSTC_WRAPPER` policy still applies. Do not set `WHISPER_DONT_GENERATE_BINDINGS`: that crate's bundled Linux bindings fail Windows layout checks. A manual Windows app build must install CMake and libclang and set `LIBCLANG_PATH`. Ensure the service account can run `npm ci`, Cargo, and the workflow's test commands in its own work root, and can download the pinned archives from Kitware's GitHub release and NuGet.
2. Register each Actions runner service with its own directory and `_work` root. Give both services a host-specific label for operator-only qualification. Keep `cowrite-required` absent during qualification.
3. Install the external `sccache-server` task described below. Confirm that its process is running under the same account as the runner services. The workflow's cache preflight must pass before Rust and e2e driver builds.
4. Use the [isolation canary](../.github/workflows/windows-runner-isolation-canary.yml) to prove distinct work roots on that host. Use the [contention benchmark](../.github/workflows/windows-runner-contention-benchmark.yml) to compare three jobs at `parallelism=one` with three jobs at `parallelism=two`. Accept concurrent service use only when aggregate throughput improves by at least 1.5× and correctness checks remain green.
5. Inspect the job API results and their exact revisions. Admission is decided from those job-API results and correctness guards. All-zero pressure counters are non-discriminating; they do not establish CPU/disk saturation or headroom and are excluded from the admission decision.
6. Add `cowrite-required` to each qualified runner through the GitHub runner-label API. Record the run IDs, hostnames, `_work` paths, and admission decision with the host's operations record.

To remove eligibility without deleting or unregistering a runner, remove its `cowrite-required` label. For a known runner id, use `gh api -X DELETE repos/williacj/cowrite/actions/runners/$runnerId/labels/cowrite-required`. Label removal affects new jobs; cancel an already assigned run separately when its result would be unsafe. A host-specific label remains available for qualification while `cowrite-required` is absent.

## Compiler cache task

The two runner services on one host use one externally owned `sccache` server. Install the templates [sccache-server.cmd](../scripts/sccache-server.cmd) and [windows-sccache-task.xml](../scripts/windows-sccache-task.xml) from an elevated PowerShell in a Cowrite checkout. Set all three values for that host:

| Host | `__USER__` | `__SCCACHE_EXE__` | `__SCCACHE_DIR__` |
|---|---|---|---|
| WILLIACJ-01 | `.\williacj` | `%USERPROFILE%\.cargo\bin\sccache.exe` | `%LOCALAPPDATA%\Mozilla\sccache\cache` |
| FINN-PC10 | `.\ghrunner` | `C:\tools\sccache.exe` | `C:\sccache\cache` |

```powershell
# Per-host values from the table above. All three MUST be substituted.
$account    = '.\<account>'
$sccacheExe = '<path to sccache.exe for that host>'
$sccacheDir = '<cache directory for that host>'

New-Item -ItemType Directory -Force C:\sccache | Out-Null
(Get-Content -Raw scripts\sccache-server.cmd) `
  -replace '__SCCACHE_EXE__', $sccacheExe `
  -replace '__SCCACHE_DIR__', $sccacheDir |
  Set-Content C:\sccache\start-sccache-server.cmd -Encoding ascii

$taskXml = (Get-Content -Raw scripts\windows-sccache-task.xml) -replace '__USER__', $account
Register-ScheduledTask -TaskName 'sccache-server' -Xml $taskXml -Force
```

The task account must have `SeBatchLogonRight`. Runner service logon permission alone does not grant it. `Register-ScheduledTask` can succeed without the task ever starting if that right is missing. Verify the process and task result after installation and after reboot. Each physical host needs its own task; sharing a task across hosts is impossible.

The workflow's `boot-trigger` diagnostic checks that Task Scheduler Operational Event 118 occurred during the current boot and that the server started near it. It is operator-only and intentionally fails the workflow after reporting evidence, so a diagnostic run cannot stand in for an ordinary CI pass.

## Service control

The Windows runner is installed directly as a service. On the host that owns it, use an elevated PowerShell:

```powershell
Get-CimInstance Win32_Service |
  Where-Object Name -Like 'actions.runner.williacj-cowrite.*' |
  Select-Object Name, StartName, State

Stop-Service 'actions.runner.williacj-cowrite.cowrite-windows-3'
Start-Service 'actions.runner.williacj-cowrite.cowrite-windows-3'
```

Replace the example service name with the one reported on that host. Restart services after editing the machine PATH because a running service retains its startup environment. Stopping a host's second service is the immediate containment step for shared-work-root or contention trouble; stopping both removes the host from the pool while another admitted host can continue.

A queued Windows job does not turn green because a runner is unavailable. Restore an admitted host, or let the queued run fail visibly. Before re-admitting a repaired host, repeat the work-root and cache checks above.
