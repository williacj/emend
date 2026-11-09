// ABOUTME: Bridges Emend's effective app theme into the CM6 dark-theme facet on every editor.
// ABOUTME: Keeps editor chrome on the app's existing core color tokens instead of new hues.
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  getEffectiveTheme,
  subscribeToEffectiveTheme,
  type EffectiveTheme,
} from "../theme";

const editorColors = {
  "&": {
    color: "var(--color-fg)",
    backgroundColor: "var(--color-editor-canvas-bg)",
  },
  ".cm-content": {
    caretColor: "var(--color-fg)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-fg)",
  },
};

function editorTheme(theme: EffectiveTheme): Extension {
  return EditorView.theme(editorColors, { dark: theme === "dark" });
}

export function editorThemeExtensions(): Extension[] {
  const themeCompartment = new Compartment();
  const themeWatcher = ViewPlugin.fromClass(
    class {
      private readonly unsubscribe: () => void;

      constructor(view: EditorView) {
        this.unsubscribe = subscribeToEffectiveTheme((theme) => {
          if (view.state.facet(EditorView.darkTheme) === (theme === "dark")) return;
          view.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
        });
      }

      destroy() {
        this.unsubscribe();
      }
    },
  );

  return [themeCompartment.of(editorTheme(getEffectiveTheme())), themeWatcher];
}
