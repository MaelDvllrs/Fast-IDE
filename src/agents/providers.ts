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

/** Outils de Claude Code -> phrases affichées dans la conversation. */
function describeClaudeTool(name: string, input: Record<string, unknown> | undefined): ToolDescription {
  const i = input ?? {};
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
