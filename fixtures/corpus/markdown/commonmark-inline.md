<!-- ABOUTME: CommonMark inline-level feature coverage (original content, CC0). -->
<!-- ABOUTME: Emphasis, code spans, links, images, autolinks, escapes, entities, hard breaks. -->

# Inline coverage

Plain paragraph text with a *single-asterisk emphasis* run, an _underscore
emphasis_ run, some **double-asterisk strong** text, and __underscore strong__
text. Nesting works too: **strong with *nested emphasis* inside** and
*emphasis with `code` inside*.

A code span uses backticks: `let x = 1;`. A code span that itself contains a
backtick uses more delimiters: `` a ` b ``. Leading and trailing spaces in a
code span are stripped once: `` padded ``.

Links come in several shapes. An [inline link](https://example.com) with a
[titled inline link](https://example.com "the title"). A [collapsed
reference][] and a [full reference][ref] and a shortcut [ref]. Autolinks:
<https://example.com> and <mailto:someone@example.com>.

[collapsed reference]: https://example.com/collapsed
[ref]: https://example.com/ref "reference title"

Images: an ![inline image](https://example.com/a.png) and a reference
![image][img].

[img]: https://example.com/b.png "image title"

Backslash escapes keep literal punctuation: \*not emphasis\*, \`not code\`,
\[not a link\], a literal backslash \\, and a literal hash \# mid-line. HTML
entities decode: &amp; &copy; &hearts; &#42; &#x1F600;.

A hard line break is two trailing spaces here,  
then the continuation. A backslash also forces a break,\
like this.

Soft breaks (a plain newline inside a paragraph)
join into a single line when rendered.

Raw inline HTML is allowed: this <em>emphasis</em> and this <strong>strong</strong>
come through as HTML. So does a self-closing <br /> tag.
