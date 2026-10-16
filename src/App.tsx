import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityBar, type SidebarView } from "./components/ActivityBar";
import { Breadcrumb } from "./components/Breadcrumb";
import { ClaudePanel } from "./components/ClaudePanel";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { ResizeHandle } from "./components/ResizeHandle";
import { Editor } from "./components/Editor";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TitleBar } from "./components/TitleBar";
import { useOpenFiles } from "./hooks/useOpenFiles";
import { welcomeBanner } from "./lib/banner";
import { appWindow, workspace } from "./lib/ipc";
import type { Menu } from "./lib/menu";
import { platform } from "./platform";
import { currentPrimaryColor } from "./theme";

// Largeurs des fenêtres redimensionnables (px). La fenêtre code prend le reste.
const EXPLORER_WIDTH = { default: 240, min: 170, max: 520 };
const CLAUDE_WIDTH = { default: 380, min: 280, max: 760 };
// Hauteur du terminal, sous la fenêtre code (px).
const TERMINAL_HEIGHT = { default: 300, min: 90, max: 700 };

export function App() {
  const [root, setRoot] = useState<string | null>(null);
  const tabs = useOpenFiles();
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SidebarView | null>("explorer");
  const [navExpanded, setNavExpanded] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_WIDTH.default);
  const [claudeWidth, setClaudeWidth] = useState(CLAUDE_WIDTH.default);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_HEIGHT.default);
  const banner = useMemo(() => welcomeBanner(currentPrimaryColor()), []);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Mode agentic : Claude Code occupe tout l'espace de travail. Les autres
  // fenêtres sont seulement masquées, leur état (onglets, shell) est conservé.
  const [agentMode, setAgentMode] = useState(false);
  const closePreferences = useCallback(() => setPreferencesOpen(false), []);

  // Ctrl+, (⌘, sur macOS) ouvre les préférences, comme dans la plupart des éditeurs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "," && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPreferencesOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Recliquer sur la vue active replie le panneau latéral.
  const selectView = (next: SidebarView) => setView((current) => (current === next ? null : next));

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const openFolder = () =>
    run(async () => {
      const picked = await workspace.pickFolder();
      if (picked) {
        setRoot(picked);
        tabs.closeAll();
      }
    });

  const openFile = (path: string) => run(() => tabs.open(path));
  const save = (path: string) => run(() => tabs.save(path));

  const active = tabs.activePath;
  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "Open Folder…", onSelect: openFolder },
        "separator",
        {
          label: "Save",
          shortcut: platform().shortcut("S"),
          disabled: !active,
          onSelect: () => active && save(active),
        },
        { label: "Close Tab", disabled: !active, onSelect: () => active && tabs.close(active) },
        "separator",
        { label: "Exit", onSelect: () => appWindow.close() },
      ],
    },
    {
      label: "Options",
      // Les options seront ajoutées ici au fur et à mesure.
      items: [
        { label: "Preferences…", shortcut: platform().shortcut(","), onSelect: () => setPreferencesOpen(true) },
      ],
    },
  ];

  const activeFile = tabs.files.find((f) => f.path === tabs.activePath) ?? null;

  return (
    <>
      <TitleBar menus={menus} />
      <div className={agentMode && root ? "layout agent-mode" : "layout"}>
        <ActivityBar
          active={view}
          onSelect={selectView}
          expanded={navExpanded}
          onToggleExpanded={() => setNavExpanded((e) => !e)}
        />
        {view && (
          <Sidebar
            view={view}
            root={root}
            activePath={tabs.activePath}
            onOpenFile={openFile}
            onOpenFolder={openFolder}
            width={explorerWidth}
          />
        )}
        {view && (
          <ResizeHandle
            label="Resize explorer"
            value={explorerWidth}
            onChange={setExplorerWidth}
            min={EXPLORER_WIDTH.min}
            max={EXPLORER_WIDTH.max}
            defaultValue={EXPLORER_WIDTH.default}
            direction={1}
          />
        )}

        <div className="center-column">
          <main className="window main">
            <TabBar files={tabs.files} activePath={tabs.activePath} onSelect={tabs.setActivePath} onClose={tabs.close} />
            {root && activeFile && <Breadcrumb root={root} path={activeFile.path} />}
            {error && <div className="error-bar">{error}</div>}
            <div className="editor-stack">
              {tabs.files.map((file) => (
                <Editor
                  key={file.path}
                  path={file.path}
                  active={file.path === tabs.activePath}
                  initialContent={file.savedContent}
                  onChange={(content) => tabs.update(file.path, content)}
                  onSave={() => save(file.path)}
                />
              ))}
            </div>
            {activeFile && <StatusBar file={activeFile} />}
          </main>
          <ResizeHandle
            orientation="horizontal"
            label="Resize terminal"
            value={terminalHeight}
            onChange={setTerminalHeight}
            min={TERMINAL_HEIGHT.min}
            max={TERMINAL_HEIGHT.max}
            defaultValue={TERMINAL_HEIGHT.default}
            direction={-1}
          />
          {/* Sans dossier : dossier personnel et message d'accueil. Ouvrir un dossier relance le shell dedans. */}
          <TerminalPanel key={root ?? "home"} cwd={root} banner={root ? undefined : banner} height={terminalHeight} />
        </div>

        <ResizeHandle
          label="Resize Claude Code"
          value={claudeWidth}
          onChange={setClaudeWidth}
          min={CLAUDE_WIDTH.min}
          max={CLAUDE_WIDTH.max}
          defaultValue={CLAUDE_WIDTH.default}
          direction={-1}
        />
        {root ? (
          <ClaudePanel
            key={root}
            cwd={root}
            activeFile={tabs.activePath}
            width={claudeWidth}
            expanded={agentMode}
            onToggleExpanded={() => setAgentMode((on) => !on)}
          />
        ) : (
          <aside className="window claude-panel" style={{ flexBasis: claudeWidth }}>
            <header className="panel-header">
              <span className="panel-title">Claude Code</span>
            </header>
            <p className="panel-placeholder">Open a folder to start Claude Code.</p>
          </aside>
        )}
      </div>
      {preferencesOpen && <PreferencesDialog onClose={closePreferences} root={root} />}
    </>
  );
}
