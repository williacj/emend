<!-- ABOUTME: Root instructions for agents working in Cowrite checkouts. -->
<!-- ABOUTME: Points to the repo constitution and keeps linked worktrees in a persistent sibling folder. -->

# Cowrite agent instructions

Read [CLAUDE.md](CLAUDE.md) before changing this repository. It contains Cowrite's project rules, design authorities, test gates, and review process.

Use the main `cowrite` checkout as the stable reference checkout. Create one linked worktree per issue or bounded card under its persistent sibling directory, `cowrite-worktrees/<issue-number>-<slug>`. Find the main checkout with `git worktree list` when working from a linked checkout; resolve the sibling directory from the main checkout's parent. Do not put a linked worktree in `/private/tmp` or another directory cleared on reboot, and do not create `cowrite-*` worktree siblings directly in the GitHub folder.

After a card merges, remove its worktree only after checking that its working tree is clean and its work is represented on `main`. Preserve any worktree with uncommitted changes or unmerged work. Prune stale Git worktree records only when their directories no longer exist.
