ABOUTME: Defines the standard workflow for parallel feature development using git worktrees.
ABOUTME: Documents coder/reviewer separation, review loops, and model preference handling across sessions.

# Parallel Development Workflow

## Goals

- Run multiple feature efforts in parallel without branch contamination.
- Keep implementation and review responsibilities separated.
- Preserve a repeatable process that works across new sessions.

## Worktree Standard

- Use one worktree per active feature branch.
- Keep the main checkout dedicated to `main` synchronization and merge operations.
- Keep all linked worktrees in the persistent `emend-worktrees/` directory beside the main `emend` checkout. Find the main checkout with `git worktree list` when starting from a linked checkout.
- Do not use `/private/tmp` or another directory cleared on reboot, or create `emend-*` worktree siblings directly in the GitHub folder.

### Recommended naming

- Branch: `feature/<topic>`
- Worktree path: `../emend-worktrees/<issue-number>-<slug>` (relative to the main checkout)

### Create a worktree

1. From the main checkout, make sure `main` is up to date.
2. Add a feature worktree from `main`:
   - `mkdir -p ../emend-worktrees`
   - `git worktree add ../emend-worktrees/<issue-number>-<slug> -b feature/<topic> main`
3. Enter that worktree and install/update dependencies as needed.

### Daily usage

1. Work only inside the feature's worktree.
2. Run both test suites before and after substantial changes:
   - frontend: `npm test` or `vitest`
   - backend: `cargo test` in `src-tauri/`
3. Commit atomically with focused messages.
4. Push branch and open PR.

### Cleanup after merge

0. Confirm the worktree is clean with `git status --short`. A clean worktree can still be the only copy of committed work (#1288/#1206).
1. Confirm all branch work is on `main`: check `git merge-base --is-ancestor feature/<topic> main`, or verify that the merged PR included the branch's current tip when GitHub used a squash or rebase merge. A pushed branch or an empty `git log feature/<topic> --not --remotes=origin` does not prove its work reached `main`. Preserve the worktree and branch if any work is unmerged or uncertain.
2. Remove the merged, clean feature worktree:
   - `git worktree remove ../emend-worktrees/<issue-number>-<slug>`
3. Delete the local feature branch if still present.
4. Run `git worktree prune --dry-run --verbose` and prune only stale records whose directories no longer exist.

`origin/<branch>` alone is not a dependable record when GitHub deletes the head branch on merge.

## Coder/Reviewer Separation Workflow

## Principle

- The coding pass and review pass must be separated as roles.
- Do not self-approve the coding pass without an explicit review pass.

## Review loop

1. Coder pass: implement requested scope and run tests.
2. Reviewer pass (separate agent/session): perform code review and return actionable findings.
3. Coder pass: apply fixes and re-run tests.
4. Reviewer pass: re-review until no actionable issues remain.
5. Merge only after review loop is clean.

## Model preference handling

- Preferred policy: use different models for coding and reviewing.
- Example intent: coding with GPT-5.3-Codex and review with Opus 4.6 (or vice versa).
- If strict per-agent model control is unavailable in the active tool, run review in a separate session configured to the alternate model.

## PR checklist

- Scope is limited to one feature branch/worktree.
- Frontend tests pass.
- Backend tests pass.
- Review pass completed by a separate reviewer role.
- All review findings addressed or explicitly documented.
