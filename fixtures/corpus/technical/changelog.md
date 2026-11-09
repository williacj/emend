# Changelog

A technical document exercising nested lists, links, inline code, and
tight/loose list mixing. Original content, released CC0.

All notable changes are documented here. This project adheres to semantic
versioning.

## [2.3.0] - 2026-07-09

### Added

- New `--dry-run` flag for the `sync` command.
- Support for `PATCH /widgets/{id}` partial updates.

### Changed

- `list()` now returns results sorted by `created_at` descending.
- Bumped the minimum runtime to `1.80`.

### Fixed

- Race between the checkpoint writer and the sync worker ([#412]).
- Off-by-one in the CRLF line-offset mapping ([#398]).

## [2.2.1] - 2026-06-01

### Fixed

- Panic on empty front matter (`---\n---`).

## [2.2.0] - 2026-05-15

### Added

- Table rendering with column alignment.

[#412]: https://example.com/issues/412
[#398]: https://example.com/issues/398
