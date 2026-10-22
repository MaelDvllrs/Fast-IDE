import { useEffect, useRef, useState } from "react";
import { settings } from "../lib/ipc";
import { currentVersion, findUpdate, installUpdate, STARTUP_TIMEOUT_MS, type Update } from "../lib/updater";
import { FastSymbol } from "./FastSymbol";
import { Markdown } from "./Markdown";
import { UiIcon } from "./fileIcons";

/**
 * Mise à jour au lancement (si activée dans Preferences → Updates) : au démarrage
 * rien ne tourne encore, on peut donc installer et relancer sans rien interrompre.
 * Pas de réseau ou réponse lente : FAST s'ouvre normalement.
 */
export function StartupUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // En développement, la version locale ne correspond à aucune release.
    if (started.current || import.meta.env.DEV) return;
    started.current = true;
    settings
      .load()
      .then((s) => (s.autoUpdate === false ? null : findUpdate(STARTUP_TIMEOUT_MS)))
      .then((found) => {
        if (!found) return;
        setUpdate(found);
        return installUpdate(found, setProgress);
      })
      .catch((e) => {
        setError(String(e));
        // L'ancienne version reste utilisable : on la laisse s'ouvrir.
        setTimeout(() => setUpdate(null), 4000);
      });
  }, []);

  if (!update) return null;
  return (
    <div className="update-screen" role="status">
      <FastSymbol className="update-logo" />
      <div className="update-title">{error ? "Update failed" : `Updating Fast to ${update.version}…`}</div>
      {error ? (
        <div className="update-error">{error}</div>
      ) : (
        <div className={progress === null ? "update-bar indeterminate" : "update-bar"}>
          <span style={{ width: `${(progress ?? 0.3) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

type CheckState =
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; update: Update; progress: number | null }
  | { kind: "error"; message: string };

/** Recherche de mise à jour à la main (menu Settings, Preferences → Updates). */
export function UpdateCheck() {
  const [state, setState] = useState<CheckState>({ kind: "checking" });
  const [version, setVersion] = useState("");

  const run = () => {
    setState({ kind: "checking" });
    findUpdate().then(
      (update) => setState(update ? { kind: "available", update } : { kind: "latest" }),
      (e) => setState({ kind: "error", message: String(e) }),
    );
  };

  useEffect(() => {
    currentVersion().then(setVersion, () => {});
    run();
  }, []);

  const install = (update: Update) => {
    setState({ kind: "installing", update, progress: null });
    installUpdate(update, (progress) => setState({ kind: "installing", update, progress })).catch((e) =>
      setState({ kind: "error", message: String(e) }),
    );
  };

  return (
    <div className="update-check">
      {state.kind === "checking" && (
        <div className="update-line">
          <UiIcon name="lucide:loader-circle" className="spin update-line-icon" />
          Checking for updates…
        </div>
      )}
      {state.kind === "latest" && (
        <div className="update-line ok">
          <UiIcon name="lucide:check" className="update-line-icon" />
          You're up to date{version && ` (${version})`}.
        </div>
      )}
      {state.kind === "error" && (
        <>
          <div className="update-line error">
            <UiIcon name="lucide:circle-alert" className="update-line-icon" />
            Could not check for updates.
          </div>
          <div className="update-error">{state.message}</div>
          <div className="update-actions">
            <button className="secondary-button" onClick={run}>
              Try again
            </button>
          </div>
        </>
      )}
      {(state.kind === "available" || state.kind === "installing") && (
        <>
          <div className="update-line">
            <UiIcon name="lucide:download" className="update-line-icon accent" />
            Fast {state.update.version} is available{version && ` (you have ${version})`}.
          </div>
          {state.update.body && (
            <div className="update-notes">
              <Markdown text={state.update.body} />
            </div>
          )}
          {state.kind === "installing" ? (
            <div className={state.progress === null ? "update-bar indeterminate" : "update-bar"}>
              <span style={{ width: `${(state.progress ?? 0.3) * 100}%` }} />
            </div>
          ) : (
            <div className="update-actions">
              <button className="primary-button" onClick={() => install(state.update)}>
                <UiIcon name="lucide:download" className="primary-button-icon" />
                Install and restart
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Fenêtre « Check for updates… » du menu Settings. */
export function UpdateDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dialog" role="dialog" aria-modal="true" aria-label="Check for updates">
        <header className="preferences-header">
          <h2>Updates</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <UiIcon name="lucide:x" className="icon-button-icon" />
          </button>
        </header>
        <div className="dialog-body">
          <UpdateCheck />
        </div>
      </div>
    </div>
  );
}
