import { useState } from "react";
import type { RosterAgent, Turn } from "../lib/agentRoster";
import { compact, dollars } from "./AgentOverview";
import { Popover } from "./Composer";
import { UiIcon } from "./fileIcons";

type Metric = "tokens" | "cost";

// Périodes en jours (aujourd'hui compris) ; « All » part du premier tour connu.
const RANGES: { id: string; label: string; days: number | null }[] = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "all", label: "All time", days: null },
];

const W = 600;
const H = 140;
const DAY_MS = 86_400_000;

/** Plafond « rond » de l'axe : 1, 2 ou 5 × 10ⁿ au-dessus du maximum. */
function niceMax(value: number, metric: Metric) {
  if (value <= 0) return metric === "cost" ? 0.01 : 1000;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((m) => m * power >= value) ?? 10) * power;
}

const format = (value: number, metric: Metric) => (metric === "cost" ? dollars(value) : `${compact(value)} tokens`);
const axis = (value: number, metric: Metric) =>
  metric === "cost" ? `$${+value.toFixed(value < 0.1 ? 3 : 2)}` : compact(value);

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const weekday = (at: number) => new Date(at).toLocaleDateString("en-US", { weekday: "short" });
const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Courbe lissée (Catmull-Rom → Bézier) passant par tous les points. */
function smoothPath(points: [number, number][]) {
  if (points.length === 1) return `M0,${points[0][1]} L${W},${points[0][1]}`;
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[i - 1] ?? points[i], points[i], points[i + 1], points[i + 2] ?? points[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Jours de la période (minuit local), du plus ancien à aujourd'hui. */
function periodDays(turns: Turn[], days: number | null) {
  const today = startOfDay(Date.now());
  const first = turns.length ? startOfDay(turns[0].at) : today;
  const count = days ?? Math.max(7, Math.round((today - first) / DAY_MS) + 1);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (count - 1 - i));
    return d.getTime();
  });
}

/** En-tête de carte de graphique : onglets Jetons / Coût et période. */
function ChartControls({
  metric,
  onMetric,
  rangeId,
  onRange,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  rangeId: string;
  onRange: (id: string) => void;
}) {
  const range = RANGES.find((r) => r.id === rangeId)!;
  return (
    <div className="chart-controls">
      <div className="chart-tabs" role="tablist">
        {(["tokens", "cost"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={m === metric} className={m === metric ? "chart-tab active" : "chart-tab"} onClick={() => onMetric(m)}>
            {m === "tokens" ? "Tokens" : "Cost"}
          </button>
        ))}
      </div>
      <Popover
        label="Period"
        align="end"
        trigger={
          <>
            {range.label}
            <UiIcon name="lucide:chevron-down" className="composer-chevron" />
          </>
        }
        triggerClassName="chart-range"
      >
        {(close) =>
          RANGES.map((r) => (
            <button
              key={r.id}
              className="popover-item"
              onClick={() => {
                close();
                onRange(r.id);
              }}
            >
              <span className="popover-check">{r.id === range.id && <UiIcon name="lucide:check" className="popover-icon" />}</span>
              <span className="popover-text">{r.label}</span>
            </button>
          ))
        }
      </Popover>
    </div>
  );
}

function useChartState(turns: Turn[]) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const [rangeId, setRangeId] = useState(RANGES[0].id);
  const range = RANGES.find((r) => r.id === rangeId)!;
  const days = periodDays(turns, range.days);
  const inRange = turns.filter((t) => t.at >= days[0]);
  const value = (t: Turn) => (metric === "tokens" ? t.tokens : t.cost);
  return { metric, setMetric, rangeId, setRangeId, days, inRange, value };
}

/** Axe des valeurs (5 graduations), à gauche des deux graphiques. */
function YAxis({ top, metric }: { top: number; metric: Metric }) {
  return (
    <div className="usage-axis-y">
      {[top, (top * 3) / 4, top / 2, top / 4, 0].map((t, i) => (
        <span key={i}>{axis(t, metric)}</span>
      ))}
    </div>
  );
}

