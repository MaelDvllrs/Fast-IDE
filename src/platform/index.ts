// Différences d'interface entre OS. Le code commun importe uniquement ce
// fichier ; les détails vivent dans windows.tsx / macos.ts.
import type { ComponentType } from "react";
import type { ITerminalOptions } from "@xterm/xterm";
import { system, type Os, type PlatformInfo } from "../lib/ipc";
import type { Menu } from "../lib/menu";
import * as macos from "./macos";
import * as windows from "./windows";

export interface PlatformUi {
  /** Libellé d'un raccourci, ex. shortcut("S") -> "⌘S" ou "Ctrl+S". */
  shortcut: (key: string) => string;
  /** Boutons réduire / agrandir / fermer dessinés par l'app, ou `null` si l'OS garde les siens. */
  WindowControls: ComponentType | null;
  /** Logo + menus dans la barre de titre, ou `null` si l'OS a sa propre barre de menus. */
  MenuBar: ComponentType<{ menus: Menu[] }> | null;
  /** Options xterm propres au pseudo-terminal de l'OS. */
  terminalOptions: (info: PlatformInfo) => ITerminalOptions;
}

const impls: Record<Os, PlatformUi> = { windows, macos };

let info: PlatformInfo = { os: "windows", pathSeparator: "\\", windowsBuild: null };

export async function applyPlatformClass(): Promise<void> {
  info = await system.info();
  document.documentElement.dataset.os = info.os;
}

export function platform(): PlatformUi {
  return impls[info.os];
}

/** Informations sur l'OS, lues au démarrage. */
export function platformInfo(): PlatformInfo {
  return info;
}
