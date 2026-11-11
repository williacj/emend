// ABOUTME: This repository's Rigger config: the board it works, the roles it dispatches, the
// kinds of work it binds, and the steps that provision a card.

// This file is L4, the consumer's own layer, so it is yours rather than the engine's and it
// carries no line budget. It declares the extension points Rigger's architecture marks as the
// consumer's, in the spelling that document's published config shape gives them, and Rigger
// refuses any declaration it does not offer.
//
// `rigger init` wrote this file, and filled `repo` in from this repository's `origin` remote. It
// left the board number as `PROJECT_NUMBER`, because a board number is GitHub's and nothing
// `init` can read names it: set it to the number your board's URL ends in, and until you do
// Rigger refuses this config rather than work a board nobody chose. Everything else arrives as
// the template had it, so the column display names, the roles and the kinds of work are starting
// points rather than answers: change them to match your board, and run `rigger doctor` to check
// what you changed.
export default {
  repo: 'williacj/emend',
  board: { project: 'PROJECT_NUMBER', columns: { ready: 'Ready', coding: 'Coding', review: 'Review', owner: 'Owner', done: 'Done' }, priority: { field: 'Priority', options: ['High', 'Normal', 'Low'] } },
  // Three live Engineers at once: Rigger M8 step 2.
  concurrency: 3,
  worktrees: { topic: 'rigger-{number}' },
  roles: {
    engineer: { agent: '.claude/agents/engineer.md', provider: 'claude', tier: 'standard' },
    reviewer: { agent: '.claude/agents/reviewer.md', provider: 'claude', tier: 'high' },
    pm: { agent: '.claude/agents/pm.md', provider: 'claude', tier: 'high' },
    architect: { agent: '.claude/agents/architect.md', provider: 'claude', tier: 'high' },
  },
  kinds: {
    // One judge. `rounds` omitted, so the default of three applies (`R-LOOP-9`).
    change: {
      select: { labels: ['type:change'] },
      maker: 'engineer',
      judges: ['reviewer'],
      provisioning: ['npm-ci', 'cargo-build'],
    },
    // A requirements proposal: the PM makes it, a panel of agent judges rules concurrently, and
    // CJ rules last.
    spec: {
      select: { labels: ['type:spec'] },
      maker: 'pm',
      judges: ['reviewer', 'engineer', 'architect', 'owner'],
      rounds: 2,
      // A proposal changes documents, so its workspaces skip the Rust build.
      provisioning: ['npm-ci'],
    },
  },
  // A card carrying this label is an epic: no kind selects it, whatever else it carries, so Rigger
  // never pulls it (`R-SCHED-11`). No kind may select this label itself.
  epicLabel: 'type:epic',
  provisioning: {
    'npm-ci': { run: 'npm ci', required: true },
    // The Cargo workspace lives in src-tauri/, so the build runs there. It is not required: a
    // judge provisions the pull request's head, and a head that does not compile is the work's
    // failure for the judge to rule on, not an environment failure that closes admission.
    'cargo-build': { run: 'cargo build --workspace', cwd: 'src-tauri' },
  },
  escalate: { 'recorded-decision': 'owner', critical: 'owner', ambiguous: 'owner' },
  telemetry: { push: false },
};
