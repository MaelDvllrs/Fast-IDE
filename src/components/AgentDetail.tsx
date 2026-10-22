import { useEffect, useState } from "react";
import { CLAUDE_CODE, EFFORTS } from "../agents/providers";
import {
  requestModelChange,
  requestSystemPromptChange,
  totalTokens,
  useAgentRoster,
  type RosterAgent,
} from "../lib/agentRoster";
import { AgentMascot } from "./AgentMascot";
import { openPath } from "../lib/ipc";
import { Popover } from "./Composer";
import { UiIcon } from "./fileIcons";
import { AgentActivity, AgentOverview } from "./AgentOverview";
import { ModelChart, UsageChart } from "./UsageCharts";

type AppIcon = "fast:claude-app" | "fast:openai-app" | "fast:gemini-app";

// IA possibles pour un agent ; seul Claude Code est branché pour l'instant.
const AIS: { id: string; label: string; icon: AppIcon; available: boolean }[] = [
  { id: "claude-code", label: "Claude Code", icon: "fast:claude-app", available: true },
  { id: "openai", label: "OpenAI", icon: "fast:openai-app", available: false },
  { id: "gemini", label: "Gemini", icon: "fast:gemini-app", available: false },
];

/**
 * Fenêtre d'un agent, à la place du code et du terminal (ouverte depuis le
 * panneau Agents), en tableau de bord : chiffres clés, modèle, options,
 * jetons par tour et répartition.
 */
