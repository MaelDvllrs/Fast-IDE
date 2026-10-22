// Change le numéro de version de Fast partout où il apparaît (package.json,
// tauri.conf.json, Cargo.toml), avant de taguer une release.
//
// Usage : npm run version:set 0.2.0
//         git commit -am "Release 0.2.0"
//         git tag -a v0.2.0 -m "Fast 0.2.0"   (tag annoté : poussé par --follow-tags)
//         git push --follow-tags               (ou : git push origin v0.2.0)
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("Usage : npm run version:set <x.y.z>");
  process.exit(1);
}

const root = new URL("../", import.meta.url);
const edit = (path, change) => {
  const file = new URL(path, root);
  writeFileSync(file, change(readFileSync(file, "utf8")));
  console.log(`${path} → ${version}`);
};

const setJsonVersion = (text) => text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
edit("package.json", setJsonVersion);
edit("src-tauri/tauri.conf.json", setJsonVersion);
// Seulement la version du paquet (première ligne `version =` de [package]).
edit("src-tauri/Cargo.toml", (text) => text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));
