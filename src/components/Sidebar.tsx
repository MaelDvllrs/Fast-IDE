import type { SidebarView } from "./ActivityBar";
import { FileTree } from "./FileTree";
import { UiIcon } from "./fileIcons";

interface Props {
  view: SidebarView;
  /** Dossier ouvert, ou `null` si aucun. */
  root: string | null;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  /** Largeur en px, réglée par la poignée de redimensionnement. */
  width: number;
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Panneau latéral : son contenu dépend de la vue choisie dans l'ActivityBar. */
export function Sidebar({ view, root, activePath, onOpenFile, onOpenFolder, width }: Props) {
  const style = { flexBasis: width };
  switch (view) {
    case "explorer":
      if (!root) {
        return (
          <aside className="window sidebar" style={style}>
            <header className="panel-header">
              <span className="panel-title">Explorer</span>
              <button className="title-icon-button end" title="Open Folder" aria-label="Open Folder" onClick={onOpenFolder}>
                <UiIcon name="lucide:folder-plus" className="title-icon" />
              </button>
            </header>
          </aside>
        );
      }
      return (
        <aside className="window sidebar" style={style}>
          <header className="panel-header" title={root}>
            <span className="panel-title">{basename(root)}</span>
            <button className="icon-button" title="Open another folder" onClick={onOpenFolder}>
              <UiIcon name="lucide:folder-open" className="icon-button-icon" />
            </button>
          </header>
          <FileTree root={root} activePath={activePath} onOpen={onOpenFile} />
        </aside>
      );
    case "search":
      return (
        <aside className="window sidebar" style={style}>
          <header className="panel-header"><span className="panel-title">Search</span></header>
          <p className="sidebar-placeholder">Project search is coming soon.</p>
        </aside>
      );
    case "git":
      return (
        <aside className="window sidebar" style={style}>
          <header className="panel-header"><span className="panel-title">Git</span></header>
          <p className="sidebar-placeholder">Git integration is coming soon.</p>
        </aside>
      );
  }
}
