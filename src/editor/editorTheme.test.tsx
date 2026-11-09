// @vitest-environment jsdom
// ABOUTME: Verifies every shared CM6 document surface follows Cowrite's effective light/dark theme.
// ABOUTME: Covers live explicit/system changes and editors mounted after a theme is already active.
import { EditorView } from "@codemirror/view";
import { act, createRef, useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "../theme";
import { DocumentSurface, type DocumentSurfaceHandle } from "./DocumentSurface";

vi.mock("./ipc", async (importActual) => {
  const actual = await importActual<typeof import("./ipc")>();
  return { ...actual, parseChanges: vi.fn().mockResolvedValue([]) };
});

function ThemeControls() {
  const { mode, setMode } = useTheme();
  useEffect(() => () => document.documentElement.removeAttribute("data-theme"), []);
  return (
    <>
      <button type="button" onClick={() => setMode("light")} aria-pressed={mode === "light"}>
        Light
      </button>
      <button type="button" onClick={() => setMode("dark")} aria-pressed={mode === "dark"}>
        Dark
      </button>
      <button type="button" onClick={() => setMode("system")} aria-pressed={mode === "system"}>
        System
      </button>
    </>
  );
}

function renderEditor(): EditorView {
  const surfaceRef = createRef<DocumentSurfaceHandle>();
  render(
    <>
      <ThemeControls />
      <DocumentSurface ref={surfaceRef} platform="win" />
    </>,
  );
  let view!: EditorView;
  act(() => {
    view = surfaceRef.current!.mount({
      content: "Theme integration",
      parseDocument: null,
      parseGeneration: null,
    });
  });
  return view;
}

describe("editor/editorTheme — effective theme integration (#2392)", () => {
  let systemDark = false;
  let systemThemeChanged: (() => void) | null = null;

  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    systemDark = false;
    systemThemeChanged = null;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_event: string, listener: () => void) => {
        systemThemeChanged = listener;
      },
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it("reconfigures an existing editor across light, dark, and system changes", () => {
    const view = renderEditor();

    expect(view.state.facet(EditorView.darkTheme)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    systemDark = true;
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    systemDark = false;
    act(() => systemThemeChanged?.());
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });

  it("mounts a new editor with the active dark facet and core colour tokens", () => {
    const surfaceRef = createRef<DocumentSurfaceHandle>();
    render(
      <>
        <ThemeControls />
        <DocumentSurface ref={surfaceRef} platform="win" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    let view!: EditorView;
    act(() => {
      view = surfaceRef.current!.mount({
        content: "Mounted after dark",
        parseDocument: null,
        parseGeneration: null,
      });
    });

    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(document.head.textContent).toContain("var(--color-fg)");
    expect(document.head.textContent).toContain("var(--color-editor-canvas-bg)");
  });
});
