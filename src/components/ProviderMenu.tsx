import { useEffect, useState } from "react";
import { PROVIDER_INFO, type ProviderId } from "../agents/providers";
import { claude, codex, gemini } from "../lib/ipc";
import { UiIcon } from "./fileIcons";

/** IA proposées à la création d'un agent, dans cet ordre. */
const PROVIDERS: ProviderId[] = ["claude-code", "codex", "gemini"];

/** Où se connecter à chaque IA (panneau AI & Models). */
const CONNECT_HINT: Record<ProviderId, string> = {
  "claude-code": "Connect Claude Code in AI & Models before creating an agent with it.",
  codex: "Connect Codex in AI & Models before creating an agent with it.",
  gemini: "Connect Gemini in AI & Models before creating an agent with it.",
};

/** IA prête (installée et connectée) ; `null` tant que ce n'est pas vérifié. */
type Ready = Record<ProviderId, boolean | null>;

// Dernier état connu, partagé par les menus : affiché tout de suite, puis revérifié.
let known: Ready = { "claude-code": null, codex: null, gemini: null };

function checkAll(update: (ready: Ready) => void) {
  const set = (id: ProviderId, ready: boolean) => {
    known = { ...known, [id]: ready };
    update(known);
  };
  claude.status().then((s) => set("claude-code", s.installed && s.loggedIn), () => set("claude-code", false));
  codex.status().then((s) => set("codex", s.installed && s.loggedIn), () => set("codex", false));
  gemini.status().then((s) => set("gemini", s.installed && s.loggedIn), () => set("gemini", false));
}

/**
 * Choix de l'IA d'un nouvel agent (contenu d'un menu `Popover`). Les IA non
 * connectées sont grisées, avec un rappel au survol ; l'état est revérifié à
 * chaque ouverture du menu.
 */
export function ProviderMenuItems({ onPick }: { onPick: (provider: ProviderId) => void }) {
  const [ready, setReady] = useState(known);

  useEffect(() => {
    let open = true;
    checkAll((next) => open && setReady(next));
    return () => {
      open = false;
    };
  }, []);

  return (
    <>
      {PROVIDERS.map((p) => {
        // Pas encore vérifiée : proposée normalement plutôt que bloquée à tort.
        const unavailable = ready[p] === false;
        return (
          <button
            key={p}
            className="popover-item"
            aria-disabled={unavailable}
            // `title` sur un bouton actif : un bouton `disabled` n'affiche pas d'infobulle partout.
            title={unavailable ? CONNECT_HINT[p] : undefined}
            onClick={() => !unavailable && onPick(p)}
          >
            <UiIcon name={PROVIDER_INFO[p].icon} className="popover-icon" />
            <span className="popover-text">{PROVIDER_INFO[p].label}</span>
          </button>
        );
      })}
    </>
  );
}
