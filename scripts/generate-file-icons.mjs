// Extrait du jeu « logos » (gilbarbara/logos, CC0, via @iconify-json/logos)
// uniquement les icônes référencées dans src/components/fileIcons/mapping.json,
// pour ne pas embarquer les ~2 000 icônes du jeu dans l'application.
//
// Usage : npm run icons   (après avoir modifié mapping.json)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const dir = new URL("../src/components/fileIcons/", import.meta.url);
const mapping = JSON.parse(readFileSync(new URL("mapping.json", dir), "utf8"));
const require = createRequire(import.meta.url);
const sets = {};
/** Charge un jeu Iconify installé via @iconify-json/<jeu>, ou le jeu « fast »
 *  (icônes propres à FAST, ex. la mascotte) de fileIcons/fast-icons.json. */
const loadSet = (prefix) =>
  (sets[prefix] ??= JSON.parse(
    readFileSync(
      prefix === "fast" ? new URL("fast-icons.json", dir) : require.resolve(`@iconify-json/${prefix}/icons.json`),
      "utf8",
    ),
  ));

const names = [
  ...new Set([
    ...Object.values(mapping.configFiles),
    ...Object.values(mapping.configPrefixes),
    ...Object.values(mapping.extensions),
    // Icônes d'interface (dossiers, flèches) : "jeu:icône".
    ...mapping.uiIcons,
  ]),
].sort();

const isDark = (hex) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.15;
};

/** Un logo d'une seule couleur sombre (ex. Rust, noir) serait invisible sur
 *  fond sombre : il reçoit sa couleur de marque depuis mapping.brandColors. */
function applyBrandColor(name, body) {
  const colors = [...new Set([...body.matchAll(/fill="(#[0-9a-f]{3,6})"/gi)].map((m) => m[1]))];
  const noFill = colors.length === 0 && !/fill=/.test(body);
  const monoDark = noFill || (colors.length === 1 && isDark(colors[0]));
  if (!monoDark) return body;

  const brand = mapping.brandColors[name];
  if (!brand) missingColors.push(name);
  if (noFill) return `<g fill="${brand}">${body}</g>`;
  return body.replaceAll(`fill="${colors[0]}"`, `fill="${brand}"`);
}

const missingColors = [];
const entries = names.map((name) => {
  // Sans préfixe, l'icône vient du jeu logos.
  const [prefix, iconName] = name.includes(":") ? name.split(":") : ["logos", name];
  const set = loadSet(prefix);
  const icon = set.icons[iconName] ?? set.icons[set.aliases?.[iconName]?.parent];
  if (!icon) throw new Error(`Icône introuvable dans le jeu ${prefix} : ${iconName}`);
  const viewBox = [icon.left ?? 0, icon.top ?? 0, icon.width ?? set.width, icon.height ?? set.height].join(" ");
  let body = applyBrandColor(name, icon.body);
  // Épaisseur de trait imposée pour ce jeu (mapping.strokeWidths).
  const stroke = mapping.strokeWidths?.[prefix];
  if (stroke) body = body.replace(/stroke-width="[^"]*"/g, `stroke-width="${stroke}"`);
  return `  ${JSON.stringify(name)}: { viewBox: ${JSON.stringify(viewBox)}, body: ${JSON.stringify(body)} },`;
});

if (missingColors.length) {
  throw new Error(
    `Logos monochromes sombres sans couleur de marque (à ajouter dans mapping.json > brandColors) : ${missingColors.join(", ")}`,
  );
}

const output = `// Fichier généré par scripts/generate-file-icons.mjs : ne pas modifier à la main.
// Icônes : gilbarbara/logos (CC0 1.0).

export const LOGOS: Record<string, { viewBox: string; body: string }> = {
${entries.join("\n")}
};
`;

writeFileSync(new URL("logos.generated.ts", dir), output);
console.log(`${names.length} icônes écrites dans src/components/fileIcons/logos.generated.ts`);
