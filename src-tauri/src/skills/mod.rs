// ABOUTME: Skills + workflow discovery (FR-SKILL-1/FR-SKILL-5, D10) — finds every `SKILL.md` and
// ABOUTME: `workflows/*.md` file in the opened project, wherever the repo keeps them (§3.1).

//! **Discovery, not storage.** This module only walks the filesystem and parses the tiny bit of
//! frontmatter FR-SKILL-5 requires; it never copies skill/workflow *content* anywhere, and never
//! writes to disk (FR-SKILL-2/D10 — the repo stays the one, provider-neutral home). Callers get
//! back paths plus the two required frontmatter fields.
//!
//! **Ratified defaults, `.emend/config.json`-overridable (P2b-8a-ii, #422).** The sibling
//! `config` submodule reads and confines the published project-config override (its own published
//! schema + path-confinement obligation — `docs/formats/sidecar/project-config.schema.json`); this
//! module's own defaults are what apply absent (or despite a rejected/malformed) override:
//! - Skills: any file named `SKILL.md`, at any depth, carrying **both** `name` and `description`
//!   frontmatter keys. Either missing means the file is not a skill (not an error — just excluded).
//! - Workflows: the top-level `workflows/*.md` glob — files directly inside a project-root
//!   `workflows/` directory whose name ends in `.md`. Not recursive (`workflows/nested/*.md` is out
//!   of scope for the default *and* for the config override — `config`'s own `workflows.glob`
//!   only relocates the directory, per its own module doc) and workflows carry no required
//!   frontmatter (D7: a workflow is agent-facing prose, not a `SKILL.md`).
//!
//! **Standard ignore directories (enumerated here, not folklore):** `.git`, `.hg`, `.svn` (version
//! control internals — never authored content), `node_modules` (JS dependency trees, can be huge),
//! `target` (Rust build output — this project's own, and any Rust project a user opens), `dist` and
//! `build` (common JS/general build-output directory names). Matched by directory *name*, case
//! -insensitively (Windows filesystems are case-insensitive; test-plan §3 flags this class of bug
//! generally), at any depth — a vendored copy nested inside otherwise-real content is excluded too.
//! This is a fixed, documented set, not `.gitignore`-driven: FR-SKILL-5 asks for "standard ignore
//! dirs", not full gitignore semantics, and this list is unaffected by `.emend/config.json` — the
//! published override (`config` submodule) only relocates *where* discovery looks (`skills.roots`,
//! `workflows.glob`), not the ignore-dir set applied within that walk.
//!
//! **Honest partial failure (FR-X-5).** A `SKILL.md` that can't be read (bad encoding, I/O error)
//! or whose frontmatter block is malformed (no opening/closing `---` delimiter at all — an
//! unrecognized *line* inside an otherwise well-formed block is tolerated, see [`parse_frontmatter`])
//! is skipped rather than aborting the whole walk. The same holds one level up: a subdirectory that
//! can't be read (permission denied, a disconnected mount, an ACL'd folder) skips just that subtree
//! rather than discarding everything already found in sibling subtrees — only `project_root` itself
//! failing to walk is fatal to the whole call. This holds for `workflows/` too, including the case
//! where it isn't a directory at all (e.g. a plain file happens to be named `workflows`). Every skip
//! — file or directory, with its path and reason — is returned to the caller so it stays reportable
//! instead of silently vanishing; a broken `workflows/` can be reported twice (once from the general
//! skill walk, which also descends into it, and once from workflow-glob matching), since the two
//! passes read it independently — harmless duplication, not a lost skip. A `.emend/config.json`
//! problem (unreadable/malformed, or a configured path §3.5 rejects) is reported the same way, via
//! [`SkipReason::ConfigMalformed`]/[`SkipReason::ConfigPathRejected`] (see `config` module doc).

pub mod config;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Directory names never descended into. Matched case-insensitively against a single path
/// component (not a substring match, so e.g. a real directory named `distillery` is untouched).
/// See the module doc above for what each entry is and why.
const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// The default workflow glob's directory name (FR-SKILL-5: `workflows/*.md`).
const WORKFLOWS_DIR_NAME: &str = "workflows";

const SKILL_FILE_NAME: &str = "SKILL.md";

/// A discovered skill: just enough to show a user "what it is, when to use" (D7/FR-SKILL-1) — never
/// the file body (FR-SKILL-2/D10). `description` doubles as the when-to-use guidance: that's the
/// real Claude Code `SKILL.md` convention (see this repo's own `.claude/skills/*/SKILL.md`) — the
/// frontmatter carries no separate field, and FR-SKILL-5's discovery rule names only `name` +
/// `description` as required.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// A discovered workflow: the default glob carries no frontmatter requirement (see module doc), so
/// `name` is just the filename stem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workflow {
    pub name: String,
    pub path: PathBuf,
}

