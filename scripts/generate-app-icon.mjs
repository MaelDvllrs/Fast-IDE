// Génère toutes les icônes de l'app (fenêtre, barre des tâches, installeurs)
// dans src-tauri/icons/ à partir d'une seule source : src/assets/app-icon.svg
// (prioritaire) ou src/assets/app-icon.png (carré, 1024×1024 conseillé).
//
// Usage : npm run app-icon
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const candidates = ["src/assets/app-icon.svg", "src/assets/app-icon.png"];
const source = candidates.find((file) => existsSync(join(root, file)));

if (!source) {
  console.error(`Aucune source d'icône : ajoute ${candidates.join(" ou ")}.`);
  process.exit(1);
}

/** `tauri icon` exige une image carrée : un SVG rectangulaire est centré dans
 *  un carré (on agrandit son viewBox), sans être déformé. */
function squareSvg(file) {
  const svg = readFileSync(file, "utf8");
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4) return file;

  const [x, y, w, h] = viewBox;
  if (w === h) return file;

  const size = Math.max(w, h);
  const squared = svg
    .replace(/viewBox="[^"]+"/, `viewBox="${x - (size - w) / 2} ${y - (size - h) / 2} ${size} ${size}"`)
    .replace(/(<svg[^>]*?)\swidth="[^"]*"/, `$1 width="${size}"`)
    .replace(/(<svg[^>]*?)\sheight="[^"]*"/, `$1 height="${size}"`);

  const out = join(mkdtempSync(join(tmpdir(), "vibe-ide-icon-")), "app-icon.svg");
  writeFileSync(out, squared);
  console.log(`SVG ${w}×${h} non carré : centré dans un carré de ${size}×${size}.`);
  return out;
}

const input = source.endsWith(".svg") ? squareSvg(join(root, source)) : join(root, source);

console.log(`Génération des icônes depuis ${source}…`);
// `input` est un chemin construit par ce script : seuls les guillemets suffisent.
execSync(`npx tauri icon "${input}"`, { cwd: root, stdio: "inherit" });

// L'app ne cible que Windows et macOS : on retire les variantes mobiles.
for (const dir of ["android", "ios"]) {
  rmSync(join(root, "src-tauri", "icons", dir), { recursive: true, force: true });
}
console.log("Icônes à jour dans src-tauri/icons/.");
