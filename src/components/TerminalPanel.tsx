import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminal } from "../lib/ipc";
import { registerTerminal } from "../lib/terminalBus";
import { platform, platformInfo } from "../platform";
import { THEME_CHANGE_EVENT } from "../theme";

interface Props {
  /** Dossier dans lequel le shell démarre (le dossier ouvert dans l'explorateur),
   *  ou `null` pour le dossier personnel. */
  cwd: string | null;
  /** Message affiché avant la première invite du shell. */
  banner?: string;
  /** Hauteur en px, réglée par la poignée de redimensionnement. */
  height: number;
}

const FONT = "Geist Mono Variable";

/** Lit une variable CSS du thème, pour que le terminal suive les couleurs de l'app. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Fenêtre terminal : xterm.js pour l'affichage, shell réel côté Rust. */
export function TerminalPanel({ cwd, banner, height }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Un identifiant par exécution de l'effet (StrictMode monte deux fois).
    const id = crypto.randomUUID();
    let disposed = false;

    // Couleurs lues dans le thème actif ; relues à chaque changement de thème.
    const terminalTheme = () => ({
      background: cssVar("--bg-terminal"),
      foreground: cssVar("--text"),
      cursor: cssVar("--primary"),
      cursorAccent: cssVar("--bg-terminal"),
      selectionBackground: cssVar("--selection"),
    });
    const xterm = new Terminal({
      ...platform().terminalOptions(platformInfo()),
      fontFamily: `"${FONT}", monospace`,
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: false,
      theme: terminalTheme(),
    });
    const onThemeChange = () => {
      xterm.options.theme = terminalTheme();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    const fit = new FitAddon();
    xterm.loadAddon(fit);

    const unlisten = terminal.onEvent(({ sessionId, event }) => {
      if (sessionId !== id) return;
      if (event.type === "output") xterm.write(event.data);
      else xterm.write(`\r\n\x1b[2m[process exited${event.data !== null ? ` with code ${event.data}` : ""}]\x1b[0m\r\n`);
    });

    let started: Promise<void> = Promise.resolve();
    let observer: ResizeObserver | undefined;
    let unregister: (() => void) | undefined;

    // La police doit être chargée avant que xterm mesure ses cellules.
    document.fonts.load(`13px "${FONT}"`).finally(() => {
      if (disposed || !host.current) return;
      xterm.open(host.current);
      fit.fit();

      started = terminal.start(id, cwd, xterm.cols, xterm.rows, banner).catch((err) => {
        xterm.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
      });

      const write = (data: string) => {
        started.then(() => terminal.write(id, data)).catch(() => {});
      };
      xterm.onData(write);
      // Les autres composants peuvent lancer une commande dans ce shell.
      unregister = registerTerminal(write);

      // Ajuste le nombre de colonnes / lignes du shell à la taille de la fenêtre.
      observer = new ResizeObserver(() => {
        if (!host.current?.offsetWidth) return;
        fit.fit();
        started.then(() => terminal.resize(id, xterm.cols, xterm.rows)).catch(() => {});
      });
      observer.observe(host.current);
    });

    return () => {
      disposed = true;
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      unregister?.();
      observer?.disconnect();
      unlisten.then((fn) => fn());
      // Attendre la fin du démarrage pour que l'arrêt ne le précède jamais.
      started.then(() => terminal.stop(id)).catch(() => {});
      xterm.dispose();
    };
    // Le message n'est lu qu'au démarrage du shell.
  }, [cwd]);

  return (
    <section className="window terminal-panel" style={{ flexBasis: height }}>
      <header className="panel-header">
        <span className="panel-title">Terminal</span>
      </header>
      <div className="terminal-host" ref={host} />
    </section>
  );
}