/** Utilisation globale : une valeur par jour sur la période. */
export function UsageChart({ agent }: { agent: RosterAgent }) {
  const { metric, setMetric, rangeId, setRangeId, days, inRange, value } = useChartState(agent.turns);
  const values = days.map((day) =>
    inRange.filter((t) => startOfDay(t.at) === day).reduce((sum, t) => sum + value(t), 0),
  );

  return (
    <section className="dash-card chart-card">
      <ChartControls metric={metric} onMetric={setMetric} rangeId={rangeId} onRange={setRangeId} />
      <div className="dash-card-title">Usage</div>
      <div className="dash-card-text">{metric === "tokens" ? "Tokens per day" : "Estimated cost per day"}</div>
      <LinePlot values={values} days={days} metric={metric} />
    </section>
  );
}

function LinePlot({ values, days, metric }: { values: number[]; days: number[]; metric: Metric }) {
  const top = niceMax(Math.max(...values), metric);
  const x = (i: number) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - (v / top) * H;
  const points = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const line = smoothPath(points);
  const last = points[points.length - 1];
  // Une graduation par jour sur 7 jours ; au-delà, 7 dates réparties.
  const labelCount = Math.min(7, days.length);
  const labels = Array.from({ length: labelCount }, (_, k) =>
    labelCount === 1 ? 0 : Math.round((k / (labelCount - 1)) * (days.length - 1)),
  );
  const label = (at: number) => (days.length <= 7 ? weekday(at) : shortDate(at));

  return (
    <div className="usage-plot tall">
      <YAxis top={top} metric={metric} />
      <div className="usage-graph">
        <div className="chart-axes" aria-hidden="true" />
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {/* Repère horizontal en pointillé, aux trois quarts de l'axe */}
          <line x1="0" x2={W} y1={H / 4} y2={H / 4} className="chart-guide" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Point sur aujourd'hui (en HTML : reste rond malgré l'étirement du SVG) */}
        <span
          className="chart-dot"
          style={{ left: `${(last[0] / W) * 100}%`, top: `calc((100% - 20px) * ${last[1] / H})` }}
          title={format(values[values.length - 1], metric)}
        />
        <div className="usage-axis-x">
          {labels.map((i) => (
            <span key={i} className="chart-tick" style={{ left: `${(x(i) / W) * 100}%` }}>
              {label(days[i])}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Utilisation par modèle : une barre par modèle (Claude Code en appelle parfois plusieurs). */
export function ModelChart({ agent }: { agent: RosterAgent }) {
  const { metric, setMetric, rangeId, setRangeId, inRange } = useChartState(agent.turns);
  const totals = new Map<string, number>();
  for (const turn of inRange) {
    for (const [name, share] of Object.entries(turn.models)) {
      totals.set(name, (totals.get(name) ?? 0) + (metric === "tokens" ? share.tokens : share.cost));
    }
  }
  // Le modèle le plus utilisé en premier : c'est lui qui est mis en avant.
  const models = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const sum = models.reduce((s, [, v]) => s + v, 0);
  const top = niceMax(models[0]?.[1] ?? 0, metric);

  return (
    <section className="dash-card chart-card">
      <ChartControls metric={metric} onMetric={setMetric} rangeId={rangeId} onRange={setRangeId} />
      <div className="dash-card-title">Usage by model</div>
      <div className="dash-card-text">{metric === "tokens" ? "Token distribution across models" : "Cost distribution across models"}</div>
      <div className="usage-plot tall">
        <YAxis top={top} metric={metric} />
        <div className="usage-graph">
          <div className="chart-axes" aria-hidden="true" />
          <div className="model-bars">
            {models.length === 0 && <span className="model-bars-empty">No usage yet</span>}
            {models.map(([name, value], i) => (
              <div
                key={name}
                className={i === 0 ? "model-bar-slot top" : "model-bar-slot"}
                title={`Claude ${name}: ${format(value, metric)} (${Math.round((value / (sum || 1)) * 100)}%)`}
              >
                <UiIcon name="fast:claude-app" className="model-bar-icon" />
                <span className="model-bar" style={{ height: `${Math.max(2, (value / top) * 100)}%` }} />
              </div>
            ))}
          </div>
          {/* Sous l'axe des x : seulement le modèle le plus utilisé (le détail est au survol des barres) */}
          <div className="chart-bottom">
            {models.length > 0 && (
              <>
                <UiIcon name="fast:claude-app" className="model-summary-icon" />
                Most used: Claude {models[0][0]}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
