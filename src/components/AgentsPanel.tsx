import { useCallback, useEffect, useState } from "react";
import { CLAUDE_CODE } from "../agents/providers";
import { claude, type ClaudeStatus } from "../lib/ipc";
import { runInTerminal } from "../lib/terminalBus";
import { UiIcon } from "./fileIcons";

type ProviderId = "claude" | "openai" | "gemini";
type ProviderIcon = "simple-icons:claude" | "simple-icons:openai" | "simple-icons:googlegemini";

// IA proposées pour les agents. Seul Claude Code est branché pour l'instant.
const PROVIDERS: { id: ProviderId; label: string; icon: ProviderIcon; available: boolean }[] = [
  { id: "claude", label: "Claude", icon: "simple-icons:claude", available: true },
  { id: "openai", label: "OpenAI", icon: "simple-icons:openai", available: false },
  { id: "gemini", label: "Gemini", icon: "simple-icons:googlegemini", available: false },
];

/** Revérification de l'état de Claude Code après une installation ou une connexion. */
const POLL_MS = 3000;

/** « team » → « Team » ; formule inconnue affichée telle quelle. */
const planLabel = (plan: string) => `${plan[0].toUpperCase()}${plan.slice(1)}`;

/** AI & Models : connexion à chaque IA (compte connecté) et modèles proposés, un onglet par IA. */
export function AgentsPanel() {
  const [provider, setProvider] = useState<ProviderId>("claude");
  const current = PROVIDERS.find((p) => p.id === provider)!;

  return (
    <>
      <header className="panel-header">
        <span className="panel-title">AI &amp; Models</span>
      </header>

      <div className="provider-tabs" role="tablist" aria-label="AI providers">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === provider}
            className={["provider-tab", p.id === provider ? "active" : "", p.available ? "" : "soon"].join(" ")}
            title={p.available ? p.label : `${p.label} (coming soon)`}
            aria-label={p.label}
            onClick={() => setProvider(p.id)}
          >
            <UiIcon name={p.icon} className="provider-tab-icon" />
          </button>
        ))}
      </div>

      <div className="provider-body" role="tabpanel">
        {current.available ? <ClaudeProvider /> : <ComingSoon label={current.label} icon={current.icon} />}
      </div>
    </>
  );
}

/** Claude Code : installation, compte claude.ai connecté, modèles proposés. */
function ClaudeProvider() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    claude.status().then(setStatus, (err) => setNotice(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const ready = !!status?.installed && status.loggedIn;

  useEffect(() => {
    if (!waiting || ready) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, ready, refresh]);

  // Installation et connexion se font dans le terminal intégré, visibles par l'utilisateur.
  const launch = (command: string | null | undefined) => {
    if (!command) return;
    if (runInTerminal(command)) {
      setNotice(null);
      setWaiting(true);
    } else {
      setNotice("Open a folder first: the command runs in the terminal.");
    }
  };

  const logout = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await claude.logout();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
      setWaiting(false);
      refresh();
    }
  };

  return (
    <>
      <div className="provider-card">
        <div className="provider-card-title">
          <UiIcon name="simple-icons:claude" className="provider-card-icon" />
          Claude Code
          <button className="title-icon-button end" title="Check again" aria-label="Check again" onClick={refresh}>
            <UiIcon name="lucide:refresh-cw" className="title-icon" />
          </button>
        </div>

        {!status ? (
          <div className="provider-row">Checking…</div>
        ) : !status.installed ? (
          <>
            <StatusRow ok={false} label="Not installed" />
            <button className="thin-button" onClick={() => launch(status.installCommand)}>
              Install Claude Code
            </button>
          </>
        ) : !status.loggedIn ? (
          <>
            <StatusRow ok={false} label="Not signed in" />
            <div className="provider-note">Uses your Claude subscription (Pro, Max, Team…), not an API key.</div>
            <button className="thin-button" onClick={() => launch(status.loginCommand)}>
              Sign in to Claude
            </button>
          </>
        ) : (
          <>
            <div className="provider-account">
              <div className="provider-account-avatar">{(status.email ?? "?")[0].toUpperCase()}</div>
              <div className="account-text">
                <div className="provider-account-email">{status.email ?? "Claude account"}</div>
                <div className="account-login">
                  {[status.orgName, status.subscriptionType && `${planLabel(status.subscriptionType)} plan`]
                    .filter(Boolean)
                    .join(" · ") || "Signed in"}
                </div>
              </div>
            </div>
            <div className="provider-actions">
              <button className="provider-action" disabled={busy} onClick={() => launch(status.loginCommand)}>
                <UiIcon name="lucide:arrow-left-right" className="provider-action-icon" />
                Switch account
              </button>
              <button className="provider-action" disabled={busy} onClick={logout}>
                <UiIcon name="lucide:log-out" className="provider-action-icon" />
                {busy ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </>
        )}
        {waiting && !ready && <div className="provider-note">Waiting for the terminal to finish…</div>}
        {notice && <div className="form-error">{notice}</div>}
      </div>

      <div className="provider-section-title">Models</div>
      <ul className="provider-models">
        {CLAUDE_CODE.models
          .filter((m) => m.id)
          .map((m) => (
            <li key={m.id} className="provider-model">
              <span className="provider-model-name">{m.label}</span>
              <span className="provider-model-description">{m.description}</span>
            </li>
          ))}
      </ul>
    </>
  );
}

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={ok ? "provider-row ok" : "provider-row"}>
      <UiIcon name={ok ? "lucide:check" : "lucide:circle-alert"} className="provider-row-icon" />
      {label}
    </div>
  );
}

function ComingSoon({ label, icon }: { label: string; icon: ProviderIcon }) {
  return (
    <div className="provider-soon">
      <UiIcon name={icon} className="provider-soon-icon" />
      <div className="provider-soon-title">{label}</div>
      <span className="provider-soon-badge">Coming soon</span>
    </div>
  );
}
