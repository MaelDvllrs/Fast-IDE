import { useCallback, useEffect, useState } from "react";
import { CLAUDE_CODE, GEMINI } from "../agents/providers";
import { useCodexModels } from "../lib/codexModels";
import { claude, codex, gemini, type ClaudeStatus, type CodexStatus, type GeminiStatus } from "../lib/ipc";
import { runInTerminal } from "../lib/terminalBus";
import { UiIcon } from "./fileIcons";

type ProviderId = "claude" | "openai" | "gemini";
type ProviderIcon = "simple-icons:claude" | "simple-icons:openai" | "simple-icons:googlegemini";

// IA proposées pour les agents.
const PROVIDERS: { id: ProviderId; label: string; icon: ProviderIcon }[] = [
  { id: "claude", label: "Claude", icon: "simple-icons:claude" },
  { id: "openai", label: "OpenAI", icon: "simple-icons:openai" },
  { id: "gemini", label: "Gemini", icon: "simple-icons:googlegemini" },
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
            className={p.id === provider ? "provider-tab active" : "provider-tab"}
            title={p.label}
            aria-label={p.label}
            onClick={() => setProvider(p.id)}
          >
            <UiIcon name={p.icon} className="provider-tab-icon" />
          </button>
        ))}
      </div>

      <div className="provider-body" role="tabpanel">
        {current.id === "openai" ? <CodexProvider /> : current.id === "gemini" ? <GeminiProvider /> : <ClaudeProvider />}
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

/** Codex (OpenAI) : installation, compte ChatGPT connecté, modèles du compte. */
function CodexProvider() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    codex.status().then(setStatus, (err) => setNotice(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const ready = !!status?.installed && status.loggedIn;
  const models = useCodexModels(ready);

  useEffect(() => {
    if (!waiting || ready) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, ready, refresh]);

  // Installation et connexion dans le terminal intégré, visibles par l'utilisateur.
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
      await codex.logout();
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
          <UiIcon name="simple-icons:openai" className="provider-card-icon" />
          Codex
          <button className="title-icon-button end" title="Check again" aria-label="Check again" onClick={refresh}>
            <UiIcon name="lucide:refresh-cw" className="title-icon" />
          </button>
        </div>

        {!status ? (
          <div className="provider-row">Checking…</div>
        ) : !status.installed ? (
          <>
            <StatusRow ok={false} label="Not installed" />
            <div className="provider-note">Codex is OpenAI's coding agent. FAST installs it with npm.</div>
            <button className="thin-button" onClick={() => launch(status.installCommand)}>
              Install Codex
            </button>
          </>
        ) : !status.loggedIn ? (
          <>
            <StatusRow
              ok={false}
              label={status.loginMethod ? `Signed in with ${status.loginMethod}, not ChatGPT` : "Not signed in"}
            />
            <div className="provider-note">Uses your ChatGPT plan (Plus, Pro, Team…), not an API key.</div>
            <button className="thin-button" onClick={() => launch(status.loginCommand)}>
              Sign in with ChatGPT
            </button>
          </>
        ) : (
          <>
            <div className="provider-account">
              <div className="provider-account-avatar">{(status.email ?? "?")[0].toUpperCase()}</div>
              <div className="account-text">
                <div className="provider-account-email">{status.email ?? "ChatGPT account"}</div>
                <div className="account-login">
                  {status.plan ? `ChatGPT ${planLabel(status.plan)} plan` : "Signed in with ChatGPT"}
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

      {ready && (
        <>
          <div className="provider-section-title">Models</div>
          <ul className="provider-models">
            {models.length === 0 && <li className="provider-model provider-note">Loading models…</li>}
            {models.map((m) => (
              <li key={m.id} className="provider-model">
                <span className="provider-model-name">{m.displayName}</span>
                <span className="provider-model-description">{m.isDefault ? "Default" : m.description}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Gemini CLI (Google) : installation, compte Google connecté, modèles proposés. */
function GeminiProvider() {
  const [status, setStatus] = useState<GeminiStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    gemini.status().then(setStatus, (err) => setNotice(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const ready = !!status?.installed && status.loggedIn;

  // Installation dans le terminal intégré ; l'état est revérifié jusqu'à la fin.
  useEffect(() => {
    if (!waiting || status?.installed) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, status?.installed, refresh]);

  const install = () => {
    if (!status) return;
    if (runInTerminal(status.installCommand)) {
      setNotice(null);
      setWaiting(true);
    } else {
      setNotice("Open a folder first: the command runs in the terminal.");
    }
  };

  // Gemini CLI ouvre la connexion Google dans le navigateur et attend sa validation.
  const run = async (action: "login" | "logout") => {
    setBusy(action);
    setNotice(null);
    try {
      await (action === "login" ? gemini.login() : gemini.logout());
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <>
      <div className="provider-card">
        <div className="provider-card-title">
          <UiIcon name="simple-icons:googlegemini" className="provider-card-icon" />
          Gemini CLI
          <button className="title-icon-button end" title="Check again" aria-label="Check again" onClick={refresh}>
            <UiIcon name="lucide:refresh-cw" className="title-icon" />
          </button>
        </div>

        {!status ? (
          <div className="provider-row">Checking…</div>
        ) : !status.installed ? (
          <>
            <StatusRow ok={false} label="Not installed" />
            <div className="provider-note">Gemini CLI is Google's coding agent. FAST installs it with npm (Node 20 or later).</div>
            <button className="thin-button" onClick={install}>
              Install Gemini CLI
            </button>
            {waiting && <div className="provider-note">Waiting for the terminal to finish…</div>}
          </>
        ) : !status.loggedIn ? (
          <>
            <StatusRow ok={false} label="Not signed in" />
            <div className="provider-note">Uses your Google account, not an API key.</div>
            <button className="thin-button" disabled={busy !== null} onClick={() => run("login")}>
              {busy === "login" ? "Waiting for the browser…" : "Sign in with Google"}
            </button>
            {busy === "login" && (
              <div className="provider-note">Finish signing in on the page that opened in your browser.</div>
            )}
          </>
        ) : (
          <>
            <div className="provider-account">
              <div className="provider-account-avatar">{(status.email ?? "?")[0].toUpperCase()}</div>
              <div className="account-text">
                <div className="provider-account-email">{status.email ?? "Google account"}</div>
                <div className="account-login">Signed in with Google</div>
              </div>
            </div>
            <div className="provider-actions">
              <button className="provider-action" disabled={busy !== null} onClick={() => run("logout")}>
                <UiIcon name="lucide:log-out" className="provider-action-icon" />
                {busy === "logout" ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </>
        )}
        {notice && <div className="form-error">{notice}</div>}
      </div>

      {ready && (
        <>
          <div className="provider-section-title">Models</div>
          <ul className="provider-models">
            {GEMINI.models
              .filter((m) => m.id)
              .map((m) => (
                <li key={m.id} className="provider-model">
                  <span className="provider-model-name">{m.label}</span>
                  <span className="provider-model-description">{m.description}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </>
  );
}
