import { useState, type ReactNode } from "react";
import { effortsFor, providerIdOf } from "../agents/providers";
import { limitTokens, requestEffortChange, setTokenLimit, type RosterAgent } from "../lib/agentRoster";
import { Popover } from "./Composer";
import { UiIcon } from "./fileIcons";

/** Jetons en unités rondes, sans décimale : 1234 → « 1k », 2 500 000 → « 3M ». */
export const compact = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${Math.round(n / 1_000_000)}M`;

export const dollars = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** Crans du curseur de limite (jetons d'entrée + sortie) ; le dernier = pas de limite. */
const LIMIT_STEPS: (number | null)[] = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, null];

type CardIcon = "lucide:gauge" | "lucide:brain" | "lucide:circle-dollar-sign";

/** Carte du haut : icône + titre, valeur, jauge, légende et actions. */
function OverviewCard({
  icon,
  title,
  value,
  ratio,
  tone,
  caption,
  editor,
  actions,
}: {
  icon: CardIcon;
  title: string;
  value: ReactNode;
  /** Remplissage de la jauge (0-1), `null` = jauge grisée. */
  ratio: number | null;
  tone: "primary" | "warning" | "danger" | "info";
  caption: ReactNode;
  /** Réglage affiché dans la carte, sous la légende (ex. curseur de limite). */
  editor?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="dash-card overview-card">
      <div className="overview-card-title">
        <UiIcon name={icon} className="overview-card-icon" />
        {title}
      </div>
      <div className="overview-value">{value}</div>
      <div className={ratio === null ? "overview-meter none" : `overview-meter ${tone}`}>
        <span style={{ width: `${(ratio ?? 0) * 100}%` }} />
      </div>
      <div className="overview-caption">{caption}</div>
      {editor && <div className="overview-editor">{editor}</div>}
      {actions && <div className="overview-actions">{actions}</div>}
    </section>
  );
}

/** Cartes du haut de la fenêtre d'un agent : limite de jetons, effort, coût estimé. */
export function AgentOverview({ agent }: { agent: RosterAgent }) {
  const used = limitTokens(agent.usage);
  const limit = agent.tokenLimit;
  const share = limit ? used / limit : null;
  // Curseur de limite affiché dans la carte (bouton « Manage limit »).
  const [editingLimit, setEditingLimit] = useState(false);
  const step = limit === null ? LIMIT_STEPS.length - 1 : Math.max(0, LIMIT_STEPS.findIndex((s) => s !== null && s >= limit));
  const EFFORTS = effortsFor(agent.provider);
  const effortIndex = Math.max(0, EFFORTS.findIndex((e) => e.id === agent.effort));
  const effort = EFFORTS[effortIndex];
  // Niveaux réels (sans « Default ») pour la jauge d'effort.
  const levels = EFFORTS.length - 1;

  return (
    <section className="agent-options">
      <div className="agent-options-title">Overview</div>
      <div className="agent-options-description">{agent.name}'s usage at a glance.</div>

      <div className="overview-grid">
        <OverviewCard
          icon="lucide:gauge"
          title="Token limit"
          value={
            <>
              {compact(used)}
              <span className="overview-value-muted">
                {limit === null ? " tokens · no limit" : ` / ${compact(limit)} tokens (${Math.round((share ?? 0) * 100)}%)`}
              </span>
            </>
          }
          ratio={share === null ? null : Math.min(1, share)}
          tone={share !== null && share >= 1 ? "danger" : "primary"}
          caption="Input + output tokens"
          editor={
            editingLimit && (
              <>
                <div className="agent-option-label">
                  <span>Token limit</span>
                  <span className="agent-option-value">{limit === null ? "No limit" : compact(limit)}</span>
                </div>
                <input
                  type="range"
                  className="limit-slider"
                  aria-label="Token limit"
                  min={0}
                  max={LIMIT_STEPS.length - 1}
                  step={1}
                  value={step}
                  style={{ "--ratio": step / (LIMIT_STEPS.length - 1) } as React.CSSProperties}
                  onChange={(e) => setTokenLimit(agent.id, LIMIT_STEPS[Number(e.target.value)])}
                />
                <div className="agent-option-hint">The agent stops once it's reached.</div>
              </>
            )
          }
          actions={
            <>
              {limit !== null && (
                <button className="overview-ghost" onClick={() => setTokenLimit(agent.id, null)}>
                  Remove limit
                </button>
              )}
              <button
                className="overview-button"
                aria-expanded={editingLimit}
                onClick={() => setEditingLimit((open) => !open)}
              >
                {editingLimit ? "Done" : "Manage limit"}
              </button>
            </>
          }
        />

        <OverviewCard
          icon="lucide:brain"
          title="Effort"
          value={
            <>
              {effort.label}
              {effort.id !== null && <span className="overview-value-muted">{` (${effortIndex}/${levels})`}</span>}
            </>
          }
          ratio={effort.id === null ? null : effortIndex / levels}
          tone="warning"
          caption="Thinking before answering"
          actions={
            <>
              {effort.id !== null && (
                <button className="overview-ghost" onClick={() => requestEffortChange(agent.id, null)}>
                  Reset
                </button>
              )}
              <Popover label="Manage effort" align="end" trigger="Manage effort" triggerClassName="overview-button">
                {(close) =>
                  EFFORTS.map((e) => (
                    <button
                      key={e.id ?? "default"}
                      className="popover-item"
                      onClick={() => {
                        close();
                        requestEffortChange(agent.id, e.id);
                      }}
                    >
                      <span className="popover-check">
                        {e.id === effort.id && <UiIcon name="lucide:check" className="popover-icon" />}
                      </span>
                      <span className="popover-text">
                        {e.label}
                        {e.description && <span className="popover-description">{e.description}</span>}
                      </span>
                    </button>
                  ))
                }
              </Popover>
            </>
          }
        />

        <OverviewCard
          icon="lucide:circle-dollar-sign"
          title="Estimated cost"
          value={
            <>
              {dollars(agent.cost)}
              <span className="overview-value-muted">{` · ${agent.turns.length} turns`}</span>
            </>
          }
          ratio={null}
          tone="info"
          caption={
            <span
              title={
                providerIdOf(agent.provider) === "codex"
                  ? "Codex doesn't report a price: your ChatGPT plan isn't billed per token."
                  : providerIdOf(agent.provider) === "gemini"
                    ? "Gemini doesn't report a price: your Google account isn't billed per token."
                    : "API-equivalent price reported by Claude Code. Your Claude subscription isn't billed per token."
              }
            >
              API-equivalent price
            </span>
          }
        />
      </div>
    </section>
  );
}

/** Semaines affichées dans la grille d'activité (une colonne par semaine) : un an. */
const WEEKS = 52;
const DAY_MS = 86_400_000;
const DAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** Minuit (heure locale) du jour de `at`. */
const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayKey = (at: number) => new Date(at).toDateString();
const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const month = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short" });

/**
 * Activité de l'agent par jour : une case par jour, une colonne par semaine
 * (lundi en haut), plus foncée selon les jetons consommés (style « contributions »).
 */
export function AgentActivity({ agent }: { agent: RosterAgent }) {
  const today = startOfDay(Date.now());
  // Lundi de la semaine en cours, puis on remonte de WEEKS - 1 semaines.
  const weekday = (new Date(today).getDay() + 6) % 7;
  const start = today - weekday * DAY_MS - (WEEKS - 1) * 7 * DAY_MS;

  const perDay = new Map<string, number>();
  for (const turn of agent.turns) perDay.set(dayKey(turn.at), (perDay.get(dayKey(turn.at)) ?? 0) + turn.tokens);

  // Jours de la grille (avec un pas d'un jour calendaire : robuste aux changements d'heure).
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d.getTime();
  });
  const values = days.map((at) => perDay.get(dayKey(at)) ?? 0);
  const max = Math.max(0, ...values);
  const peakIndex = max > 0 ? values.indexOf(max) : -1;
  // 5 niveaux : vide, puis 4 intensités de la couleur primaire.
  const level = (value: number) => (value === 0 ? 0 : Math.min(4, 1 + Math.floor((value / max) * 3.999)));

  return (
    <section className="agent-options joined">
      <div className="dash-card activity-card">
        <div className="usage-head">
          <div className="dash-card-title">Activity</div>
          <div className="dash-card-text">
            {month(days[0])} – {month(today)} {new Date(today).getFullYear()}
          </div>
        </div>
        <div className="activity-peak">
          {peakIndex < 0 ? (
            "No activity yet"
          ) : (
            <>
              Peak: <span className="activity-peak-value">{compact(max)} tokens</span> ({shortDate(days[peakIndex])})
            </>
          )}
          <span className="usage-info" title="Each square is a day; each column is a week, Monday at the top.">
            <UiIcon name="lucide:info" className="usage-info-icon" />
          </span>
        </div>

        <div className="activity-grid-wrap">
          <div className="activity-rows">
            {DAYS.map((label, r) => (
              <span key={r}>{label}</span>
            ))}
          </div>
          <div className="activity-scroll">
            <div className="activity-hours" style={{ gridTemplateColumns: `repeat(${WEEKS}, var(--cell))` }}>
              {Array.from({ length: WEEKS }, (_, w) => {
                // Mois affiché sur la semaine qui contient son 1er jour (et sur la première colonne).
                const week = days.slice(w * 7, w * 7 + 7);
                const first = week.find((at) => new Date(at).getDate() === 1);
                return <span key={w}>{first ? month(first) : w === 0 ? month(week[0]) : ""}</span>;
              })}
            </div>
            <div className="activity-grid" style={{ gridTemplateColumns: `repeat(${WEEKS}, var(--cell))` }}>
              {Array.from({ length: WEEKS }, (_, w) => (
                <div key={w} className="activity-column">
                  {Array.from({ length: 7 }, (_, d) => {
                    const index = w * 7 + d;
                    const at = days[index];
                    const future = at > today;
                    return (
                      <span
                        key={d}
                        className={[
                          "activity-cell",
                          `l${level(values[index])}`,
                          index === peakIndex ? "peak" : "",
                          future ? "future" : "",
                        ].join(" ")}
                        title={future ? undefined : `${shortDate(at)} · ${values[index].toLocaleString("en-US")} tokens`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="activity-legend">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`activity-cell l${l}`} />
          ))}
          <span>More</span>
        </div>
      </div>
    </section>
  );
}
