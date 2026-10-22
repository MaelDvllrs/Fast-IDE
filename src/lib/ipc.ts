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
  /** Enregistre un fichier collé (contenu en base64) dans `.fast/attachments/` ; rend son chemin. */
  saveAttachment: (root: string, name: string, data: string) =>
    invoke<string>("attachment_save", { root, name, data }),
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
  /** `command` : exécute cette ligne à la place du shell interactif (bouton Run). */
  start: (sessionId: string, cwd: string | null, cols: number, rows: number, banner?: string, command?: string) =>
    invoke<void>("terminal_start", { sessionId, cwd, cols, rows, banner, command }),
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
  /** Worktree `.fast/worktrees/agent-N` ; `index` 0 = Prime, prioritaire à l'intégration. */
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

export interface RunCandidate {
  /** Libellé court (ex. « dev », « cargo run »). */
  label: string;
  command: string;
}

export interface RunOptions {
  selected: string | null;
  candidates: RunCandidate[];
}

export const project = {
  config: (root: string) =>
    invoke<{ config: ProjectConfig; detectedBuildCommand: string | null }>("project_config_get", { root }),
  saveConfig: (root: string, config: ProjectConfig) => invoke<void>("project_config_set", { root, config }),
  /** Commandes du bouton Run (détectées) et celle choisie pour ce projet. */
  runOptions: (root: string) => invoke<RunOptions>("project_run_options", { root }),
  /** `null` revient à la commande détectée. */
  setRunCommand: (root: string, command: string | null) => invoke<void>("project_run_set", { root, command }),
};

export interface ClaudeStatus {
  installed: boolean;
  /** Connecté à un compte claude.ai (abonnement). */
  loggedIn: boolean;
  /** Commande shell de l'installeur officiel. */
  installCommand: string;
  /** Commande shell de connexion, si Claude Code est installé. */
  loginCommand: string | null;
  /** Compte connecté. */
  email: string | null;
  orgName: string | null;
  /** Formule : « pro », « max », « team »… */
  subscriptionType: string | null;
}

export const claude = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  logout: () => invoke<void>("claude_logout"),
  start: (
    sessionId: string,
    cwd: string,
    opts: {
      permissionMode?: string;
      model?: string | null;
      resume?: string | null;
      effort?: string | null;
      /** Instructions ajoutées au prompt système ; `""` = retirées, `null` = jamais définies. */
      systemPrompt?: string | null;
    } = {},
  ) => invoke<void>("claude_start", { sessionId, cwd, ...opts }),
  send: (sessionId: string, text: string) =>
    invoke<void>("claude_send", { sessionId, text }),
  /** Arrête le tour en cours (la session reste ouverte). */
  interrupt: (sessionId: string) => invoke<void>("claude_interrupt", { sessionId }),
  /** Réponse courte d'un modèle rapide, sans outils (résumé d'une conversation). */
  quick: (prompt: string) => invoke<string>("claude_quick", { prompt }),
  /** Réponse à une demande d'autorisation (`control_request` / `can_use_tool`). */
  permission: (sessionId: string, requestId: string, allow: boolean, input: unknown, message?: string) =>
    invoke<void>("claude_permission", { sessionId, requestId, allow, input, message }),
  stop: (sessionId: string) => invoke<void>("claude_stop", { sessionId }),
  onEvent: (handler: (e: ClaudeEvent) => void): Promise<UnlistenFn> =>
    listen<ClaudeEvent>("claude://event", (e) => handler(e.payload)),
};

/** Ouvre une adresse https dans le navigateur par défaut. */
export const openUrl = (url: string) => invoke<void>("system_open_url", { url });

export type SpeechEvent =
  | { type: "partial"; data: string }
  | { type: "final"; data: string }
  | { type: "end"; data: string | null };

/** Dictée vocale (reconnaissance du système), pour le champ de saisie des agents. */
export const speech = {
  start: () => invoke<void>("speech_start"),
  stop: () => invoke<void>("speech_stop"),
  onEvent: (handler: (e: SpeechEvent) => void): Promise<UnlistenFn> =>
    listen<SpeechEvent>("speech://event", (e) => handler(e.payload)),
};

/** Ouvre un dossier dans l'explorateur de fichiers du système. */
export const openPath = (path: string) => invoke<void>("system_open_path", { path });

export interface GithubAccount {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** Code de connexion à saisir sur github.com (device flow). */
export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  attempt: number;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string;
}

export const github = {
  account: () => invoke<GithubAccount | null>("github_account"),
  loginStart: () => invoke<GithubDeviceCode>("github_login_start"),
  /** Se résout quand le code a été validé sur github.com. */
  loginFinish: (code: GithubDeviceCode) => invoke<GithubAccount>("github_login_finish", { code }),
  loginCancel: () => invoke<void>("github_login_cancel"),
  signOut: () => invoke<void>("github_sign_out"),
  repos: () => invoke<GithubRepo[]>("github_repos"),
};

export interface ScmChange {
  /** Relatif à la racine du dépôt, séparateurs `/`. */
  path: string;
  absPath: string;
  /** M, A, D, R, C, T, U (conflit) ou ? (non suivi). */
  status: string;
  from: string | null;
}

export interface ScmStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  hasCommits: boolean;
  merging: boolean;
  staged: ScmChange[];
  changes: ScmChange[];
  conflicts: ScmChange[];
}

export interface ScmCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Secondes depuis l'époque Unix. */
  time: number;
  /** Pas encore sur la branche distante. */
  unpushed: boolean;
}

export interface ScmBranches {
  current: string | null;
  local: string[];
  remote: string[];
}

/** Gestion de version du dossier ouvert (panneau Git). */
export const scm = {
  status: (root: string) => invoke<ScmStatus>("scm_status", { root }),
  /** `paths` vide = tout. */
  stage: (root: string, paths: string[]) => invoke<void>("scm_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => invoke<void>("scm_unstage", { root, paths }),
  /** Rend le hash court du commit. */
  commit: (root: string, message: string) => invoke<string>("scm_commit", { root, message }),
  push: (root: string) => invoke<void>("scm_push", { root }),
  pull: (root: string) => invoke<void>("scm_pull", { root }),
  fetch: (root: string) => invoke<void>("scm_fetch", { root }),
  branches: (root: string) => invoke<ScmBranches>("scm_branches", { root }),
  /** Derniers commits de la branche courante, du plus récent au plus ancien. */
  log: (root: string, limit = 50) => invoke<ScmCommit[]>("scm_log", { root, limit }),
  checkout: (root: string, branch: string) => invoke<void>("scm_checkout", { root, branch }),
  createBranch: (root: string, name: string) => invoke<void>("scm_create_branch", { root, name }),
  init: (root: string) => invoke<void>("scm_init", { root }),
  publish: (root: string, name: string, isPrivate: boolean, description: string | null) =>
    invoke<GithubRepo>("scm_publish", { root, name, private: isPrivate, description }),
  /** Rend le chemin du dossier cloné. */
  clone: (url: string, parent: string, name: string) => invoke<string>("scm_clone", { url, parent, name }),
};
