# SPIKE-6 — cross-platform second-instance spawn and cooperative activation

ABOUTME: Measures TD-20's launch, cooperative activation, and filesystem-notification assumptions on
ABOUTME: real Windows and macOS hosts, then gives P2a-11f the platform-specific sequences to build.

**Verdict: GO for P2a-11f on the two measured hosts, with one material implementation constraint.**
Use TD-20's detached launch shapes and its file-rendezvous protocol; option C's endpoint is not
needed. On Windows, the requester grants the validated owner PID and the owner restores a minimized
window before focusing it. On macOS, do not rely on `NSApp.yieldActivation(to:)` alone: invoke
`NSRunningApplication.activate(options: [])` for the validated owner, then have the owner restore or
show its window before `set_focus()`. That macOS sequence raised visible, minimized, and hidden targets
in every measured repetition.

This selects between mechanisms TD-20 already records (rulings 5–7); it proposes **no recorded-
decision delta**, does not apply one, and does not require the `Open in another window` outcome to
return to CJ as a product question on the measured systems. Platform refusal remains an expected,
honest `Failed(reason)` outcome under TD-20/J9 rather than a silent `Focused` acknowledgement.

**Date:** 2026-09-05 · **findings base:** `d3fc8b77468bc17fd83fb34d2a3b8eade9798a80`
(`origin/main`) · **Windows host:** Windows 11 25H2, NT build 26200.9278, x64 · **macOS host:**
macOS 26.6.2 (25G83), Darwin 25.6.0, arm64 · **throwaway harness:**
`spikes/spike6-project-activation/`, gitignored and never merged (test-plan §9b)

**Evidence tags:** **[MEASURED]** = raw receipt from the named real host · **[DERIVED]** = arithmetic
over those receipts · **[SOURCE]** = behavior verified from the throwaway probe source or the pinned
constitutional brief. Latencies use the probe's nearest-rank-at-or-below index
`floor((n - 1) * fraction)`.

---

## 1. Question and answer

SPIKE-6 asks three questions separately on each shipped platform:

1. Does the selected second-instance launch survive its launcher and meet the 20-second launch
   budget (FR-X-12; TD-20 ruling 7)?
2. Does the grant → owner-raise sequence actually make the target frontmost, including a
   background-but-not-frontmost requester and a minimized target, while distinguishing focus-only
   from restore + focus (FR-X-11; TD-20 ruling 6)?
3. Does `notify 8.2.0` deliver outcome-directory events inside the 3-second raise budget, or must the
   raise case use TD-20 option C's per-instance endpoint?

The six required clause/platform cells all have real-host measurements:

| clause | Windows 11 25H2 | macOS 26.6.2 |
|---|---|---|
| (a) second-instance launch | **PASS.** Detached direct exec, 30/30 launchers exited and 30/30 distinct children remained alive after 2 s; max ready 13.419 ms. | **PASS.** `open -n -a` launched 10/10 distinct, simultaneously live app instances, all parented to PID 1 and alive 2 s after `open` returned; max 462.742 ms. The `setsid` fallback separately passed 20/20. |
| (b) cooperative activation | **PASS with required order.** The valid foreground-entitlement sequence raised a visible target; focus-only left a minimized target minimized; restore + focus raised the minimized target. | **PASS via `NSRunningApplication.activate`; PARTIAL via yield-only.** Explicit activation plus owner restore/show + focus passed visible, minimized, and hidden cases 10/10 each. Yield + restore + focus failed the minimized case 0/10. |
| (c) native outcome notification | **PASS.** 5 × 500 = 2,500 events; p50 0.524 ms, p95 0.801 ms, p99 2.165 ms, max 21.078 ms; 0 over 3 s. | **PASS.** 5 × 500 = 2,500 events; p50 5.433 ms, p95 6.585 ms, p99 8.207 ms, max 28.254 ms; 0 over 3 s. |

**Answer:** build P2a-11f on TD-20's file rendezvous. Neither platform needs option C for latency.
Both support the product outcome on the measured OS version, so no product reconsideration is
required. The implementation must preserve the platform-specific activation sequence and must not
acknowledge `Focused` from an API return alone.

## 2. Clause (a): second-instance spawn

### 2.1 Windows detached direct exec **[MEASURED]**

Thirty launchers spawned the probe with
`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB` (`0x01000208`), discarded
stdio, wrote their child identity, and exited. After two seconds:

| trials | distinct launchers | distinct children | launchers gone | children alive | min | p50 | p95 | max | over 20 s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 30 | 30 | 30 | 30 | 30 | 9.841 ms | 11.582 ms | 12.621 ms | 13.419 ms | 0 |

