// @vitest-environment jsdom
// ABOUTME: Component proof of the approved timeline chat-card appearance and P2b-7 quoted excerpt.
// ABOUTME: Covers platform chrome, attribution, provenance, and explicit-click deep-link behavior.
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageCard } from "./ChatMessageCard";
import { createChatMessageCard } from "./types";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

let styleElement: HTMLStyleElement | undefined;

function pickStyles(element: Element, properties: string[]): Record<string, string> {
  const style = getComputedStyle(element) as unknown as Record<string, string>;
  return Object.fromEntries(properties.map((property) => [property, style[property]]));
}

function cssRule(selector: string, occurrence = 0): string {
  const needle = `${selector} {`;
  let exactSelectorStart = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    exactSelectorStart = STYLESHEET.indexOf(needle, exactSelectorStart + 1);
  }
  const selectorStart =
    exactSelectorStart >= 0 ? exactSelectorStart : STYLESHEET.indexOf(selector);
  const blockStart = STYLESHEET.indexOf("{", selectorStart);
  return selectorStart < 0 || blockStart < 0
    ? ""
    : STYLESHEET.slice(blockStart + 1, STYLESHEET.indexOf("}", blockStart));
}

function renderStyled(
  card: ReturnType<typeof createChatMessageCard>,
  platform: "win" | "mac" = "win",
  workshop = false,
) {
  styleElement ??= document.createElement("style");
  styleElement.textContent = STYLESHEET;
  document.head.append(styleElement);
  return render(
    <div className={workshop ? "app-body--workshop" : undefined}>
      <ChatMessageCard card={card} platform={platform} now={() => Date.parse("2026-09-03T12:04:00Z")} />
    </div>,
  );
}

afterEach(() => {
  styleElement?.remove();
  styleElement = undefined;
});

