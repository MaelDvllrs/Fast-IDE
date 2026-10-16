import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { settings } from "./lib/ipc";
import { applyPlatformClass } from "./platform";
import { applyTheme } from "./theme";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

await applyPlatformClass();

// Thème appliqué avant le premier affichage (pas de flash de couleurs).
const prefs = await settings.load().catch(() => null);
applyTheme(prefs?.theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