/// Why a candidate `SKILL.md` — or, for [`SkipReason::DirectoryUnreadable`], an entire
/// subdirectory — was skipped rather than fully processed. Carries the underlying I/O message for
/// auditability, not a guess dressed up as certainty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// The file exists but couldn't be read (I/O error, invalid encoding).
    Unreadable(String),
    /// The file was read but its frontmatter block doesn't parse (see module doc).
    Malformed(String),
    /// A directory (or one of its entries) couldn't be read — permission denied, a disconnected
    /// mount, an ACL — so this subtree was skipped rather than aborting the whole walk (FR-X-5).
    /// Anything already found in sibling subtrees is unaffected.
    DirectoryUnreadable(String),
    /// `.emend/config.json` exists but couldn't be read as UTF-8, parsed as JSON, or matched the
    /// published schema's shape (missing `schema_version`, an unsupported `workflows.glob`, …) —
    /// discovery proceeded on the ratified defaults instead (`skills::config`, FR-X-5).
    ConfigMalformed(String),
    /// A path named inside `.emend/config.json` (a `skills.roots` entry, or the directory half
    /// of `workflows.glob`) failed §3.5 path confinement — rejected, not followed. Any other,
    /// still-valid part of the config is unaffected.
    ConfigPathRejected(String),
}

impl std::fmt::Display for SkipReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkipReason::Unreadable(msg) => write!(f, "unreadable: {msg}"),
            SkipReason::Malformed(msg) => write!(f, "malformed: {msg}"),
            SkipReason::DirectoryUnreadable(msg) => write!(f, "directory unreadable: {msg}"),
            SkipReason::ConfigMalformed(msg) => write!(f, "config malformed: {msg}"),
            SkipReason::ConfigPathRejected(msg) => write!(f, "config path rejected: {msg}"),
        }
    }
}

/// One path this walk could not fully process: a `SKILL.md` candidate it couldn't turn into a
/// [`Skill`], or (for [`SkipReason::DirectoryUnreadable`]) a subdirectory it couldn't read at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkippedSkill {
    pub path: PathBuf,
    pub reason: SkipReason,
}

/// Everything [`discover`] found under a project root.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Discovery {
    pub skills: Vec<Skill>,
    pub workflows: Vec<Workflow>,
    pub skipped: Vec<SkippedSkill>,
}

/// Walks `project_root` for skills and workflows under the ratified defaults, as overridden by
/// `.emend/config.json` if one is present and trustworthy (see [`config`] module doc). Fails
/// only if `project_root` itself can't be walked (e.g. does not exist); a problem with an
/// individual `SKILL.md`, a subdirectory encountered anywhere below the root, or the config
/// override itself, is captured in [`Discovery::skipped`] instead — sibling subtrees that read
/// fine are still returned (FR-X-5).
pub fn discover(project_root: &Path) -> io::Result<Discovery> {
    let mut discovery = Discovery::default();
    let resolved = config::resolve(project_root, &mut discovery.skipped);

    match resolved.skill_roots {
        None => walk_for_skills(project_root, &mut discovery, true)?,
        Some(roots) => {
            // An override root is user-configured, untrusted-ish input: unlike `project_root`
            // itself, one bad override root (missing, permission-denied, …) must not fail project
            // open outright — it degrades to a reported skip instead (`is_root: false`), the same
            // FR-X-5 contract a permission-denied subdirectory below the default root already gets.
            for root in roots {
                walk_for_skills(&root, &mut discovery, false)?;
            }
        }
    }

    match resolved.workflow_dirs {
        None => discover_workflows(project_root, &mut discovery),
        Some(dirs) => {
            for dir in dirs {
                discover_workflows_in(dir, &mut discovery);
            }
        }
    }

    Ok(discovery)
}

/// Recurses into `dir`, collecting skills/skips into `discovery`. `is_root` is true only for the
/// initial call from [`discover`]: a directory-level I/O error there still fails the whole
/// discovery (per its doc), but the same error at any depth below the root is recorded via
/// [`SkipReason::DirectoryUnreadable`] instead of aborting — the whole point of FR-X-5 is that one
/// bad subtree (permission-denied, a disconnected mount, an ACL) must not discard everything
/// already found in sibling subtrees.
fn walk_for_skills(dir: &Path, discovery: &mut Discovery, is_root: bool) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            if is_root {
                return Err(e);
            }
            discovery.skipped.push(SkippedSkill {
                path: dir.to_path_buf(),
                reason: SkipReason::DirectoryUnreadable(e.to_string()),
            });
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                discovery.skipped.push(SkippedSkill {
                    path: dir.to_path_buf(),
                    reason: SkipReason::DirectoryUnreadable(e.to_string()),
                });
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                discovery.skipped.push(SkippedSkill {
                    path,
                    reason: SkipReason::DirectoryUnreadable(e.to_string()),
                });
                continue;
            }
        };

        if file_type.is_dir() {
            if is_ignored_dir(&entry.file_name().to_string_lossy()) {
                continue;
            }
            walk_for_skills(&path, discovery, false)?;
        } else if file_type.is_file() && entry.file_name() == SKILL_FILE_NAME {
            match read_skill(&path) {
                Ok(Some(skill)) => discovery.skills.push(skill),
                Ok(None) => {} // Well-formed frontmatter, missing a required field: not a skill.
                Err(reason) => discovery.skipped.push(SkippedSkill { path, reason }),
            }
        }
    }
    Ok(())
}

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIR_NAMES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