This directly answers FR-X-12's launcher-lifetime property. One additional diagnostic showed that the
probe process and child were still members of the surrounding sandbox job on this host even though
the breakaway flag was supplied. The result therefore proves survival after the immediate launcher
exits; it does **not** claim survival after an arbitrary enclosing job object is terminated. A normal
desktop launch is not expected to have that enclosing sandbox job, and TD-20 already says breakaway
is used “where permitted.” P2a-11f should retain the flag and separately keep its honest launch-
failure path.

### 2.2 macOS LaunchServices and direct-exec fallback **[MEASURED]**

The target was an ad-hoc-signed arm64 `.app` bundle (`com.cowrite.spike6.target`). Ten calls to
`open -n -a Spike6Target.app --args …` produced ten distinct PIDs. All ten were simultaneously alive
two seconds after each `open` command returned, and every process reported PPID 1:

| trials | distinct PIDs | alive after 2 s | PPID set | min | p50 | p95 | max | over 20 s |
|---:|---:|---:|---|---:|---:|---:|---:|---:|
| 10 | 10 | 10 | `{1}` | 146.301 ms | 164.625 ms | 179.345 ms | 462.742 ms | 0 |

The non-bundle fallback was tested separately. Twenty launcher processes called `setsid()` during
spawn and exited; after two seconds, all 20 launchers were gone, all 20 children were alive, and all
20 children reported `sid == pid`:

| trials | launchers gone | children alive | session leaders | min | p50 | p95 | max | over 20 s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 20 | 20 | 20 | 92.529 ms | 113.172 ms | 127.472 ms | 160.498 ms | 0 |

These measurements support TD-20 ruling 7's primary LaunchServices path and its detached development
fallback. They do not cover a notarized release bundle; §6 carries that limit.

## 3. Clause (b): cooperative activation

Success was credited only when the final frontmost process was the target and the target window
reported focused. A successful API return by itself earned no credit.

### 3.1 Windows: grant succeeds, focus-only remains the negative control **[MEASURED]**

The accepted receipts came from three runs on CJ's actual interactive desktop. A tao foreground
controller spawned a helper, making the helper background-but-not-frontmost while preserving the
user-initiated foreground entitlement. The helper called `AllowSetForegroundWindow(target_pid)`;
the target process then performed the named owner-side action.

| target/action | n | controller frontmost | helper frontmost | grant | final target state | request → observation | result |
|---|---:|---:|---:|---|---|---:|---|
| visible / `set_focus()` | 1 | yes | no | success | foreground, not minimized | 256.745 ms | **PASS** |
| minimize / `set_focus()` only | 1 | yes | no | success | still minimized, not foreground | 354.033 ms | **EXPECTED NO-OP** |
| minimize / restore + `set_focus()` | 1 | yes | no | success | restored and foreground | 360.988 ms | **PASS** |

The focus-only control is load-bearing: tao 0.35.3 guards focus while minimized, so a report that
counted the API call rather than the observed state would have produced the wrong implementation.
P2a-11f must grant the identity-validated owner PID, then the owner must unminimize before focus.

Several earlier Windows runs are deliberately excluded. Sandbox-launched attempts returned a null
foreground HWND and could observe no interactive desktop. In a later repeated matrix, most
controllers did not become foreground and `AllowSetForegroundWindow` returned zero with access
denied; those rows lacked the required precondition and are not folded into the successful sample.
They do demonstrate why the production path must treat a refused grant/raise as a bounded failure,
not write `Focused` optimistically. Only the three directories whose controller receipts prove the
foreground precondition are summarized above.

**Consequence of the partial cell:** option C is not relevant—an endpoint cannot confer foreground
permission or restore a minimized window. The measured grant + restore + focus path works, so the
product outcome does not return to CJ. A denied grant remains TD-20's ordinary `Failed(reason)` case.

### 3.2 macOS: explicit running-application activation is the reliable grant **[MEASURED]**

The macOS probe used an ad-hoc-signed AppKit requester and a real tao 0.35.3 target. Each case ran ten
times. Active requester cases used macOS's `NSApp.yieldActivation(to:)`; explicit cases called
`NSRunningApplication.activate(options: [])` for the target before the owner action. Background cases
made the process issuing the grant a non-frontmost child of the frontmost requester controller.

