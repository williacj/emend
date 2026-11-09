// ABOUTME: Frontend entry point — mounts the React app shell into #root and loads global styles.
// ABOUTME: The frontend is a projection only (TD-2); all document authority lives in the Rust backend.
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-400-italic.css";
import "@fontsource/source-serif-4/latin-700.css";
import "@fontsource/source-serif-4/latin-700-italic.css";
import { RenderRecoverySupervisor } from "./renderRecovery";
import { startSettingsStore } from "./settings";
import { publishUnhandledRejection } from "./stores/appStatus";
import "./styles.css";

// @anchor:main-unhandled-rejection-listener
window.addEventListener("unhandledrejection", (event) => {
  publishUnhandledRejection(event.reason);
});

// TD-26: establish the cross-process event stream before the initial settings read can hydrate.
void startSettingsStore();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RenderRecoverySupervisor />,
);
