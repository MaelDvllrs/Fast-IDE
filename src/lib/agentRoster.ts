// Agents ouverts dans la fenêtre IA, partagés avec le reste de l'interface
// (panneau Agents) : nom, couleur, modèle, activité et jetons consommés.
// La fenêtre IA les déclare et les met à jour ; les autres ne font que lire.
import { useEffect, useState } from "react";

export interface TokenUsage {
  input: number;
  output: number;
  /** Jetons relus depuis le cache de Claude (contexte déjà envoyé). */
  cacheRead: number;
  /** Jetons écrits dans le cache. */
  cacheWrite: number;
}

/** Consommation d'un modèle pendant un tour. */
export interface ModelShare {
  tokens: number;
  cost: number;
}

/** Un tour de l'agent : heure de fin, jetons (tous types), coût estimé et répartition par modèle. */
export interface Turn {
  at: number;
  tokens: number;
  cost: number;
  /** Par nom de modèle lisible (« Opus 5.5 ») ; Claude Code peut en appeler plusieurs par tour. */
  models: Record<string, ModelShare>;
}

export interface RosterAgent {
  id: string;
  name: string;
  color: string;
  /** Libellé du modèle (ex. « Opus 5.5 »), `null` tant qu'il n'est pas connu. */
  model: string | null;
  /** Modèle choisi (identifiant du fournisseur), `null` = modèle par défaut du compte. */
  modelId: string | null;
  /** Niveau d'effort choisi, `null` = celui du compte. */
  effort: string | null;
  /** Plafond de jetons (entrée + sortie) fixé par l'utilisateur, `null` = aucun. */
  tokenLimit: number | null;
  /** Instructions ajoutées au prompt système de l'agent, `null` = aucune. */
  systemPrompt: string | null;
  /** Dossier de travail : le projet (premier agent) ou son worktree. */
  cwd: string | null;
  /** Branche du worktree, `null` seulement sans git (l'agent travaille alors dans le projet). */
  branch: string | null;
  /** Résumé en une ligne de la conversation (sur quoi l'agent travaille), `null` avant la première tâche. */
  summary: string | null;
  working: boolean;
  usage: TokenUsage;
  /** Tours, du plus ancien au plus récent. */
  turns: Turn[];
  /** Coût estimé cumulé (prix API équivalent annoncé par Claude Code), en dollars. */
  cost: number;
}

/** Tours conservés pour le graphique de la fenêtre de l'agent. */
const MAX_TURNS = 200;

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let agents: RosterAgent[] = [];
// Mises à jour reçues avant la déclaration de l'agent (les effets des sessions
// passent avant celui de la liste) : appliquées à son arrivée.
type SessionPatch = Partial<Omit<RosterAgent, "id" | "name" | "color">>;
const pending = new Map<string, SessionPatch>();
const listeners = new Set<(a: RosterAgent[]) => void>();
const focusListeners = new Set<(id: string) => void>();
const addListeners = new Set<() => void>();
const settingsListeners = new Set<(id: string) => void>();
const modelListeners = new Set<(id: string, modelId: string | null) => void>();
const effortListeners = new Set<(id: string, effort: string | null) => void>();
const promptListeners = new Set<(id: string, prompt: string | null) => void>();

function emit(next: RosterAgent[]) {
  agents = next;
  listeners.forEach((l) => l(agents));
}

/**
 * Liste des agents, dans l'ordre des onglets ; les agents absents de `list` sont
 * retirés. `initial` : valeurs d'un agent restauré (consommation, limite…), appliquées à sa création.
 */
export function syncAgents(list: { id: string; name: string; color: string; initial?: SessionPatch }[]) {
  emit(
    list.map((a) => {
      const current = agents.find((x) => x.id === a.id);
      const { initial, ...identity } = a;
      if (current) return { ...current, ...identity };
      const early = pending.get(a.id);
      pending.delete(a.id);
      return {
        model: null,
        modelId: null,
        effort: null,
        tokenLimit: null,
        systemPrompt: null,
        cwd: null,
        branch: null,
        summary: null,
        working: false,
        usage: EMPTY_USAGE,
        turns: [],
        cost: 0,
        // Champs absents d'un enregistrement ancien : les valeurs par défaut restent.
        ...Object.fromEntries(Object.entries(initial ?? {}).filter(([, value]) => value !== undefined)),
        ...early,
        ...identity,
      };
    }),
  );
}

