// Source vectorielle de l'icône de l'app : nette à toutes les échelles d'affichage.
import appIcon from "../assets/app-icon.svg";
import { MenuBar as Menus } from "../components/MenuBar";
import { appWindow } from "../lib/ipc";
import type { ITerminalOptions } from "@xterm/xterm";
import type { Menu } from "../lib/menu";
import type { PlatformInfo } from "../lib/ipc";

export const shortcut = (key: string) => `Ctrl+${key}`;

/** Le shell tourne sous ConPTY, qui redessine l'écran quand on redimensionne.
 *  xterm doit le savoir (et connaître le build de Windows) pour ne pas perdre
 *  de lignes de l'historique. */
export const terminalOptions = (info: PlatformInfo): ITerminalOptions => ({
  windowsPty: { backend: "conpty", buildNumber: info.windowsBuild ?? undefined },
});

/** Sous Windows la fenêtre n'a pas de décorations natives (decorations: false) :
 *  l'app dessine ses propres boutons, à la manière de Windows 11. */
export function WindowControls() {
  return (
    <div className="window-controls">
      <button aria-label="Minimize" onClick={() => appWindow.minimize()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button aria-label="Maximize" onClick={() => appWindow.toggleMaximize()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
        </svg>
      </button>
      <button className="close" aria-label="Close" onClick={() => appWindow.close()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" />
        </svg>
      </button>
    </div>
  );
}

/** Pas de barre de menus native avec decorations: false : logo de l'app puis menus. */
export function MenuBar({ menus }: { menus: Menu[] }) {
  return (
    <div className="app-menubar">
      <img className="app-logo" src={appIcon} alt="" draggable={false} />
      <Menus menus={menus} />
    </div>
  );
}
