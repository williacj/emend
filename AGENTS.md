<!-- ABOUTME: Root instructions for agents working in Emend checkouts: roles under Rigger, review and merge, -->
<!-- ABOUTME: hand-coordinated pull requests, keeping hand work apart from the engine, the git operations reserved to the owner, and worktrees. -->

# Emend agent instructions

Read [CLAUDE.md](CLAUDE.md) in full at the start of every session, whether or not you will change anything: Claude Code loads it for you, and Codex loads only this file. It contains Emend's project rules, design authorities, test gates, and review process, and its "Cards and Rigger" section says how a card is made, judged and merged by [Rigger](https://github.com/williacj/rigger). This file holds the rules that process puts on every session. Both files bind every session.

## Sessions and roles

A session Rigger dispatches has a role, and its authority comes from that role's prompt under `.claude/agents/`. A role prompt narrows these rules and never widens them; where it is narrower than a rule here, it wins for that role.

A session with no role prompt, such as the owner working with an interactive agent, takes every rule here as written. The owner is present in that session, so "ask the owner" means ask now and wait.

A dispatched session cannot ask. What it does instead, a maker's escalation or a judge's verdict, is `CLAUDE.md`'s "Cards and Rigger".

## Documents own their facts

A fact lives in one owning document, and every other document links to it rather than restating it. A restated fact goes stale the day its owner changes. The constitution owns Emend's decisions and requirements, cited by id; `CLAUDE.md` owns the project rules and how a card moves; this file owns the rules below; `rigger.config.mjs` owns the board, roles and kinds; Rigger's own documents own how the engine works. Where you need a fact another document owns, cite it by id or section.

## Review and merge

How a card Rigger runs is judged and merged is `CLAUDE.md`'s "Cards and Rigger". This section covers what that leaves to the people and agents working by hand.

- **Nobody judges their own work.** Working by hand, the person who did the work dispatches an independent reviewer, a separate session that did not write it, rather than reading it back to themselves. The reviewer loads `.claude/skills/code-review/` and rules by it.
- **Dispatch the reviewer once the branch is ready**, and batch a round's fixes into as few commits as they need, for the reason the "Judged" bullet of `CLAUDE.md`'s "Cards and Rigger" gives.
- **A hand-coordinated pull request is made by hand and judged by the engine**, once `rigger/gate` is a required check: "Hand-coordinated pull requests" below is the procedure. Until the owner adds `rigger/gate` to the `main` ruleset's required checks (`CLAUDE.md`, "Code Review"), the coordinating agent merges it once an independent review is `sound`, CI is green on its head and the owner has approved it, and the procedure below does not apply yet. These pull requests are expected to be rare: Rigger's own config, prompts and gate, onboarding, an escalation the owner hands back for interactive work, and the owner's own interactive work.
- **Never work around a hook or the gate.** If one stops you, ask the owner; a dispatched maker escalates instead.

### Hand-coordinated pull requests

Once `rigger/gate` is a required check, a pull request made by hand is judged and merged by Rigger's engine, as any card is (`CLAUDE.md`, "Cards and Rigger"). The engine offers a card in Review to its loop whether or not it claimed the card before, and for a Review card with one open pull request from its branch it dispatches the kind's judges rather than its maker. What the gate reads is owned by Rigger's `ARCHITECTURE.md`, "The gate" and "Markers". The gate and `rigger verdict` read `rigger.config.mjs` from `main`, never from the pull request's head, so a pull request that changes the config is judged under `main`'s.

1. **File or choose the card.** Exactly one kind in `rigger.config.mjs` selects it by its label, and it does not carry the epic label. Its `## Acceptance` is plain bullets (`- `) and is not only its title restated. The form check does not count task-list boxes (`- [ ]`), so an acceptance written only in boxes is refused as missing.
2. **Keep the card away from the engine until its pull request is open.** Until then it has no Status, or sits in a column other than Ready, Coding, Review and Owner, as "Keeping hand work and the engine apart" says.
3. **Work on the card's branch.** Make a hand worktree as "Version control" says, on the branch that `rigger.config.mjs`'s topic rule names for the card, `rigger-<N>`. The engine and the gate find the card's pull request from that branch name alone, and refuse one from a fork.
4. **Open the pull request** from that branch into `main`, with `Closes #<N>` in its body.
5. **Move the card to Review.** The engine's next pass dispatches the kind's judges, each isolated and on the provider `rigger.config.mjs` requires. The provider follows the configured maker, not whoever made the work, so hand work made with Codex is still judged on Codex, and that pull request loses the cross-model check. From this move on, nobody works the branch by hand. If a judge returns `needs revision`, the engine's own maker works the branch from then on, and that is accepted.
6. **Read the gate when you need to know why it refuses.** Each event on the pull request, and an `edited`, `labeled` or `unlabeled` event on the card, starts a `rigger-gate` workflow run; a comment on the card starts none. The step summary of its "Rule and post" job lists the card's judges and each refusal. Find the run with `gh run list -R williacj/emend --workflow rigger-gate.yml`, where it carries the pull request's or the card's title. Read it on the run's page, or with `gh run view <run-id> --log` under the step "Run the gate check on each pull request". After an acceptance edit, read the latest run's summary: until the next run posts, an earlier success on an unchanged head still stands.
7. **The owner gives a verdict** where the kind names the owner. The engine moves the card to Owner once every agent judge is sound, and the owner runs `rigger verdict <pull request> sound`, or `needs-revision` or `critical` with `--to-sound "<what would make it sound>"` (Rigger's README, "Install and usage"). The verb builds the marker from the same reads the gate makes, and posts it only once the owner confirms it at a terminal. It runs the Rigger the owner installed, not the commit the gate pins, so keep the two at one commit. While `telemetry.push` is on it pushes telemetry from whichever checkout it runs in (williacj/rigger#1410), so the owner chooses that checkout. An agent never writes or posts the owner's marker. The gate cannot tell one an agent posted from the owner's (Rigger's `ARCHITECTURE.md`, "What the gate cannot tell apart").
8. **The engine merges** once `rigger/gate` and the required checks are green on the head, and moves the card to Done. The gate is the whole bar: a `type:change` card needs no approval from the owner beyond it. Work the owner wants a say on is filed as `type:spec` or `type:tech-design`, whose kinds name the owner as a judge.