export function updateAgent(id: string, patch: SessionPatch) {
  const current = agents.find((a) => a.id === id);
  if (!current) {
    pending.set(id, { ...pending.get(id), ...patch });
    return;
  }
  if (Object.entries(patch).every(([k, v]) => current[k as keyof RosterAgent] === v)) return;
  emit(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

/**
 * Ajoute la consommation d'un tour, lue dans le message `result` de Claude Code :
 * `usage`, `total_cost_usd` et `modelUsage` (par modèle). `modelName` rend un
 * identifiant lisible ; `fallbackModel` sert si `modelUsage` est absent.
 */
export function addUsage(
  id: string,
  result: Record<string, unknown>,
  modelName: (raw: string) => string,
  fallbackModel: string | null,
) {
  const usage = result.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  const turnCost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const turnTokens = n("input_tokens") + n("output_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");

  const models: Record<string, ModelShare> = {};
  const perModel = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
  for (const [raw, m] of Object.entries(perModel ?? {})) {
    const k = (key: string) => (typeof m[key] === "number" ? (m[key] as number) : 0);
    const name = modelName(raw);
    const share = models[name] ?? { tokens: 0, cost: 0 };
    models[name] = {
      tokens: share.tokens + k("inputTokens") + k("outputTokens") + k("cacheReadInputTokens") + k("cacheCreationInputTokens"),
      cost: share.cost + k("costUSD"),
    };
  }
  if (Object.keys(models).length === 0) models[fallbackModel ?? "Default"] = { tokens: turnTokens, cost: turnCost };
  emit(
    agents.map((a) =>
      a.id === id
        ? {
            ...a,
            usage: {
              input: a.usage.input + n("input_tokens"),
              output: a.usage.output + n("output_tokens"),
              cacheRead: a.usage.cacheRead + n("cache_read_input_tokens"),
              cacheWrite: a.usage.cacheWrite + n("cache_creation_input_tokens"),
            },
            turns: [
              ...a.turns,
              { at: Date.now(), tokens: turnTokens, cost: turnCost, models },
            ].slice(-MAX_TURNS),
            cost: a.cost + turnCost,
          }
        : a,
    ),
  );
}

export const totalTokens = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** Jetons comptés pour la limite : seulement ceux envoyés et générés (sans le cache). */
export const limitTokens = (u: TokenUsage) => u.input + u.output;

export const limitReached = (a: RosterAgent) => a.tokenLimit !== null && limitTokens(a.usage) >= a.tokenLimit;

/** Plafond de jetons d'un agent ; `null` le supprime. */
export function setTokenLimit(id: string, limit: number | null) {
  emit(agents.map((a) => (a.id === id ? { ...a, tokenLimit: limit } : a)));
}

/** Demande à la fenêtre IA d'afficher cet agent. */
export function focusAgent(id: string) {
  focusListeners.forEach((l) => l(id));
}

export function onFocusAgent(listener: (id: string) => void) {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/** Demande à la session d'un agent de passer sur un autre modèle. */
export function requestModelChange(id: string, modelId: string | null) {
  modelListeners.forEach((l) => l(id, modelId));
}

export function onModelChangeRequest(listener: (id: string, modelId: string | null) => void) {
  modelListeners.add(listener);
  return () => {
    modelListeners.delete(listener);
  };
}

/** Demande à la session d'un agent de changer de niveau d'effort. */
export function requestEffortChange(id: string, effort: string | null) {
  effortListeners.forEach((l) => l(id, effort));
}

export function onEffortChangeRequest(listener: (id: string, effort: string | null) => void) {
  effortListeners.add(listener);
  return () => {
    effortListeners.delete(listener);
  };
}

/** Demande à la session d'un agent d'appliquer un nouveau prompt système (`null` = aucun). */
export function requestSystemPromptChange(id: string, prompt: string | null) {
  promptListeners.forEach((l) => l(id, prompt));
}

export function onSystemPromptChangeRequest(listener: (id: string, prompt: string | null) => void) {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

/** Ouvre la fenêtre d'options d'un agent (à la place du code). */
export function openAgentSettings(id: string) {
  settingsListeners.forEach((l) => l(id));
}

export function onOpenAgentSettings(listener: (id: string) => void) {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

/** Demande à la fenêtre IA d'ouvrir un nouvel agent. */
export function requestNewAgent() {
  addListeners.forEach((l) => l());
}

export function onNewAgentRequest(listener: () => void) {
  addListeners.add(listener);
  return () => {
    addListeners.delete(listener);
  };
}

export function useAgentRoster(): RosterAgent[] {
  const [value, setValue] = useState(agents);
  useEffect(() => {
    listeners.add(setValue);
    setValue(agents);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