describe("timeline/ChatMessageCard — quoted excerpt (P2b-7)", () => {
  it("renders the approved agent tile and round user avatar before their fixed labels (#2068)", () => {
    const agent = createChatMessageCard("agent", "An answer");
    const { unmount } = renderStyled(agent, "win");

    const agentTile = document.querySelector(".chat-message-card__agent-tile");
    const agentShape = {
      tileHidden: agentTile?.getAttribute("aria-hidden"),
      tileLabel: agentTile?.nextElementSibling?.textContent,
      tileStyle: pickStyles(agentTile as Element, ["width", "height", "borderRadius"]),
      userAvatarPresent: document.querySelector(".chat-message-card__user-avatar") !== null,
    };

    unmount();
    renderStyled(createChatMessageCard("user", "A question"), "win");
    const userAvatar = document.querySelector(".chat-message-card__user-avatar");
    expect({
      agentShape,
      userAvatarHidden: userAvatar?.getAttribute("aria-hidden"),
      userAvatarLabel: userAvatar?.nextElementSibling?.textContent,
      userAvatarStyle: pickStyles(userAvatar as Element, [
        "width",
        "height",
        "borderRadius",
        "backgroundColor",
      ]),
      agentTilePresent: document.querySelector(".chat-message-card__agent-tile") !== null,
    }).toEqual({
      agentShape: {
        tileHidden: "true",
        tileLabel: "Agent",
        tileStyle: { width: "20px", height: "20px", borderRadius: "5px" },
        userAvatarPresent: false,
      },
      userAvatarHidden: "true",
      userAvatarLabel: "You",
      userAvatarStyle: {
        width: "20px",
        height: "20px",
        borderRadius: "50%",
        backgroundColor: "var(--color-timeline-chat-user-avatar)",
      },
      agentTilePresent: false,
    });
  });

  it("matches the complete approved Windows and macOS card chrome and attribution (#2068)", () => {
    const card = createChatMessageCard("agent", "An answer", {
      timestamp: "2026-09-03T12:00:00Z",
    });
    const { unmount } = renderStyled(card, "win");

    let shell = document.querySelector('[data-card-kind="chat-message"]') as HTMLElement;
    let tile = document.querySelector(".chat-message-card__agent-tile") as HTMLElement;
    let attribution = document.querySelector(".chat-message-card__attribution") as HTMLElement;
    let author = screen.getByText("Agent");
    let timestamp = screen.getByText("4m");
    let body = screen.getByText("An answer");
    const win = {
      shell: pickStyles(shell, ["display", "gap", "padding", "backgroundColor", "borderWidth", "borderRadius", "boxShadow"]),
      tile: pickStyles(tile, ["width", "height", "backgroundColor", "borderRadius"]),
      attribution: pickStyles(attribution, ["display", "alignItems", "gap"]),
      author: pickStyles(author, ["fontSize", "fontWeight", "color"]),
      timestamp: { text: timestamp.textContent, ...pickStyles(timestamp, ["marginLeft", "fontSize", "fontWeight", "color"]) },
      body: pickStyles(body, ["fontSize", "lineHeight", "color"]),
    };

    unmount();
    renderStyled(card, "mac");
    shell = document.querySelector('[data-card-kind="chat-message"]') as HTMLElement;
    tile = document.querySelector(".chat-message-card__agent-tile") as HTMLElement;
    attribution = document.querySelector(".chat-message-card__attribution") as HTMLElement;
    author = screen.getByText("Agent");
    timestamp = screen.getByText("4m");
    body = screen.getByText("An answer");
    expect({
      win,
      mac: {
        shell: pickStyles(shell, ["padding", "backgroundColor", "borderWidth", "borderRadius", "boxShadow"]),
        tileRadius: getComputedStyle(tile).borderRadius,
        attributionGap: getComputedStyle(attribution).gap,
        author: pickStyles(author, ["fontSize", "fontWeight", "color"]),
        timestamp: pickStyles(timestamp, ["fontSize", "fontWeight", "color"]),
        body: pickStyles(body, ["fontSize", "lineHeight", "color"]),
      },
    }).toEqual({
      win: {
        shell: { display: "flex", gap: "7px", padding: "12px", backgroundColor: "var(--color-timeline-chat-bg)", borderWidth: "1px", borderRadius: "8px", boxShadow: "" },
        tile: { width: "20px", height: "20px", backgroundColor: "var(--color-timeline-chat-agent-avatar)", borderRadius: "5px" },
        attribution: { display: "flex", alignItems: "center", gap: "8px" },
        author: { fontSize: "12.5px", fontWeight: "500", color: "var(--color-timeline-chat-author)" },
        timestamp: { text: "4m", marginLeft: "auto", fontSize: "11.5px", fontWeight: "400", color: "var(--color-timeline-chat-meta)" },
        body: { fontSize: "13px", lineHeight: "1.6", color: "var(--color-timeline-chat-body)" },
      },
      mac: {
        shell: { padding: "12px", backgroundColor: "var(--color-timeline-chat-bg)", borderWidth: "0px", borderRadius: "10px", boxShadow: "var(--shadow-timeline-chat-mac)" },
        tileRadius: "6px",
        attributionGap: "8px",
        author: { fontSize: "12.5px", fontWeight: "500", color: "var(--color-timeline-chat-author)" },
        timestamp: { fontSize: "11.5px", fontWeight: "400", color: "var(--color-timeline-chat-meta)" },
        body: { fontSize: "13px", lineHeight: "1.6", color: "var(--color-timeline-chat-body)" },
      },
    });
  });

  it("routes every chat-card color through dedicated light and derived-dark timeline tokens (#2068)", () => {
    expect({
      exactLightTokens: [
        "--color-timeline-chat-bg: #ffffff;",
        "--color-timeline-chat-border: #e3dfd6;",
        "--color-timeline-chat-author: #3a362f;",
        "--color-timeline-chat-body: #33302a;",
        "--color-timeline-chat-meta: #8c8779;",
        "--color-timeline-chat-footer-border: #f0ede6;",
        "--color-timeline-chat-user-avatar: #dcd7cc;",
        "--color-timeline-chat-agent-avatar: #2f5d8c;",
        "--shadow-timeline-chat-mac: 0 1px 2px rgba(31, 29, 26, 0.07);",
      ].every((declaration) => STYLESHEET.includes(declaration)),
      derivedDarkTokens: [
        "--color-timeline-chat-bg: var(--color-surface);",
        "--color-timeline-chat-border: var(--color-border);",
        "--color-timeline-chat-author: var(--color-fg);",
        "--color-timeline-chat-body: var(--color-fg);",
        "--color-timeline-chat-meta: var(--color-muted);",
        "--color-timeline-chat-footer-border: var(--color-border);",
        "--color-timeline-chat-user-avatar: var(--color-border);",
        "--color-timeline-chat-agent-avatar: var(--color-accent);",
        "--shadow-timeline-chat-mac: 0 1px 2px rgba(0, 0, 0, 0.4);",
      ].every((declaration) => STYLESHEET.includes(declaration)),
      componentUsesDedicatedTokens: {
        shellBackground: cssRule('.timeline-card[data-card-kind="chat-message"]').includes(
          "background-color: var(--color-timeline-chat-bg);",
        ),
        shellBorder: cssRule('.timeline-card[data-card-kind="chat-message"]').includes(
          "border-color: var(--color-timeline-chat-border);",
        ),
        macShadow: cssRule('.timeline-card[data-card-kind="chat-message"]:has(').includes(
          "box-shadow: var(--shadow-timeline-chat-mac);",
        ),
        author: cssRule(".chat-message-card__author").includes(
          "color: var(--color-timeline-chat-author);",
        ),
        body: cssRule(".chat-message-card__body").includes(
          "color: var(--color-timeline-chat-body);",
        ),
        timestamp: cssRule(".chat-message-card__timestamp").includes(
          "color: var(--color-timeline-chat-meta);",
        ),
        footerBorder: cssRule(".chat-message-card__refs").includes(
          "border-top-color: var(--color-timeline-chat-footer-border);",
        ),
        footerMeta: cssRule(".chat-message-card__refs").includes(
          "color: var(--color-timeline-chat-meta);",
        ),
        userAvatar: cssRule(".chat-message-card__user-avatar", 1).includes(
          "background-color: var(--color-timeline-chat-user-avatar);",
        ),
        agentAvatar: cssRule(".chat-message-card__agent-tile").includes(
          "background-color: var(--color-timeline-chat-agent-avatar);",
        ),
      },
    }).toEqual({
      exactLightTokens: true,
      derivedDarkTokens: true,
      componentUsesDedicatedTokens: {
        shellBackground: true,
        shellBorder: true,
        macShadow: true,
        author: true,
        body: true,
        timestamp: true,
        footerBorder: true,
        footerMeta: true,
        userAvatar: true,
        agentAvatar: true,
      },
    });
  });

  it("renders non-zero refs as the approved final footer row with no chip chrome (#2068)", () => {
    renderStyled(createChatMessageCard("agent", "An answer", { filesRead: 2 }));

    const refs = screen.getByText("refs: 2 files read");
    expect({
      inFooter: refs.closest("footer") !== null,
      ...pickStyles(refs, ["display", "paddingTop", "borderTopWidth", "fontSize", "color", "textAlign", "borderRadius"]),
    }).toEqual({
      inFooter: true,
      display: "block",
      paddingTop: "6px",
      borderTopWidth: "1px",
      fontSize: "11px",
      color: "var(--color-timeline-chat-meta)",
      textAlign: "right",
      borderRadius: "",
    });
  });

  it("reserves no footer row or hairline for absent and zero refs (#2068)", () => {
    const { unmount } = render(
      <ChatMessageCard card={createChatMessageCard("agent", "An answer")} platform="win" />,
    );
    const absentFooter = document.querySelector(".timeline-card__footer");

    unmount();
    render(
      <ChatMessageCard
        card={createChatMessageCard("agent", "An answer", { filesRead: 0 })}
        platform="win"
      />,
    );
    expect({ absentFooter, zeroFooter: document.querySelector(".timeline-card__footer") }).toEqual({
      absentFooter: null,
      zeroFooter: null,
    });
  });

  it("uses the approved 10c center-stage padding and body measure without a second component", () => {
    renderStyled(createChatMessageCard("agent", "An answer"), "mac", true);
    const shell = document.querySelector('[data-card-kind="chat-message"]') as HTMLElement;
    const body = screen.getByText("An answer");

    expect({
      shell: pickStyles(shell, ["padding", "borderRadius", "boxShadow"]),
      body: pickStyles(body, ["fontSize", "lineHeight"]),
    }).toEqual({
      shell: { padding: "14px 16px", borderRadius: "10px", boxShadow: "var(--shadow-timeline-chat-mac)" },
      body: { fontSize: "13.5px", lineHeight: "1.7" },
    });
  });

  it("renders no quote block for an ordinary message", () => {
    const card = createChatMessageCard("user", "just a message");
    render(<ChatMessageCard card={card} />);

    expect(screen.queryByText(/“/)).toBeNull();
  });

  it("renders the quoted excerpt above the body when the message carries one", () => {
    const card = createChatMessageCard("user", "see this:", {
      quote: {
        documentPath: "notes/outline.md",
        text: "the quoted sentence",
        anchor: {
          offset: 10,
          length: 20,
          text_snapshot: "the quoted sentence",
          context_before: "",
          context_after: "",
          base_revision: "blake3:abc",
        },
      },
    });

    render(<ChatMessageCard card={card} />);

    expect(screen.getByText("“the quoted sentence”")).toBeTruthy();
    expect(screen.getByText("see this:")).toBeTruthy();
  });

  it("clicking the quoted excerpt calls onFocusQuote with the anchor (deep-link back, Principle 6)", () => {
    const onFocusQuote = vi.fn();
    const anchor = {
      offset: 10,
      length: 20,
      text_snapshot: "the quoted sentence",
      context_before: "",
      context_after: "",
      base_revision: "blake3:abc",
    };
    const card = createChatMessageCard("user", "see this:", {
      quote: { documentPath: "notes/outline.md", text: "the quoted sentence", anchor },
    });

    render(<ChatMessageCard card={card} onFocusQuote={onFocusQuote} />);
    fireEvent.click(screen.getByText("“the quoted sentence”"));

    expect(onFocusQuote).toHaveBeenCalledWith(anchor);
  });

  it("never calls onFocusQuote on its own — only an explicit click (Principle 2, no focus steal)", () => {
    const onFocusQuote = vi.fn();
    const card = createChatMessageCard("user", "see this:", {
      quote: {
        documentPath: "notes/outline.md",
        text: "the quoted sentence",
        anchor: {
          offset: 10,
          length: 20,
          text_snapshot: "the quoted sentence",
          context_before: "",
          context_after: "",
          base_revision: "blake3:abc",
        },
      },
    });

    render(<ChatMessageCard card={card} onFocusQuote={onFocusQuote} />);

    expect(onFocusQuote).not.toHaveBeenCalled();
  });

  it("renders no refs chip for a user message even when filesRead is set", () => {
    const card = createChatMessageCard("user", "hello", { filesRead: 2 });
    render(<ChatMessageCard card={card} />);

    expect(screen.queryByText(/refs:/)).toBeNull();
  });

  it("renders no refs chip for an agent reply that read nothing (J2's clarifying-question edge state)", () => {
    const card = createChatMessageCard("agent", "Could you say more about the passage?");
    render(<ChatMessageCard card={card} />);

    expect(screen.queryByText(/refs:/)).toBeNull();
  });

  it("renders the J2 refs chip on an agent reply that read files, pluralized (#1391)", () => {
    const card = createChatMessageCard("agent", "Strong angle…", { filesRead: 2 });
    render(<ChatMessageCard card={card} />);

    expect(screen.getByText("refs: 2 files read")).toBeTruthy();
  });

  it("singularizes the refs chip for exactly one file read (#1391)", () => {
    const card = createChatMessageCard("agent", "Strong angle…", { filesRead: 1 });
    render(<ChatMessageCard card={card} />);

    expect(screen.getByText("refs: 1 file read")).toBeTruthy();
  });

  it("suppresses the back-link for a pathless quote but keeps the quote as quoted text (J12 Phase E #2365)", () => {
    const onFocusQuote = vi.fn();
    const card = createChatMessageCard("user", "see this:", {
      quote: {
        documentPath: null,
        label: "Untitled 2",
        text: "the quoted sentence",
        anchor: {
          offset: 10,
          length: 20,
          text_snapshot: "the quoted sentence",
          context_before: "",
          context_after: "",
          base_revision: "blake3:abc",
        },
      },
    });

    render(<ChatMessageCard card={card} onFocusQuote={onFocusQuote} />);

    // The quote remains as quoted text (J12 Phase E: "the quote remains as quoted text and its
    // back-link is absent, not broken") ...
    expect(screen.getByText("“the quoted sentence”")).toBeTruthy();
    // ... but never as a button, or any other element wired to onFocusQuote — a pathless quote's
    // deep-link has nowhere honest to resolve (TabbedEditor.focusAnchor only registers file-backed
    // editor handles), so the affordance itself must not exist, not merely fail silently on click.
    expect(screen.queryByRole("button", { name: /the quoted sentence/ })).toBeNull();
    expect(onFocusQuote).not.toHaveBeenCalled();
  });

  it("still renders the quote's back-link as a button for a path-bearing quote (J12 Phase E does not touch this case)", () => {
    const card = createChatMessageCard("user", "see this:", {
      quote: {
        documentPath: "notes/outline.md",
        text: "the quoted sentence",
        anchor: {
          offset: 10,
          length: 20,
          text_snapshot: "the quoted sentence",
          context_before: "",
          context_after: "",
          base_revision: "blake3:abc",
        },
      },
    });

    render(<ChatMessageCard card={card} />);

    expect(screen.getByRole("button", { name: "“the quoted sentence”" })).toBeTruthy();
  });

  it("reads identically as italic quoted text whether the quote is path-bearing or pathless (review round 1 Important #2365)", () => {
    // The PR body, the CSS comment, and this component's own inline comment all claim a
    // path-bearing quote's appearance is unchanged and that both variants "read identically apart
    // from the affordance itself." Pin that claim with the real stylesheet (`renderStyled`), not
    // jsdom's unstyled default — a shared class alone doesn't prove a shared cascade outcome.
    const anchor = {
      offset: 10,
      length: 20,
      text_snapshot: "the quoted sentence",
      context_before: "",
      context_after: "",
      base_revision: "blake3:abc",
    };
    const { unmount } = renderStyled(
      createChatMessageCard("user", "see this:", {
        quote: { documentPath: "notes/outline.md", text: "the quoted sentence", anchor },
      }),
    );
    const liveLink = screen.getByRole("button", { name: "“the quoted sentence”" });
    const liveStyle = pickStyles(liveLink, ["fontStyle", "color"]);

    unmount();
    renderStyled(
      createChatMessageCard("user", "see this:", {
        quote: { documentPath: null, label: "Untitled 2", text: "the quoted sentence", anchor },
      }),
    );
    const inertText = screen.getByText("“the quoted sentence”");
    const inertStyle = pickStyles(inertText, ["fontStyle", "color"]);

    expect({ liveStyle, inertStyle }).toEqual({
      liveStyle: { fontStyle: "italic", color: "var(--color-muted)" },
      inertStyle: { fontStyle: "italic", color: "var(--color-muted)" },
    });
  });

  it("is inert (no throw) when the quote is clicked with no onFocusQuote wired", () => {
    const card = createChatMessageCard("user", "see this:", {
      quote: {
        documentPath: "notes/outline.md",
        text: "the quoted sentence",
        anchor: {
          offset: 10,
          length: 20,
          text_snapshot: "the quoted sentence",
          context_before: "",
          context_after: "",
          base_revision: "blake3:abc",
        },
      },
    });

    render(<ChatMessageCard card={card} />);

    expect(() => fireEvent.click(screen.getByText("“the quoted sentence”"))).not.toThrow();
  });
});
