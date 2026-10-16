import { useEffect, useRef, useState } from "react";
import { project, settings } from "../lib/ipc";
import { THEMES, applyTheme, currentTheme } from "../theme";
import { UiIcon } from "./fileIcons";

type Section = "appearance" | "project";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "lucide:palette" },
  { id: "project", label: "Project", icon: "lucide:hammer" },
];

/** Fenêtre de préférences : navigation par sections à gauche, réglages à droite. */
export function PreferencesDialog({ onClose, root }: { onClose: () => void; root: string | null }) {
  const [section, setSection] = useState<Section>("appearance");
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
    </div>
  );
}
