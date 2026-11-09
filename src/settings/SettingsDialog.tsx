// ABOUTME: User-drivable General Settings surface (mock 1m) for persisted app preferences.
// ABOUTME: Applies field-scoped patches while reporting failures without claiming draft values are live.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { errorDetail } from "../backend";
import { isMac } from "../editor/keymap";
import type { ThemeMode } from "../theme";
import type { Settings, SettingsPatch } from "./ipc";
import { VoiceSettingsSection } from "./VoiceSettingsSection";
import {
  getSettingsStoreSnapshot,
  patchCurrentSettings,
  retrySettingsHydration,
  startSettingsStore,
  subscribeSettings,
} from "./store";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const AUTOSAVE_INTERVALS = [
  { value: 1000, label: "1 second" },
  { value: 2000, label: "2 seconds" },
  { value: 5000, label: "5 seconds" },
  { value: 30_000, label: "30 seconds" },
] as const;

export interface SettingsDialogProps {
  onClose(): void;
  themeMode: ThemeMode;
  onThemeModeChange(mode: ThemeMode): void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  initialSection?: "general" | "voice";
  /** Testable presentation seam; production derives this from the native platform. */
  platform?: "win" | "mac";
}

function failureMessage(prefix: string, error: unknown): string {
  const detail = errorDetail(error);
  return `${prefix} ${detail || "Try again."}`;
}

/**
 * The bounded General slice of ux-design §4's Settings inventory. The full P6-5 panel still owns
 * the other inventory sections; rendering inactive placeholders here would falsely imply those
 * settings work, so this prerequisite exposes only the General controls it genuinely persists.
 */
