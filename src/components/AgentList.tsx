import {
  focusAgent,
  limitTokens,
  requestNewAgent,
  totalTokens,
  useAgentRoster,
  type RosterAgent,
  type TokenUsage,
} from "../lib/agentRoster";
import { PROVIDER_INFO, type ProviderId } from "../agents/providers";
import { AgentMascot } from "./AgentMascot";
import { Popover } from "./Composer";
import { compact } from "./AgentOverview";
import { UiIcon } from "./fileIcons";
import { SchedulerTasks } from "./SchedulerTasks";


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
                    <UiIcon name={providerOf(agent).icon} className="agent-row-provider-icon" />
                    {providerOf(agent).label}
                  </span>
                </span>
                <TokenMeter agent={agent} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Vérifications, builds et previews des agents (planificateur) */}
      <SchedulerTasks />
      {/* Les agents n'existent qu'une fois un dossier ouvert et Claude Code prêt. */}
      {agents.length > 0 && (
        <div className="agent-list-footer">
          {/* Choix de l'IA du nouvel agent */}
          <Popover
            label="Add agent"
            trigger={
              <>
                <UiIcon name="lucide:plus" className="thin-button-icon" />
                Add agent
              </>
            }
            triggerClassName="thin-button"
          >
            {(close) =>
              (Object.keys(PROVIDER_INFO) as ProviderId[]).map((p) => (
                <button
                  key={p}
                  className="popover-item"
                  onClick={() => {
                    close();
                    requestNewAgent(p);
                  }}
                >
                  <UiIcon name={PROVIDER_INFO[p].icon} className="popover-icon" />
                  <span className="popover-text">{PROVIDER_INFO[p].label}</span>
                </button>
              ))
            }
          </Popover>
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

/** Libellé et icône de l'IA d'un agent. */
const providerOf = (agent: RosterAgent) => PROVIDER_INFO[agent.provider as ProviderId] ?? PROVIDER_INFO["claude-code"];
