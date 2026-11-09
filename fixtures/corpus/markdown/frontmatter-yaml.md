---
title: A Document With YAML Front Matter
author: Emend Fixtures
date: 2026-07-09
tags:
  - fidelity
  - frontmatter
  - roundtrip
draft: false
nested:
  key: value
  list:
    - one
    - two
aliases: ["/old/path", "/older/path"]
weight: 10
description: >
  A folded scalar that wraps across
  several source lines but is one logical string.
literal: |
  A literal block that
  preserves its own
  line breaks.
---

# Body after front matter

The YAML block above must round-trip **byte-for-byte** — it is structural, never
serialized through a model of the document (constitution TD-2). This body is
ordinary markdown following the closing `---` fence.

A second paragraph with a [link](https://example.com) and some `inline code`
to prove the body is parsed as markdown while the front matter is treated as an
opaque, folded block.
