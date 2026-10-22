import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityBar, type SidebarView } from "./components/ActivityBar";
import { AgentDetail } from "./components/AgentDetail";
import { Breadcrumb } from "./components/Breadcrumb";
import { ClaudePanel } from "./components/ClaudePanel";
import { PreferencesDialog, type PreferencesSection } from "./components/PreferencesDialog";
import { ResizeHandle } from "./components/ResizeHandle";
import { NotificationBell } from "./components/NotificationBell";
import { RunControl } from "./components/RunControl";
import { StartupUpdate, UpdateDialog } from "./components/Updates";
import { Editor } from "./components/Editor";
import { CloneDialog, PublishDialog } from "./components/GithubDialogs";
import { FastLogo } from "./components/FastLogo";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { TitleBar } from "./components/TitleBar";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { useOpenFiles } from "./hooks/useOpenFiles";
import { onOpenAgentSettings } from "./lib/agentRoster";
import { appWindow, workspace } from "./lib/ipc";
import type { Menu } from "./lib/menu";
import { platform } from "./platform";

// Largeurs des fenêtres redimensionnables (px). La fenêtre code prend le reste.
const EXPLORER_WIDTH = { default: 240, min: 170, max: 520 };
const CLAUDE_WIDTH = { default: 380, min: 280, max: 760 };
// Hauteur du terminal, sous la fenêtre code (px).
const TERMINAL_HEIGHT = { default: 240, min: 90, max: 700 };

