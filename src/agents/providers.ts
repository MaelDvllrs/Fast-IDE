// Fournisseurs d'IA disponibles dans le panneau agent. Le champ de saisie
// (Composer) ne connaît que cette description : brancher une autre IA =
// ajouter un fournisseur ici, avec ses modèles et sa façon de citer le contexte.

export interface AgentModel {
  /** Valeur transmise au fournisseur ; `null` = modèle par défaut du compte. */
  id: string | null;
  label: string;
  description?: string;
}

/** Élément de contexte joint à un message (fichier, document…). */
export interface Attachment {
  path: string;
  name: string;
  /** Aperçu d'une image collée (URL locale du navigateur), affiché dans le champ. */
  preview?: string;
}

/** Description lisible d'une action de l'IA (outil), en cours puis terminée. */
export interface ToolDescription {
  icon: string;
  /** Ex. « Reading App.tsx » (en cours). */
  running: string;
  /** Ex. « Read App.tsx » (terminé). */
  done: string;
}

export interface AgentProvider {
  id: string;
  label: string;
  models: AgentModel[];
  /** Nom lisible d'un identifiant de modèle renvoyé par l'IA (ex. « Opus 5.5 »). */
  formatModelName: (raw: string) => string;
  /** Traduit un appel d'outil (nom + paramètres) en phrase lisible. */
  describeTool: (name: string, input: Record<string, unknown> | undefined) => ToolDescription;
  /** Construit le message envoyé à l'IA à partir du texte et du contexte joint. */
  formatPrompt: (text: string, attachments: Attachment[]) => string;
}

