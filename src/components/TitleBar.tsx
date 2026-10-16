import type { Menu } from "../lib/menu";
import { platform } from "../platform";

/** Barre de titre : même fond que l'app, sert à déplacer la fenêtre
 *  (double-clic pour agrandir). Selon l'OS, accueille le logo, les menus
 *  et les boutons de fenêtre. */
export function TitleBar({ menus }: { menus: Menu[] }) {
  const { WindowControls, MenuBar } = platform();
  return (
    <header className="titlebar" data-tauri-drag-region>
      {MenuBar && <MenuBar menus={menus} />}
      {WindowControls && <WindowControls />}
    </header>
  );
}
