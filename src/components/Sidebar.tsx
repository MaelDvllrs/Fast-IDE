import { useState } from "react";
import type { SidebarView } from "./ActivityBar";
import { AgentList } from "./AgentList";
import { AgentsPanel } from "./AgentsPanel";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { UiIcon } from "./fileIcons";

interface Props {
  view: SidebarView;
  /** Dossier ouvert, ou `null` si aucun. */
  root: string | null;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onClone: () => void;
  onPublish: () => void;
  /** Ouvre la fenêtre d'un agent à la place du code. */
  onOpenAgent: (agentId: string) => void;
  /** Largeur en px, réglée par la poignée de redimensionnement. */
  width: number;
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Panneau latéral : son contenu dépend de la vue choisie dans l'ActivityBar. */
export function Sidebar(props: Props) {
  // Rafraîchissement de l'explorateur, gardé ici : il survit au changement de vue.
  const [treeRefresh, setTreeRefresh] = useState(0);
  return <SidebarContent {...props} treeRefresh={treeRefresh} onRefreshTree={() => setTreeRefresh((n) => n + 1)} />;
}

function SidebarContent({
  treeRefresh,
  onRefreshTree, view, root, activePath, onOpenFile, onOpenFolder, onClone, onPublish, onOpenAgent, width }: Props & { treeRefresh: number; onRefreshTree: () => void }) {
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
            {/* Explorateur vide : bouton fin, pleine largeur */}
            <div className="sidebar-empty">
              <button className="thin-button" onClick={onOpenFolder}>
                Open Folder
              </button>
              <button className="thin-button" onClick={onClone}>
                Clone Repository
              </button>
            </div>
          </aside>
        );
      }
      return (
        <aside className="window sidebar" style={style}>
          <header className="panel-header" title={root}>
            <span className="panel-title">{basename(root)}</span>
            <button className="icon-button" title="Refresh" aria-label="Refresh explorer" onClick={onRefreshTree}>
              <UiIcon name="lucide:refresh-cw" className="icon-button-icon small" />
            </button>
            <button className="icon-button next" title="Open another folder" onClick={onOpenFolder}>
              <UiIcon name="lucide:folder-open" className="icon-button-icon" />
            </button>
          </header>
          <FileTree root={root} activePath={activePath} onOpen={onOpenFile} refreshKey={treeRefresh} />
        </aside>
      );
    case "search":
      return (
        <aside className="window sidebar" style={style}>
          <header className="panel-header"><span className="panel-title">Search</span></header>
          <p className="sidebar-placeholder">Project search is coming soon.</p>
        </aside>
      );
    case "ai":
      return (
        <aside className="window sidebar" style={style}>
          <AgentsPanel />
        </aside>
      );
    case "agents":
      return (
        <aside className="window sidebar" style={style}>
          <AgentList onOpen={onOpenAgent} />
        </aside>
      );
    case "git":
      return (
        <aside className="window sidebar" style={style}>
          {root ? (
            <GitPanel key={root} root={root} onOpenFile={onOpenFile} onPublish={onPublish} />
          ) : (
            <>
              <header className="panel-header"><span className="panel-title">Git</span></header>
              <div className="sidebar-empty">
                <button className="thin-button" onClick={onOpenFolder}>
                  Open Folder
                </button>
                <button className="thin-button" onClick={onClone}>
                  Clone Repository
                </button>
              </div>
            </>
          )}
        </aside>
      );
  }
}
