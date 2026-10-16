import { basename } from "../hooks/useOpenFiles";
import { UiIcon } from "./fileIcons";

interface Props {
  root: string;
  path: string;
}

/** Chemin du fichier actif depuis la racine du projet : projet › dossier › fichier. */
export function Breadcrumb({ root, path }: Props) {
  const relative = path.startsWith(root) ? path.slice(root.length) : path;
  const segments = [basename(root), ...relative.split(/[\\/]/).filter(Boolean)];

  return (
    <nav className="breadcrumb" aria-label="File path">
      {segments.map((segment, i) => (
        <span key={i} className={i === segments.length - 1 ? "crumb current" : "crumb"}>
          {i > 0 && <UiIcon name="material-symbols:chevron-right-rounded" className="crumb-separator" />}
          {segment}
        </span>
      ))}
    </nav>
  );
}
