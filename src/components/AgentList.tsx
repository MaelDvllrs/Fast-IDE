import {
  focusAgent,
  limitTokens,
  requestNewAgent,
  totalTokens,
  useAgentRoster,
  type RosterAgent,
  type TokenUsage,
} from "../lib/agentRoster";
import { AgentMascot } from "./AgentMascot";
import { compact } from "./AgentOverview";
import { UiIcon } from "./fileIcons";


const usageDetail = (u: TokenUsage) =>
  [
    `Input: ${u.input.toLocaleString("en-US")}`,
    `Output: ${u.output.toLocaleString("en-US")}`,
    `Cache read: ${u.cacheRead.toLocaleString("en-US")}`,
    `Cache write: ${u.cacheWrite.toLocaleString("en-US")}`,
  ].join("\n");

/** Panneau Agents : un agent par ligne (mascotte, nom, modèle, jetons consommés). */
export function AgentList({ onOpen }: { onOpen: (agentId: string) => void }) {
  const agents = useAgentRoster();

  return (
    <>
      <header className="panel-header">
        <span className="panel-title">Agents</span>
      </header>
      {agents.length === 0 ? (
        <p className="sidebar-placeholder">Open a folder to start your agents.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                className="agent-row"
                onClick={() => {
                  focusAgent(agent.id);
                  onOpen(agent.id);
                }}
              >
                <AgentMascot color={agent.color} working={agent.working} size={26} />
                <span className="agent-row-text">
                  <span className="agent-row-name">{agent.name}</span>
                  {/* IA de l'agent ; le modèle exact est dans l'infobulle */}
                  <span className="agent-row-provider" title={agent.model ?? "Default model"}>
                    <UiIcon name="fast:claude-app" className="agent-row-provider-icon" />
                    Claude Code
                  </span>
                </span>
                <TokenMeter agent={agent} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Les agents n'existent qu'une fois un dossier ouvert et Claude Code prêt. */}
      {agents.length > 0 && (
        <div className="agent-list-footer">
          <button className="thin-button" onClick={requestNewAgent}>
            <UiIcon name="lucide:plus" className="thin-button-icon" />
            Add agent
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Jetons de l'agent avec une barre : remplie selon la limite (entrée + sortie,
 * comme la limite elle-même), grisée quand aucune limite n'est fixée.
 */
function TokenMeter({ agent }: { agent: RosterAgent }) {
  const limit = agent.tokenLimit;
  const used = limitTokens(agent.usage);
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const title =
    limit === null
      ? `No token limit
${usageDetail(agent.usage)}`
      : `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} input + output tokens
${usageDetail(agent.usage)}`;

  return (
    <span className="agent-row-tokens" title={title}>
      <span>
        {limit === null ? compact(totalTokens(agent.usage)) : compact(used)}
        {limit !== null && <span className="agent-row-limit"> / {compact(limit)}</span>}
      </span>
      <span className={limit === null ? "token-meter none" : ratio >= 1 ? "token-meter full" : "token-meter"}>
        <span style={{ width: `${ratio * 100}%` }} />
      </span>
    </span>
  );
}
