// ABOUTME: Draws Cowrite's one platform-sized app title row around the existing author controls.
// ABOUTME: Tauri owns drag and double-click maximize; Windows close enters the app-lifetime guard.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import type { ReactNode } from "react";

export interface WindowChromeProps {
  platform: "win" | "mac";
  title: string;
  leading?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}

function windowAction(action: "close" | "minimize" | "toggleMaximize") {
  if (!isTauri()) return;
  // `close()` emits the native close request. The installed router handles dirty tabs, active
  // runs, and session-write guards before its own explicit `destroy()` edge.
  void getCurrentWindow()[action]();
}

export function WindowChrome({ platform, title, leading, status, actions }: WindowChromeProps) {
  return (
    // Tauri 2.11's injected drag script walks a deep region but stops at buttons. It also owns
    // double-click maximize, so a React double-click handler would toggle the window twice.
    <header
      className="app-header"
      data-platform={platform}
      data-tauri-drag-region="deep"
    >
      <div className="app-header__identity">
        {platform === "mac" ? (
          <span className="app-header__traffic-light-space" aria-hidden="true" />
        ) : (
          <span className="app-header__icon" aria-hidden="true" />
        )}
        {leading}
        {platform === "win" && <span className="app-header__title">{title}</span>}
        {platform === "mac" && status && <span className="app-header__status">{status}</span>}
      </div>
      {platform === "mac" && <span className="app-header__title">{title}</span>}
      {platform === "win" && status && <span className="app-header__status">{status}</span>}
      <div className="app-header__actions">
        {actions}
      </div>
      {platform === "win" && (
        <div className="app-header__window-controls" role="group" aria-label="Window controls">
          <button type="button" aria-label="Minimize window" onClick={() => windowAction("minimize")}>
            <Minus aria-hidden="true" />
          </button>
          <button type="button" aria-label="Maximize or restore window" onClick={() => windowAction("toggleMaximize")}>
            <Square aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close window" onClick={() => windowAction("close")}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
