import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminal } from "../lib/ipc";
import { registerRunView, runState, stopRun, useRunState } from "../lib/runner";
import { registerTerminal } from "../lib/terminalBus";
import { platform, platformInfo } from "../platform";
import { THEME_CHANGE_EVENT } from "../theme";

interface Props {
  /** Dossier dans lequel le shell démarre (le dossier ouvert dans l'explorateur),
   *  ou `null` pour le dossier personnel. */
  cwd: string | null;
  /** Hauteur en px, réglée par la poignée de redimensionnement. */
  height: number;
}

/** Couleurs ANSI d'xterm qu'un thème peut redéfinir (variables --ansi-red, --ansi-bright-black…). */
const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const FONT = "Geist Mono Variable";

/** Lit une variable CSS du thème, pour que le terminal suive les couleurs de l'app. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Couleurs lues dans le thème actif ; relues à chaque changement de thème.
// Palette ANSI : seulement si le thème la définit (--ansi-red…), sinon celle d'xterm.
const terminalTheme = () => ({
  background: cssVar("--bg-terminal"),
  foreground: cssVar("--text"),
  cursor: cssVar("--primary"),
  cursorAccent: cssVar("--bg-terminal"),
  selectionBackground: cssVar("--selection"),
  ...Object.fromEntries(
    ANSI_COLORS.map((name) => [name, cssVar(`--ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)]).filter(
      ([, value]) => value,
    ),
  ),
});

/**
 * Vue xterm dans `host`, qui suit le thème et la taille de son conteneur.
 * `onReady` est appelé une fois la police chargée et le terminal affiché ;
 * `onResize` à chaque changement de colonnes / lignes. Rend la fonction de fermeture.
 */
function mountXterm(
  host: HTMLElement,
  { cursor, onReady, onResize }: { cursor: boolean; onReady: (xterm: Terminal) => void; onResize: (xterm: Terminal) => void },
) {
  let disposed = false;
  const xterm = new Terminal({
    ...platform().terminalOptions(platformInfo()),
    fontFamily: `"${FONT}", monospace`,
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: cursor,
    cursorInactiveStyle: cursor ? "outline" : "none",
    allowProposedApi: false,
    theme: terminalTheme(),
  });
  const onThemeChange = () => {
    xterm.options.theme = terminalTheme();
  };
  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  let observer: ResizeObserver | undefined;

  // La police doit être chargée avant que xterm mesure ses cellules.
  document.fonts.load(`13px "${FONT}"`).finally(() => {
    if (disposed) return;
    xterm.open(host);
    fit.fit();
    onReady(xterm);
    // Onglet masqué (largeur nulle) : on attend qu'il soit de nouveau visible.
    observer = new ResizeObserver(() => {
      if (!host.offsetWidth) return;
      fit.fit();
      onResize(xterm);
    });
    observer.observe(host);
  });

  return {
    xterm,
    dispose: () => {
      disposed = true;
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      observer?.disconnect();
      xterm.dispose();
    },
  };
}

type Tab = "terminal" | "run";

/** Fenêtre terminal : le shell interactif, et l'onglet Run où tourne le projet. */
export function TerminalPanel({ cwd, height }: Props) {
  const run = useRunState();
  const [tab, setTab] = useState<Tab>("terminal");
  const runSession = useRef(run.sessionId);

  // Nouvelle exécution : l'onglet Run passe au premier plan.
  useEffect(() => {
    if (run.sessionId && run.sessionId !== runSession.current) setTab("run");
    runSession.current = run.sessionId;
  }, [run.sessionId]);

  // Fermeture du projet : le programme lancé s'arrête avec lui.
  useEffect(() => () => void stopRun(), [cwd]);

  const runLabel =
    run.status === "running"
      ? "Running"
      : run.status === "stopping"
        ? "Stopping…"
        : run.exitCode === null
          ? "Stopped"
          : `Exited with code ${run.exitCode}`;

  return (
    <section className="window terminal-panel" style={{ flexBasis: height }}>
      <header className="panel-header terminal-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "terminal"} className="terminal-tab" onClick={() => setTab("terminal")}>
          Terminal
        </button>
        {run.sessionId && (
          <button role="tab" aria-selected={tab === "run"} className="terminal-tab" onClick={() => setTab("run")}>
            <span className={`run-dot ${run.status}${run.status === "exited" && run.exitCode ? " failed" : ""}`} />
            Run
          </button>
        )}
        {tab === "run" && run.command && (
          <span className="terminal-run-info" title={run.command}>
            <code>{run.command}</code> · {runLabel}
          </span>
        )}
      </header>
      <ShellView cwd={cwd} hidden={tab !== "terminal"} />
      <RunView hidden={tab !== "run"} />
    </section>
  );
}