export function App() {
  const [root, setRoot] = useState<string | null>(null);
  const tabs = useOpenFiles();
  const [error, setError] = useState<string | null>(null);
  // Au lancement (aucun dossier) : barre latérale fermée, terminal en grand.
  const [view, setView] = useState<SidebarView | null>(null);
  const [navExpanded, setNavExpanded] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_WIDTH.default);
  const [claudeWidth, setClaudeWidth] = useState(CLAUDE_WIDTH.default);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_HEIGHT.default);
  // Section affichée à l'ouverture des préférences, `null` = fermées.
  const [preferencesOpen, setPreferencesOpen] = useState<PreferencesSection | null>(null);
  const [githubDialog, setGithubDialog] = useState<"clone" | "publish" | null>(null);
  const closeGithubDialog = useCallback(() => setGithubDialog(null), []);
  // Mode agentic : Claude Code occupe tout l'espace de travail. Les autres
  // fenêtres sont seulement masquées, leur état (onglets, shell) est conservé.
  const [agentMode, setAgentMode] = useState(false);
  // Vue latérale ouverte avant le mode large, rouverte à sa sortie.
  const viewBeforeAgentMode = useRef<SidebarView | null>(null);
  // Agent affiché à la place du code et du terminal (panneau Agents), `null` sinon.
  // Le code et le terminal restent montés, seulement masqués.
  const [agentDetail, setAgentDetail] = useState<string | null>(null);
  const closeAgentDetail = useCallback(() => setAgentDetail(null), []);
  const closePreferences = useCallback(() => setPreferencesOpen(null), []);
  // Fenêtre « Check for updates… » (menu Settings).
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const closeUpdates = useCallback(() => setUpdatesOpen(false), []);

  // Ctrl+, (⌘, sur macOS) ouvre les préférences, comme dans la plupart des éditeurs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "," && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setPreferencesOpen("appearance");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Le mode large ferme le panneau latéral (on peut le rouvrir depuis la barre
  // d'activité) ; à la sortie, la vue d'avant revient.
  const toggleAgentMode = () => {
    if (agentMode) {
      setView(viewBeforeAgentMode.current);
    } else {
      viewBeforeAgentMode.current = view;
      setView(null);
    }
    setAgentMode(!agentMode);
  };

  // Bouton réglages d'un agent (mode Vibe) : sa fenêtre d'options s'ouvre à côté
  // des agents, sans quitter le mode.
  useEffect(() => onOpenAgentSettings(setAgentDetail), []);

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

  const openRoot = (path: string) => {
    setAgentDetail(null);
    setRoot(path);
    setView("explorer");
    tabs.closeAll();
  };

  const openFolder = () =>
    run(async () => {
      const picked = await workspace.pickFolder();
      if (picked) openRoot(picked);
    });

  const openClone = () => setGithubDialog("clone");

  const openFile = (path: string) => {
    setAgentDetail(null);
    return run(() => tabs.open(path));
  };
  const save = (path: string) => run(() => tabs.save(path));

  const active = tabs.activePath;
  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "Open Folder…", onSelect: openFolder },
        { label: "Clone Repository…", onSelect: openClone },
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
      label: "Settings",
      // Les options seront ajoutées ici au fur et à mesure.
      items: [
        { label: "Preferences…", shortcut: platform().shortcut(","), onSelect: () => setPreferencesOpen("appearance") },
        "separator",
        { label: "Check for updates…", onSelect: () => setUpdatesOpen(true) },
      ],
    },
  ];

  const activeFile = tabs.files.find((f) => f.path === tabs.activePath) ?? null;

  return (
    <>
      <TitleBar
        menus={menus}
        center={
          root && (
            // Mode IDE (code, terminal, agents à droite) ou mode Vibe (agents en grand).
            <div className="mode-switch" role="radiogroup" aria-label="Mode">
              <button role="radio" aria-checked={!agentMode} className="mode-option" onClick={() => agentMode && toggleAgentMode()}>
                IDE
              </button>
              <button role="radio" aria-checked={agentMode} className="mode-option" onClick={() => !agentMode && toggleAgentMode()}>
                Vibe
              </button>
            </div>
          )
        }
        actions={
          root && (
            <>
              <NotificationBell />
              <RunControl root={root} onConfigure={() => setPreferencesOpen("project")} />
            </>
          )
        }
      />
      <div className={agentMode && root ? "layout agent-mode" : "layout"}>
        <ActivityBar
          active={view}
          onSelect={selectView}
          expanded={navExpanded}
          onToggleExpanded={() => setNavExpanded((e) => !e)}
          onOpenAccounts={() => setPreferencesOpen("accounts")}
        />
        {view && (
          <Sidebar
            view={view}
            root={root}
            activePath={tabs.activePath}
            onOpenFile={openFile}
            onOpenFolder={openFolder}
            onClone={openClone}
            onPublish={() => setGithubDialog("publish")}
            onOpenAgent={setAgentDetail}
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

        <div className={agentDetail && root ? "center-column showing-agent" : "center-column"}>
          {agentDetail && root && <AgentDetail agentId={agentDetail} onClose={closeAgentDetail} />}
          {/* Sans dossier ouvert : écran d'accueil à la place du code et du terminal. */}
          {!root && <WelcomeScreen onOpenFolder={openFolder} onClone={openClone} />}
          {root && (
            <>
              <main className="window main">
                <TabBar files={tabs.files} activePath={tabs.activePath} onSelect={tabs.setActivePath} onClose={tabs.close} />
                {root && activeFile && <Breadcrumb root={root} path={activeFile.path} />}
                {error && <div className="error-bar">{error}</div>}
                <div className="editor-stack">
                  {/* Aucun fichier ouvert : le logo plutôt qu'une page vide */}
                  {tabs.files.length === 0 && (
                    <div className="editor-empty">
                      <FastLogo className="small" />
                    </div>
                  )}
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
            </>
          )}
          {root && <TerminalPanel key={root} cwd={root} height={terminalHeight} />}
        </div>

        {root && (
          <>
            {!agentMode && (
              <ResizeHandle
                label="Resize Claude Code"
                value={claudeWidth}
                onChange={setClaudeWidth}
                min={CLAUDE_WIDTH.min}
                max={CLAUDE_WIDTH.max}
                defaultValue={CLAUDE_WIDTH.default}
                direction={-1}
              />
            )}
            <ClaudePanel
              key={root}
              cwd={root}
              activeFile={tabs.activePath}
              width={claudeWidth}
              expanded={agentMode}
            />
          </>
        )}
      </div>
      {updatesOpen && <UpdateDialog onClose={closeUpdates} />}
      {/* Au lancement : mise à jour automatique si une nouvelle version est publiée */}
      <StartupUpdate />
      {preferencesOpen && <PreferencesDialog onClose={closePreferences} root={root} initialSection={preferencesOpen} />}
      {githubDialog === "clone" && (
        <CloneDialog
          onClose={closeGithubDialog}
          onCloned={(path) => {
            setGithubDialog(null);
            openRoot(path);
          }}
        />
      )}
      {githubDialog === "publish" && root && (
        <PublishDialog root={root} onClose={closeGithubDialog} onPublished={() => setGithubDialog(null)} />
      )}
    </>
  );
}
