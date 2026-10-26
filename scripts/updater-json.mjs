// Construit latest.json (description de la version lue par FAST pour se mettre
// à jour) à partir des fichiers d'une release GitHub et de leurs signatures.
//
//   node scripts/updater-json.mjs v0.2.2 latest.json
//
// Lancé par le workflow de release une fois tous les builds terminés : chaque
// build écrivant son propre latest.json, des builds en parallèle s'écrasaient
// (il ne restait qu'une plateforme). Ici, un seul fichier, complet.
// GITHUB_TOKEN (facultatif pour un dépôt public) et GITHUB_REPOSITORY sont lus
// dans l'environnement.
import { writeFileSync } from "node:fs";

const [tag, out = "latest.json"] = process.argv.slice(2);
if (!tag) {
  console.error("Usage: node scripts/updater-json.mjs <tag> [output]");
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY ?? "MaelDvllrs/Fast-IDE";
const headers = { Accept: "application/vnd.github+json", "User-Agent": "fast-release" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
if (!response.ok) throw new Error(`release ${tag}: ${response.status} ${await response.text()}`);
const release = await response.json();
const assets = new Map(release.assets.map((a) => [a.name, a]));

// Fichier de mise à jour → clés de plateforme du plugin updater de Tauri.
// `windows-x86_64` pointe sur l'installeur NSIS : c'est celui que FAST installe.
const PLATFORMS = [
  { match: (n) => n.endsWith("-setup.exe"), keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { match: (n) => n.endsWith(".msi"), keys: ["windows-x86_64-msi"] },
  { match: (n) => n.endsWith("aarch64.app.tar.gz"), keys: ["darwin-aarch64-app", "darwin-aarch64"] },
  { match: (n) => n.endsWith("x64.app.tar.gz"), keys: ["darwin-x86_64-app", "darwin-x86_64"] },
];

const platforms = {};
for (const { match, keys } of PLATFORMS) {
  const asset = release.assets.find((a) => match(a.name));
  const sig = asset && assets.get(`${asset.name}.sig`);
  if (!asset || !sig) {
    console.warn(`missing for ${keys[0]}: ${asset ? `${asset.name}.sig` : "update file"}`);
    continue;
  }
  const signature = (await (await fetch(sig.browser_download_url, { headers: { "User-Agent": "fast-release" } })).text()).trim();
  for (const key of keys) platforms[key] = { signature, url: asset.browser_download_url };
}

const missing = ["windows-x86_64-nsis", "darwin-aarch64", "darwin-x86_64"].filter((k) => !platforms[k]);
if (missing.length) {
  console.error(`latest.json would be incomplete (missing ${missing.join(", ")}): not written.`);
  process.exit(1);
}

const latest = {
  version: tag.replace(/^v/, ""),
  notes: release.body ?? "",
  pub_date: release.published_at ?? new Date().toISOString(),
  platforms,
};
writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`${out}: ${latest.version}, ${Object.keys(platforms).join(", ")}`);
