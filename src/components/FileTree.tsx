import { useEffect, useState } from "react";
import { fs, type DirEntry } from "../lib/ipc";
import { FileIcon, UiIcon } from "./fileIcons";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
}

type NodeProps = Omit<Props, "root"> & { depth: number };

export function FileTree({ root, activePath, onOpen }: Props) {
  return (
    <nav className="file-tree">
      <Directory path={root} depth={0} activePath={activePath} onOpen={onOpen} />
    </nav>
  );
}

function Directory({ path, depth, activePath, onOpen }: NodeProps & { path: string }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fs.readDir(path).then(setEntries, (e) => setError(String(e)));
  }, [path]);

  if (error) return <div className="tree-error">{error}</div>;
  if (!entries) return null;

  return (
    <ul>
      {entries.map((entry) => (
        <Entry key={entry.path} entry={entry} depth={depth} activePath={activePath} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function Entry({ entry, depth, activePath, onOpen }: NodeProps & { entry: DirEntry }) {
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: `calc(var(--tree-indent-base) + ${depth} * var(--tree-indent-step))` };

  if (!entry.isDir) {
    return (
      <li>
        <button
          className={entry.path === activePath ? "tree-item active" : "tree-item"}
          style={indent}
          onClick={() => onOpen(entry.path)}
        >
          {/* Réserve la place de la flèche pour aligner fichiers et dossiers */}
          <span className="tree-arrow" aria-hidden="true" />
          <FileIcon name={entry.name} />
          {entry.name}
        </button>
      </li>
    );
  }

  return (
    <li>
      <button className="tree-item dir" style={indent} aria-expanded={open} onClick={() => setOpen(!open)}>
        <UiIcon name="material-symbols:arrow-forward-ios-rounded" className={open ? "tree-arrow open" : "tree-arrow"} />
        <UiIcon
          name={open ? "material-symbols:folder-open-outline-rounded" : "material-symbols:folder-outline-rounded"}
          className="file-icon folder-icon"
        />
        {entry.name}
      </button>
      {open && <Directory path={entry.path} depth={depth + 1} activePath={activePath} onOpen={onOpen} />}
    </li>
  );
}
