import type { ReactNode } from "react";
import type { Menu } from "../lib/menu";
import { platform } from "../platform";

/** Barre de titre : même fond que l'app, sert à déplacer la fenêtre
 *  (double-clic pour agrandir). Selon l'OS, accueille le logo, les menus
 *  et les boutons de fenêtre ; `center` (choix du mode) au milieu, `actions`
 *  (bouton Run) à droite. */
export function TitleBar({ menus, center, actions }: { menus: Menu[]; center?: ReactNode; actions?: ReactNode }) {
  const { WindowControls, MenuBar } = platform();
  return (
    <header className="titlebar" data-tauri-drag-region>
      {MenuBar && <MenuBar menus={menus} />}
      {center && <div className="titlebar-center">{center}</div>}
      {actions && <div className="titlebar-actions">{actions}</div>}
      {WindowControls && <WindowControls />}
    </header>
  );
}
