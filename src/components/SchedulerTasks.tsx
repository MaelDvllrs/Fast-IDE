import { useEffect, useState } from "react";
import { useAgentRoster } from "../lib/agentRoster";
import { openUrl, scheduler, type SchedulerKind, type SchedulerTask } from "../lib/ipc";
import { AgentMascot } from "./AgentMascot";
import { UiIcon } from "./fileIcons";

/** Libellé et icône de chaque opération du planificateur. */
export const TASK_KINDS: Record<SchedulerKind, { label: string; icon: "lucide:list-checks" | "lucide:flask-conical" | "lucide:hammer" | "lucide:server" }> = {
  typecheck: { label: "Type check", icon: "lucide:list-checks" },
  lint: { label: "Lint", icon: "lucide:list-checks" },
  test: { label: "Unit tests", icon: "lucide:flask-conical" },
  integration_test: { label: "Integration tests", icon: "lucide:flask-conical" },
  e2e: { label: "E2E tests", icon: "lucide:flask-conical" },
  build: { label: "Build", icon: "lucide:hammer" },
  preview: { label: "Preview", icon: "lucide:server" },
};

/** Tâches du planificateur, tenues à jour par ses événements. */
export function useSchedulerTasks() {
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  useEffect(() => {
    let disposed = false;
    scheduler.tasks().then((t) => !disposed && setTasks(t), () => {});
    const unlisten = scheduler.onChange((t) => !disposed && setTasks(t));
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, []);
  return tasks;
}

/** « 12 s », « 3 min ». */
const elapsed = (since: number, now: number) => {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

/**
 * Vérifications, builds et serveurs lancés par les agents (panneau Agents) :
 * en cours puis en file, avec l'agent, la durée, l'adresse d'une preview et un
 * bouton d'arrêt. Masqué quand rien ne tourne.
 */
export function SchedulerTasks() {
  const tasks = useSchedulerTasks();
  const agents = useAgentRoster();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (tasks.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tasks.length]);

  if (tasks.length === 0) return null;
  let queued = 0;

  return (
    <section className="scheduler-tasks">
      <div className="scheduler-tasks-title">Tasks</div>
      <ul>
        {tasks.map((task) => {
          const agent = agents.find((a) => a.sessionId === task.sessionId);
          const kind = TASK_KINDS[task.kind];
          const running = task.status === "running";
          if (!running) queued += 1;
          return (
            <li key={task.id} className={running ? "scheduler-task" : "scheduler-task queued"} title={task.command}>
              {agent ? (
                <AgentMascot color={agent.color} working={running} size={18} />
              ) : (
                <UiIcon name={kind.icon} className="scheduler-task-icon" />
              )}
              <span className="scheduler-task-text">
                <span className="scheduler-task-name">
                  {kind.label}
                  {agent && <span className="scheduler-task-agent"> · {agent.name}</span>}
                </span>
                <span className="scheduler-task-status">
                  {running ? (task.url ? task.url.replace(/^https?:\/\//, "") : "Running") : `Queued #${queued}`} ·{" "}
                  {elapsed(task.since, now)}
                </span>
              </span>
              {task.url && (
                <button className="title-icon-button" title="Open in the browser" aria-label="Open in the browser" onClick={() => openUrl(task.url!)}>
                  <UiIcon name="lucide:external-link" className="title-icon" />
                </button>
              )}
              <button
                className="title-icon-button"
                title={running ? "Stop" : "Remove from the queue"}
                aria-label={running ? "Stop" : "Remove from the queue"}
                onClick={() => scheduler.stop(task.id).catch(() => {})}
              >
                <UiIcon name={running ? "lucide:square" : "lucide:x"} className="title-icon" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