/** Shell interactif du projet. */
function ShellView({ cwd, hidden }: { cwd: string | null; hidden: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    // Un identifiant par exécution de l'effet (StrictMode monte deux fois).
    const id = crypto.randomUUID();
    let started: Promise<void> = Promise.resolve();
    let unregister: (() => void) | undefined;

    const { xterm, dispose } = mountXterm(host.current, {
      cursor: true,
      onReady: (xterm) => {
        started = terminal.start(id, cwd, xterm.cols, xterm.rows).catch((err) => {
          xterm.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
        });
        const write = (data: string) => {
          started.then(() => terminal.write(id, data)).catch(() => {});
        };
        xterm.onData(write);
        // Les autres composants peuvent lancer une commande dans ce shell.
        unregister = registerTerminal(write);
      },
      onResize: (xterm) => {
        started.then(() => terminal.resize(id, xterm.cols, xterm.rows)).catch(() => {});
      },
    });

    const unlisten = terminal.onEvent(({ sessionId, event }) => {
      if (sessionId !== id) return;
      if (event.type === "output") xterm.write(event.data);
      else xterm.write(`\r\n\x1b[2m[process exited${event.data !== null ? ` with code ${event.data}` : ""}]\x1b[0m\r\n`);
    });

    return () => {
      unregister?.();
      unlisten.then((fn) => fn());
      // Attendre la fin du démarrage pour que l'arrêt ne le précède jamais.
      started.then(() => terminal.stop(id)).catch(() => {});
      dispose();
    };
  }, [cwd]);

  return <div className="terminal-host" ref={host} hidden={hidden} />;
}

/** Sortie du programme lancé par le bouton Run (et ses entrées clavier). */
function RunView({ hidden }: { hidden: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    let ready: Terminal | null = null;

    const { xterm, dispose } = mountXterm(host.current, {
      cursor: false,
      onReady: (xterm) => {
        ready = xterm;
        xterm.onData((data) => {
          const { sessionId, status } = runState();
          if (sessionId && status === "running") terminal.write(sessionId, data).catch(() => {});
        });
      },
      onResize: (xterm) => {
        const { sessionId, status } = runState();
        if (sessionId && status !== "exited") terminal.resize(sessionId, xterm.cols, xterm.rows).catch(() => {});
      },
    });

    const unregister = registerRunView({
      size: () => ({ cols: ready?.cols ?? 120, rows: ready?.rows ?? 30 }),
      // Écran vide puis la commande en tête, comme si on l'avait tapée.
      reset: (command) => {
        xterm.reset();
        xterm.write(`\x1b[2m$ ${command}\x1b[0m\r\n`);
      },
    });

    const unlisten = terminal.onEvent(({ sessionId, event }) => {
      if (sessionId !== runState().sessionId) return;
      if (event.type === "output") xterm.write(event.data);
      else
        xterm.write(
          `\r\n\x1b[2m[${event.data === null ? "stopped" : `process exited with code ${event.data}`}]\x1b[0m\r\n`,
        );
    });

    return () => {
      unregister();
      unlisten.then((fn) => fn());
      dispose();
    };
  }, []);

  return <div className="terminal-host" ref={host} hidden={hidden} />;
}
