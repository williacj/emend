@echo off
REM ABOUTME: Launcher for the externally-owned sccache server on a self-hosted Windows runner host
REM ABOUTME: (#1178) — portable across hosts; __SCCACHE_EXE__/__SCCACHE_DIR__ substituted at install.
REM
REM Why this exists: sccache's server is a per-user daemon, so BOTH runner services on a host share
REM one. A daemon spawned by a CI job is reaped when that job completes, killing any concurrent job's
REM compile mid-flight (issue #1178). Task Scheduler owning it removes that failure entirely.
REM
REM THIS FILE IS THE CANONICAL TEMPLATE, NOT THE INSTALLED COPY. The install step substitutes the
REM placeholders below and writes the result to C:\sccache\start-sccache-server.cmd, deliberately
REM outside any checkout: a boot-triggered daemon whose launcher lives in a git working tree breaks
REM on a branch switch, a `git clean`, or a moved checkout, and sources a system service from a dev
REM tree. Edit here, then re-substitute and re-copy. See docs/ci-windows-runner.md
REM "Externally-owned compiler cache".
REM
REM THREE VALUES ARE HOST-SPECIFIC, NOT ONE (corrected 2026-08-23; #1900 claimed only the task XML's
REM __USER__ was). That claim rested on %USERPROFILE% resolving per-account, which silently assumes
REM the service account owns a .cargo directory. It does not hold where the runner services run as a
REM DEDICATED account rather than the operator's own: on FINN-PC10 they run as a local service account
REM whose profile has no .cargo at all, so substituting the correct __USER__ produced a path to a
REM missing binary — no daemon, and the workflow preflight then fails every job on that host. Both
REM values below are therefore substituted explicitly, and a substituted value may itself contain
REM %USERPROFILE%/%LOCALAPPDATA% on a host where that is the right answer.
REM
REM These variables MUST be set here, on the process that starts the server: sccache reads them
REM when the server starts, so setting them in the workflow has no effect at all.

REM Where the server keeps its cache. Only the SERVER reads this; clients reach it over
REM 127.0.0.1:4226 and need no matching setting. Set explicitly rather than relying on the
REM %LOCALAPPDATA% default, because a service account has no interactive profile to resolve that
REM default through — pass the literal %LOCALAPPDATA%\Mozilla\sccache\cache on hosts where the task
REM runs as the operator's own account and an existing warm cache must be preserved.
set SCCACHE_DIR=__SCCACHE_DIR__

REM 0 = never expire. VERIFIED EMPIRICALLY on WILLIACJ-01 / sccache 0.17.0 (2026-08-05), not assumed:
REM with SCCACHE_IDLE_TIMEOUT=30 the process exited on its own at 30.06s, proving the variable is
REM read at all; with 0 the same PID was still alive at T+5s, T+60s and T+150s and ran 8m11s until an
REM explicit --stop-server. The control run is what rules out "0 is silently ignored".
set SCCACHE_IDLE_TIMEOUT=0

REM Foreground mode: this process IS the server, so Task Scheduler supervises the real thing rather
REM than a launcher that exits immediately.
REM
REM DO NOT "correct" this to --start-server. `sccache --help` on 0.17.0 documents only that flag and
REM lists no foreground option, so this mode looks wrong if you check the help text — it is not. It
REM was verified empirically on this build: these two variables produce a genuinely blocking process
REM (evidence above). Switching to --start-server would return control immediately, leaving the task
REM with nothing to supervise.
set SCCACHE_START_SERVER=1
set SCCACHE_NO_DAEMON=1

REM Fail LOUDLY on a bad substitution. Without this the task starts, cmd reports "not recognized",
REM the action exits, and the host is left with a registered task and no daemon — which reads exactly
REM like the #1178 reaping this file exists to prevent, and is caught only by the workflow preflight
REM one job later. A non-zero exit here is what RestartOnFailure and the operator can both see.
if not exist "__SCCACHE_EXE__" (
  echo [sccache-server] FATAL: sccache not found at "__SCCACHE_EXE__" on this host.
  echo [sccache-server] Re-run the install recipe with the correct __SCCACHE_EXE__ substitution.
  exit /b 1
)

"__SCCACHE_EXE__"
