// ABOUTME: Contract tests for the two-runner Windows workspace-isolation canary (#981).
// ABOUTME: Keeps the proof concurrent, dispatch-only, bounded, and non-destructive.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowUrl = new URL('../.github/workflows/windows-runner-isolation-canary.yml', import.meta.url);
const productionWorkflowUrl = new URL('../.github/workflows/windows-self-hosted.yml', import.meta.url);

function readWorkflow() {
  return readFileSync(workflowUrl, 'utf8');
}

function readGitHubOutput(outputFile) {
  const bytes = readFileSync(outputFile);
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = bytes.subarray(3).toString('utf8');
  } else {
    text = bytes.toString('utf8');
  }
  const hexPrefix = [...bytes.subarray(0, 24)]
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  return {
    text,
    diagnostic: `GITHUB_OUTPUT byte length: ${bytes.length}; hex prefix: ${hexPrefix}`,
  };
}

test('GitHub output decoding matches the runner across PowerShell encodings (#1335)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'github-output-encoding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await t.test('decodes a UTF-16LE file with a BOM', () => {
    const outputFile = join(dir, 'utf16le.txt');
    writeFileSync(
      outputFile,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('convened=true\r\n', 'utf16le')]),
    );
    const decoded = readGitHubOutput(outputFile);
    assert.equal(decoded.text, 'convened=true\r\n');
    assert.equal(
      decoded.diagnostic,
      'GITHUB_OUTPUT byte length: 32; hex prefix: FF FE 63 00 6F 00 6E 00 76 00 65 00 6E 00 65 00 64 00 3D 00 74 00 72 00',
    );
  });

  await t.test('decodes a UTF-8 file without a BOM', () => {
    const outputFile = join(dir, 'utf8.txt');
    writeFileSync(outputFile, Buffer.from('convened=false\n', 'utf8'));
    assert.equal(readGitHubOutput(outputFile).text, 'convened=false\n');
  });

  await t.test('strips a UTF-8 BOM', () => {
    const outputFile = join(dir, 'utf8-bom.txt');
    writeFileSync(
      outputFile,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('convened=true\n', 'utf8')]),
    );
    assert.equal(readGitHubOutput(outputFile).text, 'convened=true\n');
  });
});

