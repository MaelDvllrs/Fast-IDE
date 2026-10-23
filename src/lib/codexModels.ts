// Modèles Codex du compte connecté, lus une fois (un `codex app-server` éphémère
// côté Rust) et partagés : menus de modèle et d'effort des agents Codex.
import { useEffect, useState } from "react";
import { CODEX, codexModelNames, type AgentModel } from "../agents/providers";
import { codex, type CodexModel } from "./ipc";

let models: CodexModel[] | null = null;
let loading: Promise<CodexModel[]> | null = null;
const listeners = new Set<(m: CodexModel[]) => void>();

export function loadCodexModels(): Promise<CodexModel[]> {
  if (models) return Promise.resolve(models);
  loading ??= codex.models().then(
    (list) => {
      models = list;
      for (const m of list) codexModelNames.set(m.id, m.displayName);
      listeners.forEach((l) => l(list));
      return list;
    },
    () => {
      loading = null;
      return [];
    },
  );
  return loading;
}

/** « Default » puis les modèles du compte, au format des menus. */
export const toAgentModels = (list: CodexModel[]): AgentModel[] => [
  ...CODEX.models,
  ...list.map((m) => ({ id: m.id, label: m.displayName, description: m.isDefault ? `${m.description} (default)` : m.description })),
];

export function useCodexModels(enabled: boolean): CodexModel[] {
  const [value, setValue] = useState<CodexModel[]>(models ?? []);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setValue);
    loadCodexModels().then(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, [enabled]);
  return value;
}