/// Reads and parses one candidate `SKILL.md`. `Ok(None)` means it parsed fine but isn't a skill
/// (missing `name` or `description`); `Err` means it was skipped (see [`SkipReason`]).
fn read_skill(path: &Path) -> Result<Option<Skill>, SkipReason> {
    let content = fs::read_to_string(path).map_err(|e| SkipReason::Unreadable(e.to_string()))?;
    let fields = parse_frontmatter(&content).map_err(SkipReason::Malformed)?;
    let (Some(name), Some(description)) = (fields.get("name"), fields.get("description")) else {
        return Ok(None);
    };
    Ok(Some(Skill {
        name: name.clone(),
        description: description.clone(),
        path: path.to_path_buf(),
    }))
}

/// A minimal `key: value` frontmatter parser — not general YAML. Real `SKILL.md` frontmatter (this
/// repo's own `.claude/skills/*/SKILL.md`) is mostly a flat block of single-line `key: value` pairs,
/// but real files also carry blank lines, `#` comments, and YAML list values (`allowed-tools:`
/// followed by `  - Read` continuation lines) that this rule has no use for. A line this parser
/// doesn't recognize is simply skipped, never fatal: `Malformed` is reserved for a genuinely
/// missing/unclosed `---` delimiter block, because dropping a whole valid skill over one
/// unrecognized line would be a false negative against FR-SKILL-5's "any `SKILL.md` with `name` +
/// `description`" MUST. A value may be wrapped in matching double **or** single quotes (the only
/// reason to quote here is a `:` or `—` inside the value); leading blank lines and a UTF-8 BOM
/// before the opening delimiter are tolerated too, since both are ordinary artifacts of how editors
/// save files and neither changes what the frontmatter means.
fn parse_frontmatter(content: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let content = content.strip_prefix('\u{FEFF}').unwrap_or(content);
    let mut lines = content.lines();

    let opened = loop {
        match lines.next() {
            Some(line) if line.trim().is_empty() => continue,
            Some(line) => break line.trim() == "---",
            None => break false,
        }
    };
    if !opened {
        return Err("missing opening `---` frontmatter delimiter".to_string());
    }

    let mut fields = std::collections::HashMap::new();
    for line in lines.by_ref() {
        let trimmed = line.trim();
        if trimmed == "---" {
            return Ok(fields);
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            // Blank line, YAML comment, or a list-item continuation (e.g. an `allowed-tools:`
            // value spread across lines) — not a `key: value` pair, but not an error either.
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            // A line shape this rule doesn't understand (see the module/function docs): skip it
            // rather than failing the whole file over a field this rule never reads.
            continue;
        };
        let value = strip_matching_quotes(value.trim());
        fields.insert(key.trim().to_string(), value.to_string());
    }
    Err("frontmatter never closed with a second `---` delimiter".to_string())
}

/// Strips a pair of matching `"` or `'` quotes wrapping `value`, if present.
fn strip_matching_quotes(value: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner;
        }
    }
    value
}

/// The default `workflows/*.md` glob: every top-level, non-recursive `.md` file directly inside a
/// root-level `workflows/` directory (see [`discover_workflows_in`] for the shared implementation
/// and its FR-X-5 contract, which this default and a `.emend/config.json` `workflows.glob`
/// override both go through identically).
fn discover_workflows(project_root: &Path, discovery: &mut Discovery) {
    discover_workflows_in(project_root.join(WORKFLOWS_DIR_NAME), discovery);
}

/// Every top-level, non-recursive `.md` file directly inside `workflows_dir`. Missing entirely is
/// not an error — most opened projects simply won't have a (or the configured) workflows
/// directory. Any other problem reading it — permission denied, a disconnected mount, an ACL'd
/// folder, or even a regular file at that path (`NotADirectory`) — is recorded via
/// [`SkipReason::DirectoryUnreadable`] rather than aborting [`discover`]: the same
/// subdirectory-level partial-failure contract [`walk_for_skills`] honors for skills (FR-X-5), so a
/// broken workflows directory never discards skills already found elsewhere in the project.
fn discover_workflows_in(workflows_dir: PathBuf, discovery: &mut Discovery) {
    let entries = match fs::read_dir(&workflows_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(e) => {
            discovery.skipped.push(SkippedSkill {
                path: workflows_dir,
                reason: SkipReason::DirectoryUnreadable(e.to_string()),
            });
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                discovery.skipped.push(SkippedSkill {
                    path: workflows_dir.clone(),
                    reason: SkipReason::DirectoryUnreadable(e.to_string()),
                });
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                discovery.skipped.push(SkippedSkill {
                    path,
                    reason: SkipReason::DirectoryUnreadable(e.to_string()),
                });
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            discovery.workflows.push(Workflow { name, path });
        }
    }
}

