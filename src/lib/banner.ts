// Message d'accueil affiché dans le terminal au lancement de l'app.

const LOGO = [
  " ________ ________  ________  _________   ",
  "|\\  _____\\\\   __  \\|\\   ____\\|\\___   ___\\ ",
  "\\ \\  \\__/\\ \\  \\|\\  \\ \\  \\___|\\|___ \\  \\_| ",
  " \\ \\   __\\\\ \\   __  \\ \\_____  \\   \\ \\  \\  ",
  "  \\ \\  \\_| \\ \\  \\ \\  \\|____|\\  \\   \\ \\  \\ ",
  "   \\ \\__\\   \\ \\__\\ \\__\\____\\_\\  \\   \\ \\__\\",
  "    \\|__|    \\|__|\\|__|\\_________\\   \\|__|",
  "                      \\|_________|",
];

/** Couleur ANSI 24 bits d'un #rrggbb. */
const fg = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m`;
};
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Logo « FAST » dans la couleur primaire, puis « Welcome to FAST ». */
export function welcomeBanner(primaryHex: string): string {
  const logo = LOGO.map((line) => fg(primaryHex) + line + RESET);
  const title = `${fg("#ffffff")}Welcome to ${fg(primaryHex)}${BOLD}FAST${RESET}`;
  return ["", ...logo, "", `  ${title}`, ""].join("\n");
}