| requester grant / owner action | n | target frontmost + focused | retained wrong state | interpretation |
|---|---:|---:|---:|---|
| active yield / visible focus | 10 | 10 | 0 | passes, but no-yield control also passes |
| active yield / minimized focus-only | 10 | 0 | 10 minimized | expected negative control |
| active yield / minimized restore + focus | 10 | 0 | 0 minimized, but 10 not focused | **yield is insufficient for minimized target** |
| active yield / hidden focus-only | 10 | 0 | 10 hidden | expected negative control |
| active yield / hidden show + focus | 10 | 10 | 0 | passes |
| active yield + explicit activation / visible focus | 10 | 10 | 0 | passes; activation returned true 10/10 |
| background yield / visible focus | 10 | 10 | 0 | empirical only; tao fallback confounds attribution |
| background explicit activation / visible focus | 10 | 10 | 0 | passes; activation returned true 10/10 |
| background explicit activation / minimized restore + focus | 10 | 10 | 0 | **required minimized case passes 10/10** |
| background explicit activation / hidden show + focus | 10 | 10 | 0 | passes 10/10 |
| active no-yield / visible focus control | 10 | 10 | 0 | tao's deprecated fallback raises by itself |

The no-yield result prevents attributing visible-window success to the cooperative grant: tao 0.35.3
still calls deprecated `activateIgnoringOtherApps`, which can raise a visible target on this OS.
The minimized case separates the mechanisms. Yield followed by owner restore + focus restores the
window but leaves it unfocused in 10/10 runs; explicit `NSRunningApplication.activate`, followed by
the identical restore + focus owner action, raises and focuses it in 10/10 runs even when the grant
process itself is background.

P2a-11f should therefore use the identity-validated `NSRunningApplication` route, then have the owner
restore/show before focus. It must not depend on tao's deprecated fallback or on yield-only behavior.
This is within TD-20 ruling 6's recorded “activation yielded to / `NSRunningApplication` activation”
choice and does not amend it.

**Consequence of the failed yield-only cell:** option C is not required; it changes transport, not
AppKit activation policy. The alternate mechanism already recorded by TD-20 passes all required
states, so `Open in another window` does not return to CJ. If a future OS refuses explicit activation,
the owner must report bounded failure and that newly measured platform result—not this failure of a
discarded alternative—would reopen the product question.

## 4. Clause (c): `notify` outcome latency

Both probes used the repository's exact `notify 8.2.0`, watched one outcome directory
non-recursively, published each outcome atomically, and waited for its receipt before sending the
next. Each host ran five independent watcher processes with 500 publications apiece.

| host | watchers × events | min | p50 | p95 | p99 | max | over 3-second raise budget |
|---|---:|---:|---:|---:|---:|---:|---:|
| Windows 11 25H2 | 5 × 500 = 2,500 | 0.346 ms | 0.524 ms | 0.801 ms | 2.165 ms | 21.078 ms | 0 |
| macOS 26.6.2 | 5 × 500 = 2,500 | 0.676 ms | 5.433 ms | 6.585 ms | 8.207 ms | 28.254 ms | 0 |

The slowest observation was under 1% of the 3-second budget on both hosts. **TD-20 option C is not
required.** The file rendezvous remains one mechanism for raise and launch, as TD-20 intended.

This is notification-delivery latency, not the complete user-perceived route latency: serialization,
request handling, window activation, and outcome publication still consume budget. The more than
2-second minimum slack left by the observed activation rows is ample on these hosts, but P2a-11f's
bounded integration tests must still measure from the user's request deadline rather than reset the
clock at the watcher.

## 5. Recommendation for P2a-11f

Implement the recorded TD-20 shape with these platform adapters:

1. **Common precondition:** canonicalize the target, validate the live owner PID plus executable or
   bundle identity, and keep the OS lock—not `owner.json`—as ownership authority.
2. **Windows requester:** while carrying the user-initiated foreground entitlement, call
   `AllowSetForegroundWindow(owner_pid)` and reject a failed grant honestly.
3. **Windows owner:** on the request, unminimize first, then call `set_focus()`; verify the observable
   result before writing `Focused`.
4. **macOS requester:** obtain the validated owner's `NSRunningApplication` and call
   `activate(options: [])`. Do not make correctness depend on `NSApp.yieldActivation(to:)` or tao's
   deprecated `activateIgnoringOtherApps` fallback.
5. **macOS owner:** unminimize a minimized window or show a hidden window, then call `set_focus()`;
   verify frontmost/focused state before acknowledging.
6. **Both:** retain `notify` for request/outcome observation, the injected 3-second raise and
   20-second launch deadlines, the final read at expiry, and the bounded `Failed(reason)` path.
7. **Launch:** use `open -n -a <bundle> --args …` for packaged macOS, detached `setsid` for the macOS
   development fallback, and `0x01000208` detached flags for Windows.

The downstream tests should preserve the controls this spike needed: visible versus minimized;
focus-only versus restore + focus; grant accepted versus refused; frontmost versus background grant
caller; and acknowledgement withheld until an observable focused state exists. A mock that simply
returns success from the grant API would erase the central finding.

## 6. Limits and negative evidence