export function AgentDetail({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const agent = useAgentRoster().find((a) => a.id === agentId);
  // Agent fermé entre-temps : retour au code.
  useEffect(() => {
    if (!agent) onClose();
  }, [agent, onClose]);
  if (!agent) return null;

  const { usage } = agent;
  const total = totalTokens(usage);

  return (
    <main className="window agent-detail">
      <header className="agent-detail-header">
        <AgentMascot color={agent.color} working={agent.working} size={22} />
        <span className="agent-detail-name">{agent.name}</span>
        <span className={agent.working ? "agent-detail-status working" : "agent-detail-status"}>
          {agent.working ? "Working" : "Idle"}
        </span>
        <button className="icon-button" title="Back to code" aria-label="Close agent" onClick={onClose}>
          <UiIcon name="lucide:x" className="icon-button-icon" />
        </button>
      </header>

      <div className="agent-detail-body">
        <AgentOverview agent={agent} />
        <AgentActivity agent={agent} />
        <section className="agent-options joined">
          <div className="chart-row">
            <UsageChart agent={agent} />
            <ModelChart agent={agent} />
          </div>
        </section>
        <AgentOptions agent={agent} />
        <SystemPrompt agent={agent} />

        <section className="agent-options">
          <div className="agent-options-title">Info</div>
          <div className="agent-options-description">Details about this agent and where its tokens went.</div>
          <table className="dash-table info-table">
            <tbody>
              <tr>
                <td>Agent</td>
                <td>{agent.name}</td>
              </tr>
              <tr>
                <td>Folder</td>
                <td>
                  {agent.cwd ? (
                    <span className="info-path">
                      {/* bdi : le chemin garde son sens de lecture malgré la troncature par le début */}
                      <span className="info-path-text" title={agent.cwd}>
                        <bdi>{agent.cwd}</bdi>
                      </span>
                      {!agent.branch && <span className="info-share">project</span>}
                      <button
                        className="provider-action"
                        title="Open in the file explorer"
                        onClick={() => openPath(agent.cwd!).catch(() => {})}
                      >
                        <UiIcon name="lucide:folder-open" className="provider-action-icon" />
                        Open
                      </button>
                    </span>
                  ) : (
                    "Preparing…"
                  )}
                </td>
              </tr>
              <tr>
                <td>Branch</td>
                <td>{agent.branch ?? "None (git unavailable: works in the project folder)"}</td>
              </tr>
              <tr>
                <td>AI</td>
                <td>Claude Code</td>
              </tr>
              <tr>
                <td>Model</td>
                <td>{agent.model ?? "Default"}</td>
              </tr>
              <tr>
                <td>Effort</td>
                <td>{EFFORTS.find((e) => e.id === agent.effort)?.label ?? "Default"}</td>
              </tr>
              <tr>
                <td>Token limit</td>
                <td>{agent.tokenLimit === null ? "No limit" : agent.tokenLimit.toLocaleString("en-US")}</td>
              </tr>
              <tr>
                <td>Turns</td>
                <td>{agent.turns.length}</td>
              </tr>
              {(
                [
                  ["Input tokens", usage.input],
                  ["Output tokens", usage.output],
                  ["Cache read", usage.cacheRead],
                  ["Cache write", usage.cacheWrite],
                ] as const
              ).map(([label, value]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>
                    {value.toLocaleString("en-US")}
                    <span className="info-share">{total ? `${Math.round((value / total) * 100)}%` : "–"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

/** Modèle de l'agent : choix de l'IA puis du modèle, deux menus côte à côte. */
function AgentOptions({ agent }: { agent: RosterAgent }) {
  const models = CLAUDE_CODE.models;
  const current = models.find((m) => m.id === agent.modelId) ?? models[0];
  // « Default » affiche le modèle réellement utilisé quand Claude Code l'a annoncé.
  const label = (m: (typeof models)[number]) =>
    m.id === null && agent.modelId === null && agent.model ? `Default (${agent.model})` : m.label;

  const ai = AIS[0];

  return (
    <section className="agent-options">
      <div className="agent-options-title">Model</div>
      <div className="agent-options-description">The AI and the model this agent works with.</div>
      <div className="agent-option-row">
        <Popover
          label="AI"
          trigger={
            <>
              <UiIcon name={ai.icon} className="model-select-icon" />
              <span className="model-select-value">{ai.label}</span>
              <UiIcon name="lucide:chevron-down" className="composer-chevron" />
            </>
          }
          triggerClassName="model-select"
        >
          {(close) =>
            AIS.map((item) => (
              <button key={item.id} className="popover-item" disabled={!item.available} onClick={close}>
                <span className="popover-check">
                  {item.id === ai.id && <UiIcon name="lucide:check" className="popover-icon" />}
                </span>
                <UiIcon name={item.icon} className="model-select-icon" />
                <span className="popover-text">
                  {item.label}
                  {!item.available && <span className="popover-description">Coming soon</span>}
                </span>
              </button>
            ))
          }
        </Popover>

        <Popover
          label="Model"
          trigger={
            <>
              <span className="model-select-value">{label(current)}</span>
              <UiIcon name="lucide:chevron-down" className="composer-chevron" />
            </>
          }
          triggerClassName="model-select"
        >
          {(close) =>
            models.map((m) => (
              <button
                key={m.id ?? "default"}
                className="popover-item"
                onClick={() => {
                  close();
                  requestModelChange(agent.id, m.id);
                }}
              >
                <span className="popover-check">
                  {m.id === current.id && <UiIcon name="lucide:check" className="popover-icon" />}
                </span>
                <span className="popover-text">
                  {label(m)}
                  {m.description && <span className="popover-description">{m.description}</span>}
                </span>
              </button>
            ))
          }
        </Popover>
      </div>
    </section>
  );
}

/** Prompt système : ce que l'agent doit faire, ajouté aux instructions de Claude Code. */
function SystemPrompt({ agent }: { agent: RosterAgent }) {
  const saved = agent.systemPrompt ?? "";
  const [text, setText] = useState(saved);
  const changed = text.trim() !== saved.trim();

  return (
    <section className="agent-options">
      <div className="agent-options-title">System prompt</div>
      <div className="agent-options-description">
        What this agent should focus on. Added to its instructions for every message; the conversation is kept.
      </div>
      <textarea
        className="system-prompt"
        value={text}
        rows={5}
        spellCheck={false}
        placeholder={`e.g. You handle the backend API. Keep changes small and write tests.`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && changed) {
            e.preventDefault();
            requestSystemPromptChange(agent.id, text.trim() || null);
          }
        }}
      />
      <div className="system-prompt-actions">
        <span className="agent-option-hint">{changed ? "Unsaved changes · Ctrl+Enter to apply" : saved ? "Applied" : ""}</span>
        {saved && (
          <button
            className="secondary-button"
            onClick={() => {
              setText("");
              requestSystemPromptChange(agent.id, null);
            }}
          >
            Clear
          </button>
        )}
        <button className="primary-button" disabled={!changed} onClick={() => requestSystemPromptChange(agent.id, text.trim() || null)}>
          Apply
        </button>
      </div>
    </section>
  );
}
