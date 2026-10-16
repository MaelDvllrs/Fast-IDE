import { basename, isDirty, type OpenFile } from "../hooks/useOpenFiles";
import { FileIcon, UiIcon } from "./fileIcons";

interface Props {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

/** Onglets des fichiers ouverts : icône, nom, puis bouton de fermeture. */
export function TabBar({ files, activePath, onSelect, onClose }: Props) {
  return (
    <div className="tab-bar" role="tablist">
      {files.map((file) => {
        const active = file.path === activePath;
        const dirty = isDirty(file);
        const className = ["tab", active && "active", dirty && "dirty"].filter(Boolean).join(" ");
        return (
          <div
            key={file.path}
            className={className}
            role="tab"
            aria-selected={active}
            title={file.path}
            onClick={() => onSelect(file.path)}
            // Clic molette : ferme l'onglet.
            onAuxClick={(e) => e.button === 1 && onClose(file.path)}
          >
            <FileIcon name={basename(file.path)} fallback />
            <span className="tab-name">{basename(file.path)}</span>
            <button
              className="tab-close"
              aria-label={`Close ${basename(file.path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(file.path);
              }}
            >
              <UiIcon name="material-symbols:close-small-rounded" className="tab-close-icon" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
