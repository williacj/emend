<!-- ABOUTME: GitHub Flavored Markdown extension coverage (original content, CC0). -->
<!-- ABOUTME: Tables, task lists, strikethrough, GFM autolinks, footnotes. -->

# GFM extensions

## Strikethrough

Text with a ~~struck-through~~ run, and ~~a longer struck phrase~~ mid-sentence.

## Autolinks (bare)

A bare URL like https://example.com/path?q=1 becomes a link, as does
www.example.com. A bare email such as person@example.com autolinks too.

## Task lists

- [x] completed task
- [ ] open task
- [ ] task with **bold** and `code`
  - [x] nested completed subtask
  - [ ] nested open subtask

## Tables

Basic table with alignment markers:

| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |
| longer cell | mid | 1 |
| `code` | *em* | **strong** |

Table with ragged rows and escaped pipes:

| Command | Description |
|---------|-------------|
| `git status` | show the working tree status |
| `a \| b` | a cell containing a literal pipe |
| one |

## Footnotes

Here is a statement needing a citation.[^note] And a second reference.[^longer]

[^note]: The footnote body.
[^longer]: A footnote body that spans
    multiple lines with a continuation.