/// The repo instruction file this walk recognizes — J8 Screen 2's own project-card example
/// (`docs/ux-design.md` §3, `"claude.md"`) and this repo's own root-level convention (D3: "the
/// agent edits the files"). Matched case-insensitively, root level only: unlike skills/workflows,
/// FR-SKILL-5 records no discovery rule for it, so this stays the single literal name the
/// constitution already documents rather than guessing at other tools' conventions
/// (`AGENTS.md`, `.github/copilot-instructions.md`, …) with no ratified rule behind them (YAGNI) —
/// broadening this is a distinct, future decision, not a default this walk should invent.
const INSTRUCTION_FILE_NAME: &str = "CLAUDE.md";

/// Looks for [`INSTRUCTION_FILE_NAME`] directly inside `project_root` (case-insensitive, not
/// recursive) and returns its on-disk name exactly as cased there, or `None` when it's absent —
/// or when the root can't even be listed, which degrades to the same honest "nothing found" rather
/// than an error (FR-X-5): a project whose root is unreadable has already failed [`discover`]
/// itself, so this is never the sole signal of that failure.
pub fn find_instruction_file(project_root: &Path) -> Option<String> {
    let entries = fs::read_dir(project_root).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case(INSTRUCTION_FILE_NAME) {
            return Some(name.into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_flat_frontmatter_block() {
        let fields = parse_frontmatter("---\nname: foo\ndescription: bar\n---\nbody\n").unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn strips_double_quotes_from_a_quoted_value_containing_a_colon() {
        let fields = parse_frontmatter("---\ndescription: \"has: a colon\"\n---\n").unwrap();
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("has: a colon")
        );
    }

    #[test]
    fn errors_without_an_opening_delimiter() {
        assert!(parse_frontmatter("name: foo\n---\n").is_err());
    }

    #[test]
    fn errors_without_a_closing_delimiter() {
        assert!(parse_frontmatter("---\nname: foo\n").is_err());
    }

    #[test]
    fn is_ignored_dir_matches_case_insensitively() {
        assert!(is_ignored_dir("node_modules"));
        assert!(is_ignored_dir("Node_Modules"));
        assert!(!is_ignored_dir("distillery"));
    }

    // -- Bug #1 (review Important 1): the parser must not abort the whole file on lines it simply
    // doesn't understand — a blank line, a YAML comment, or an `allowed-tools:`-style list value are
    // all ordinary, valid frontmatter shapes and must not cost the file its `name`/`description`.

    #[test]
    fn tolerates_a_blank_line_inside_the_frontmatter_block() {
        let fields = parse_frontmatter("---\nname: foo\n\ndescription: bar\n---\n").unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn tolerates_a_yaml_list_value_line() {
        let fields = parse_frontmatter(
            "---\nname: foo\ndescription: bar\nallowed-tools:\n  - Read\n  - Write\n---\n",
        )
        .unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn tolerates_a_yaml_comment_line() {
        let fields =
            parse_frontmatter("---\n# a comment\nname: foo\ndescription: bar\n---\n").unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn tolerates_a_leading_blank_line_before_the_opening_delimiter() {
        let fields = parse_frontmatter("\n---\nname: foo\ndescription: bar\n---\n").unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn tolerates_a_leading_utf8_bom_before_the_opening_delimiter() {
        let fields = parse_frontmatter("\u{FEFF}---\nname: foo\ndescription: bar\n---\n").unwrap();
        assert_eq!(fields.get("name").map(String::as_str), Some("foo"));
        assert_eq!(fields.get("description").map(String::as_str), Some("bar"));
    }

    #[test]
    fn strips_single_quotes_from_a_quoted_value_containing_a_colon() {
        let fields = parse_frontmatter("---\ndescription: 'has: a colon'\n---\n").unwrap();
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("has: a colon")
        );
    }

    #[test]
    fn a_genuinely_absent_opening_delimiter_is_still_malformed() {
        // Distinct from the leading-blank-line/BOM cases above: a file with real content and no
        // `---` anywhere must still be reported as malformed, not silently tolerated.
        assert!(parse_frontmatter("# Just a heading, no frontmatter block\n").is_err());
    }
}
