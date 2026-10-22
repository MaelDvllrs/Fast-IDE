// Notifications de l'app (cloche de la barre du haut) : envoyées par les agents
// quand ils terminent une tâche, posent une question ou échouent. Gardées en
// mémoire pendant la session, les plus récentes en premier.
import { useEffect, useState } from "react";

export type NotificationKind = "done" | "question" | "error";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  agentId: string;
  agentName: string;
  agentColor: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
}

/** Notifications gardées au plus (les plus anciennes partent). */
const MAX = 50;

let list: AppNotification[] = [];
const listeners = new Set<(l: AppNotification[]) => void>();

function emit(next: AppNotification[]) {
  list = next;
  listeners.forEach((l) => l(list));
}

export function notify(n: Omit<AppNotification, "id" | "at" | "read">) {
  emit([{ ...n, id: crypto.randomUUID(), at: Date.now(), read: false }, ...list].slice(0, MAX));
}

export const markRead = (id: string) => emit(list.map((n) => (n.id === id ? { ...n, read: true } : n)));
export const markAllRead = () => emit(list.map((n) => (n.read ? n : { ...n, read: true })));
export const clearNotifications = () => emit([]);

export function useNotifications(): AppNotification[] {
  const [value, setValue] = useState(list);
  useEffect(() => {
    listeners.add(setValue);
    setValue(list);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

/** Texte court pour une notification : une ligne, coupée proprement. */
export function excerpt(text: string, max = 140) {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Question posée à la fin d'une réponse (dernière phrase terminée par « ? »), sinon `null`. */
export function trailingQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.endsWith("?")) return null;
  const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/);
  return sentences.at(-1)?.trim() ?? trimmed;
}
