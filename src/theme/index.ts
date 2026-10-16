// Thèmes de l'interface. Chaque thème est un fichier themes/<id>.css qui
// définit toutes les couleurs sous [data-theme="<id>"] ; en ajouter un =
// créer ce fichier, l'importer ci-dessous et le déclarer dans THEMES.
import "./base.css";
import "./themes/dark.css";
import "./themes/shades-of-purple.css";

export interface Theme {
  id: string;
  label: string;
  /** Aperçu affiché dans les préférences : fond, fenêtre, code, couleur primaire. */
  preview: { app: string; window: string; editor: string; primary: string };
}

export const THEMES: Theme[] = [
  {
    id: "dark",
    label: "Dark",
    preview: { app: "#000000", window: "#000000", editor: "#070707", primary: "#b3a42b" },
  },
  {
    id: "shades-of-purple",
    label: "Shades of Purple",
    preview: { app: "#0f0f22", window: "#131327", editor: "#191830", primary: "#fad000" },
  },
];

/** Événement envoyé à chaque changement de thème : pour ce qui n'est pas en CSS (terminal). */
export const THEME_CHANGE_EVENT = "fast:themechange";

export const DEFAULT_THEME = THEMES[0].id;

/** Applique un thème ; un identifiant inconnu retombe sur le thème par défaut. */
export function applyTheme(id: string | null | undefined): string {
  const theme = THEMES.find((t) => t.id === id)?.id ?? DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  return theme;
}

export function currentTheme(): string {
  return document.documentElement.dataset.theme ?? DEFAULT_THEME;
}

/** Couleur primaire du thème actif (#rrggbb), pour ce qui n'est pas en CSS (terminal). */
export function currentPrimaryColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
}
