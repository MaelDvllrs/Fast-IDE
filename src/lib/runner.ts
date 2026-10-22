// Exécution du projet (bouton Run de la barre du haut) : un seul processus à la
// fois, lancé dans un pseudo-terminal dédié et affiché dans l'onglet Run du
// terminal. Ce module garde son état ; l'onglet Run s'y déclare pour l'affichage.
import { useEffect, useState } from "react";
import { terminal } from "./ipc";

export type RunStatus = "idle" | "running" | "stopping" | "exited";

export interface RunState {
  status: RunStatus;
  command: string | null;
  /** Session du pseudo-terminal en cours (ou de la dernière exécution). */
  sessionId: string | null;
  /** Code de sortie de la dernière exécution, `null` si arrêtée par FAST. */
  exitCode: number | null;
  /** Adresse locale annoncée par le programme (serveur web), `null` sinon. */
  url: string | null;
}

/** Vue de l'onglet Run : sa taille et de quoi repartir d'un écran vide. */
interface RunView {
  size: () => { cols: number; rows: number };
  reset: (header: string) => void;
}

/** Envoyé quand la commande Run du projet change (préférences) : le bouton la relit. */
export const RUN_CONFIG_EVENT = "fast:runconfig";

/** Délai laissé au programme pour s'arrêter après Ctrl+C, avant de le tuer. */
const STOP_GRACE_MS = 2000;

let state: RunState = { status: "idle", command: null, sessionId: null, exitCode: null, url: null };
// Fin de la sortie reçue : une adresse peut être coupée entre deux morceaux.
let outputTail = "";

/** Séquences d'échappement du terminal (couleurs, curseur), retirées avant la recherche. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Première adresse locale d'un serveur web dans la sortie (Vite, Next, Django…). */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>)]*)?/;

/** Adresse trouvée dans la sortie ; `0.0.0.0` (toutes les interfaces) s'ouvre sur localhost. */
function findUrl(output: string): string | null {
  const match = output.replace(ANSI, "").match(LOCAL_URL);
  return match ? match[0].replace("0.0.0.0", "localhost").replace(/[.,;]+$/, "") : null;
}
let view: RunView | null = null;
const listeners = new Set<(s: RunState) => void>();
// Attente de la fin d'une exécution (relance : arrêter puis démarrer).
let waitingExit: (() => void) | null = null;

function set(patch: Partial<RunState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

// Sortie : on y cherche l'adresse du serveur. Fin : il s'est arrêté seul, ou après Stop.
terminal.onEvent(({ sessionId, event }) => {
  if (sessionId !== state.sessionId) return;
  if (event.type === "output") {
    if (state.url) return;
    outputTail = (outputTail + event.data).slice(-2000);
    const url = findUrl(outputTail);
    if (url) set({ url });
    return;
  }
  set({ status: "exited", exitCode: event.data });
  waitingExit?.();
  waitingExit = null;
});

export function registerRunView(next: RunView) {
  view = next;
  return () => {
    if (view === next) view = null;
  };
}

export const runState = () => state;

export function stopRun(): Promise<void> {
  const { sessionId, status } = state;
  if (!sessionId || (status !== "running" && status !== "stopping")) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    waitingExit = resolve;
  });
  if (status === "running") {
    set({ status: "stopping" });
    // Ctrl+C d'abord, pour que le serveur se ferme proprement ; sinon on le tue.
    terminal.write(sessionId, "\x03").catch(() => {});
    setTimeout(() => {
      if (state.sessionId === sessionId && state.status === "stopping") terminal.stop(sessionId).catch(() => {});
    }, STOP_GRACE_MS);
  }
  return exited;
}

/** Lance `command` dans `cwd` ; une exécution en cours est d'abord arrêtée. */
export async function startRun(cwd: string, command: string) {
  await stopRun();
  const id = crypto.randomUUID();
  view?.reset(command);
  outputTail = "";
  set({ status: "running", command, sessionId: id, exitCode: null, url: null });
  const { cols, rows } = view?.size() ?? { cols: 120, rows: 30 };
  try {
    await terminal.start(id, cwd, cols, rows, undefined, command);
  } catch (err) {
    set({ status: "exited", exitCode: null });
    throw err;
  }
}

export function useRunState(): RunState {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    setValue(state);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
