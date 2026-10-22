import { useEffect, useRef, useState } from "react";
import { focusAgent } from "../lib/agentRoster";
import {
  clearNotifications,
  markAllRead,
  markRead,
  useNotifications,
  type AppNotification,
} from "../lib/notifications";
import { AgentMascot } from "./AgentMascot";
import { UiIcon } from "./fileIcons";

const ago = (at: number) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

const KIND_LABEL: Record<AppNotification["kind"], string> = {
  done: "Task finished",
  question: "Question",
  error: "Error",
};

/**
 * Cloche de la barre du haut : nombre de notifications non lues, et menu
 * déroulant de la liste. Cliquer une notification affiche l'agent concerné.
 */
export function NotificationBell() {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.read).length;

  // Clic en dehors ou Échap : fermeture.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openAgent = (n: AppNotification) => {
    markRead(n.id);
    focusAgent(n.agentId);
    setOpen(false);
  };

  return (
    <div className="notif" ref={root}>
      <button
        className="notif-bell"
        title={unread ? `${unread} unread notification${unread > 1 ? "s" : ""}` : "Notifications"}
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <UiIcon name="lucide:bell" className="notif-bell-icon" />
        {unread > 0 && <span className="notif-count">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="notif-menu" role="dialog" aria-label="Notifications">
          <header className="notif-head">
            <span className="notif-title">Notifications</span>
            {unread > 0 && (
              <button className="notif-action" onClick={markAllRead}>
                Mark all as read
              </button>
            )}
            {notifications.length > 0 && (
              <button className="notif-action" onClick={clearNotifications}>
                Clear
              </button>
            )}
          </header>

          {notifications.length === 0 ? (
            <div className="notif-empty">
              <UiIcon name="lucide:bell" className="notif-empty-icon" />
              No notifications yet. Agents notify you here when they finish a task or have a question.
            </div>
          ) : (
            <ul className="notif-list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button className={n.read ? `notif-item ${n.kind}` : `notif-item ${n.kind} unread`} onClick={() => openAgent(n)}>
                    <AgentMascot color={n.agentColor} working={false} size={22} />
                    <span className="notif-text">
                      <span className="notif-line">
                        <span className="notif-item-title">{n.title}</span>
                        <span className="notif-time">{ago(n.at)}</span>
                      </span>
                      <span className={`notif-kind ${n.kind}`}>{KIND_LABEL[n.kind]}</span>
                      {n.body && <span className="notif-body">{n.body}</span>}
                    </span>
                    {!n.read && <span className="notif-dot" aria-label="Unread" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
