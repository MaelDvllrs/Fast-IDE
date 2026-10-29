import { useCallback, useEffect, useRef, useState } from "react";
import { extractCommitMessage, parseCommand, withUltracode, type AgentCommand } from "../agents/commands";
import {
  CLAUDE_CODE,
  CODEX_EFFORTS,
  effortsFor,
  PROVIDER_INFO,
  PROVIDERS,
  type Attachment,
  type ProviderId,
} from "../agents/providers";
import { toAgentModels, useCodexModels } from "../lib/codexModels";
import {
  agents as agentsApi,
  claude,
  codex,
  gemini,
  scm,
  type AgentWorkspace,
  type ClaudeMessage,
  type ClaudeStatus,
  type OrchestratorStatus,
} from "../lib/ipc";
import {
  addUsage,
  limitReached,
  onEffortChangeRequest,
  onSystemPromptChangeRequest,
  onFocusAgent,
  onModelChangeRequest,
  onNewAgentRequest,
  onProviderChangeRequest,
  openAgentSettings,
  syncAgents,
  totalTokens,
  updateAgent,
  useAgentRoster,
} from "../lib/agentRoster";
import { excerpt, notify, trailingQuestion } from "../lib/notifications";
import {
  beginProject,
  loadProjectAgents,
  MAX_SAVED_ITEMS,
  saveAgent,
  savedAgent,
  setAgentOrder,
  type SavedAgent,
  type SavedProject,
} from "../lib/projectAgents";
import { runInTerminal } from "../lib/terminalBus";
import { AgentMascot } from "./AgentMascot";
import { Popover } from "./Composer";
import { ProviderMenuItems } from "./ProviderMenu";
import { Markdown } from "./Markdown";
import { compact } from "./AgentOverview";
import { Composer } from "./Composer";
import { UiIcon } from "./fileIcons";

interface Props {
  cwd: string;
  /** Fichier ouvert dans l'éditeur, proposé comme contexte. */
  activeFile: string | null;
  /** Largeur en px, réglée par la poignée de redimensionnement. */
  width: number;
  /** Mode Vibe (choisi dans la barre du haut) : la fenêtre occupe tout l'espace de travail. */
  expanded: boolean;
}

/** En-tête avant l'ouverture des agents (installation, connexion). */
function ClaudeHeader({ busy }: { busy: boolean }) {
  return (
    <header className="panel-header">
      <span className="panel-title">Claude Code</span>
      {busy && <span className="spinner">●</span>}
    </header>
  );
}

/** Couleurs de contour des mascottes, attribuées aux agents dans l'ordre.
 *  Le premier agent prend la couleur primaire du thème (elle suit le thème). */
const AGENT_COLORS = ["var(--primary)", "#61afef", "#c678dd", "#98c379", "#e5707a", "#56b6c2", "#d19a66"];

interface Agent {
  id: string;
  /** Ordre de création : 0 = Prime, prioritaire à l'intégration ; chacun a son worktree. */
  index: number;
  name: string;
  color: string;
  /** IA de l'agent : Claude Code, Codex ou Gemini. */
  provider: ProviderId;
  /** État enregistré lors d'une session précédente, à restaurer. */
  saved?: SavedAgent;
  /** Incrémenté à chaque changement d'IA : la session repart de zéro. */
  switched?: number;
}

/** Noms des agents dans l'ordre de création : Prime est l'agent principal et a
 *  la priorité ; au-delà de 10, les noms secondaires reviennent numérotés (« Nova 2 »). */
const AGENT_NAMES = ["Prime", "Nova", "Atlas", "Echo", "Onyx", "Neo", "Apex", "Orion", "Pulse", "Flux"];
const SECONDARY_NAMES = AGENT_NAMES.slice(1);

const agentName = (n: number) => {
  if (n < AGENT_NAMES.length) return AGENT_NAMES[n];
  const k = n - 1;
  return `${SECONDARY_NAMES[k % SECONDARY_NAMES.length]} ${Math.floor(k / SECONDARY_NAMES.length) + 1}`;
};

/** IA proposées à l'ajout d'un agent, dans cet ordre. */
const PROVIDER_IDS: ProviderId[] = ["claude-code", "codex", "gemini"];

const isProvider = (value: unknown): value is ProviderId => PROVIDER_IDS.includes(value as ProviderId);

/** Colonnes de la grille du mode large selon le nombre d'agents :
 *  1 → 1, 2 → 2, 3 → 3, 4 → 2×2, 5-6 → 3×2, 7-9 → 3×3… */
const gridColumns = (count: number) => (count <= 3 ? count : Math.ceil(Math.sqrt(count)));

/**
 * Agents ouverts dans la fenêtre IA. Mode normal : un onglet par agent, seul
 * l'actif est affiché. Mode large : tous les agents dans une grille, déplaçables
 * en glissant leur en-tête. Les mêmes sessions servent aux deux modes (elles ne
 * sont jamais remontées), et un agent masqué continue de travailler.
 */
