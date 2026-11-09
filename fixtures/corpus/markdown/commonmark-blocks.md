<!-- ABOUTME: CommonMark block-level feature coverage (original content, CC0). -->
<!-- ABOUTME: Headings, blockquotes, lists, code blocks, thematic breaks, HTML blocks. -->

# ATX heading level 1

## ATX heading level 2

### ATX heading level 3

#### Level 4

##### Level 5

###### Level 6

Setext heading level 1
======================

Setext heading level 2
----------------------

A thematic break follows this paragraph.

---

Three kinds of thematic break marker are equivalent:

***

___

> A block quote.
> It spans several lines.
>
> > And it can nest another quote inside.
>
> Back to the outer level.

Unordered list, tight:

- first
- second
- third

Unordered list, loose (blank lines between items):

- first item

- second item

- third item

Ordered list starting at a non-one number:

3. three
4. four
5. five

Nested and mixed lists:

1. Ordered parent
   - unordered child
   - another child
     1. deep ordered grandchild
     2. sibling grandchild
2. Second ordered parent
   with a lazy continuation line.

An indented code block (four spaces):

    fn indented() -> u32 {
        42
    }

A fenced code block with an info string:

```rust
fn fenced(x: i32) -> i32 {
    x * 2
}
```

A fenced code block using tildes and no language:

~~~
plain fenced text
with two lines
~~~

A paragraph with a trailing hard-wrapped
line that is really one logical paragraph.

<div class="html-block">
  A raw HTML block passes through untouched.
  <p>Including nested tags.</p>
</div>
