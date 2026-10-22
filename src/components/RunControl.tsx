import { useEffect, useRef, useState } from "react";
import { openUrl, project, type RunCandidate } from "../lib/ipc";
import { RUN_CONFIG_EVENT, startRun, stopRun, useRunState } from "../lib/runner";
import { UiIcon } from "./fileIcons";

/**
 * Bouton Run de la barre du haut, à côté des boutons de fenêtre : lance le
 * projet ouvert avec la commande choisie dans Preferences → Project (ou
 * détectée). F5 lance, Maj+F5 arrête.
 */
export function RunControl({ root, onConfigure }: { root: string; onConfigure: () => void }) {
  const run = useRunState();
  const [candidates, setCandidates] = useState<RunCandidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      project.runOptions(root).then(
        (options) => {
          setCandidates(options.candidates);
          setSelected(options.selected);
        },
        () => setSelected(null),
      );
    load();
    window.addEventListener(RUN_CONFIG_EVENT, load);
    return () => window.removeEventListener(RUN_CONFIG_EVENT, load);
  }, [root]);

  const active = run.status === "running" || run.status === "stopping";
  const label = candidates.find((c) => c.command === selected)?.label ?? selected;

  // Sans commande, le bouton ouvre les réglages pour en choisir une.
  const launch = (command = selected) => {
    if (!command) return onConfigure();
    setError(null);
    startRun(root, command).catch((e) => setError(String(e)));
  };

  // Raccourcis lus via une ref : l'écouteur est installé une seule fois.
  const keys = useRef(launch);
  keys.current = launch;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F5") return;
      e.preventDefault();
      if (e.shiftKey) stopRun();
      else keys.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="run-control">
      {active ? (
        <>
          {/* Application web : l'adresse annoncée par le serveur, ouverte dans le navigateur */}
          {run.url && (
            <button className="run-link" title={`Open ${run.url}`} onClick={() => openUrl(run.url!).catch(() => {})}>
              <UiIcon name="lucide:external-link" className="run-link-icon" />
              {run.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </button>
          )}
          <button className="run-button" title={`Restart ${run.command} (F5)`} aria-label="Restart" onClick={() => launch(run.command)}>
            <UiIcon name="lucide:rotate-ccw" className="run-icon" />
          </button>
          <button className="run-button stop" title="Stop (Shift+F5)" aria-label="Stop" onClick={() => stopRun()}>
            <UiIcon name="lucide:square" className="run-icon" />
          </button>
        </>
      ) : (
        <button
          className={error ? "run-button play error" : "run-button play"}
          title={error ?? (selected ? `Run ${label} (F5)` : "Choose a run command")}
          aria-label="Run"
          onClick={() => launch()}
        >
          <UiIcon name="lucide:play" className="run-icon" />
        </button>
      )}
    </div>
  );
}