function AgentTabs({
  cwd,
  activeFile,
  expanded,
  saved,
}: {
  cwd: string;
  activeFile: string | null;
  expanded: boolean;
  saved: SavedProject | null;
}) {
  // Le n-ième agent créé : nom et couleur suivent l'ordre de création.
  const agentAt = (n: number, provider: ProviderId = "claude-code"): Agent => ({
    id: crypto.randomUUID(),
    index: n,
    name: agentName(n),
    color: AGENT_COLORS[n % AGENT_COLORS.length],
    provider,
  });
  const [agents, setAgents] = useState<Agent[]>(() =>
    saved?.agents.length
      ? saved.agents.map((a) => ({ ...agentAt(a.index, isProvider(a.provider) ? a.provider : "claude-code"), saved: a }))
      : [agentAt(0)],
  );
  // Prochain indice de création (après les agents restaurés) ; n'augmente qu'à l'ajout d'un agent.
  const created = useRef(Math.max(0, ...agents.map((a) => a.index)) + 1);
  // Ordre des onglets enregistré pour la prochaine ouverture ; un agent fermé est oublié.
  useEffect(() => setAgentOrder(agents.map((a) => a.index)), [agents]);
  const makeAgent = (provider: ProviderId) => agentAt(created.current++, provider);
  const [activeId, setActiveId] = useState(agents[0].id);
  // Liste partagée (panneau Agents) : suit les onglets, vidée à la fermeture du projet.
  useEffect(
    () =>
      syncAgents(
        agents.map(({ id, name, color, provider, saved: s }) => ({
          id,
          name,
          color,
          provider,
          // Agent restauré : sa consommation, sa limite et son résumé dès sa création.
          initial: s && { tokenLimit: s.tokenLimit, summary: s.summary, usage: s.usage, turns: s.turns, cost: s.cost },
        })),
      ),
    [agents],
  );
  useEffect(() => () => syncAgents([]), []);
  // Clic sur un agent du panneau Agents : son onglet passe au premier plan.
  useEffect(() => onFocusAgent(setActiveId), []);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  // Espace de travail de chaque agent, préparé côté Rust (worktree à partir du 2e).
  const [workspaces, setWorkspaces] = useState<Record<string, AgentWorkspace | { error: string }>>({});
  // Dossier et branche de chaque agent, affichés dans sa fenêtre (panneau Agents).
  useEffect(() => {
    for (const [id, workspace] of Object.entries(workspaces)) {
      if ("cwd" in workspace) updateAgent(id, { cwd: workspace.cwd, branch: workspace.branch });
    }
  }, [workspaces]);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    for (const agent of agents) {
      if (requested.current.has(agent.id)) continue;
      requested.current.add(agent.id);
      agentsApi.createWorkspace(cwd, agent.id, agent.index, agent.name).then(
        (workspace) => setWorkspaces((prev) => ({ ...prev, [agent.id]: workspace })),
        (err) => setWorkspaces((prev) => ({ ...prev, [agent.id]: { error: String(err) } })),
      );
    }
  }, [agents, cwd]);
  // Glisser-déposer d'un panneau de la grille : agent déplacé et panneau survolé.
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const grid = expanded;

  const add = (provider: ProviderId = "claude-code") => {
    const agent = makeAgent(provider);
    setAgents((prev) => [...prev, agent]);
    setActiveId(agent.id);
  };
  // Bouton « Add agent » du panneau Agents. `add` change à chaque rendu : passé par une ref.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => onNewAgentRequest((provider) => addRef.current(isProvider(provider) ? provider : "claude-code")), []);
  // Changement d'IA d'un agent (fenêtre de ses options) : nouvelle session, nouvelle
  // conversation, mais les messages déjà affichés restent visibles.
  useEffect(
    () =>
      onProviderChangeRequest((id, provider) => {
        if (!isProvider(provider)) return;
        setAgents((prev) =>
          prev.map((a) => {
            if (a.id !== id || a.provider === provider) return a;
            const previous = savedAgent(a.index) as SavedAgent | undefined;
            const kept = previous && { ...previous, provider, conversation: null, model: null, effort: null, ultracode: false };
            saveAgent(a.index, { provider, conversation: null, model: null, effort: null });
            // Consommation remise à zéro : elle revenait à l'ancienne IA, pas à la nouvelle.
            updateAgent(id, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: [], cost: 0 });
            return { ...a, provider, saved: kept, switched: (a.switched ?? 0) + 1 };
          }),
        );
      }),
    [],
  );

  const close = (id: string) => {
    agentsApi.removeWorkspace(id).catch(() => {});
    const index = agents.findIndex((a) => a.id === id);
    const remaining = agents.filter((a) => a.id !== id);
    setAgents(remaining);
    if (id === activeId) setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
  };

  /** Échange la place de deux agents (dans la grille comme dans les onglets). */
  const swap = (a: string, b: string) =>
    setAgents((prev) => {
      const next = [...prev];
      const i = next.findIndex((x) => x.id === a);
      const j = next.findIndex((x) => x.id === b);
      if (i < 0 || j < 0) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const setAgentWorking = useCallback((id: string, busy: boolean) => {
    setWorking((prev) => (prev[id] === busy ? prev : { ...prev, [id]: busy }));
    updateAgent(id, { working: busy });
  }, []);

  // Pointeur plutôt que le glisser-déposer HTML5 : sous Windows, Tauri intercepte
  // les dépôts au niveau de la fenêtre et les événements HTML5 ne passent pas.
  const dragHandlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ id, over: null });
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag) return;
      const pane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-agent-id]");
      const over = pane?.dataset.agentId ?? null;
      if (over !== drag.over) setDrag({ ...drag, over: over === drag.id ? null : over });
    },
    onPointerUp: () => {
      if (drag?.over) swap(drag.id, drag.over);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });

  // Agent agrandi dans le mode large : il prend toute la place, les autres
  // restent montés (et continuent de travailler) mais masqués.
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const maximized = grid && maximizedId !== null && agents.some((a) => a.id === maximizedId) ? maximizedId : null;
  const columns = maximized ? 1 : gridColumns(agents.length);
  const roster = useAgentRoster();
  // Consommation, limite et résumé de chaque agent : enregistrés avec sa conversation.
  useEffect(() => {
    for (const entry of roster) {
      const agent = agents.find((a) => a.id === entry.id);
      if (!agent) continue;
      saveAgent(agent.index, {
        name: entry.name,
        tokenLimit: entry.tokenLimit,
        summary: entry.summary,
        usage: entry.usage,
        turns: entry.turns,
        cost: entry.cost,
      });
    }
  }, [roster, agents]);
  const summaries = Object.fromEntries(roster.map((a) => [a.id, a.summary]));

  return (
    <>
      {grid ? (
        <header className="panel-header agent-grid-toolbar">
          {/* Tous les agents ouverts, mascottes légèrement superposées */}
          <div className="agent-stack" aria-label={`${agents.length} agents`}>
            {agents.map((agent) => (
              <span key={agent.id} className="agent-stack-item" title={agent.name}>
                <AgentMascot color={agent.color} working={!!working[agent.id]} size={14} />
              </span>
            ))}
          </div>
          <AddAgentMenu onAdd={add} label="Add agent" />
          {/* Jetons consommés depuis l'ouverture de l'app, par IA utilisée par les agents */}
          <span className="session-ais">
            {PROVIDER_IDS.filter((p) => roster.some((a) => a.provider === p)).map((p) => {
              const tokens = roster.filter((a) => a.provider === p).reduce((sum, a) => sum + totalTokens(a.usage), 0);
              return (
                <span
                  key={p}
                  className="session-ai"
                  title={`${PROVIDER_INFO[p].label}: ${tokens.toLocaleString("en-US")} tokens this session`}
                >
                  <UiIcon name={PROVIDER_INFO[p].icon} className="session-ai-icon" />
                  {compact(tokens)}
                </span>
              );
            })}
          </span>
        </header>
      ) : (
        // Mêmes onglets que la fenêtre code (classes tab-bar / tab), mascotte à la place de l'icône
        <header className="tab-bar agent-tab-bar">
          {/* Onglets + « + » défilent (barre visible, molette horizontale) ; la bascule reste à droite. */}
          <div
            className="agent-tab-scroll"
            role="tablist"
            onWheel={(e) => {
              if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {agents.map((agent) => (
              <div
                key={agent.id}
                role="tab"
                aria-selected={agent.id === activeId}
                className={agent.id === activeId ? "tab active" : "tab"}
                onClick={() => setActiveId(agent.id)}
              >
                <AgentMascot color={agent.color} working={!!working[agent.id]} size={14} />
                <span className="tab-name">{agent.name}</span>
                {agents.length > 1 && (
                  <button
                    className="tab-close"
                    aria-label={`Close ${agent.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(agent.id);
                    }}
                  >
                    <UiIcon name="material-symbols:close-small-rounded" className="tab-close-icon" />
                  </button>
                )}
              </div>
            ))}
            <AddAgentMenu onAdd={add} />
          </div>
        </header>
      )}

      {/* Même conteneur et mêmes clés dans les deux modes : les sessions ne sont pas remontées. */}
      <div
        className={grid ? "agent-panes grid" : "agent-panes"}
        style={grid ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {agents.map((agent) => {
          const classes = ["agent-pane"];
          if (grid && agent.id === activeId) classes.push("active");
          if (drag?.id === agent.id) classes.push("dragging");
          if (drag?.over === agent.id) classes.push("drop-target");
          return (
            <div
              key={agent.id}
              className={classes.join(" ")}
              data-agent-id={agent.id}
              hidden={grid ? maximized !== null && agent.id !== maximized : agent.id !== activeId}
              onPointerDownCapture={() => setActiveId(agent.id)}
            >
              {grid && (
                <header className="agent-pane-header" title="Drag to move" {...dragHandlers(agent.id)}>
                  <AgentMascot color={agent.color} working={!!working[agent.id]} size={16} />
                  <span className="agent-pane-name">{agent.name}</span>
                  {/* Sur quoi travaille l'agent, en une ligne, à côté de son nom */}
                  <span className="agent-pane-summary" title={summaries[agent.id] ?? undefined}>
                    {summaries[agent.id] ?? "No task yet"}
                  </span>
                  {/* Dossier de l'agent (branche de son worktree), à gauche de son IA */}
                  {(() => {
                    const workspace = workspaces[agent.id];
                    return workspace && "branch" in workspace && workspace.branch ? (
                      <span className="agent-pane-branch" title={workspace.cwd}>
                        <UiIcon name="lucide:git-branch" className="agent-pane-branch-icon" />
                        {workspace.branch}
                      </span>
                    ) : null;
                  })()}
                  {/* IA puis réglages de l'agent, à droite de l'en-tête */}
                  <span className="agent-pane-ai" title={PROVIDER_INFO[agent.provider].label}>
                    <UiIcon name={PROVIDER_INFO[agent.provider].icon} className="agent-pane-ai-icon" />
                    {PROVIDER_INFO[agent.provider].label}
                  </span>
                  <button
                    className="agent-pane-settings"
                    title={`${agent.name} settings`}
                    aria-label={`${agent.name} settings`}
                    onClick={() => openAgentSettings(agent.id)}
                  >
                    <UiIcon name="lucide:settings" className="agent-pane-settings-icon" />
                  </button>
                  {agents.length > 1 && (
                    <button
                      className="agent-pane-settings"
                      title={maximized === agent.id ? "Restore" : "Maximize"}
                      aria-label={maximized === agent.id ? `Restore ${agent.name}` : `Maximize ${agent.name}`}
                      aria-pressed={maximized === agent.id}
                      onClick={() => setMaximizedId(maximized === agent.id ? null : agent.id)}
                    >
                      <UiIcon
                        name={maximized === agent.id ? "lucide:minimize-2" : "lucide:maximize-2"}
                        className="agent-pane-settings-icon"
                      />
                    </button>
                  )}
                  {agents.length > 1 && (
                    <button
                      className="tab-close agent-pane-close"
                      aria-label={`Close ${agent.name}`}
                      onClick={() => close(agent.id)}
                    >
                      <UiIcon name="material-symbols:close-small-rounded" className="tab-close-icon" />
                    </button>
                  )}
                </header>
              )}
              <AgentPaneBody
                key={`${agent.provider}-${agent.switched ?? 0}`}
                agent={agent}
                workspace={workspaces[agent.id]}
                activeFile={activeFile}
                onWorkingChange={(busy) => setAgentWorking(agent.id, busy)}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Message texte ; `at` = heure système de son affichage (ms), ajoutée par `push`. */
type Line = { kind: "user" | "assistant" | "info" | "error"; text: string; at?: number };

/** Heure d'un message au format du système (ex. « 14:32 »). */
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });

function MessageTime({ at }: { at?: number }) {
  if (!at) return null;
  const date = new Date(at);
  return (
    <time className="message-time" dateTime={date.toISOString()} title={date.toLocaleString("en-US")}>
      {timeFormat.format(date)}
    </time>
  );
}

/** Intervalle de revérification pendant une installation ou une connexion. */
const POLL_MS = 3000;

/** Panneau Claude Code : vérifie que la CLI est installée et connectée à un
 *  abonnement, propose sinon de l'installer ou de se connecter, puis ouvre la session. */
export function ClaudePanel({ cwd, activeFile, width, expanded }: Props) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  // Une installation ou une connexion a été lancée : on revérifie régulièrement.
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    claude.status().then(setStatus, (err) => setNotice(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const ready = status?.installed && status.loggedIn;

  // Agents et conversations du projet (`.fast/agents.json`), rouverts tels quels.
  const [saved, setSaved] = useState<SavedProject | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setSaved(undefined);
    loadProjectAgents(cwd).then((project) => {
      if (cancelled) return;
      beginProject(cwd, project);
      setSaved(project);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!waiting || ready) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, ready, refresh]);

  const launch = (command: string | null | undefined) => {
    if (!command) return;
    if (runInTerminal(command)) {
      setNotice(null);
      setWaiting(true);
    } else {
      setNotice("The terminal is not ready yet. Try again in a moment.");
    }
  };

  return (
    <aside
      className={expanded ? "window claude-panel expanded" : "window claude-panel"}
      // Agrandie, la fenêtre prend toute la place : la largeur réglée ne s'applique plus.
      style={expanded ? undefined : { flexBasis: width }}
    >
      {ready ? (
        saved === undefined ? (
          <>
            <ClaudeHeader busy />
            <div className="claude-setup">
              <p className="claude-setup-text">Restoring agents…</p>
            </div>
          </>
        ) : (
          <AgentTabs cwd={cwd} activeFile={activeFile} expanded={expanded} saved={saved} />
        )
      ) : (
        <>
          <ClaudeHeader busy={!status || waiting} />
          <div className="claude-setup">
            {!status ? (
              <p className="claude-setup-text">Checking Claude Code…</p>
            ) : !status.installed ? (
              <>
                <h3>Install Claude Code</h3>
                <p className="claude-setup-text">
                  FAST runs the official Claude Code CLI with your Claude subscription. The installer runs in the
                  terminal below.
                </p>
                <button className="setup-button" onClick={() => launch(status.installCommand)}>
                  Install Claude Code
                </button>
              </>
            ) : (
              <>
                <h3>Sign in to Claude</h3>
                <p className="claude-setup-text">
                  Use your Claude account (Pro, Max, Team…). A browser page opens; if a code is shown, paste it in the
                  terminal below.
                </p>
                <button className="setup-button" onClick={() => launch(status.loginCommand)}>
                  Sign in to Claude
                </button>
              </>
            )}
            {waiting && <p className="claude-setup-text">Waiting for the terminal to finish…</p>}
            {notice && <p className="claude-setup-error">{notice}</p>}
            {status && (
              <button className="setup-link" onClick={refresh}>
                Check again
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** Session de discussion avec le véritable agent Claude Code (piloté par Rust). */
/** Corps d'un panneau d'agent : attente de son espace de travail, puis sa session. */
function AgentPaneBody({
  agent,
  workspace,
  activeFile,
  onWorkingChange,
}: {
  agent: Agent;
  workspace: AgentWorkspace | { error: string } | undefined;
  activeFile: string | null;
  onWorkingChange: (working: boolean) => void;
}) {
  if (!workspace) {
    return (
      <div className="claude-setup">
        <p className="claude-setup-text">Preparing workspace…</p>
      </div>
    );
  }
  if ("error" in workspace) {
    return (
      <div className="claude-setup">
        <p className="claude-setup-error">Could not prepare the workspace: {workspace.error}</p>
      </div>
    );
  }
  return (
    <ClaudeSession
      agentId={agent.id}
      index={agent.index}
      providerId={agent.provider}
      saved={agent.saved}
      name={agent.name}
      color={agent.color}
      branch={workspace.branch}
      isolated={!workspace.notice}
      cwd={workspace.cwd}
      notice={workspace.notice}
      activeFile={activeFile}
      onWorkingChange={onWorkingChange}
    />
  );
}

interface SessionProps {
  agentId: string;
  /** IA de la session : Claude Code, Codex ou Gemini. */
  providerId: ProviderId;
  /** Ordre de création de l'agent : clé de son état enregistré. */
  index: number;
  /** Conversation d'une session précédente, à restaurer. */
  saved?: SavedAgent;
  /** Couleur de la mascotte de l'agent. */
  color: string;
  /** Branche git de l'agent (ou branche principale pour l'agent du projet). */
  branch: string | null;
  /** L'agent travaille dans son propre worktree. */
  isolated: boolean;
  /** Avertissement sur l'espace de travail (ex. git absent : pas d'isolation). */
  notice: string | null;
  /** Nom de l'agent, utilisé dans le champ de saisie (« Ask Prime anything… »). */
  name: string;
  cwd: string;
  activeFile: string | null;
  /** Prévient l'onglet quand l'agent commence ou finit de travailler (mascotte). */
  onWorkingChange: (working: boolean) => void;
}

const provider = CLAUDE_CODE;

/** Élément de la conversation : message, ou étape de travail de l'IA mise à jour en direct. */
type Item =
  | Line
  | { kind: "thinking"; id: string; startedAt: number; endedAt?: number }
  | { kind: "tool"; id: string; name: string; input?: Record<string, unknown>; status: "running" | "done" | "error" }
  | { kind: "step"; id: string; stage: string; label: string; status: OrchestratorStatus; detail: string | null }
  | { kind: "commit"; id: string; message: string }
  | {
      kind: "permission";
      /** `request_id` de Claude Code, à renvoyer avec la réponse. */
      id: string;
      sessionId: string;
      tool: string;
      input: Record<string, unknown>;
      status: "pending" | "allowed" | "denied";
    };

interface Block {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  content_block?: Block;
  delta?: { type?: string; text?: string };
}

function ClaudeSession({ agentId, index, providerId, saved, color, branch, isolated, notice, name, cwd, activeFile, onWorkingChange }: SessionProps) {
  // IA de la session : modèles, noms et niveaux d'effort (ceux de Codex dépendent du compte).
  const ai = PROVIDERS[providerId];
  const isCodex = providerId === "codex";
  const isGemini = providerId === "gemini";
  const codexModels = useCodexModels(isCodex);
  const aiModels = isCodex ? toAgentModels(codexModels) : ai.models;
  // Session active, `null` tant que le processus n'est pas prêt ou après sa fin.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>(() => restoreItems(saved?.items));
  // Réponse en cours d'écriture, alimentée morceau par morceau ; remplacée par
  // le message complet quand il arrive.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | null>(saved?.model ?? null);
  // Niveaux d'effort : ceux de Codex sont filtrés selon le modèle choisi.
  const supported = codexModels.find((m) => m.id === model)?.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const efforts = isCodex
    ? CODEX_EFFORTS.filter((e) => e.id === null || !supported || supported.includes(e.id))
    : effortsFor(providerId);
  const [effort, setEffort] = useState<string | null>(saved?.effort ?? null);
  // Ultracode activé : le mot-clé est ajouté à chaque message (sans relancer la session).
  const [ultracode, setUltracode] = useState(saved?.ultracode ?? false);
  // `undefined` : jamais défini (option non transmise) ; `null` : retiré.
  const [systemPrompt, setSystemPrompt] = useState<string | null | undefined>(saved?.systemPrompt);
  // Limite de jetons fixée dans la fenêtre de l'agent : atteinte, plus de nouvelle demande.
  const rosterEntry = useAgentRoster().find((a) => a.id === agentId);
  const overLimit = !!rosterEntry && limitReached(rosterEntry);
  // Modèle annoncé par Claude Code au démarrage de la session (ex. claude-opus-5-5).
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  // Conversation côté Claude Code : reprise quand on change de modèle.
  const conversation = useRef<string | null>(saved?.conversation ?? null);
  // Dernière demande de l'utilisateur : sert de message de commit à l'orchestrateur.
  const lastPrompt = useRef<string | null>(null);
  // Tour arrêté par l'utilisateur (bouton Stop) : sa fin n'est ni une erreur ni une tâche terminée.
  const interrupted = useRef(false);
  // Totaux de la session Claude Code (coût, jetons par modèle) au tour précédent.
  const sessionTotals = useRef<SessionTotals | null>(null);
  // « Allow all » choisi : les demandes d'autorisation suivantes sont acceptées d'office.
  const allowAll = useRef(false);
  // Demandes de l'utilisateur, pour le résumé en une ligne de la conversation.
  const prompts = useRef<string[]>(saved?.prompts ?? []);

  // Conversation et réglages enregistrés à chaque changement (écriture regroupée).
  useEffect(() => {
    saveAgent(index, {
      name,
      provider: providerId,
      conversation: conversation.current,
      model,
      effort,
      ultracode,
      systemPrompt,
      prompts: prompts.current.slice(-20),
      items: items.slice(-MAX_SAVED_ITEMS),
    });
  }, [index, name, providerId, items, model, effort, ultracode, systemPrompt]);
  const summarySeq = useRef(0);
  // Commande « / » du tour en cours, et texte de la réponse (pour /commit).
  const turnCommand = useRef<AgentCommand | null>(null);
  const turnText = useRef("");
  const bottom = useRef<HTMLDivElement>(null);

  const updateItems = (match: (item: Item) => boolean, patch: (item: Item) => Item) =>
    setItems((prev) => prev.map((item) => (match(item) ? patch(item) : item)));

  // Chaque message texte reçoit l'heure système au moment où il s'affiche.
  const push = (...l: Item[]) =>
    setItems((prev) => [...prev, ...l.map((item) => ("text" in item && !item.at ? { ...item, at: Date.now() } : item))]);

  // L'agent « travaille » tant que Claude répond ou que l'orchestrateur traite
  // sa tâche (commit, build, merge) ; la fonction reçue change à chaque rendu.
  const pipelineRunning = items.some((item) => item.kind === "step" && item.status === "running");
  const working = busy || pipelineRunning;
  const workingChanged = useRef(onWorkingChange);
  workingChanged.current = onWorkingChange;
  useEffect(() => workingChanged.current(working), [working]);
  // Modèle affiché dans le panneau Agents : celui choisi, ou celui annoncé par Claude Code.
  const modelLabel = model === null ? resolvedModel : (aiModels.find((m) => m.id === model)?.label ?? model);
  // Lu par le gestionnaire des messages de Claude (installé une seule fois par session).
  const modelLabelRef = useRef(modelLabel);
  modelLabelRef.current = modelLabel;
  useEffect(() => updateAgent(agentId, { model: modelLabel, modelId: model }), [agentId, model, modelLabel]);
  useEffect(() => updateAgent(agentId, { effort }), [agentId, effort]);
  // Session en cours : relie les tâches du planificateur (vérifications, previews) à l'agent.
  useEffect(() => updateAgent(agentId, { sessionId }), [agentId, sessionId]);
  useEffect(() => updateAgent(agentId, { systemPrompt: systemPrompt ?? null }), [agentId, systemPrompt]);
  useEffect(() => {
    if (overLimit) push({ kind: "info", text: "Token limit reached: raise it in the agent's options to continue." });
  }, [overLimit]);
  // L'orchestrateur ne met à jour que les agents inactifs. Seul Claude compte :
  // les étapes de l'orchestrateur ne doivent pas bloquer leur propre intégration.
  useEffect(() => {
    agentsApi.setBusy(agentId, busy).catch(() => {});
  }, [agentId, busy]);

  useEffect(() => {
    if (notice) push({ kind: "info", text: notice });
  }, [notice]);

  // Étapes de l'orchestrateur pour cet agent : une ligne par étape, mise à jour en direct.
  useEffect(() => {
    const unlisten = agentsApi.onOrchestratorEvent((event) => {
      if (event.agentId !== agentId) return;
      const id = `${event.runId}:${event.stage}`;
      const step: Item = { kind: "step", id, stage: event.stage, label: event.label, status: event.status, detail: event.detail };
      setItems((prev) =>
        prev.some((item) => item.kind === "step" && item.id === id)
          ? prev.map((item) => (item.kind === "step" && item.id === id ? step : item))
          : [...prev, step],
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [agentId]);

  useEffect(() => {
    // Un identifiant par exécution de l'effet : en StrictMode, l'effet est
    // monté deux fois et chaque montage doit avoir sa propre session.
    const id = crypto.randomUUID();
    let disposed = false;
    // Réflexion en cours (bloc `thinking` ouvert), pour en mesurer la durée.
    let thinkingId: string | null = null;

    const update = (match: (item: Item) => boolean, patch: (item: Item) => Item) =>
      setItems((prev) => prev.map((item) => (match(item) ? patch(item) : item)));

    const endThinking = () => {
      if (!thinkingId) return;
      const ended = thinkingId;
      thinkingId = null;
      update(
        (item) => item.kind === "thinking" && item.id === ended,
        (item) => ({ ...item, endedAt: Date.now() }),
      );
    };

    /** Événements de `--include-partial-messages` : début / morceaux / fin d'un bloc. */
    const onStreamEvent = (event: StreamEvent | undefined) => {
      if (event?.type === "content_block_start" && event.content_block) {
        const block = event.content_block;
        if (block.type === "thinking") {
          thinkingId = crypto.randomUUID();
          push({ kind: "thinking", id: thinkingId, startedAt: Date.now() });
        } else if (block.type === "tool_use" && block.id) {
          push({ kind: "tool", id: block.id, name: block.name ?? "tool", status: "running" });
        }
      } else if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text ?? "";
        setDraft((d) => (d ?? "") + text);
      } else if (event?.type === "content_block_stop") {
        endThinking();
      }
    };

    const onMessage = (msg: ClaudeMessage) => {
      switch (msg.type) {
        case "stream_event":
          onStreamEvent(msg.event as StreamEvent | undefined);
          return;
        case "control_request": {
          // Claude Code demande l'autorisation de lancer une commande, d'écrire hors du projet…
          const request = msg.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> } | undefined;
          const requestId = String(msg.request_id ?? "");
          if (request?.subtype !== "can_use_tool" || !requestId) return;
          const tool = request.tool_name ?? "tool";
          const input = request.input ?? {};
          // Un push n'est jamais accepté d'office : toujours l'accord explicite de l'utilisateur.
          if (allowAll.current && tool !== "GitPush") {
            claude.permission(id, requestId, true, input).catch(() => {});
            return;
          }
          push({ kind: "permission", id: requestId, sessionId: id, tool, input, status: "pending" });
          const action = provider.describeTool(tool, input).running;
          notify({ agentId, agentName: name, agentColor: color, kind: "question", title: `${name} needs your approval`, body: excerpt(action) });
          return;
        }
        case "system":
          if (typeof msg.session_id === "string") conversation.current = msg.session_id;
          if (msg.subtype === "init" && typeof msg.model === "string") {
            const name = ai.formatModelName(msg.model);
            setResolvedModel(name);
            push({ kind: "info", text: `Session ready · ${name}` });
          }
          return;
        case "assistant": {
          // Un message complet par bloc : il remplace le texte en cours et
          // complète les paramètres de l'outil annoncé plus tôt.
          for (const block of (msg.message as { content?: Block[] } | undefined)?.content ?? []) {
            if (block.type === "text" && block.text) {
              setDraft(null);
              turnText.current += `${block.text}\n`;
              push({ kind: "assistant", text: block.text });
            } else if (block.type === "tool_use" && block.id) {
              const toolId = block.id;
              setItems((prev) =>
                prev.some((item) => item.kind === "tool" && item.id === toolId)
                  ? prev.map((item) =>
                      item.kind === "tool" && item.id === toolId ? { ...item, input: block.input } : item,
                    )
                  : [...prev, { kind: "tool", id: toolId, name: block.name ?? "tool", input: block.input, status: "running" }],
              );
            }
          }
          return;
        }
        case "user":
          // Résultats d'outils : l'action est terminée (ou a échoué).
          for (const block of (msg.message as { content?: Block[] } | undefined)?.content ?? []) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const toolId = block.tool_use_id;
              update(
                (item) => item.kind === "tool" && item.id === toolId,
                (item) => (item.kind === "tool" ? { ...item, status: block.is_error ? "error" : "done" } : item),
              );
            }
          }
          return;
        case "result":
          endThinking();
          setDraft(null);
          setBusy(false);
          if (providerId === "claude-code") {
            const totals = sessionTotals.current;
            sessionTotals.current = totalsOf(msg);
            addUsage(agentId, perTurn(msg, totals), ai.formatModelName, modelLabelRef.current);
          } else {
            addUsage(agentId, msg, ai.formatModelName, modelLabelRef.current);
          }
          if (interrupted.current) {
            interrupted.current = false;
            turnCommand.current = null;
            push({ kind: "info", text: "Stopped" });
            return;
          }
          {
            const command = turnCommand.current;
            turnCommand.current = null;
            // Notification : erreur, question posée à la fin de la réponse, ou tâche terminée.
            const reply = turnText.current.trim();
            if (!msg.is_error) summarize(reply);
            const question = trailingQuestion(reply);
            const who = { agentId, agentName: name, agentColor: color };
            if (msg.is_error) {
              notify({ ...who, kind: "error", title: `${name} ran into an error`, body: excerpt(String(msg.result ?? "")) });
            } else if (question) {
              notify({ ...who, kind: "question", title: `${name} has a question`, body: excerpt(question) });
            } else {
              const task = lastPrompt.current ? excerpt(lastPrompt.current, 80) : "";
              notify({ ...who, kind: "done", title: `${name} finished${task ? `: ${task}` : " a task"}`, body: excerpt(reply) });
            }
            if (msg.is_error) {
              push({ kind: "error", text: String(msg.result ?? "Error") });
            } else if (command?.kind === "commit") {
              // /commit : le message proposé, à valider avant le commit.
              const message = extractCommitMessage(turnText.current);
              if (message) push({ kind: "commit", id: crypto.randomUUID(), message });
              else push({ kind: "info", text: "No commit message was proposed." });
            } else if (!command?.readOnly) {
              // Tâche terminée : l'orchestrateur ramène le travail sur la branche principale.
              // (Les commandes en lecture seule ne modifient rien : pas de commit automatique.)
              agentsApi.taskFinished(agentId, lastPrompt.current).catch(() => {});
            }
          }
          return;
      }
    };

    const unlisten = claude.onEvent(({ sessionId: eventId, event }) => {
      if (eventId !== id) return;
      switch (event.type) {
        case "message":
          onMessage(event.data);
          break;
        case "stderr":
          push({ kind: "error", text: event.data });
          break;
        case "raw":
          push({ kind: "info", text: event.data });
          break;
        case "exit":
          push({ kind: "info", text: `Session ended (code ${event.data ?? "?"})` });
          setSessionId(null);
          setBusy(false);
          setDraft(null);
          break;
      }
    });

    // acceptEdits : l'agent modifie les fichiers sans demander ; tout est versionné par git.
    // Une fois défini (même retiré), transmis à chaque démarrage pour remplacer l'ancien.
    sessionTotals.current = null;
    const prompt = systemPrompt === undefined ? null : (systemPrompt ?? "");
    const started = (
      isCodex
        ? codex.start(id, cwd, { model, effort, systemPrompt: prompt, resume: conversation.current })
        : isGemini
          ? gemini.start(id, cwd, { model, systemPrompt: prompt, resume: conversation.current })
          : claude.start(id, cwd, { permissionMode: "acceptEdits", model, effort, systemPrompt: prompt, resume: conversation.current })
    ).then(
      () => {
        if (!disposed) setSessionId(id);
      },
      (err) => {
        if (!disposed) push({ kind: "error", text: String(err) });
      },
    );

    return () => {
      disposed = true;
      setSessionId(null);
      unlisten.then((fn) => fn());
      // Attendre la fin du démarrage pour que l'arrêt ne le précède jamais.
      started.then(() => claude.stop(id)).catch(() => {});
    };
    // Changer de modèle, d'effort ou de prompt système relance la session sur la même conversation.
  }, [cwd, model, effort, systemPrompt]);

  const changeModel = (next: string | null) => {
    if (next === model) return;
    const label = aiModels.find((m) => m.id === next)?.label ?? next;
    push({ kind: "info", text: `Model: ${label}` });
    setBusy(false);
    // Le modèle réel sera annoncé à nouveau par la prochaine session.
    setResolvedModel(null);
    setModel(next);
  };
  const changeEffort = (next: string | null) => {
    if (next === effort) return;
    const label = efforts.find((e) => e.id === next)?.label ?? next;
    push({ kind: "info", text: `Effort: ${label}` });
    setBusy(false);
    setEffort(next);
  };
  const changeEffortRef = useRef(changeEffort);
  changeEffortRef.current = changeEffort;
  useEffect(
    () => onEffortChangeRequest((id, next) => id === agentId && changeEffortRef.current(next)),
    [agentId],
  );

  const changeSystemPrompt = (next: string | null) => {
    if (next === (systemPrompt ?? null)) return;
    push({ kind: "info", text: next ? "System prompt updated" : "System prompt removed" });
    setBusy(false);
    setSystemPrompt(next);
  };
  const changeSystemPromptRef = useRef(changeSystemPrompt);
  changeSystemPromptRef.current = changeSystemPrompt;
  useEffect(
    () => onSystemPromptChangeRequest((id, next) => id === agentId && changeSystemPromptRef.current(next)),
    [agentId],
  );

  // Choix du modèle depuis la fenêtre de l'agent (panneau Agents).
  const changeModelRef = useRef(changeModel);
  changeModelRef.current = changeModel;
  useEffect(
    () => onModelChangeRequest((id, next) => id === agentId && changeModelRef.current(next)),
    [agentId],
  );

  // Accolades obligatoires : scrollIntoView renvoie une Promise dans les
  // WebView récentes, et React refuse tout retour d'effet qui n'est pas une fonction.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items, draft]);

  const running = sessionId !== null;
  // Rien de visible n'avance (ni texte, ni réflexion, ni outil) : on l'indique.
  const idle =
    busy &&
    draft === null &&
    !items.some(
      (item) => (item.kind === "tool" && item.status === "running") || (item.kind === "thinking" && !item.endedAt),
    );

  /**
   * Résumé en une ligne de la conversation (affiché en mode Vibe), écrit par un
   * modèle rapide après chaque tour à partir des dernières demandes et de la réponse.
   */
  const summarize = (reply: string) => {
    const seq = ++summarySeq.current;
    const requests = prompts.current.slice(-4).map((p) => `User: ${p.slice(0, 400)}`).join("\n");
    const prompt = `Summarize in one short line (max 12 words, no final period, in English) what this AI coding agent is working on and in which part of the project. Reply with the line only.

${requests}
Agent: ${reply.slice(0, 1500)}`;
    claude
      .quick(prompt)
      .then((line) => {
        // Une réponse plus ancienne arrivée en retard ne remplace pas la dernière.
        const summary = line.split("\n")[0].replace(/^["'\s]+|["'.\s]+$/g, "");
        if (seq === summarySeq.current && summary) updateAgent(agentId, { summary });
      })
      .catch(() => {});
  };

  /** Arrête le tour en cours ; la conversation continue au message suivant. */
  const stop = () => {
    if (!sessionId || interrupted.current) return;
    interrupted.current = true;
    // Les demandes d'autorisation en attente n'attendent plus de réponse.
    updateItems(
      (x) => x.kind === "permission" && x.status === "pending",
      (x) => (x.kind === "permission" ? { ...x, status: "denied" } : x),
    );
    claude.interrupt(sessionId).catch((err) => {
      interrupted.current = false;
      push({ kind: "error", text: String(err) });
    });
  };

  const submit = async (text: string, attachments: Attachment[]) => {
    if (!sessionId || overLimit) return;
    interrupted.current = false;
    prompts.current.push(text);
    // « /review … » : le prompt préparé de la commande, complété par le reste du texte.
    const parsed = parseCommand(text);
    turnCommand.current = parsed?.command ?? null;
    turnText.current = "";
    const base = parsed ? parsed.command.prompt(parsed.args) : text;
    // /ultracode contient déjà le mot-clé ; l'option l'ajoute aux autres messages.
    const prompt = ultracode && providerId === "claude-code" && parsed?.command.name !== "ultracode" ? withUltracode(base) : base;
    lastPrompt.current = text;
    setBusy(true);
    push({
      kind: "user",
      text: attachments.length ? `${text}\nContext: ${attachments.map((a) => a.name).join(", ")}` : text,
    });
    try {
      await claude.send(sessionId, ai.formatPrompt(prompt, attachments));
    } catch (err) {
      setBusy(false);
      push({ kind: "error", text: String(err) });
    }
  };

  return (
    <>
      <div className="claude-log">
        {/* Avant le premier message : la mascotte de l'agent se présente */}
        {!items.some((item) => item.kind === "user") && (
          <AgentIntro name={name} color={color} branch={branch} isolated={isolated} working={working} />
        )}
        {items.map((item, i) =>
          item.kind === "thinking" ? (
            <ThinkingRow key={item.id} startedAt={item.startedAt} endedAt={item.endedAt} />
          ) : item.kind === "tool" ? (
            <ToolRow key={item.id} name={item.name} input={item.input} status={item.status} />
          ) : item.kind === "step" ? (
            <StepRow
              key={item.id}
              stage={item.stage}
              label={item.label}
              status={item.status}
              detail={item.detail}
              // Build cassé sur la branche principale : l'agent vérifie ses dépendances (/deps).
              onCheckDeps={
                item.stage === "build" && item.status === "error" && running && !busy
                  ? () => submit(`/deps ${(item.detail ?? "").slice(-3000)}`.trim(), [])
                  : undefined
              }
            />
          ) : item.kind === "permission" ? (
            <PermissionCard
              key={item.id}
              item={item}
              onAnswer={(allow, all) => {
                if (all) allowAll.current = true;
                updateItems(
                  (x) => x.kind === "permission" && x.id === item.id,
                  (x) => (x.kind === "permission" ? { ...x, status: allow ? "allowed" : "denied" } : x),
                );
                claude.permission(item.sessionId, item.id, allow, item.input).catch((err) => push({ kind: "error", text: String(err) }));
                // « Allow all » : les autres demandes encore en attente sont acceptées aussi.
                if (all) {
                  for (const other of items) {
                    if (other.kind === "permission" && other.status === "pending" && other.id !== item.id && other.tool !== "GitPush") {
                      claude.permission(other.sessionId, other.id, true, other.input).catch(() => {});
                    }
                  }
                  updateItems(
                    (x) => x.kind === "permission" && x.status === "pending" && x.tool !== "GitPush",
                    (x) => (x.kind === "permission" ? { ...x, status: "allowed" } : x),
                  );
                }
              }}
            />
          ) : item.kind === "commit" ? (
            <CommitCard key={item.id} cwd={cwd} message={item.message} canPush={!isolated} />
          ) : (
            // Réponses, étapes et erreurs ont leur point sur le fil (classe « tl ») ; les
            // messages de l'utilisateur et les infos (« Session ready »…) restent au-dessus.
            item.kind === "user" ? (
              <div key={i} className="user-message">
                <div className="claude-line user">{item.text}</div>
                <MessageTime at={item.at} />
              </div>
            ) : (
              <div key={i} className={item.kind === "info" ? "claude-line info" : `claude-line ${item.kind} tl`}>
                {item.kind === "assistant" ? <Markdown text={item.text} /> : item.text}
                {item.kind === "assistant" && <MessageTime at={item.at} />}
              </div>
            )
          ),
        )}
        {draft !== null && (
          <div className="claude-line assistant streaming tl">
            <Markdown text={draft} />
            <span className="caret" aria-hidden="true" />
          </div>
        )}
        {idle && (
          <div className="activity running tl">
            <UiIcon name="lucide:loader-circle" className="activity-row-icon spin" />
            <span className="activity-text shimmer">Working…</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="claude-input">
        <Composer
          models={aiModels}
          model={model}
          // Seul le modèle par défaut a besoin d'être précisé ; il est réinitialisé à chaque changement.
          resolvedModel={model === null ? resolvedModel : null}
          onModelChange={changeModel}
          efforts={efforts}
          effort={effort}
          onEffortChange={changeEffort}
          ai={PROVIDER_INFO[providerId]}
          ultracode={ultracode}
          onUltracodeChange={providerId !== "claude-code" ? undefined : (on) => {
            setUltracode(on);
            push({ kind: "info", text: on ? "Ultracode on: multi-agent orchestration for every message" : "Ultracode off" });
          }}
          root={cwd}
          activeFile={activeFile}
          disabled={!running || overLimit}
          busy={busy}
          onStop={stop}
          placeholder={overLimit ? "Token limit reached" : running ? `Ask ${name} anything…` : `Starting ${name}…`}
          onSubmit={submit}
        />
      </div>
    </>
  );
}

/** Durée lisible : « 2s », « 1m 05s ». */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** « Thinking… 3s » pendant la réflexion (compteur en direct), puis « Thought for 3s ». */
function ThinkingRow({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endedAt]);

  return endedAt ? (
    <div className="activity tl">
      <UiIcon name="lucide:brain" className="activity-row-icon" />
      <span className="activity-text">Thought for {formatDuration(endedAt - startedAt)}</span>
    </div>
  ) : (
    <div className="activity running tl">
      <UiIcon name="lucide:brain" className="activity-row-icon" />
      <span className="activity-text shimmer">Thinking… {formatDuration(now - startedAt)}</span>
    </div>
  );
}

interface ToolRowProps {
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "done" | "error";
}

/** Action de l'IA : en cours (animée), terminée, ou en échec. */
function ToolRow({ name, input, status }: ToolRowProps) {
  const tool = provider.describeTool(name, input);
  const icon = status === "running" ? "lucide:loader-circle" : status === "error" ? "lucide:circle-alert" : tool.icon;
  const text =
    status === "running" ? `${tool.running}…` : status === "error" ? `Failed: ${tool.running.toLowerCase()}` : tool.done;
  return (
    <div className={`activity ${status} tl`}>
      <UiIcon name={icon} className={status === "running" ? "activity-row-icon spin" : "activity-row-icon"} />
      <span className={status === "running" ? "activity-text shimmer" : "activity-text"}>{text}</span>
    </div>
  );
}

/** Icône de chaque étape de l'orchestrateur. */
const STEP_ICONS: Record<string, string> = {
  commit: "lucide:git-commit-horizontal",
  queue: "lucide:list-todo",
  integrate: "lucide:git-merge",
  sync: "lucide:refresh-cw",
  build: "lucide:hammer",
  merge: "lucide:git-merge",
};

/** Étape de l'orchestrateur ; en cas d'erreur, le détail (sortie du build…) se déplie. */
function StepRow({
  stage,
  label,
  status,
  detail,
  onCheckDeps,
}: {
  stage: string;
  label: string;
  status: OrchestratorStatus;
  detail: string | null;
  /** Build cassé : demander à l'agent de vérifier ses dépendances. */
  onCheckDeps?: () => void;
}) {
  const icon = status === "running" ? "lucide:loader-circle" : status === "error" ? "lucide:circle-alert" : (STEP_ICONS[stage] ?? "lucide:wrench");
  const row = (
    <>
      <UiIcon name={icon} className={status === "running" ? "activity-row-icon spin" : "activity-row-icon"} />
      <span className={status === "running" ? "activity-text shimmer" : "activity-text"}>
        {status === "running" ? `${label}…` : label}
      </span>
    </>
  );
  if (status === "error" && detail) {
    return (
      <details className="activity error tl step-details">
        <summary>{row}</summary>
        <pre className="step-detail">{detail}</pre>
        {onCheckDeps && (
          <button className="secondary-button step-action" onClick={onCheckDeps}>
            <UiIcon name="lucide:wrench" className="secondary-button-icon" />
            Check dependencies
          </button>
        )}
      </details>
    );
  }
  return <div className={`activity ${status} tl`}>{row}</div>;
}

/** Présentation d'un agent dans sa conversation vide : mascotte + message. */
function AgentIntro({
  name,
  color,
  branch,
  isolated,
  working,
}: {
  name: string;
  color: string;
  branch: string | null;
  isolated: boolean;
  working: boolean;
}) {
  return (
    <div className="agent-intro">
      <AgentMascot color={color} working={working} size={56} />
      <div className="agent-intro-title">Hi, I'm {name}!</div>
      <p className="agent-intro-text">
        {isolated ? (
          <>
            I work in my own copy of the project{branch && <> on <code>{branch}</code></>}, so I never get in the way of
            the other agents. When I finish a task, my work is built and merged automatically.
          </>
        ) : (
          <>
            I work directly in your project{branch && <> on <code>{branch}</code></>}. Ask me to explain, fix or build
            anything — I can read and edit your files.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Commit proposé par /commit : message modifiable, puis commit (et push pour
 * l'agent du projet) par la gestion Git de FAST, comme le panneau Git.
 */
function CommitCard({ cwd, message, canPush }: { cwd: string; message: string; canPush: boolean }) {
  const [text, setText] = useState(message);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });

  const commit = async (push: boolean) => {
    setState({ kind: "busy", text: push ? "Committing and pushing…" : "Committing…" });
    try {
      const hash = await scm.commit(cwd, text);
      if (push) await scm.push(cwd);
      setState({ kind: "done", text: push ? `Committed ${hash} and pushed` : `Committed ${hash}` });
    } catch (e) {
      setState({ kind: "error", text: String(e) });
    }
  };

  const locked = state.kind === "busy" || state.kind === "done";

  return (
    <div className="commit-card tl">
      <div className="commit-card-title">
        <UiIcon name="lucide:git-commit-horizontal" className="commit-card-icon" />
        Proposed commit
      </div>
      <textarea
        className="commit-card-message"
        value={text}
        disabled={locked}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="commit-card-actions">
        {state.text && <span className={state.kind === "error" ? "commit-card-status error" : "commit-card-status"}>{state.text}</span>}
        {state.kind !== "done" && (
          <>
            {canPush && (
              <button className="secondary-button" disabled={locked || !text.trim()} onClick={() => commit(true)}>
                Commit & Push
              </button>
            )}
            <button className="primary-button" disabled={locked || !text.trim()} onClick={() => commit(false)}>
              <UiIcon name="lucide:check" className="primary-button-icon" />
              Commit
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type PermissionItem = Extract<Item, { kind: "permission" }>;

/**
 * Demande d'autorisation d'un agent (commande à lancer, fichier hors du
 * projet…) : l'agent attend la réponse. « Allow all » vaut pour la suite de
 * la session de cet agent.
 */
function PermissionCard({ item, onAnswer }: { item: PermissionItem; onAnswer: (allow: boolean, all: boolean) => void }) {
  const tool = provider.describeTool(item.tool, item.input);
  const command = typeof item.input.command === "string" ? item.input.command : null;
  const path = typeof item.input.file_path === "string" ? item.input.file_path : null;
  // Push : la commande, puis l'adresse du dépôt distant.
  const remoteUrl = item.tool === "GitPush" && typeof item.input.url === "string" && item.input.url ? item.input.url : null;
  const detail = [command ?? path, remoteUrl].filter(Boolean).join("\n") || null;

  return (
    <div className={`permission-card ${item.status} tl`}>
      <div className="permission-title">
        <UiIcon name={item.status === "pending" ? "lucide:circle-alert" : tool.icon} className="permission-icon" />
        {item.status === "pending" ? `Wants to ${tool.running.charAt(0).toLowerCase()}${tool.running.slice(1)}` : tool.running}
      </div>
      {detail && <code className="permission-detail">{detail}</code>}
      {item.status === "pending" ? (
        <div className="permission-actions">
          <button className="secondary-button" onClick={() => onAnswer(false, false)}>
            Deny
          </button>
          {/* Publier sur GitHub : seulement au cas par cas */}
          {item.tool !== "GitPush" && (
            <button className="secondary-button" onClick={() => onAnswer(true, true)}>
              Allow all this session
            </button>
          )}
          <button className="primary-button" onClick={() => onAnswer(true, false)}>
            <UiIcon name="lucide:check" className="primary-button-icon" />
            Allow
          </button>
        </div>
      ) : (
        <div className={`permission-status ${item.status}`}>{item.status === "allowed" ? "Allowed" : "Denied"}</div>
      )}
    </div>
  );
}

/**
 * Conversation enregistrée → éléments à afficher. Ce qui était en cours à la
 * fermeture est clos (outils, réflexion), les demandes d'autorisation sans
 * réponse sont expirées (la session qui les attendait n'existe plus).
 */
function restoreItems(saved: unknown[] | undefined): Item[] {
  if (!saved?.length) return [];
  const items = (saved as Item[]).flatMap((item): Item[] => {
    switch (item.kind) {
      case "tool":
        return [item.status === "running" ? { ...item, status: "done" } : item];
      case "thinking":
        return [item.endedAt ? item : { ...item, endedAt: item.startedAt }];
      case "permission":
        return [item.status === "pending" ? { ...item, status: "denied" } : item];
      case "step":
        return item.status === "running" ? [] : [item];
      default:
        return [item];
    }
  });
  return [...items, { kind: "info", text: "Conversation restored", at: Date.now() }];
}

/** Coût et jetons par modèle cumulés depuis le début d'une session Claude Code. */
interface SessionTotals {
  cost: number;
  models: Record<string, Record<string, number>>;
}

const MODEL_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"];

function totalsOf(result: Record<string, unknown>): SessionTotals {
  const models: SessionTotals["models"] = {};
  for (const [name, m] of Object.entries((result.modelUsage ?? {}) as Record<string, Record<string, unknown>>)) {
    models[name] = Object.fromEntries(MODEL_FIELDS.map((f) => [f, typeof m[f] === "number" ? (m[f] as number) : 0]));
  }
  return { cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0, models };
}

/**
 * Message `result` ramené au seul tour : Claude Code y donne le coût et les jetons
 * par modèle cumulés sur la session (seul `usage` est propre au tour). Un total en
 * baisse signale une nouvelle session : il vaut alors pour le tour entier.
 */
function perTurn(result: Record<string, unknown>, previous: SessionTotals | null): Record<string, unknown> {
  const current = totalsOf(result);
  if (!previous || current.cost < previous.cost) return result;
  const modelUsage = Object.fromEntries(
    Object.entries(current.models).map(([name, m]) => [
      name,
      Object.fromEntries(MODEL_FIELDS.map((f) => [f, Math.max(0, m[f] - (previous.models[name]?.[f] ?? 0))])),
    ]),
  );
  return { ...result, total_cost_usd: current.cost - previous.cost, modelUsage };
}

/**
 * Bouton d'ajout d'un agent : menu des IA (Claude Code, Codex, Gemini). `label` : texte
 * à côté du « + » (en-tête du mode Vibe) ; sans, un simple « + » (onglets).
 */
function AddAgentMenu({ onAdd, label }: { onAdd: (provider: ProviderId) => void; label?: string }) {
  return (
    <Popover
      label="New agent"
      align={label ? "start" : "end"}
      // En haut de la fenêtre (onglets, en-tête du mode Vibe) : le menu s'ouvre vers le bas.
      placement="below"
      trigger={
        <>
          <UiIcon name="lucide:plus" className={label ? "agent-add-icon" : "agent-tab-add-icon"} />
          {label}
        </>
      }
      triggerClassName={label ? "agent-add-button" : "agent-tab-add"}
    >
      {(close) => (
        <ProviderMenuItems
          onPick={(p) => {
            close();
            onAdd(p);
          }}
        />
      )}
    </Popover>
  );
}
