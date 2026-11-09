<!-- ABOUTME: Top-level guide to the committed fixture corpus (P0-4). -->
<!-- ABOUTME: What the corpus is, how tests load it, and how to add fixtures. -->

# Fixture corpus

Committed open-source documents used as test inputs across Emend — property
tests (`textops/` P1–P6), corpus tests, and perf budgets (FR-X-4). Traces to
**test-plan §2 / TP-Q3**.

Everything here is portable and license-clean: **public domain / CC0 preferred,
CC-BY acceptable, no NonCommercial, no ShareAlike.** The policy is enforced by a
test, not by convention.

## Layout

```
fixtures/
  README.md              ← this file
  corpus/
    manifest.json        ← machine-readable: source + license per fixture
    LICENSES.md          ← human-readable mirror of the manifest
    prose/               ← long-form homiletic prose (authored, CC0)
    markdown/            ← CommonMark / GFM feature coverage (authored, CC0)
    technical/           ← technical docs: frontmatter, tables, code (authored, CC0)
    fidelity/            ← byte-level edge cases: BOM, CRLF, unicode (authored, CC0)
```

## Using the corpus from Rust tests

The `fixtures` crate (`src-tauri/crates/fixtures`) parses the manifest and hands
each fixture to a test:

```rust
use fixtures::{load, by_id, by_category, Category};

// Every fixture:
for f in load() {
    let text = f.read();          // UTF-8 string
    let bytes = f.read_bytes();   // exact bytes (BOM/CRLF preserved)
}

// One fixture by id:
let discourse = by_id("authored-discourse-plain-speech").unwrap();

// A whole category (e.g. drive P1 fidelity over every prose doc):
for f in by_category(Category::Prose) {
    assert_eq!(f.read_bytes(), f.read_bytes()); // stand-in for save∘load ≡ identity
}
```

Add `fixtures` as a `dev-dependency` to any crate whose tests need the corpus:

```toml
[dev-dependencies]
fixtures = { path = "../fixtures" }
```

Path resolution is relative to the `fixtures` crate by default; set
`EMEND_FIXTURES_DIR` to point at the corpus root from another context (e.g. a
frontend/e2e harness with a different working directory).

## Adding a fixture

1. Drop the file in the right category directory.
2. Add an entry to `corpus/manifest.json` — `id`, `category`, `title`, `path`,
   `source`, and `license` (set `share_alike`/`noncommercial` honestly).
3. Mirror it in `corpus/LICENSES.md`.
4. Run `cargo test -p fixtures`. The suite fails if a file is undocumented
   (orphan check), a declared file is missing, or a license is NC/SA.

### The prose fixtures

The `prose/` documents are **authored, CC0** — no network fetch, no external
dependency. Earlier revisions pulled public-domain sermons from Project Gutenberg;
those are no longer reliably fetchable, and per test-plan §2 the corpus tests
depend on synthesized edit *patterns* rather than any specific prose ("patterns
travel; prose doesn't"), so authored substrate is equivalent. `collected-discourses.md`
is the large-document performance fixture (FR-X-4): authored short addresses
deterministically assembled for size. Write new prose directly and register it as
in "Adding a fixture" above.