## Keeping hand work and the engine apart

While Rigger's launchd job is loaded, three things hold, and they hold for any `rigger run` or `rigger once` you start by hand as well. Rigger's [guide](https://github.com/williacj/rigger/blob/main/docs/guide.md), "Keeping hand work and the engine apart", is their source.

- **A card worked by hand is off the board, with no Status set, or in a column other than Ready, Coding, Review and Owner.** Rigger offers every card in those four columns to its loop and may pull any one a kind selects and it has not claimed. An escalated card the owner hands back for hand work is moved out of Owner first.
- **No hand dispatch takes a Ready card that a kind selects.** The engine may pull it at any moment, and only one actor may change a card's board state or its workspace at a time.
- **The engine works its own clone, and nobody works there by hand.** Its clone and its worktree root are kept apart from the main `emend` checkout and from `emend-worktrees/`.

## Git operations reserved to the owner

Only the owner performs these. An agent that needs one asks the owner, and never reaches it another way: not by another spelling, not inside a script or subshell, and not by turning the hooks off.

- **Force-pushing**, in any spelling: `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, a `+` refspec, `git push --mirror`, or `gh pr update-branch --rebase`.
- **Deleting a branch**, local or remote: `git branch -d`, `-D` or `--delete`; `git push --delete`, `git push -d`, a `:branch` refspec, or `git push --prune`; `git update-ref -d`; or `gh pr merge --delete-branch` or `-d`. The forge deletes a merged pull request's head branch itself.
- **Skipping or disabling the hooks**: `git commit -n` or `--no-verify`, `git push --no-verify`, `git -c core.hooksPath=…`, or changing or unsetting `core.hooksPath` with `git config`.

**Nobody pushes to `main`, the owner included.**

`.claude/hooks/refuse-reserved-git-commands.mjs` and `.claude/settings.json` refuse the git spellings they can parse in Claude Code sessions. `.githooks/pre-push` refuses a push to `main`, but only in a checkout whose `core.hooksPath` is `.githooks`. Because changing `core.hooksPath` is reserved, the owner sets it to `.githooks` in a fresh clone, the engine's included. If the hook refuses every push because the remote's default branch is unknown, run `git remote set-head origin -a`. This list is the rule and the hooks enforce part of it, so a spelling the hooks miss is still reserved.

## Version control

Use the main `emend` checkout as the stable reference checkout. Create one linked worktree per issue or bounded card under its persistent sibling directory, `emend-worktrees/<issue-number>-<slug>`. Find the main checkout with `git worktree list` when working from a linked checkout; resolve the sibling directory from the main checkout's parent. Do not put a linked worktree in `/private/tmp` or another directory cleared on reboot, and do not create `emend-*` worktree siblings directly in the GitHub folder.

A session Rigger dispatches is already in the worktree Rigger made for its card, on the branch `rigger.config.mjs`'s topic rule names. Rigger removes that worktree itself once the card's pull request merges.

**Updating a branch that is behind `main`.** Rebase only before a branch's first push. Once it is pushed, bring it up to date only when it conflicts with `main` or needs `main`'s changes: run `git fetch origin` and `git merge origin/main` in its worktree, rerun the applicable suites, and push normally. Pull requests land by merge commit, so those merge-from-`main` commits enter `main`'s history, which is accepted.

**Cleaning up after a merge.** After a card merges, remove its worktree only after checking that its working tree is clean and its work is represented on `main`:

1. Confirm the worktree is clean with `git status --short`. A clean worktree can still be the only copy of committed work.
2. Confirm that its work is on `main`. `gh pr view <number> --json state -q .state` prints `MERGED`, and after `git fetch origin`, `git merge-base --is-ancestor <branch> origin/main` passes. A merge commit makes the branch's tip an ancestor of `main`, so a local commit that never reached the pull request fails this check. The forge deletes `origin/<branch>` on merge, so never check against it.
3. Remove the worktree with `git worktree remove <path>`.
4. Run `git worktree prune --dry-run --verbose`, and prune only records whose directories no longer exist. `git fetch --prune` removes the stale `origin/<branch>` tracking ref.

Preserve any worktree with uncommitted changes or unmerged work, and never remove a worktree you did not make or one another process is using. The local branch is left in place, because deleting a branch is reserved to the owner.
