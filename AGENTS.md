<!-- ABOUTME: Root instructions for agents working in Emend checkouts: roles under Rigger, review and merge, -->
<!-- ABOUTME: keeping hand work apart from the engine, the git operations reserved to CJ, and worktrees. -->

# Emend agent instructions

Read [CLAUDE.md](CLAUDE.md) before changing this repository. It contains Emend's project rules, design authorities, test gates, and review process, and its "Cards and Rigger" section says how a card is made, judged and merged by [Rigger](https://github.com/williacj/rigger). This file holds the rules that process puts on every session. Both files bind every session.

## Sessions and roles

A session Rigger dispatches has a role, and its authority comes from that role's prompt under `.claude/agents/`. A role prompt narrows these rules and never widens them; where it is narrower than a rule here, it wins for that role.

A session with no role prompt, such as CJ working with an interactive agent, takes every rule here as written. CJ is present in that session, so "ask CJ" means ask now and wait.

A dispatched session cannot ask. A dispatched maker escalates to CJ instead, in the category its role prompt names. A dispatched judge never escalates: it returns its verdict, `critical` where only CJ can resolve the fault.

## Documents own their facts

A fact lives in one owning document, and every other document links to it rather than restating it. A restated fact goes stale the day its owner changes. The constitution owns Emend's decisions and requirements, cited by id; `CLAUDE.md` owns the project rules and how a card moves; this file owns the rules below; `rigger.config.mjs` owns the board, roles and kinds; Rigger's own documents own how the engine works. Where you need a fact another document owns, cite it by id or section.

## Review and merge

How a card Rigger runs is judged and merged is `CLAUDE.md`'s "Cards and Rigger". This section covers what that leaves to the people and agents working by hand.

- **Nobody judges their own work.** Working by hand, the person who did the work dispatches an independent reviewer, a separate session that did not write it, rather than reading it back to themselves. The reviewer loads `.claude/skills/code-review/` and rules by it.
- **Dispatch the reviewer once the branch is ready.** A new commit sends every judge back, so batch a round's fixes into as few commits as they need.
- **A hand reviewer's verdict reaches the gate as a marker.** A judge Rigger did not dispatch writes its verdict in Rigger's marker form, taking the head, acceptance digest and items from the gate check's run summary (Rigger's `ARCHITECTURE.md`, "Markers"). #14 sets up the required `rigger/gate` check and these mechanics.
- **The coordinating agent merges a hand-coordinated pull request**, by squash merge, once an independent review is `sound`, CI is green on its head and CJ has approved it. These pull requests are expected to be rare: Rigger's own config, prompts and gate, onboarding, an escalation CJ hands back for interactive work, and CJ's own interactive work.
- **Never work around a hook or the gate.** If one stops you, ask CJ; a dispatched maker escalates instead.

## Keeping hand work and the engine apart

While Rigger's launchd job is loaded, three things hold, and they hold for any `rigger run` or `rigger once` you start by hand as well. Rigger's [guide](https://github.com/williacj/rigger/blob/main/docs/guide.md), "Keeping hand work and the engine apart", is their source.

- **A card worked by hand is off the board, or in a column other than Ready, Coding, Review and Owner.** Rigger offers every card in those four columns to its loop and may pull any one a kind selects and it has not claimed.
- **No hand dispatch takes a Ready card that a kind selects.** The engine may pull it at any moment, and only one actor may change a card's board state or its workspace at a time.
- **The engine works its own clone, and nobody works there by hand.** Its clone and its worktree root are kept apart from the main `emend` checkout and from `emend-worktrees/`.

## Git operations reserved to CJ

Only CJ performs these. An agent that needs one asks CJ, and never reaches it another way: not by another spelling, not inside a script or subshell, and not by turning the hooks off.

- **Force-pushing**, in any spelling: `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, a `+` refspec, `git push --mirror`, or `gh pr update-branch --rebase`.
- **Deleting a branch**, local or remote: `git branch -d`, `-D` or `--delete`; `git push --delete`, `git push -d`, a `:branch` refspec, or `git push --prune`; `git update-ref -d`; or `gh pr merge --delete-branch` or `-d`. The forge deletes a merged pull request's head branch itself.
- **Skipping or disabling the hooks**: `git commit -n` or `--no-verify`, `git push --no-verify`, `git -c core.hooksPath=…`, or changing or unsetting `core.hooksPath` with `git config`.

**Nobody pushes to `main`, CJ included.** Work reaches it only by merging its pull request.

`.claude/hooks/refuse-reserved-git-commands.mjs` and `.claude/settings.json` refuse the git spellings they can parse in Claude Code sessions. `.githooks/pre-push` refuses a push to `main`, but only in a checkout whose `core.hooksPath` is `.githooks`. If it refuses every push because the remote's default branch is unknown, run `git remote set-head origin -a`. This list is the rule and the hooks enforce part of it, so a spelling the hooks miss is still reserved.

## Version control

Use the main `emend` checkout as the stable reference checkout. Create one linked worktree per issue or bounded card under its persistent sibling directory, `emend-worktrees/<issue-number>-<slug>`. Find the main checkout with `git worktree list` when working from a linked checkout; resolve the sibling directory from the main checkout's parent. Do not put a linked worktree in `/private/tmp` or another directory cleared on reboot, and do not create `emend-*` worktree siblings directly in the GitHub folder.

A session Rigger dispatches is already in the worktree Rigger made for its card, on the branch `rigger.config.mjs`'s topic rule names. Rigger removes that worktree itself once the card's pull request merges.

**Updating a branch that is behind `main`.** Rebase only before a branch's first push. Once it is pushed, bring it up to date only when it conflicts with `main` or needs `main`'s changes: run `git fetch origin` and `git merge origin/main` in its worktree, rerun the applicable suites, and push normally. The squash merge leaves the merge commits out of `main`.

**Cleaning up after a merge.** After a card merges, remove its worktree only after checking that its working tree is clean and its work is represented on `main`:

1. Confirm the worktree is clean with `git status --short`. A clean worktree can still be the only copy of committed work.
2. Confirm that its work is on `main`. The forge deletes `origin/<branch>` on merge, so check the pull request instead: `gh pr view <number> --json state,headRefOid,mergeCommit` shows `MERGED`, its `headRefOid` equals `git rev-parse <branch>`, and `git merge-base --is-ancestor <mergeCommit> origin/main` passes after `git fetch origin`.
3. Remove the worktree with `git worktree remove <path>`.
4. Run `git worktree prune --dry-run --verbose`, and prune only records whose directories no longer exist. `git fetch --prune` removes the stale `origin/<branch>` tracking ref.

Preserve any worktree with uncommitted changes or unmerged work, and never remove a worktree you did not make or one another process is using. The local branch is left in place, because deleting a branch is reserved to CJ.
