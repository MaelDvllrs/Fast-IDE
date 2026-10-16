import { useCallback, useEffect, useRef, useState } from "react";
import { CLAUDE_CODE, type Attachment } from "../agents/providers";
import {
  agents as agentsApi,
  claude,
  type AgentWorkspace,
  type ClaudeMessage,
  type ClaudeStatus,
  type OrchestratorStatus,
} from "../lib/ipc";
import { runInTerminal } from "../lib/terminalBus";
import { AgentMascot } from "./AgentMascot";
import { Composer } from "./Composer";
import { UiIcon } from "./fileIcons";

interface Props {
  cwd: string;
  /** Fichier ouvert dans l'éditeur, proposé comme contexte. */
  activeFile: string | null;
  /** Largeur en px, réglée par la poignée de redimensionnement. */
  width: number;
  /** Mode agentic : la fenêtre occupe tout l'espace de travail. */
  expanded: boolean;
  onToggleExpanded: () => void;
}

type ExpandProps = Pick<Props, "expanded" | "onToggleExpanded">;
type HeaderProps = ExpandProps & { busy: boolean };

/** Bascule du mode agentic (fenêtre agrandie). */
function ExpandButton({ expanded, onToggleExpanded }: ExpandProps) {
  const label = expanded ? "Exit agentic mode" : "Agentic mode";
  return (
    <button className="title-icon-button end" title={label} aria-label={label} aria-pressed={expanded} onClick={onToggleExpanded}>
      <UiIcon name={expanded ? "lucide:minimize-2" : "lucide:maximize-2"} className="title-icon" />
    </button>
  );
}

/** En-tête avant l'ouverture des agents (installation, connexion). */
function ClaudeHeader({ busy, ...expand }: HeaderProps) {
  return (
    <header className="panel-header">
      <span className="panel-title">Claude Code</span>
      {busy && <span className="spinner">●</span>}
      <ExpandButton {...expand} />
    </header>
  );
}

/** Couleurs de contour des mascottes, attribuées aux agents dans l'ordre. */
const AGENT_COLORS = ["#b3a42b", "#61afef", "#c678dd", "#98c379", "#e5707a", "#56b6c2", "#d19a66"];

interface Agent {
  id: string;
  /** Ordre de création : 0 travaille dans le projet, les suivants dans un worktree. */
  index: number;
  name: string;
  color: string;
}

/** Colonnes de la grille du mode large selon le nombre d'agents :
 *  1 → 1, 2 → 2, 3 → 3, 4 → 2×2, 5-6 → 3×2, 7-9 → 3×3… */
const gridColumns = (count: number) => (count <= 3 ? count : Math.ceil(Math.sqrt(count)));

/**
 * Agents ouverts dans la fenêtre IA. Mode normal : un onglet par agent, seul
 * l'actif est affiché. Mode large : tous les agents dans une grille, déplaçables
 * en glissant leur en-tête. Les mêmes sessions servent aux deux modes (elles ne
 * sont jamais remontées), et un agent masqué continue de travailler.
 */
