// Description des menus de l'application, indépendante de leur affichage :
// barre de menus dessinée par l'app sous Windows (platform/windows.tsx).

export type MenuEntry =
  | {
      label: string;
      /** Raccourci affiché à droite, ex. "Ctrl+S". */
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | "separator";

export interface Menu {
  label: string;
  items: MenuEntry[];
}
