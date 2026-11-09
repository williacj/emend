ABOUTME: Why `.agents/skills` exists, which providers depend on it, and how it behaves on a Windows checkout.
ABOUTME: The skills themselves live in `.claude/skills/` — this directory adds a path, never a copy.

# `.agents/` — provider-neutral alias for the repo's skills

`.agents/skills` is a **symlink to `../.claude/skills`**, nothing else. `.claude/skills/` stays the
single home for every repo-owned `SKILL.md`; no source is duplicated here, and none should be.

Skills are repo-owned and provider-neutral by decision — **D1** (repo-owned `SKILL.md`, portability
is a hard requirement) and **D10** (skills live in a provider-neutral repo location chosen by the
repo; the app never hardcodes `.claude/skills/`), carried as **FR-SKILL-2**. Note that **FR-X-8 is
not the relevant clause** — it is the sidecar-schema (`.comments/`, `.track-changes/`) and
CriticMarkup portability contract, and does not govern skills.

## Which provider needs this

| Provider | Reads `.claude/skills/` | Reads `.agents/skills/` | Effect of the symlink |
|---|---|---|---|
| **Codex CLI 0.153.4** (measured 2026-09-08) | **no** | **yes** | **load-bearing** — without it Codex sees none of this repo's skills |
| **Copilot CLI 1.0.71** | yes | yes (also `.github/skills/`) | cosmetic — finds them either way; the alias only changes which path wins |

So the symlink exists for **Codex**, which cannot see `.claude/skills/` at all. Codex resolves the
symlink and reports the real `.claude/skills/<name>/SKILL.md` path as the skill's source locator, so
the single home survives the alias.

This matches the current [official Codex skill-location documentation](https://developers.openai.com/codex/skills):
Codex scans `.agents/skills` from the working directory to the repository root and follows symlinked
skill folders.

Verify either provider without spending a model request:

```powershell
codex debug prompt-input | Select-String -Pattern 'tdd|\.claude/skills'
copilot skill list
```

## Windows — this is a real gap, not a cosmetic one

Git for Windows defaults to `core.symlinks=false` unless the installer's symlink option was enabled.
Under that setting the entry materializes as a **plain 17-byte text file** containing the literal
target path. This was reproduced on a real Windows checkout on 2026-09-07. The consequences differ
by provider:

- **Copilot** is unaffected — a non-directory at `.agents/skills` does not suppress its other project
  sources, so it still finds the skills at `.claude/skills/`.
- **Codex sees no repo skills at all.** User, plugin, and system skills can still appear, but Codex has
  no direct `.claude/skills/` fallback. It fails **silently**: nothing errors, the repo skills are
  simply absent from the prompt.

### Check and repair one Windows worktree

Run the deterministic check from the affected worktree:

```powershell
npm run check:repo-skills
```

The broken checkout fails with `BROKEN` and identifies the plain 17-byte file. Enable Windows
Developer Mode or use an elevated shell, then repair it:

```powershell
npm run repair:repo-skills
npm run check:repo-skills
codex debug prompt-input | Select-String -Pattern 'tdd|\.claude/skills'
```

The repair replaces only the exact tracked placeholder text. It refuses any unexpected file or
directory instead of overwriting it. It enables Git's `extensions.worktreeConfig`, sets
`core.symlinks=true` only for the current worktree, creates the real directory symlink, and requires
the result to remain Git-clean. Any failed repair restores the placeholder, the prior worktree
setting, and the exact prior repository-local state of the shared `extensions.worktreeConfig` switch. Run the repair
once in each existing worktree that Codex uses; sibling worktrees
keep their own setting.

After the real Windows repair on 2026-09-08, `codex debug prompt-input` reported the repository skill
root as this worktree's `.claude/skills` and enumerated the repo-only `tdd` and `ste` skills
from it. Restart Codex if an already-running session does not refresh its skill inventory, then invoke
one explicitly as `$tdd` when its workflow applies.

A new clone can instead start with `git clone -c core.symlinks=true ...`, provided Windows Developer
Mode or elevation permits Git to create the symlink.

Duplicating the `SKILL.md` sources would recreate the drift surface the single home exists to prevent
(D1/FR-SKILL-2). The supported repair therefore changes only the alias and Git's worktree-local
checkout behavior; every skill body remains under `.claude/skills/`.