// @anchor:test-plan-settings-dialog
export function SettingsDialog({
  onClose,
  themeMode,
  onThemeModeChange,
  returnFocusTo,
  initialSection = "general",
  platform = isMac ? "mac" : "win",
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const voiceFocusDone = useRef(false);
  const mountedRef = useRef(true);
  const storeSnapshot = useSyncExternalStore(
    subscribeSettings,
    getSettingsStoreSnapshot,
    getSettingsStoreSnapshot,
  );
  const committed = storeSnapshot.status === "ready" ? storeSnapshot.settings : null;
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [retryPatch, setRetryPatch] = useState<SettingsPatch | null>(null);

  const load = useCallback(() => {
    setSaveError(null);
    setSavedStatus(null);
    void retrySettingsHydration();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void startSettingsStore();
    closeRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (storeSnapshot.status !== "ready") return;
    setDraft(storeSnapshot.settings);
  }, [storeSnapshot]);

  useEffect(() => {
    if (initialSection !== "voice" || voiceFocusDone.current || !draft || storeSnapshot.status !== "ready") return;
    const heading = dialogRef.current?.querySelector<HTMLElement>("#settings-voice-heading");
    if (!heading) return;
    heading.focus();
    voiceFocusDone.current = true;
  }, [initialSection, draft, storeSnapshot.status]);

  const close = () => {
    if (saving) return;
    onClose();
    returnFocusTo?.current?.focus();
  };

  const commit = async (patch: SettingsPatch, next: Settings) => {
    setDraft(next);
    setRetryPatch(patch);
    setSaving(true);
    setSaveError(null);
    setSavedStatus(null);
    try {
      await patchCurrentSettings(patch);
      if (!mountedRef.current) return;
      const current = getSettingsStoreSnapshot().settings;
      setDraft(current);
      setRetryPatch(null);
      setSavedStatus("Settings saved");
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveError(failureMessage("Settings weren’t saved.", error));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div className="settings-backdrop">
      <section
        ref={dialogRef}
        className="settings-dialog"
        data-platform={platform}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-busy={storeSnapshot.status === "loading" || saving}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="settings-dialog__header">
          <h1 id="settings-title">Settings</h1>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            disabled={saving}
          >
            Close Settings
          </button>
        </header>
        <div className="settings-dialog__body">
          <nav className="settings-dialog__nav" aria-label="Settings sections">
            <span aria-current="page">General</span>
          </nav>
          <div className="settings-dialog__content">
            <div className="settings-dialog__row">
              <span className="settings-dialog__setting-label" id="settings-theme-label">Theme</span>
              <div className="theme-switch" role="group" aria-labelledby="settings-theme-label">
                {THEME_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    className="theme-switch__option"
                    aria-pressed={value === themeMode}
                    onClick={() => onThemeModeChange(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {storeSnapshot.status === "loading" && (
              <p className="settings-dialog__progress">Loading settings…</p>
            )}
            {storeSnapshot.status === "error" && (
              <div className="settings-dialog__failure" role="alert">
                <p>
                  {failureMessage(
                    "Cowrite couldn’t load Settings.",
                    storeSnapshot.error,
                  )}
                </p>
                <button type="button" onClick={load}>
                  Try again
                </button>
              </div>
            )}
            {storeSnapshot.status === "ready" && draft && committed && (
              <>
                <div className="settings-dialog__row">
                  <label
                    className="settings-dialog__setting-label"
                    htmlFor="settings-autosave"
                  >
                    Autosave
                  </label>
                  <input
                    id="settings-autosave"
                    type="checkbox"
                    checked={draft.autosave.enabled}
                    disabled={saving}
                    onChange={(event) => {
                      const nextAutosave = {
                        ...committed.autosave,
                        enabled: event.currentTarget.checked,
                      };
                      void commit(
                        {
                          autosave: {
                            enabled: nextAutosave.enabled,
                            intervalMs: nextAutosave.interval_ms,
                          },
                        },
                        {
                          ...committed,
                          autosave: nextAutosave,
                        },
                      );
                    }}
                  />
                  <span className="settings-dialog__secondary">every</span>
                  <label
                    className="settings-dialog__visually-hidden"
                    htmlFor="settings-autosave-interval"
                  >
                    Autosave interval
                  </label>
                  <select
                    id="settings-autosave-interval"
                    value={draft.autosave.interval_ms}
                    disabled={saving || !draft.autosave.enabled}
                    onChange={(event) => {
                      const nextAutosave = {
                        ...committed.autosave,
                        interval_ms: Number(event.currentTarget.value),
                      };
                      void commit(
                        {
                          autosave: {
                            enabled: nextAutosave.enabled,
                            intervalMs: nextAutosave.interval_ms,
                          },
                        },
                        {
                          ...committed,
                          autosave: nextAutosave,
                        },
                      );
                    }}
                  >
                    {!AUTOSAVE_INTERVALS.some(
                      ({ value }) => value === draft.autosave.interval_ms,
                    ) && (
                      <option value={draft.autosave.interval_ms}>
                        {draft.autosave.interval_ms} milliseconds
                      </option>
                    )}
                    {AUTOSAVE_INTERVALS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-dialog__row">
                  <label
                    className="settings-dialog__setting-label"
                    htmlFor="settings-reveal-markup-at-cursor"
                  >
                    Reveal markup at cursor
                  </label>
                  <input
                    id="settings-reveal-markup-at-cursor"
                    type="checkbox"
                    checked={draft.reveal_markup_at_cursor}
                    disabled={saving}
                    onChange={(event) => {
                      const revealMarkupAtCursor = event.currentTarget.checked;
                      void commit(
                        { revealMarkupAtCursor },
                        {
                          ...committed,
                          reveal_markup_at_cursor: revealMarkupAtCursor,
                        },
                      );
                    }}
                  />
                </div>
                {saving && (
                  <p className="settings-dialog__progress">
                    Saving settings…
                  </p>
                )}
                {saveError && (
                  <div className="settings-dialog__failure" role="alert">
                    <p>{saveError}</p>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        if (retryPatch) void commit(retryPatch, draft);
                      }}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {savedStatus && !saveError && (
                  <p role="status" aria-label="Settings save status">{savedStatus}</p>
                )}
                <VoiceSettingsSection />
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
