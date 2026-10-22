import { useEffect, useRef, useState } from "react";
import { signOut, useGithubAccount } from "../lib/githubAccount";
import { project, settings, type RunCandidate } from "../lib/ipc";
import { RUN_CONFIG_EVENT } from "../lib/runner";
import { THEMES, applyTheme, currentTheme } from "../theme";
import { UiIcon } from "./fileIcons";
import { GithubSignIn } from "./GithubSignIn";

export type PreferencesSection = "appearance" | "project" | "accounts";
type Section = PreferencesSection;

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "lucide:palette" },
  { id: "project", label: "Project", icon: "lucide:hammer" },
  { id: "accounts", label: "Accounts", icon: "lucide:github" },
];

/** Fenêtre de préférences : navigation par sections à gauche, réglages à droite. */
export function PreferencesDialog({
  onClose,
  root,
  initialSection = "appearance",
}: {
  onClose: () => void;
  root: string | null;
  initialSection?: Section;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const panel = useRef<HTMLDivElement>(null);

  // Échap ferme la fenêtre ; le focus est placé dedans à l'ouverture.
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal preferences" role="dialog" aria-modal="true" aria-label="Preferences" tabIndex={-1} ref={panel}>
        <nav className="preferences-nav">
          <div className="preferences-nav-title">Preferences</div>
          {SECTIONS.map(({ id, label, icon }) => (
            <button
              key={id}
              className={id === section ? "preferences-nav-item active" : "preferences-nav-item"}
              onClick={() => setSection(id)}
            >
              <UiIcon name={icon} className="preferences-nav-icon" />
              {label}
            </button>
          ))}
        </nav>

        <section className="preferences-content">
          <header className="preferences-header">
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button className="icon-button" aria-label="Close" onClick={onClose}>
              <UiIcon name="lucide:x" className="icon-button-icon" />
            </button>
          </header>
          {section === "appearance" && <AppearanceSettings />}
          {section === "project" && <ProjectSettings root={root} />}
          {section === "accounts" && <AccountSettings />}
        </section>
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const [theme, setTheme] = useState(currentTheme());

  const select = (id: string) => {
    setTheme(applyTheme(id));
    settings.save({ theme: id }).catch(() => {});
  };

  return (
    <div className="preferences-body">
      <div className="setting-text">
        <div className="setting-label">Theme</div>
        <div className="setting-description">Colors of the whole interface.</div>
      </div>

      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map(({ id, label, preview }) => (
          <button
            key={id}
            role="radio"
            aria-checked={id === theme}
            className={id === theme ? "theme-card active" : "theme-card"}
            onClick={() => select(id)}
          >
            {/* Miniature : fond, fenêtre latérale, zone de code, trait primaire */}
            <span className="theme-preview" style={{ background: preview.app }}>
              <span className="theme-preview-window" style={{ background: preview.window }} />
              <span className="theme-preview-editor" style={{ background: preview.editor }}>
                <span className="theme-preview-accent" style={{ background: preview.primary }} />
              </span>
            </span>
            <span className="theme-name">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Réglages du projet ouvert (`.fast/config.json`) : commande de build de l'orchestrateur. */
function ProjectSettings({ root }: { root: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [detected, setDetected] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!root) return;
    project.config(root).then(({ config, detectedBuildCommand }) => {
      setDetected(detectedBuildCommand);
      setEnabled(config.buildCommand !== "");
      setCommand(config.buildCommand ?? "");
      setLoaded(true);
    });
  }, [root]);

  if (!root) {
    return (
      <div className="preferences-body">
        <p className="setting-description">Open a folder to configure its project settings.</p>
      </div>
    );
  }

  // Vide = détection automatique ; build désactivé = chaîne vide enregistrée.
  const save = (nextEnabled: boolean, nextCommand: string) => {
    const buildCommand = !nextEnabled ? "" : nextCommand.trim() || null;
    project.saveConfig(root, { buildCommand }).catch(() => {});
  };

  return (
    <div className="preferences-body">
      <div className="setting-text">
        <div className="setting-label">Build after each task</div>
        <div className="setting-description">
          When an agent finishes a task, FAST commits its work, runs this build, then merges it into the main branch.
        </div>
      </div>

      <label className="setting-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save(e.target.checked, command);
          }}
        />
        Run a build
      </label>

      <input
        className="setting-input"
        value={command}
        disabled={!loaded || !enabled}
        spellCheck={false}
        placeholder={detected ? `${detected} (detected)` : "No build command detected"}
        aria-label="Build command"
        onChange={(e) => setCommand(e.target.value)}
        onBlur={() => save(enabled, command)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <div className="setting-description">Leave empty to use the detected command. Saved in .fast/config.json.</div>

      <RunSettings root={root} />
    </div>
  );
}

/** Commande du bouton Run (barre du haut) : une des commandes détectées, ou la sienne. */
function RunSettings({ root }: { root: string }) {
  const [candidates, setCandidates] = useState<RunCandidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    project.runOptions(root).then(({ candidates, selected }) => {
      setCandidates(candidates);
      setSelected(selected);
      if (selected && !candidates.some((c) => c.command === selected)) setCustom(selected);
    });
  }, [root]);

  const choose = (command: string | null) => {
    setSelected(command);
    project
      .setRunCommand(root, command)
      .then(() => window.dispatchEvent(new Event(RUN_CONFIG_EVENT)))
      .catch(() => {});
  };
  const isCustom = selected !== null && !candidates.some((c) => c.command === selected);

  return (
    <>
      <div className="setting-text setting-group">
        <div className="setting-label">Run command</div>
        <div className="setting-description">What the Run button in the top bar starts (F5). Output shows in the Run tab.</div>
      </div>

      <div className="run-options" role="radiogroup" aria-label="Run command">
        {candidates.map((c) => (
          <label key={c.command} className="run-option">
            <input type="radio" name="run-command" checked={selected === c.command} onChange={() => choose(c.command)} />
            <span className="run-option-label">{c.label}</span>
            <code className="run-option-command">{c.command}</code>
          </label>
        ))}
        <label className="run-option">
          <input
            type="radio"
            name="run-command"
            checked={isCustom}
            onChange={() => custom.trim() && choose(custom.trim())}
          />
          <span className="run-option-label">Custom</span>
          <input
            className="setting-input run-option-input"
            value={custom}
            spellCheck={false}
            placeholder="e.g. npm run dev -- --port 3000"
            aria-label="Custom run command"
            onChange={(e) => setCustom(e.target.value)}
            onBlur={() => custom.trim() && custom.trim() !== selected && choose(custom.trim())}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
      </div>
      {candidates.length === 0 && (
        <div className="setting-description">No run command detected in this project: type yours above.</div>
      )}
    </>
  );
}

/** Compte GitHub : utilisé pour push / pull, cloner et publier des dépôts. */
function AccountSettings() {
  const { loading, account } = useGithubAccount();

  return (
    <div className="preferences-body">
      <div className="setting-text">
        <div className="setting-label">GitHub</div>
        <div className="setting-description">Used to push and pull, clone your repositories and publish new ones.</div>
      </div>
      {loading ? null : account ? (
        <div className="account-card">
          <img className="account-avatar" src={account.avatarUrl} alt="" />
          <div className="account-text">
            <div className="account-name">{account.name ?? account.login}</div>
            <div className="account-login">@{account.login}</div>
          </div>
          <button className="secondary-button" onClick={() => signOut().catch(() => {})}>
            <UiIcon name="lucide:log-out" className="secondary-button-icon" />
            Sign out
          </button>
        </div>
      ) : (
        <GithubSignIn />
      )}
    </div>
  );
}
