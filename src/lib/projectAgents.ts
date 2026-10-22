// Agents d'un projet et leurs conversations, gardés dans `.fast/agents.json`
// pour les rouvrir au prochain lancement (comme une conversation Claude dans
// VS Code). Chaque session d'agent y dépose son état ; l'écriture sur disque est
// regroupée (un court délai après le dernier changement).
import { invoke } from "@tauri-apps/api/core";
import type { TokenUsage, Turn } from "./agentRoster";

export interface SavedAgent {
  /** Ordre de création (0 = Prime) : donne le nom, la couleur et le worktree. */
  index: number;
  name: string;
  /** Conversation Claude Code à reprendre (`--resume`). */
  conversation: string | null;
  model: string | null;
  effort: string | null;
  /** Ultracode (orchestration multi-agents) ajouté à chaque message. */
  ultracode?: boolean;
  /** `undefined` : jamais défini ; `null` : retiré. */
  systemPrompt?: string | null;
  tokenLimit: number | null;
  summary: string | null;
  usage: TokenUsage;
  turns: Turn[];
  cost: number;
  /** Demandes de l'utilisateur (pour le résumé). */
  prompts: string[];
  /** Messages affichés dans la conversation. */
  items: unknown[];
}

export interface SavedProject {
  version: 1;
  agents: SavedAgent[];
}

/** Messages gardés au plus par agent (les plus récents). */
export const MAX_SAVED_ITEMS = 300;
/** Délai entre le dernier changement et l'écriture sur disque. */
const SAVE_DELAY_MS = 800;

let root: string | null = null;
let order: number[] = [];
const data = new Map<number, Partial<SavedAgent>>();
let timer: number | undefined;

export function loadProjectAgents(projectRoot: string): Promise<SavedProject | null> {
  return invoke<SavedProject | null>("project_agents_load", { root: projectRoot }).then(
    (saved) => (saved && Array.isArray(saved.agents) ? saved : null),
    () => null,
  );
}

/** Nouveau projet ouvert : l'état enregistré devient la base des sauvegardes suivantes. */
export function beginProject(projectRoot: string, saved: SavedProject | null) {
  flush();
  root = projectRoot;
  data.clear();
  order = saved?.agents.map((a) => a.index) ?? [];
  for (const agent of saved?.agents ?? []) data.set(agent.index, agent);
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, SAVE_DELAY_MS);
}

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!root) return;
  const agents = order.map((index) => data.get(index)).filter((a): a is SavedAgent => !!a && a.index !== undefined);
  const state: SavedProject = { version: 1, agents };
  invoke("project_agents_save", { root, state }).catch(() => {});
}

/** Ordre des onglets (indices de création) ; un agent absent de la liste est oublié. */
export function setAgentOrder(indices: number[]) {
  if (indices.join() === order.join()) return;
  for (const index of [...data.keys()]) if (!indices.includes(index)) data.delete(index);
  order = indices;
  schedule();
}

export function saveAgent(index: number, patch: Partial<SavedAgent>) {
  data.set(index, { ...data.get(index), ...patch, index });
  schedule();
}

// Fermeture de l'app : la dernière modification est écrite tout de suite.
window.addEventListener("beforeunload", flush);
