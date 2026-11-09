// ABOUTME: App-shell theme state — light, dark, or system (following the OS preference).
// ABOUTME: Sets <html data-theme> to the effective theme so CSS variables switch (FR-X-6).
import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

export type EffectiveTheme = "light" | "dark";

type EffectiveThemeListener = (theme: EffectiveTheme) => void;

const DARK_QUERY = "(prefers-color-scheme: dark)";
const STORAGE_KEY = "cowrite.theme";

function browserStorage(): Storage | null {
  // Vitest's jsdom window is the Node global; Node 26's localStorage getter warns before it throws.
  if (typeof process !== "undefined" && process.versions?.node) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storedMode(): ThemeMode {
  try {
    const saved = browserStorage()?.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // Private or restricted storage must not prevent choosing a theme for this session.
  }
  return "system";
}

const effectiveThemeListeners = new Set<EffectiveThemeListener>();

function resolveEffective(mode: ThemeMode): EffectiveTheme {
  if (mode === "system") {
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches
      ? "dark"
      : "light";
  }
  return mode;
}

function applyTheme(effective: EffectiveTheme): void {
  if (document.documentElement.getAttribute("data-theme") === effective) return;
  document.documentElement.setAttribute("data-theme", effective);
  for (const listener of effectiveThemeListeners) listener(effective);
}

export function getEffectiveTheme(): EffectiveTheme {
  const applied = document.documentElement.getAttribute("data-theme");
  return applied === "light" || applied === "dark" ? applied : resolveEffective("system");
}

export function subscribeToEffectiveTheme(listener: EffectiveThemeListener): () => void {
  effectiveThemeListeners.add(listener);
  return () => effectiveThemeListeners.delete(listener);
}

export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const [mode, updateMode] = useState<ThemeMode>(storedMode);
  const setMode = (next: ThemeMode) => {
    try {
      browserStorage()?.setItem(STORAGE_KEY, next);
    } catch {
      // The live selection still works if storage is unavailable.
    }
    updateMode(next);
  };

  useEffect(() => {
    applyTheme(resolveEffective(mode));
    if (mode !== "system") {
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme(resolveEffective("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  return { mode, setMode };
}