// Lifts a step's `run:` block scalar straight out of the workflow. The behavioural tests below
// execute THE SHIPPED SCRIPT — never a copy pasted into this file, which could drift from the YAML
// and keep passing while the workflow itself regressed.
function extractRunScript(yaml, stepName) {
  const start = yaml.indexOf(`- name: ${stepName}\n`);
  assert.notEqual(start, -1, `no step named ${stepName}`);
  const afterRun = yaml.indexOf('run: |\n', start);
  assert.notEqual(afterRun, -1, `step ${stepName} has no 'run: |' block`);
  const lines = yaml.slice(afterRun + 'run: |\n'.length).split('\n');
  const indent = lines[0].match(/^ */)[0].length;
  const body = [];
  for (const line of lines) {
    if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

// The runner executes this with Windows PowerShell 5.1; a dev box may have pwsh 7 or neither.
function findPowerShell(spawn = spawnSync) {
  for (const exe of ['powershell', 'pwsh']) {
    const probe = spawn(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

test('PowerShell discovery prefers the workflow-declared inbox edition (#1335)', () => {
  for (const [name, url] of [
    ['isolation canary', workflowUrl],
    ['production suite', productionWorkflowUrl],
  ]) {
    assert.match(
      readFileSync(url, 'utf8'),
      /defaults:\s*\n\s+run:\s*\n\s+shell:\s*powershell(?:\s|$)/,
      `${name} must keep declaring the shell this discovery order exercises`,
    );
  }

  const probed = [];
  const shell = findPowerShell((exe) => {
    probed.push(exe);
    return { status: 0 };
  });
  assert.equal(shell, 'powershell');
  assert.deepEqual(probed, ['powershell']);
});

// The tests below dot-source extracted step bodies themselves, so their arguments have to be the
// runner's, argument for argument — under whichever edition `findPowerShell` located. Both Windows
// editions were executed against this argument list (inbox 5.1 and pwsh 7.6.5 behave identically,
// #2051). That pwsh on macOS/Linux also accepts `-ExecutionPolicy` is NOT executed here and is not
// executable on a Windows-only box; it is inferred from a reading of upstream's
// `CommandLineParameterParser.cs` recorded in #2051's review, which reports `executionpolicy`
// handled outside every `#if !UNIX` guard. #2051: they were approximated instead, and the
// approximation dropped the workflow's process-scoped `-ExecutionPolicy Bypass`. On the Windows
// default policy (`Restricted`) PowerShell then refuses every generated `.ps1` before an assertion
// runs, so ten real decision-table cells reported a spawn failure on any unmodified dev box.
// Deriving the arguments from the workflow's own `shell:` line stops the two drifting apart, and
// it also gives that line its only pin: #1335's check above matches `shell: powershell` and would
// pass with the bypass deleted. Resolved once at load so the drift guard fails on EVERY host,
// including the PowerShell-less ones that skip every case which would otherwise reach it.
function workflowShell() {
  const declared = readWorkflow().match(/^\s*shell:\s*powershell\s+(.*?)\s+-Command\s+"(.*)"\s*$/m);
  // At least one option is required between `powershell` and `-Command`, deliberately: the runner's
  // line has carried four since #1335, and a line with none would silently strip the very bypass
  // this derivation exists to carry. Refusing at load names that, where deriving an empty flag list
  // would instead fail later inside a spawn, as a policy refusal that looks like the #2051 defect.
  assert.ok(
    declared,
    'the canary workflow must declare the `shell: powershell <option>… -Command "…"` line these tests model',
  );
  return { flags: declared[1].split(/\s+/), commandTemplate: declared[2] };
}

const WORKFLOW_SHELL = workflowShell();

function powerShellArguments(file) {
  const { flags, commandTemplate } = WORKFLOW_SHELL;
  // A function replacement, so `$&`/`$$` and the other dollar forms in a temp path are inserted
  // literally rather than reinterpreted as replacement patterns.
  return [...flags, '-Command', commandTemplate.replaceAll('{0}', () => file)];
}

// Pin the child to the Windows DEFAULT process-scope policy rather than inheriting whatever this
// host happens to allow, so every case below exercises the refusal the workflow's bypass exists to
// defeat. Last wins deliberately: #2051 stayed invisible on hosts that had loosened the policy, and
// #2174 handed contributors `PSExecutionPolicyPreference=Bypass` as a workaround, which would
// otherwise mask a re-broken shell in exactly the environments that ran it.
function restrictedEnvironment(overrides) {
  return { ...process.env, ...overrides, PSExecutionPolicyPreference: 'Restricted' };
}

// Every extracted step body this file dot-sources goes through here. One site is what stops the
// execution-policy treatment being applied piecemeal, the way #2051 found the omission duplicated
// across the two step helpers below. The one deliberate exception is #2051's own negative control,
// which spawns directly because its whole job is to run WITHOUT the policy option.
function spawnWorkflowShell(shell, file, { env, ...rest } = {}) {
  return spawnSync(shell, powerShellArguments(file), {
    encoding: 'utf8',
    ...rest,
    env: restrictedEnvironment(env),
  });
}

// Stands in for the two GitHub APIs the convene step reads, and records the check-run POST. Each
// scenario is a state the real pool has actually produced, named in the test that uses it.
const API_FAKE = `
# pwsh 7 renders an uncaught throw in ConciseView, wrapping it across lines behind ANSI colour and a
# "|" gutter; Windows PowerShell 5.1 does neither. Pin both to the plain rendering so an assertion
# on the message means the same thing on a dev box and on the runner.
$ErrorView = 'NormalView'
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'PlainText' }
$script:jobPolls = 0
function Start-Sleep { param([int]$Seconds) Write-Host 'SLEPT' }
function Invoke-RestMethod {
  param($Uri, $Headers, $Method, $Body, $ContentType, $TimeoutSec)
  if ($Uri -like '*/check-runs') { Write-Host "POSTED-CHECK-RUN $Body"; return @{} }
  if ($Uri -like '*/jobs*') {
    $script:jobPolls++
    # A single transient 5xx mid-poll: the loop must ride it out, not abort with a stack trace.
    if ($env:FAKE_SCENARIO -eq 'flaky' -and $script:jobPolls -eq 5) { throw '502 Bad Gateway' }
    if ($env:FAKE_SCENARIO -eq 'apidown') { throw '503 Service Unavailable' }
    $status = switch ($env:FAKE_SCENARIO) {
      'live' { 'in_progress' } 'stale' { 'completed' }
      'starved' { 'queued' } 'nomarkers' { 'in_progress' }
      # Run 31206416568: the peer sat queued behind a production suite for 8.5 minutes and finally
      # got a runner 14 seconds before this slot's budget expired - live, but far too late to have
      # published anything.
      'latestart' { if ($script:jobPolls -ge 88) { 'in_progress' } else { 'queued' } }
      'flaky' { 'queued' }
      # Live well past the threshold, publishing nothing, then exits - a broken barrier, and the
      # shape BOTH slots take when the barrier genuinely breaks and they time out together.
      'livethendead' { if ($script:jobPolls -le 50) { 'in_progress' } else { 'completed' } }
    }
    return @{ jobs = @(@{ name = 'Isolation canary (head)'; status = $status }) }
  }
  $artifacts = if ($env:FAKE_SCENARIO -in @('nomarkers', 'latestart', 'flaky', 'livethendead')) {
    @(@{ name = 'isolation-ready-base' })
  } else {
    @(@{ name = 'isolation-ready-base' }, @{ name = 'isolation-ready-head' })
  }
  return @{ artifacts = $artifacts }
}
`;

function runConveneStep(shell, script, scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-convene-'));
  const file = join(dir, 'convene.ps1');
  // A real file, because the step writes its verdict through $GITHUB_OUTPUT exactly as the runner
  // provides it. Reading that file back is what proves the probe gate is actually driven.
  const outputFile = join(dir, 'github-output.txt');
  writeFileSync(outputFile, '');
  writeFileSync(file, `${API_FAKE}\n${script}`);
  // Dot-sourced under -Command, which is what decides whether `exit 0`, `exit 1` and an uncaught
  // `throw` really pass or fail the step.
  const result = spawnWorkflowShell(shell, file, {
    env: {
      FAKE_SCENARIO: scenario,
      GITHUB_REPOSITORY: 'williacj/cowrite',
      GITHUB_RUN_ID: '1',
      GITHUB_OUTPUT: outputFile,
      GH_TOKEN: 'x',
      COWRITE_SLOT: 'base',
      COWRITE_OTHER_SLOT: 'head',
      COWRITE_VERDICT_SHA: 'deadbeef',
    },
  });
  const raw = `${result.stdout}${result.stderr}`;
  // Console width still decides where a long message wraps, so match on collapsed whitespace.
  const output = raw.replace(/\s+/g, ' ');
  const githubOutput = readGitHubOutput(outputFile);
  const outputs = Object.fromEntries(
    githubOutput.text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  return {
    status: result.status,
    output,
    outputs,
    outputDiagnostic: githubOutput.diagnostic,
    postedCheckRun: output.includes('POSTED-CHECK-RUN'),
    polls: (raw.match(/SLEPT/g) ?? []).length,
  };
}

// Drops full-line `#` comments (YAML's and, inside a `run: |` block, PowerShell's — same syntax).
// Used wherever an assertion is about what the workflow EXECUTES: the comments deliberately name
// the expressions #1266 removed, so a naive `doesNotMatch` over the raw file would be tripped by
// the very prose that explains the removal — and a column-0 comment truncates the `on:` block
// extraction below. A live `${{ ... }}` expression is never on a comment line, so nothing
// executable is hidden by this.
function withoutComments(yaml) {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

// Parses the event names out of a YAML `on:` block — the keys at its first indentation level only,
// so a nested `inputs:`/`paths:` key cannot be mistaken for a trigger. Expects a block already run
// through `withoutComments`.
function parseTriggerKeys(block) {
  const lines = block.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  const indent = Math.min(...lines.map((line) => line.match(/^ */)[0].length));
  return lines
    .filter((line) => line.match(/^ */)[0].length === indent)
    .map((line) => line.trim().match(/^(['"]?)([A-Za-z_]+)\1:/)?.[2])
    .filter((key) => key !== undefined);
}

test('runs two bounded Windows canaries under its own cohort guard (#981/#982)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /host_label:[\s\S]*?default:\s*host-williacj-01[\s\S]*?options:\s*\n\s*- host-williacj-01\s*\n\s*- host-finn-pc10/);
  assert.match(
    yaml,
    /runs-on:\s*\[self-hosted,\s*Windows,\s*["']?\$\{\{\s*inputs\.host_label\s*\}\}["']?\]/,
    'isolation canary must select the requested physical host',
  );
  assert.match(yaml, /timeout-minutes:\s*10/);
  assert.match(yaml, /fail-fast:\s*false/);
  assert.match(yaml, /slot:\s*base/);
  assert.match(yaml, /slot:\s*head/);
  assert.match(
    yaml,
    /^concurrency:\n\s+group:\s*windows-runner-isolation-canary\n\s+cancel-in-progress:\s*false/m,
  );
  assert.doesNotMatch(yaml, /windows-self-hosted-runner-workspace/);
  assert.match(yaml, /production owns no global concurrency group after #982/);
  assert.match(yaml, /actions:\s*read/);
  assert.match(yaml, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(yaml, /name:\s*isolation-ready-\$\{\{\s*matrix\.slot\s*\}\}/);
  assert.match(yaml, /Set-Content[^\n]+\$env:COMPUTERNAME/);
  assert.match(yaml, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(yaml, /Get-Content -LiteralPath \$hostFile\.FullName -Raw/);
  assert.match(yaml, /\$hostnames \| Sort-Object -Unique/);
  assert.match(yaml, /actions\/runs\/\$env:GITHUB_RUN_ID\/artifacts/);
  assert.match(yaml, /\.name -eq 'isolation-ready-base'/);
  assert.match(yaml, /\.name -eq 'isolation-ready-head'/);
  assert.match(yaml, /\$ready\.Count -ge 2/);
});

// The pin above owns the group's VALUE; this one owns the RECORD of why that value was chosen, and
// binds the two together. #1262 held the keying open pending a post-#1234 measurement of canary-vs-
// canary contention. #1266 then made dispatch the only trigger, and the measurement came back empty:
// zero canary runs across the 119 PRs merged after it landed. Per-ref keying's rationale ("every PR
// keeps its own canary") therefore describes nothing, while its cost survives — two dispatches on
// different refs would become co-eligible for the same two runners, which is the #1231 starvation
// the global group exists to prevent. CJ ratified the global group on 2026-08-14. Requiring the
// record to name the group it froze is what stops a future re-key from leaving a decision note that
// describes a keying the workflow no longer uses.
test('the global concurrency group is a ratified keying, not an unreviewed default (#1262)', () => {
  const block = readWorkflow().match(/((?:^#.*\n)+)^concurrency:\n\s+group:[ \t]*(\S+)\n/m);
  assert.ok(block, 'expected a comment block immediately above the concurrency: block');
  const [, record, group] = block;
  assert.match(record, /#1262 \(CJ, 2026-08-14\): the GLOBAL group STANDS/);
  assert.match(record, /0 canary runs across the 119 PRs merged after #1266/);
  assert.match(record, /two dispatches on different refs would contend for the same two runners/);
  assert.ok(
    record.includes(group),
    `the #1262 decision record must name the group it kept — found group "${group}"`,
  );
});

// The barrier has to prove the peer is RUNNING NOW, not that it once published. A run's artifact
// list is durable for the whole run: it keeps listing `isolation-ready-<peer>` long after that peer
// job has died. Runs 31046727724 (2026-08-05) and 30684554436 (2026-08-01) both convened on that
// stale listing — the peer timed out and exited, the surviving slot then started on the SAME runner
// seconds later, cleared a `Count -ge 2` barrier in zero seconds against the dead peer's artifact,
// probed a workspace no one else was using, and reported SUCCESS. Nothing overlapped; nothing was
// isolated; the canary went green. Counting artifacts cannot distinguish that from a real cohort,
// so the barrier also has to read live job state (#1229/#1231).
test('the readiness barrier requires a live peer, not a durable artifact from a dead one (#1229/#1231)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /actions\/runs\/\$env:GITHUB_RUN_ID\/jobs/);
  // Derived from the slot, never hardcoded: a literal peer name silently stops matching for one of
  // the two slots and that slot would then convene with nothing.
  assert.match(yaml, /\$peerJobName = "Isolation canary \(" \+ \$env:COWRITE_OTHER_SLOT \+ "\)"/);
  // Liveness AND both markers — a live peer that has not yet published is not yet convened, and a
  // published marker from a peer that has exited is not a peer at all. Pinned as the NESTING, so the
  // marker count can never authorise convening outside the liveness guard.
  assert.match(
    yaml,
    /if \(\$peerStatus -eq 'in_progress'\) \{[\s\S]*?if \(\$ready\.Count -ge 2\) \{\n\s+\$convened = \$true/,
  );
  // A terminal peer can never overlap, so the loop stops rather than burning the rest of the budget.
  assert.match(yaml, /if \(\$peerStatus -eq 'completed'\) \{\n\s+break\n/);
  // A peer live for a SUSTAINED period with missing markers is the barrier itself breaking — a real
  // failure, and it must not be routed into the not-measured excuse below. The liveness threshold is
  // the load-bearing half: without it, a peer that got a runner seconds before the deadline is
  // blamed for a broken barrier when the pool starved it (run 31206416568). It deliberately does NOT
  // also test the peer's current status — the accumulated evidence has to outlive the peer, or a
  // barrier break gets excused as "already finished" by whichever slot sees the other exit first.
  assert.match(yaml, /if \(\$peerLivePolls -ge 24\) \{\n\s+throw /);
  // Both polls are guarded: a transient 5xx must cost one round of information, never the verdict.
  assert.match(yaml, /\$jobs = try \{ Invoke-RestMethod[^\n]*\} catch \{ \$null \}/);
  assert.match(yaml, /\$response = try \{ Invoke-RestMethod[^\n]*\} catch \{ \$null \}/);
  // The artifact list is only consulted while the peer is live, which is also what keeps this
  // step's poll volume near its pre-liveness-check budget.
  assert.match(yaml, /if \(\$peerStatus -eq 'in_progress'\) \{\n\s+\$response = try \{/);
});

// GitHub gives a workflow JOB no neutral conclusion — success, failure, cancelled, skipped only —
// so "we convened nothing" can only be said through a check-run published via the Checks API.
test('a canary that convened nothing says so, distinctly from both pass and fail (#1229/#1231)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /checks:\s*write/);
  assert.match(yaml, /conclusion\s*=\s*'neutral'/);
  assert.match(yaml, /name\s*=\s*"Isolation canary \(not measured: \$env:COWRITE_SLOT\)"/);
  // The two not-measured causes are different operational facts and must not collapse into one
  // another: a peer that never got a runner (#1231) vs. a peer that ran and exited before this slot
  // started (the stale-artifact false green above).
  assert.match(yaml, /NOT MEASURED: the peer canary never got a runner/);
  assert.match(yaml, /NOT MEASURED: the peer canary had already finished/);
  assert.match(yaml, /NOT MEASURED: the peer canary got a runner too late/);
  // A pool outcome is not this diff's failure, so the step ends cleanly and the neutral check-run
  // carries the verdict (#1231). Pinned to the end of the not-measured branch, so the pairing of
  // "say convened=false" with "exit 0" cannot be split — the gate below is what stops the clean
  // exit from becoming a vacuous pass, and the two only mean anything together.
  assert.match(yaml, /"convened=false" >> \$env:GITHUB_OUTPUT\n\s+Write-Host \$reason\n\s+exit 0\n/);
  // Publishing the verdict is best-effort — a Checks API refusal must not mask the real outcome.
  assert.match(yaml, /catch \{[\s\S]*?Write-Host "Could not publish the not-measured check-run/);
});

// The single most dangerous line in this workflow. `Prove isolated runner workspace` used to be
// skipped only as a SIDE EFFECT of the convene step failing — it carried no condition of its own.
// So the "one-line flip" that #1231 asks for (`exit 1` -> `exit 0`), and that this repo's own docs
// and the parked design note both described as one line, would have let the probe run with NO PEER:
// it writes its sentinel, sleeps 30s, finds no other sentinel, and reports SUCCESS. That is exactly
// the vacuous pass #1229's card closed, re-entered through the exit code. The probe must be gated on
// the convene step's own verdict, not on the absence of a failure.
test('the isolation probe runs only on a convened cohort, never on a clean not-measured exit (#1231)', () => {
  const yaml = readWorkflow();
  // The convene step has to be addressable for the gate to reference it.
  assert.match(yaml, /- name: Convene with the peer canary\n\s+id: convene\n/);
  // Both verdicts are published, so the gate is driven by a positive claim rather than by silence.
  assert.match(yaml, /"convened=true" >> \$env:GITHUB_OUTPUT/);
  assert.match(yaml, /"convened=false" >> \$env:GITHUB_OUTPUT/);
  // And the probe consults it. Anchored to the probe step itself so a gate added anywhere else in
  // the file cannot satisfy this.
  assert.match(yaml, /"co_located=true" >> \$env:GITHUB_OUTPUT/);
  assert.match(yaml, /"co_located=false" >> \$env:GITHUB_OUTPUT/);
  assert.match(yaml, /NOT MEASURED: the convened canary jobs reported different hostnames/);
  const probe = yaml.slice(yaml.indexOf('- name: Prove isolated runner workspace'));
  assert.match(
    probe,
    /^- name: Prove isolated runner workspace\n\s+if: steps\.convene\.outputs\.convened == 'true' && steps\.colocation\.outputs\.co_located == 'true'\n/,
  );
});

// The assertions above pin the TEXT of the convene step. These run it. The defect they exist for --
// a barrier that passes against a dead peer -- was invisible to text matching: the pre-#1229 step
// mentioned artifacts, counts and a bounded loop exactly as intended and still went green on a run
// where nothing overlapped. Only executing the decision table catches that.
const powerShell = findPowerShell();

// #2051's load-bearing property is not that a flag appears in an argument list -- it is that the
// dot-source SURVIVES the restricted process scope spawnWorkflowShell pins above. Prove the pin is
// real and that the workflow's bypass is what defeats it: same script, same environment, only the
// policy option dropped, which is the argument list this file carried before #2051.
test('the pinned restricted process scope really refuses an unbypassed dot-source (#2051)', (t) => {
  if (process.platform !== 'win32') return t.skip('PowerShell execution policy is a Windows-only mechanism');
  if (!powerShell) return t.skip('neither pwsh nor powershell is on PATH');
  const dir = mkdtempSync(join(tmpdir(), 'canary-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'policy-probe.ps1');
  writeFileSync(file, "Write-Host 'DOT-SOURCED'\n");

  const bypassed = spawnWorkflowShell(powerShell, file);
  assert.equal(bypassed.status, 0, `${bypassed.stdout}${bypassed.stderr}`);
  assert.match(
    bypassed.stdout,
    /DOT-SOURCED/,
    'the workflow shell must actually RUN the script; asserting the option is in the argument list would pass on a shell that was refused',
  );

  const unbypassed = spawnSync(
    powerShell,
    powerShellArguments(file).filter(
      (argument, at, argv) => argument !== '-ExecutionPolicy' && argv[at - 1] !== '-ExecutionPolicy',
    ),
    { encoding: 'utf8', env: restrictedEnvironment() },
  );
  assert.notEqual(
    unbypassed.status,
    0,
    'without the bypass the pinned scope must refuse the script -- otherwise every case in this file proves nothing about the policy',
  );
  assert.doesNotMatch(unbypassed.stdout, /DOT-SOURCED/);
});

function runColocationStep(shell, script, hostnames) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-colocation-'));
  const evidenceRoot = join(dir, 'cowrite-isolation-host-evidence');
  mkdirSync(evidenceRoot);
  for (const [index, hostname] of hostnames.entries()) {
    writeFileSync(join(evidenceRoot, `cowrite-isolation-host-${index}.txt`), hostname);
  }
  const file = join(dir, 'colocation.ps1');
  const outputFile = join(dir, 'github-output.txt');
  writeFileSync(outputFile, '');
  writeFileSync(file, `${API_FAKE}\n${script}`);
  const result = spawnWorkflowShell(shell, file, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: 'williacj/cowrite',
      GITHUB_OUTPUT: outputFile,
      GH_TOKEN: 'x',
      COWRITE_SLOT: 'base',
      COWRITE_VERDICT_SHA: 'deadbeef',
    },
  });
  const raw = `${result.stdout}${result.stderr}`;
  const githubOutput = readGitHubOutput(outputFile);
  const outputs = Object.fromEntries(
    githubOutput.text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    output: raw.replace(/\s+/g, ' '),
    outputs,
    postedCheckRun: raw.includes('POSTED-CHECK-RUN'),
  };
}

test('the hostname backstop distinguishes a co-located canary from a straddled one (#1901)', (t) => {
  if (!powerShell) return t.skip('neither pwsh nor powershell is on PATH');
  const script = extractRunScript(readWorkflow(), 'Validate co-located host cohort');

  const coLocated = runColocationStep(powerShell, script, ['WILLIACJ-01', 'williacj-01']);
  assert.equal(coLocated.status, 0);
  assert.equal(coLocated.outputs.co_located, 'true');
  assert.equal(coLocated.postedCheckRun, false);

  const straddled = runColocationStep(powerShell, script, ['WILLIACJ-01', 'FINN-PC10']);
  assert.equal(straddled.status, 0);
  assert.equal(
    straddled.outputs.co_located,
    'false',
    'different physical hosts must keep the isolation probe closed',
  );
  assert.equal(straddled.postedCheckRun, true);
  assert.match(straddled.output, /NOT MEASURED: the convened canary jobs reported different hostnames/);

  const malformed = runColocationStep(powerShell, script, [' FINN-PC10', 'FINN-PC10']);
  assert.equal(
    malformed.outputs.co_located,
    'false',
    'malformed hostname evidence must keep the isolation probe closed',
  );
  assert.equal(malformed.postedCheckRun, true);
});

test('the convene step routes every pool state to the right outcome (#1229/#1231)', async (t) => {
  // Written as a literal `test(...)` rather than a `powerShell ? test : test.skip` alias so that
  // scripts/check-test-matrix.mjs, which matches test titles in the source text, can still see this
  // name and the subtest names below on a host that has no PowerShell at all.
  if (!powerShell) return t.skip('neither pwsh nor powershell is on PATH');
  const script = extractRunScript(readWorkflow(), 'Convene with the peer canary');

  await t.test('a live peer with both markers convenes, and the probe proceeds', () => {
    const { status, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(powerShell, script, 'live');
    assert.equal(status, 0);
    assert.equal(
      outputs.convened,
      'true',
      `the probe gate opens only on a positive convened claim; ${outputDiagnostic}`,
    );
    assert.equal(postedCheckRun, false, 'a convened cohort must not claim it measured nothing');
  });

  await t.test('a peer that already finished is NOT MEASURED, never a pass (runs 31046727724/30684554436)', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun, polls } = runConveneStep(
      powerShell,
      script,
      'stale',
    );
    // Exits cleanly (#1231) but says convened=false, which is what keeps the probe from running and
    // turning this clean exit into the vacuous pass #1229 closed.
    assert.equal(status, 0);
    assert.equal(outputs.convened, 'false', outputDiagnostic);
    assert.equal(postedCheckRun, true);
    assert.match(output, /NOT MEASURED: the peer canary had already finished/);
    assert.match(output, /"conclusion": "neutral"/);
    // A terminal peer can never overlap, so the verdict is immediate rather than 450s from now.
    assert.equal(polls, 0, 'a completed peer must short-circuit, not burn the whole wait budget');
  });

  await t.test('a peer starved of a runner is NOT MEASURED, not an isolation failure (#1231, run 31185275886)', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun, polls } = runConveneStep(
      powerShell,
      script,
      'starved',
    );
    assert.equal(status, 0);
    assert.equal(outputs.convened, 'false', outputDiagnostic);
    assert.equal(postedCheckRun, true);
    assert.match(output, /NOT MEASURED: the peer canary never got a runner/);
    assert.match(output, /"conclusion": "neutral"/);
    // A queued peer may still show up, so this one does spend the full bounded budget.
    assert.equal(polls, 90, 'a queued peer is waited for across the full 90-attempt budget');
  });

  await t.test('a live peer whose markers never appear is a real fault, with no neutral excuse', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(
      powerShell,
      script,
      'nomarkers',
    );
    // A barrier fault is still RED after #1231's flip — only pool and API outcomes exit cleanly.
    assert.equal(status, 1);
    assert.equal(
      outputs.convened,
      undefined,
      `a throw must publish no verdict for the probe to read; ${outputDiagnostic}`,
    );
    assert.equal(postedCheckRun, false, 'an artifact-visibility fault must not be excused as a pool outcome');
    assert.match(output, /artifact-visibility fault, not runner starvation/);
  });

  // A barrier break makes BOTH slots time out and exit at roughly the same moment, so whichever
  // slot notices its peer terminate first used to relabel a real fault as a pool outcome -- excusing
  // roughly half of every genuine barrier break. The liveness evidence has to outlive the peer.
  await t.test('a peer live past the threshold that then exits is still a barrier fault, not "already finished"', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(
      powerShell,
      script,
      'livethendead',
    );
    assert.equal(status, 1);
    assert.equal(outputs.convened, undefined, outputDiagnostic);
    assert.equal(postedCheckRun, false, 'a sustained-live peer that never published is not a pool outcome');
    assert.match(output, /artifact-visibility fault, not runner starvation/);
    assert.doesNotMatch(output, /had already finished/);
  });

  // An unguarded poll aborted the step with a raw PowerShell stack trace and NO verdict -- which the
  // canary's own docs tell an operator to read as a real isolation fault.
  await t.test('a transient API failure mid-poll does not abort the wait or swallow the verdict', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(
      powerShell,
      script,
      'flaky',
    );
    assert.equal(status, 0);
    assert.equal(outputs.convened, 'false', outputDiagnostic);
    assert.equal(postedCheckRun, true, 'a transient 5xx must still produce a legible verdict');
    assert.match(output, /NOT MEASURED: the peer canary never got a runner/);
    assert.doesNotMatch(output, /Bad Gateway/, 'a raw API error must not reach the operator as the outcome');
  });

  // "The peer never got a runner" is a claim about the peer. If every read failed, this slot never
  // observed the peer at all and must not assert anything about it.
  await t.test('a slot that never read the job list says so, rather than blaming the peer', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(
      powerShell,
      script,
      'apidown',
    );
    assert.equal(status, 0);
    assert.equal(outputs.convened, 'false', outputDiagnostic);
    assert.equal(postedCheckRun, true);
    assert.match(output, /NOT MEASURED: this slot could not read the run's job list/);
    assert.doesNotMatch(output, /the peer canary never got a runner/);
  });

  // Caught on this card's own first live run (31206416568): base blamed the barrier for what was
  // plainly starvation, because "peer is in_progress" was read as "peer has had time to publish".
  await t.test('a peer that got a runner too late to publish is starvation, not a barrier fault (run 31206416568)', () => {
    const { status, output, outputs, outputDiagnostic, postedCheckRun } = runConveneStep(
      powerShell,
      script,
      'latestart',
    );
    assert.equal(status, 0);
    assert.equal(outputs.convened, 'false', outputDiagnostic);
    assert.equal(postedCheckRun, true, 'a peer live for seconds has not disproved artifact visibility');
    assert.match(output, /NOT MEASURED: the peer canary got a runner too late/);
    assert.doesNotMatch(output, /artifact-visibility fault/);
  });
});

// The canary needs an atomic 2-of-2 reservation of a two-runner pool, and each slot holds one of
// those runners while it waits for the other. Its own `pull_request:` trigger fired on exactly the
// PRs that edit it — and a canary-machinery PR also runs `Windows (self-hosted)`, which has no path
// filter BY DESIGN (a filter would leave some PRs with no required context), and which holds one
// runner for 7-11 minutes. That leaves one runner for two slots, so the cohort cannot convene:
// 7 of the last 23 settled runs never overlapped at all — 30%
// (#1266). Since #1231 made a starved slot exit green, that failure is now silent. Dispatch is the
// only trigger under which the operator controls pool occupancy, so it is the only trigger.
//
// This assertion also subsumes #1234's: that card removed `docs/test-matrix.md` from the trigger
// paths because every card is required to add a matrix row, which made this two-runner rendezvous
// fire on nearly every PR. With no `pull_request:` trigger at all, no path list can reintroduce
// that — and the set equality below refuses any trigger that would bring one back, including the
// `push:`/`schedule:` variants that would starve the pool the same way. Do not re-add the
// `docs/test-matrix.md` path; do not re-add a PR trigger to carry it.
test('runs only on manual dispatch, so the cohort can be convened against a quiet pool (#1266)', () => {
  // Extracted from the comment-stripped text, not the raw file. `#` is `\S`, so a column-0 comment
  // inside the `on:` block — this file's own comment style — terminates the lookahead early and
  // hides every trigger after it, which is exactly where a re-added one would sit. Stripping first
  // is what makes the set equality below a real guard rather than one that depends on the
  // indentation of an adjacent comment.
  const onBlock = withoutComments(readWorkflow()).match(/^on:\n([\s\S]*?)\n(?=\S)/m);
  assert.ok(onBlock, 'expected a top-level on: block');
  const triggers = parseTriggerKeys(onBlock[1]);
  assert.deepStrictEqual(
    triggers,
    ['workflow_dispatch'],
    `canary triggers drifted from dispatch-only — found: [${triggers.join(', ')}]`,
  );
  const quotedTriggerMutation = `${onBlock[1]}\n  "push":\n    branches: [main]`;
  assert.deepStrictEqual(
    parseTriggerKeys(quotedTriggerMutation),
    ['workflow_dispatch', 'push'],
    'a quoted event key must not evade the dispatch-only guard',
  );
});

// A dispatch-only workflow has its own contract, and it is worth pinning for the same reason the
// path set was: the two checkout refs and the verdict SHA used to be `pull_request`-first
// expressions with a dispatch fallback, and leaving the dead first term in place would be a lie
// about where the values come from. `inputs.ref_a`/`inputs.ref_b` are now the only source of the
// two revisions, and `github.sha` — the tip of the branch the run was dispatched on, a real commit
// rather than the `refs/pull/N/merge` commit `github.sha` denoted under the old trigger — is the
// only source of the not-measured verdict's binding. That is also the SHA the eviction observer
// binds a displaced run to (`workflow_run.head_sha`), so both not-measured paths now land on the
// same commit (#1266).
test('the dispatch contract supplies both revisions and the verdict binding, with no dead PR terms (#1266)', () => {
  // Every assertion here reads the EXECUTABLE text. The comments this change added deliberately
  // quote both the removed expressions and the `required: true` they justify, and a match against
  // the raw file is satisfied by that prose — which is vacuity, not coverage.
  const executable = withoutComments(readWorkflow());
  const inputs = executable.match(/workflow_dispatch:\n\s+inputs:\n([\s\S]*?)\n\s*\n/);
  assert.ok(inputs, 'expected a workflow_dispatch inputs: block');
  // Both refs carry `required: true` AND a `default:`, each anchored to its own key. Dispatch is the
  // only source of the two revisions now, so an omitted input has no `|| github.sha` left to take
  // silently — and BOTH attributes are pinned deliberately, because which of them actually prevents
  // the omission is not settleable from here. GitHub's dispatch endpoint documents defaults being
  // applied when inputs are omitted, while `required: true` is what makes the browser form mandatory
  // and what rejects an omitted input that has no default; reaching input validation through the API
  // means creating a live canary run, which no test here can do. So neither is demoted to
  // belt-and-braces: dropping either one changes how an omitted input resolves, and both slots
  // landing on the same branch tip is a green canary that proved less than it looks.
  //
  // The `default:` pin is a VALUE pin or it is nothing, and two separate ways of writing "no value"
  // have to be excluded. `[ \t]` rather than `\s`, because `\s` crosses the newline and lets a bare
  // `default:` be satisfied by the next line's text. And `['"]?[^\s'"]` rather than `\S+`, because
  // `""` and `''` are non-whitespace and would otherwise pass while meaning exactly the empty value
  // this pin exists to forbid. Both holes were live in earlier drafts of this very assertion.
  const hasDefault = (key) =>
    new RegExp(`${key}:\\n\\s+description:[^\\n]*\\n\\s+required:\\s*true\\n\\s+default:[ \\t]*['"]?[^\\s'"]`);
  assert.match(inputs[1], hasDefault('ref_a'));
  assert.match(inputs[1], hasDefault('ref_b'));
  assert.match(executable, /checkout_ref:\s*\$\{\{\s*inputs\.ref_a\s*\}\}/);
  assert.match(executable, /checkout_ref:\s*\$\{\{\s*inputs\.ref_b\s*\}\}/);
  assert.match(executable, /COWRITE_VERDICT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  // The point of the whole card: a pull_request expression can only ever be empty now, and one that
  // is permanently empty while a test asserts its presence is worse than either removing it or
  // keeping it on purpose.
  assert.doesNotMatch(executable, /github\.event\.pull_request/);
});

test('checks out the supplied revision and detects a shared physical work root (#981)', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /ref:\s*\$\{\{\s*matrix\.checkout_ref\s*\}\}/);
  assert.match(yaml, /RUNNER_WORKSPACE/);
  assert.match(yaml, /cowrite-isolation-/);
  assert.match(yaml, /Test-Path -LiteralPath \$other/);
  assert.match(yaml, /Start-Sleep -Seconds 30/);
  assert.match(yaml, /Remove-Item -LiteralPath \$mine -Force -ErrorAction Stop/);
  assert.match(yaml, /if \(Test-Path -LiteralPath \$mine\)[\s\S]*?throw "Canary sentinel cleanup failed/);
});
