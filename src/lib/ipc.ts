// Unique point de contact avec le cœur Rust. Aucune logique système ici :
// chaque fonction est un appel typé vers une commande Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Os = "windows" | "macos";

export interface PlatformInfo {
  os: Os;
  pathSeparator: string;
  /** Numéro de build de Windows, `null` sur les autres OS. */
  windowsBuild: number | null;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type ClaudeEventKind =
  | { type: "message"; data: ClaudeMessage }
  | { type: "raw"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; data: number | null };

export interface ClaudeEvent {
  sessionId: string;
  event: ClaudeEventKind;
}

/** Ligne JSON émise par `claude --output-format stream-json`. */
export interface ClaudeMessage {
  type: "system" | "assistant" | "user" | "result" | string;
  [key: string]: unknown;
}

export const system = {
  info: () => invoke<PlatformInfo>("platform_info"),
};

/** Contrôles de la fenêtre native (utilisés quand l'OS n'affiche pas les siens). */
export const appWindow = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
};

/** Préférences enregistrées côté Rust (settings.json). */
export interface Settings {
  /** Identifiant du thème (ex. "dark"), `null` pour le thème par défaut. */
  theme: string | null;
}

export const settings = {
  load: () => invoke<Settings>("settings_load"),
  save: (value: Settings) => invoke<void>("settings_save", { settings: value }),
};

export const workspace = {
  pickFolder: () => invoke<string | null>("workspace_pick_folder"),
  /** Sélection de plusieurs fichiers, en partant de `startDir` si fourni. */
  pickFiles: (startDir?: string) => invoke<string[]>("workspace_pick_files", { startDir }),
};

export const fs = {
  readDir: (path: string) => invoke<DirEntry[]>("fs_read_dir", { path }),
  readFile: (path: string) => invoke<string>("fs_read_file", { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("fs_write_file", { path, contents }),
};

export type TerminalEventKind = { type: "output"; data: string } | { type: "exit"; data: number | null };

export interface TerminalEvent {
  sessionId: string;
  event: TerminalEventKind;
}

/** Terminal intégré : un shell dans un pseudo-terminal côté Rust. */
export const terminal = {
  /** `cwd` à `null` : le shell démarre dans le dossier personnel. */
  start: (sessionId: string, cwd: string | null, cols: number, rows: number, banner?: string) =>
    invoke<void>("terminal_start", { sessionId, cwd, cols, rows, banner }),
  write: (sessionId: string, data: string) => invoke<void>("terminal_write", { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  stop: (sessionId: string) => invoke<void>("terminal_stop", { sessionId }),
  onEvent: (handler: (e: TerminalEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalEvent>("terminal://event", (e) => handler(e.payload)),
};

/** Espace de travail d'un agent : le projet (1er agent) ou un worktree isolé. */
export interface AgentWorkspace {
  cwd: string;
  branch: string | null;
  /** Raison pour laquelle l'agent n'est pas isolé (git absent…). */
  notice: string | null;
}

export type OrchestratorStatus = "running" | "done" | "error";

/** Étape du pipeline de fin de tâche (commit, sync, build, merge). */
export interface OrchestratorEvent {
  agentId: string;
  runId: string;
  stage: string;
  status: OrchestratorStatus;
  label: string;
  detail: string | null;
}

export const agents = {
  /** `index` 0 = premier agent (travaille dans le projet), sinon worktree `.fast/worktrees/agent-N`. */
  createWorkspace: (root: string, agentId: string, index: number, name: string) =>
    invoke<AgentWorkspace>("agent_workspace_create", { root, agentId, index, name }),
  removeWorkspace: (agentId: string) => invoke<void>("agent_workspace_remove", { agentId }),
  setBusy: (agentId: string, busy: boolean) => invoke<void>("agent_set_busy", { agentId, busy }),
  /** Fin de tâche : l'orchestrateur commit, build et fusionne en arrière-plan. */
  taskFinished: (agentId: string, summary: string | null) => invoke<void>("agent_task_finished", { agentId, summary }),
  onOrchestratorEvent: (handler: (e: OrchestratorEvent) => void): Promise<UnlistenFn> =>
    listen<OrchestratorEvent>("orchestrator://event", (e) => handler(e.payload)),
};

/** Réglages propres au projet (`.fast/config.json`). */
export interface ProjectConfig {
  /** `null` = détection automatique, `""` = pas de build. */
  buildCommand: string | null;
}

export const project = {
  config: (root: string) =>
    invoke<{ config: ProjectConfig; detectedBuildCommand: string | null }>("project_config_get", { root }),
  saveConfig: (root: string, config: ProjectConfig) => invoke<void>("project_config_set", { root, config }),
};

export interface ClaudeStatus {
  installed: boolean;
  /** Connecté à un compte claude.ai (abonnement). */
  loggedIn: boolean;
  /** Commande shell de l'installeur officiel. */
  installCommand: string;
  /** Commande shell de connexion, si Claude Code est installé. */
  loginCommand: string | null;
}

export const claude = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  start: (
    sessionId: string,
    cwd: string,
    opts: { permissionMode?: string; model?: string | null; resume?: string | null } = {},
  ) => invoke<void>("claude_start", { sessionId, cwd, ...opts }),
  send: (sessionId: string, text: string) =>
    invoke<void>("claude_send", { sessionId, text }),
  stop: (sessionId: string) => invoke<void>("claude_stop", { sessionId }),
  onEvent: (handler: (e: ClaudeEvent) => void): Promise<UnlistenFn> =>
    listen<ClaudeEvent>("claude://event", (e) => handler(e.payload)),
};
