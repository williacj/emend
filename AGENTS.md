<!-- ABOUTME: Root instructions for agents working in Emend checkouts: roles under Rigger, review and merge, -->
<!-- ABOUTME: keeping hand work apart from the engine, the git operations reserved to CJ, and worktrees. -->

# Emend agent instructions

Read [CLAUDE.md](CLAUDE.md) before changing this repository. It contains Emend's project rules, design authorities, test gates, and review process, and its "Cards and Rigger" section says how a card is made, judged and merged by [Rigger](https://github.com/williacj/rigger). This file holds the rules that process puts on every session. Both files bind every session.

## Sessions and roles

A session Rigger dispatches has a role, and its authority comes from that role's prompt under `.claude/agents/`. A role prompt narrows these rules and never widens them; where it is narrower than a rule here, it wins for that role.

A session with no role prompt, such as CJ working with an interactive agent, takes every rule here as written. CJ is present in that session, so "ask CJ" means ask now and wait. A dispatched session cannot ask; it escalates to CJ instead, in the category its role prompt names.

## Review and merge

- **Nobody judges their own work.** Under Rigger, the judges a card's kind names review it, and none of them is its maker. Working by hand, the person who did the work dispatches an independent reviewer, a separate session that did not write it, rather than reading it back to themselves.
- **Every reviewer rules on the card's acceptance item by item**, as met or unmet, and returns one verdict: `sound`, `needs revision` or `critical`. The maker fixes the findings, and the work is reviewed again until the verdict is `sound`.
- **A verdict covers one head and one acceptance.** A later commit or an acceptance change stales it, so dispatch the reviewer once the branch is ready, and batch a round's fixes into as few commits as they need.
- **Nothing reaches `main` except by merging its pull request**, and Rigger's merge gate admits a card's pull request only once every judge its kind names is `sound` at its head. A change to a recorded decision also requires CJ's explicit agreement first, as CLAUDE.md's "Project Context" says.
- **Never work around a hook or the gate.** If one stops you, stop and ask CJ.

## Keeping hand work and the engine apart

While Rigger's engine is running for Emend, under `rigger run` or its launchd job, three things hold. Rigger's [guide](https://github.com/williacj/rigger/blob/main/docs/guide.md), "Keeping hand work and the engine apart", is their source.

- **Hand work stays out of the columns Rigger pulls from.** Rigger may pull any card in Ready, Coding, Review or Owner that a kind selects and it has not claimed, so a card worked by hand sits in none of them.
- **No hand dispatch takes a Ready card that a kind selects.** The engine may pull it at any moment, and only one actor may change a card's board state or its workspace at a time.
- **The engine works its own clone, and nobody works there by hand.** Its clone and its worktree root are kept apart from the main `emend` checkout and from `emend-worktrees/`.

## Git operations reserved to CJ

Only CJ performs these. An agent that needs one asks CJ, and never reaches it another way: not by another spelling, not inside a script or subshell, and not by turning the hooks off.

- **Force-pushing**, in any spelling: `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, or a `+` refspec.
- **Deleting a branch**, local (`git branch -d`, `-D` or `--delete`) or remote (`git push --delete`, `git push -d`, or a `:branch` refspec).
- **Skipping or disabling the hooks**: `git commit -n` or `--no-verify`, `git push --no-verify`, or `git -c core.hooksPath=…`.

Nobody pushes to `main`, CJ included: work reaches it only by merging its pull request.

`.claude/hooks/refuse-reserved-git-commands.mjs` and `.claude/settings.json` refuse these in Claude Code sessions, and `.githooks/pre-push` refuses a push to `main` from any checkout whose `core.hooksPath` is `.githooks`. This list is the rule and the hooks enforce it, so a spelling the hooks miss is still reserved.

## Version control

Use the main `emend` checkout as the stable reference checkout. Create one linked worktree per issue or bounded card under its persistent sibling directory, `emend-worktrees/<issue-number>-<slug>`. Find the main checkout with `git worktree list` when working from a linked checkout; resolve the sibling directory from the main checkout's parent. Do not put a linked worktree in `/private/tmp` or another directory cleared on reboot, and do not create `emend-*` worktree siblings directly in the GitHub folder.

A session Rigger dispatches is already in the worktree Rigger made for its card, on the branch `rigger.config.mjs`'s topic rule names. Rigger removes that worktree itself once the card's pull request merges.

**Updating a hand-coordinated branch that is behind `main`.** Rebase it in its own worktree onto `origin/main`, resolve any conflicts, and rerun the applicable suites. Publishing a rebased branch that is already pushed is a force push, so ask CJ to push it with `git push --force-with-lease`. A branch with nothing pushed yet needs no force push. A rebase after review moves the head and stales its verdicts, so rebase before dispatching the reviewer where you can.

**Cleaning up after a merge.** After a card merges, remove its worktree only after checking that its working tree is clean and its work is represented on `main`:

1. Confirm the worktree is clean with `git status --short`. A clean worktree can still be the only copy of committed work.
2. Confirm that its work is on `main`: `git merge-base --is-ancestor <branch> origin/main` passes, or the merged pull request included the branch's current tip when GitHub squashed or rebased it. A pushed branch does not prove its work reached `main`.
3. Remove the worktree with `git worktree remove <path>`.
4. Run `git worktree prune --dry-run --verbose`, and prune only records whose directories no longer exist.

Preserve any worktree with uncommitted changes or unmerged work, and never remove a worktree you did not make or one another process is using. Leave the merged branch in place, local and remote: deleting a branch is reserved to CJ.
