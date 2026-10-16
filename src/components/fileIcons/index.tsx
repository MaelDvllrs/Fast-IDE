import { LOGOS } from "./logos.generated";
import mapping from "./mapping.json";

const configFiles: Record<string, string> = mapping.configFiles;
const extensions: Record<string, string> = mapping.extensions;
// Préfixes les plus longs d'abord : "vitest.config." passe avant un éventuel "vite".
const configPrefixes = Object.entries(mapping.configPrefixes).sort(([a], [b]) => b.length - a.length);

/** Fichier de config -> logo de la techno ; sinon logo du langage selon l'extension. */
function logoFor(fileName: string): string | null {
  const name = fileName.toLowerCase();
  if (configFiles[name]) return configFiles[name];
  const prefix = configPrefixes.find(([p]) => name.startsWith(p));
  if (prefix) return prefix[1];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (extensions[name.slice(dot + 1)] ?? null) : null;
}

function GeneratedIcon({ name, className }: { name: string | null; className: string }) {
  const icon = name ? LOGOS[name] : undefined;
  if (!icon) return <span className={className} aria-hidden="true" />;
  return (
    <svg
      className={className}
      viewBox={icon.viewBox}
      aria-hidden="true"
      // Données statiques issues des jeux d'icônes, générées par scripts/generate-file-icons.mjs.
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

/** Icône d'un fichier. Sans correspondance : icône générique si `fallback`,
 *  sinon un espace vide qui garde l'alignement. */
export function FileIcon({ name, fallback = false }: { name: string; fallback?: boolean }) {
  const logo = logoFor(name);
  if (!logo && fallback) return <GeneratedIcon name="material-symbols:draft-outline-rounded" className="file-icon generic-file-icon" />;
  return <GeneratedIcon name={logo} className="file-icon" />;
}

/** Icône d'interface déclarée dans mapping.uiIcons ; sa couleur suit `color` en CSS. */
export function UiIcon({ name, className }: { name: (typeof mapping.uiIcons)[number]; className: string }) {
  return <GeneratedIcon name={name} className={className} />;
}