- **One OS version per platform.** These results cover Windows 11 25H2 build 26200.9278 and macOS
  26.6.2 arm64. They do not establish behavior on Windows 10, older Windows 11 builds, macOS 14/15,
  or Intel macOS. The code must retain bounded refusal rather than generalize a permission guarantee.
- **Development signatures only.** The macOS bundles were ad-hoc signed, not Developer ID signed or
  notarized. Windows used a local development executable, not an installed signed package. Release
  smoke tests must recheck bundle/executable identity and activation under release packaging.
- **Windows activation sample is narrow.** Each accepted visible/focus-only/restore cell has one
  fully qualified interactive-desktop trial. Repeated attempts without a foreground controller were
  rejected rather than averaged in. The result is sufficient to select the sequence, not to estimate
  a reliability percentage.
- **macOS visible focus is confounded by tao's fallback.** The no-yield control succeeded 10/10, so
  visible yield rows do not prove yield caused activation. The explicit-activation minimized row is
  the load-bearing positive result.
- **No user input during activation.** Both qualified runs kept the interactive desktop undisturbed.
  Competing user input or OS focus modes may change the result; those become bounded failure, never a
  false acknowledgement.
- **Notification load is serial.** The 2,500-event distribution measures native watcher delivery
  without a burst of simultaneous writers. It has enormous budget margin, but the integration suite
  should still cover joined/queued requests and deadline expiry under TD-20 ruling 9.
- **Windows job lifetime is not fully generalized.** The direct child survived its immediate launcher,
  but the sandbox job retained both processes. No claim is made about forced termination of that
  enclosing job.

None of these limits requires option C or a product decision now. They define release and integration
guards for the implementation tranche.

## 7. Evidence integrity and reproduction

The returned macOS artifacts were preserved byte-for-byte in CJ's Downloads folder and expanded only
under the gitignored spike directory:

| artifact | SHA-256 |
|---|---|
| `spike6-macos-evidence.tgz` | `e3421f47696306273cfa5446550e64407cfa530ead0b18001176a6efb8692221` |
| `last-run-summary.txt` | `4900acefcdc5778fa4c1e2488a0a97e24e09bca02fa6e90f98db3f4dc280a9ad` |
| `mac-system.txt` | `7799d87130fa6f86ef71fc78e605ce93fdc08785fe6f48aa8fb0282482e2c24e` |
| expanded `evidence.json` | `90f148b79473df5c728b3a9242b448bfc546ce81b835da104e10b499d381fcc` |

The macOS evidence itself records target binary SHA-256
`5aa86b53c90780cc8efc99efe6fc298ec51db20eaab82cdeba0c0e9fb1227b3c` and requester binary SHA-256
`e8a34516e89af86d7cf33bec91b8cb9b070eb758df2be41810c9e31148a6336f`.
The handoff package used to build them had SHA-256
`e57a5fd02fc7b3d07663657a51849efafc7075fcca018afedaf7294482b4de81`.

For Windows, a sorted SHA-256 manifest over the 2,581 accepted raw files (60 detached-launch
receipts, 2,500 numbered notification receipts, and 21 files from the three qualified activation
runs) hashes to
`041a9f63affeb585cb3daf78d8f9267e70028707eb1e49f47776fe7ea7d1e184`.
The manifest and all raw files remain under the gitignored spike directory and are deliberately not
committed.

The macOS package's reproducible command sequence was:

```sh
chmod +x build-probes.sh
./build-probes.sh
node ./run-spike6-macos.mjs | tee ./last-run-summary.txt
RUN_DIR="$(ls -td ./runs/* | head -1)"
tar -czf ./spike6-macos-evidence.tgz -C "$RUN_DIR" .
shasum -a 256 ./spike6-macos-evidence.tgz
```

Windows aggregates can be recomputed from the numbered receipts in
`runs/detached-breakaway/`, `runs/notify-rep-{1..5}/`, and the three accepted activation directories
named in §3.1. The excluded runs remain available beside them so an auditor can verify why they were
not counted.

## 8. Unblocks and decision disposition

This report clears SPIKE-6's gate on the project-open routing tranche, especially P2a-11f's
platform activator and P2a-11g's launch path. The implementation can use TD-20's existing protocol
without an endpoint fallback and without reopening J9's `Open in another window` outcome.

**No constitution amendment and no new product decision are proposed.** The one discarded mechanism
(`NSApp.yieldActivation(to:)` alone for a minimized target) is not a failure of TD-20's selected
outcome because TD-20 already records `NSRunningApplication` activation as the alternative and that
alternative passed. The raw probe code and receipts remain throwaway under test-plan §9b; this report
and the paired journal verdict are the only tracked artifacts.