function AgentTabs({ cwd, activeFile, ...expand }: { cwd: string; activeFile: string | null } & ExpandProps) {
  // Le n-ième agent créé : nom et couleur suivent l'ordre de création.
  const agentAt = (n: number): Agent => ({
    id: crypto.randomUUID(),
    index: n,
    name: `Agent ${n + 1}`,
    color: AGENT_COLORS[n % AGENT_COLORS.length],
  });
  const [agents, setAgents] = useState<Agent[]>(() => [agentAt(0)]);
  // Agents déjà créés (le premier inclus) ; n'augmente qu'à l'ajout d'un agent.
  const created = useRef(1);
  const makeAgent = () => agentAt(created.current++);
  const [activeId, setActiveId] = useState(agents[0].id);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  // Espace de travail de chaque agent, préparé côté Rust (worktree à partir du 2e).
  const [workspaces, setWorkspaces] = useState<Record<string, AgentWorkspace | { error: string }>>({});
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
  const grid = expand.expanded;

  const add = () => {
    const agent = makeAgent();
    setAgents((prev) => [...prev, agent]);
    setActiveId(agent.id);
  };

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
    // L'orchestrateur ne met à jour que les agents inactifs.
    agentsApi.setBusy(id, busy).catch(() => {});
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

  const columns = gridColumns(agents.length);

  return (
    <>
      {grid ? (
        <header className="panel-header agent-grid-toolbar">
          <span className="panel-title">Agents</span>
          <span className="agent-count">{agents.length}</span>
          <button className="agent-tab-add" title="New agent" aria-label="New agent" onClick={add}>
            <UiIcon name="lucide:plus" className="agent-tab-add-icon" />
          </button>
          <ExpandButton {...expand} />
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
            <button className="agent-tab-add" title="New agent" aria-label="New agent" onClick={add}>
              <UiIcon name="lucide:plus" className="agent-tab-add-icon" />
            </button>
          </div>
          <ExpandButton {...expand} />
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
              hidden={!grid && agent.id !== activeId}
              onPointerDownCapture={() => setActiveId(agent.id)}
            >
              {grid && (
                <header className="agent-pane-header" title="Drag to move" {...dragHandlers(agent.id)}>
                  <AgentMascot color={agent.color} working={!!working[agent.id]} size={16} />
                  <span className="agent-pane-name">{agent.name}</span>
                  {(() => {
                    const workspace = workspaces[agent.id];
                    return workspace && "branch" in workspace && workspace.branch ? (
                      <span className="agent-pane-branch" title={workspace.cwd}>
                        <UiIcon name="lucide:git-branch" className="agent-pane-branch-icon" />
                        {workspace.branch}
                      </span>
                    ) : null;
                  })()}
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
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function MessageTime({ at }: { at?: number }) {
  if (!at) return null;
  const date = new Date(at);
  return (
    <time className="message-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
      {timeFormat.format(date)}
    </time>
  );
}

/** Intervalle de revérification pendant une installation ou une connexion. */
const POLL_MS = 3000;

/** Panneau Claude Code : vérifie que la CLI est installée et connectée à un
 *  abonnement, propose sinon de l'installer ou de se connecter, puis ouvre la session. */
export function ClaudePanel({ cwd, activeFile, width, expanded, onToggleExpanded }: Props) {
  const expand = { expanded, onToggleExpanded };
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  // Une installation ou une connexion a été lancée : on revérifie régulièrement.
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    claude.status().then(setStatus, (err) => setNotice(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const ready = status?.installed && status.loggedIn;

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
        <AgentTabs cwd={cwd} activeFile={activeFile} {...expand} />
      ) : (
        <>
          <ClaudeHeader busy={!status || waiting} {...expand} />
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
      name={agent.name}
      cwd={workspace.cwd}
      notice={workspace.notice}
      activeFile={activeFile}
      onWorkingChange={onWorkingChange}
    />
  );
}

interface SessionProps {
  agentId: string;
  /** Avertissement sur l'espace de travail (ex. git absent : pas d'isolation). */
  notice: string | null;
  /** Nom de l'agent, utilisé dans le champ de saisie (« Ask Agent 1 anything… »). */
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
  | { kind: "step"; id: string; stage: string; label: string; status: OrchestratorStatus; detail: string | null };

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

function ClaudeSession({ agentId, notice, name, cwd, activeFile, onWorkingChange }: SessionProps) {
  // Session active, `null` tant que le processus n'est pas prêt ou après sa fin.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  // Réponse en cours d'écriture, alimentée morceau par morceau ; remplacée par
  // le message complet quand il arrive.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  // Modèle annoncé par Claude Code au démarrage de la session (ex. claude-opus-5-5).
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  // Conversation côté Claude Code : reprise quand on change de modèle.
  const conversation = useRef<string | null>(null);
  // Dernière demande de l'utilisateur : sert de message de commit à l'orchestrateur.
  const lastPrompt = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

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
        case "system":
          if (typeof msg.session_id === "string") conversation.current = msg.session_id;
          if (msg.subtype === "init" && typeof msg.model === "string") {
            const name = provider.formatModelName(msg.model);
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
                (item) => ({ ...item, status: block.is_error ? "error" : "done" }),
              );
            }
          }
          return;
        case "result":
          endThinking();
          setDraft(null);
          setBusy(false);
          if (msg.is_error) push({ kind: "error", text: String(msg.result ?? "Error") });
          // Tâche terminée : l'orchestrateur ramène le travail sur la branche principale.
          else agentsApi.taskFinished(agentId, lastPrompt.current).catch(() => {});
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
    const started = claude.start(id, cwd, { permissionMode: "acceptEdits", model, resume: conversation.current }).then(
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
    // Changer de modèle relance la session sur la même conversation.
  }, [cwd, model]);

  const changeModel = (next: string | null) => {
    if (next === model) return;
    const label = provider.models.find((m) => m.id === next)?.label ?? next;
    push({ kind: "info", text: `Model: ${label}` });
    setBusy(false);
    // Le modèle réel sera annoncé à nouveau par la prochaine session.
    setResolvedModel(null);
    setModel(next);
  };

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

  const submit = async (text: string, attachments: Attachment[]) => {
    if (!sessionId) return;
    lastPrompt.current = text;
    setBusy(true);
    push({
      kind: "user",
      text: attachments.length ? `${text}\nContext: ${attachments.map((a) => a.name).join(", ")}` : text,
    });
    try {
      await claude.send(sessionId, provider.formatPrompt(text, attachments));
    } catch (err) {
      setBusy(false);
      push({ kind: "error", text: String(err) });
    }
  };

  return (
    <>
      <div className="claude-log">
        {items.map((item, i) =>
          item.kind === "thinking" ? (
            <ThinkingRow key={item.id} startedAt={item.startedAt} endedAt={item.endedAt} />
          ) : item.kind === "tool" ? (
            <ToolRow key={item.id} name={item.name} input={item.input} status={item.status} />
          ) : item.kind === "step" ? (
            <StepRow key={item.id} stage={item.stage} label={item.label} status={item.status} detail={item.detail} />
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
                {item.text}
                {item.kind === "assistant" && <MessageTime at={item.at} />}
              </div>
            )
          ),
        )}
        {draft !== null && (
          <div className="claude-line assistant streaming tl">
            {draft}
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
          models={provider.models}
          model={model}
          // Seul le modèle par défaut a besoin d'être précisé ; il est réinitialisé à chaque changement.
          resolvedModel={model === null ? resolvedModel : null}
          onModelChange={changeModel}
          root={cwd}
          activeFile={activeFile}
          disabled={!running}
          placeholder={running ? `Ask ${name} anything…` : `Starting ${name}…`}
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
function StepRow({ stage, label, status, detail }: { stage: string; label: string; status: OrchestratorStatus; detail: string | null }) {
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
      </details>
    );
  }
  return <div className={`activity ${status} tl`}>{row}</div>;
}
