export const shortcut = (key: string) => `⌘${key}`;

// Les boutons natifs (feux tricolores) restent affichés grâce à titleBarStyle "Overlay".
export const WindowControls = null;

// macOS affiche les menus dans la barre de menus du système, pas dans la fenêtre.
export const MenuBar = null;

// Un PTY Unix : xterm gère seul le redimensionnement.
export const terminalOptions = () => ({});