/** Niveaux d'effort de Claude Code (option `--effort`) : réflexion avant de répondre. */
export const EFFORTS: { id: string | null; label: string; description?: string }[] = [
  { id: null, label: "Default", description: "Set for your account" },
  { id: "low", label: "Low", description: "Fastest answers" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max", description: "Deepest thinking" },
];

export const CLAUDE_CODE: AgentProvider = {
  id: "claude-code",
  label: "Claude Code",
  // Identifiants complets (et non les alias `opus`, `sonnet`…) : la version
  // affichée est exactement celle utilisée. À mettre à jour à chaque nouvelle version.
  models: [
    { id: null, label: "Default", description: "Model set for your account" },
    { id: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable" },
    { id: "claude-opus-5-5", label: "Opus 5.5", description: "Complex tasks" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and capable" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5", description: "Fastest" },
  ],
  // « claude-opus-5-5 » -> « Opus 5.5 » ; un identifiant inattendu est affiché tel quel.
  formatModelName: (raw) => {
    const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(raw);
    return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : raw;
  },
  describeTool: describeClaudeTool,
  // Claude Code lit lui-même les fichiers cités (outil Read, autorisé sans confirmation).
  formatPrompt: (text, attachments) =>
    attachments.length === 0
      ? text
      : `${text}\n\nContext files:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`,
};

/** Dernier segment d'un chemin, pour des libellés courts. */
const fileName = (value: unknown) => (typeof value === "string" ? (value.split(/[\\/]/).pop() ?? value) : "");

/** Texte court : coupé avec « … » au-delà de `max` caractères. */
const short = (value: unknown, max = 48) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Vérifications du planificateur de FAST (`run_check`), par type. */
const CHECKS: Record<string, { label: string; icon: string }> = {
  typecheck: { label: "type check", icon: "lucide:list-checks" },
  lint: { label: "lint", icon: "lucide:list-checks" },
  test: { label: "unit tests", icon: "lucide:flask-conical" },
  integration_test: { label: "integration tests", icon: "lucide:flask-conical" },
  e2e: { label: "E2E tests", icon: "lucide:flask-conical" },
  build: { label: "build", icon: "lucide:hammer" },
};

const CHECK_ALIASES: Record<string, string> = {
  integrationtest: "integration_test",
  integrationtests: "integration_test",
  integration: "integration_test",
  tests: "test",
  unittests: "test",
  unittest: "test",
  types: "typecheck",
  e2etests: "e2e",
};

/**
 * Outils du serveur MCP de FAST (planificateur), quelle que soit l'IA :
 * « mcp__fast__run_check » (Claude Code, Codex) ou « run_check (fast MCP Server) » (Gemini).
 */
function describeFastTool(name: string, i: Record<string, unknown>): ToolDescription | null {
  const tool = /^mcp__fast__(\w+)$/.exec(name)?.[1] ?? /^(run_check|start_preview|stop_preview|preview_logs|scheduler_status)\b/.exec(name)?.[1];
  switch (tool) {
    case "run_check": {
      // « type_check », « unit-tests »… : même nom que le planificateur une fois normalisé.
      const kind = String(i.kind ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const check = CHECKS[CHECK_ALIASES[kind] ?? kind] ?? { label: "check", icon: "lucide:list-checks" };
      return { icon: check.icon, running: `Running ${check.label}`, done: `Ran ${check.label}` };
    }
    case "start_preview":
      return { icon: "lucide:server", running: "Starting the preview", done: "Started the preview" };
    case "stop_preview":
      return { icon: "lucide:server", running: "Stopping the preview", done: "Stopped the preview" };
    case "preview_logs":
      return { icon: "lucide:server", running: "Reading the preview output", done: "Read the preview output" };
    case "scheduler_status":
      return { icon: "lucide:server", running: "Checking running tasks", done: "Checked running tasks" };
    default:
      return null;
  }
}

/** Outils de Claude Code -> phrases affichées dans la conversation. */
function describeClaudeTool(name: string, input: Record<string, unknown> | undefined): ToolDescription {
  const i = input ?? {};
  const fast = describeFastTool(name, i);
  if (fast) return fast;
  const target = (verb: [string, string], value: string, icon: string): ToolDescription => ({
    icon,
    running: value ? `${verb[0]} ${value}` : verb[0],
    done: value ? `${verb[1]} ${value}` : verb[1],
  });
  switch (name) {
    case "Read":
      return target(["Reading", "Read"], fileName(i.file_path), "lucide:file-text");
    case "Edit":
    case "MultiEdit":
      return target(["Editing", "Edited"], fileName(i.file_path), "lucide:pencil");
    case "Write":
      return target(["Writing", "Wrote"], fileName(i.file_path), "lucide:file-plus");
    case "NotebookEdit":
      return target(["Editing", "Edited"], fileName(i.notebook_path), "lucide:pencil");
    case "Grep":
      return target(["Searching for", "Searched for"], i.pattern ? `"${short(i.pattern, 32)}"` : "", "lucide:search");
    case "Glob":
      return target(["Finding", "Found"], short(i.pattern, 32), "lucide:folder-search");
    case "LS":
      return target(["Listing", "Listed"], fileName(i.path), "lucide:folder-search");
    case "Bash":
    case "PowerShell":
      return target(["Running", "Ran"], short(i.description ?? i.command), "lucide:terminal");
    case "WebFetch":
      return target(["Fetching", "Fetched"], short(i.url), "lucide:globe");
    case "WebSearch":
      return target(["Searching the web for", "Searched the web for"], i.query ? `"${short(i.query, 32)}"` : "", "lucide:globe");
    case "TodoWrite":
      return { icon: "lucide:list-todo", running: "Updating the plan", done: "Updated the plan" };
    case "Task":
    case "Agent":
      return target(["Delegating", "Delegated"], short(i.description), "lucide:bot");
    default:
      return { icon: "lucide:wrench", running: `Using ${name}`, done: `Used ${name}` };
  }
}

/** IA d'un agent : Claude Code, Codex (OpenAI) ou Gemini CLI (Google). */
export type ProviderId = "claude-code" | "codex" | "gemini";

/** « gpt-6.1-sol » → « GPT-6.1-Sol » quand Codex n'a pas fourni de nom. */
const prettyCodexModel = (raw: string) =>
  raw.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c: string) => `-${c.toUpperCase()}`);

/** Noms lisibles des modèles Codex, remplis par `codexModels` (liste du compte). */
export const codexModelNames = new Map<string, string>();

/**
 * Codex (CLI d'OpenAI). Ses modèles dépendent du compte : ils sont lus au
 * démarrage (voir lib/codexModels.ts) et ajoutés après « Default ». Les outils
 * arrivent sous les mêmes noms que ceux de Claude Code (traduits côté Rust).
 */
export const CODEX: AgentProvider = {
  id: "codex",
  label: "Codex",
  models: [{ id: null, label: "Default", description: "Model set for your account" }],
  formatModelName: (raw) => codexModelNames.get(raw) ?? prettyCodexModel(raw),
  describeTool: describeClaudeTool,
  formatPrompt: CLAUDE_CODE.formatPrompt,
};

/**
 * Gemini CLI (Google). ACP ne donne pas de liste de modèles à part : la liste
 * ci-dessous est celle proposée aux comptes Google (« auto » = choix de Gemini CLI).
 */
export const GEMINI: AgentProvider = {
  id: "gemini",
  label: "Gemini",
  models: [
    { id: null, label: "Auto", description: "Gemini CLI picks the model" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", description: "Most capable" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "Fast and capable" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", description: "Fastest" },
  ],
  // « gemini-3.1-pro-preview » → « Gemini 3.1 Pro » ; « auto » → « Auto ».
  formatModelName: (raw) =>
    raw
      .replace(/-preview$/, "")
      .split("-")
      .map((part) => (/^\d/.test(part) ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
      .join(" "),
  describeTool: describeClaudeTool,
  formatPrompt: CLAUDE_CODE.formatPrompt,
};

export const PROVIDERS: Record<ProviderId, AgentProvider> = { "claude-code": CLAUDE_CODE, codex: CODEX, gemini: GEMINI };

/** Libellé et icône (carré coloré) de chaque IA, partout dans l'interface. */
export const PROVIDER_INFO: Record<
  ProviderId,
  { label: string; icon: "fast:claude-app" | "fast:openai-app" | "fast:gemini-app" }
> = {
  "claude-code": { label: "Claude Code", icon: "fast:claude-app" },
  codex: { label: "Codex", icon: "fast:openai-app" },
  gemini: { label: "Gemini", icon: "fast:gemini-app" },
};

/** Niveaux de raisonnement de Codex (les modèles n'acceptent pas tous les mêmes). */
export const CODEX_EFFORTS: { id: string | null; label: string; description?: string }[] = [
  { id: null, label: "Default", description: "Set for the model" },
  { id: "low", label: "Low", description: "Fastest answers" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra", description: "Deepest reasoning" },
];

/** IA d'un agent de la liste partagée (valeur inconnue = Claude Code). */
export const providerIdOf = (provider: string | undefined): ProviderId =>
  provider === "codex" || provider === "gemini" ? provider : "claude-code";

/** Gemini CLI ne règle pas l'effort : seul « Default » est proposé. */
const GEMINI_EFFORTS: { id: string | null; label: string; description?: string }[] = [{ id: null, label: "Default", description: "Set by Gemini CLI" }];

/** Niveaux d'effort proposés pour une IA. */
export const effortsFor = (provider: string | undefined) => {
  const id = providerIdOf(provider);
  return id === "codex" ? CODEX_EFFORTS : id === "gemini" ? GEMINI_EFFORTS : EFFORTS;
};
