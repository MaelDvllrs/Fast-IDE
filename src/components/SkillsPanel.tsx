import { useCallback, useEffect, useState } from "react";
import { PROVIDER_INFO, type ProviderId } from "../agents/providers";
import { openUrl, skills as skillsApi, type Skill, type SkillCandidate, type SkillScope } from "../lib/ipc";
import { UiIcon } from "./fileIcons";

/** IA qui reçoivent un skill installé (une copie dans le dossier de chacune). */
const AIS: ProviderId[] = ["claude-code", "codex", "gemini"];

type Step =
  | { kind: "idle" }
  | { kind: "reading" }
  /** Le lien contient plusieurs skills : l'utilisateur choisit. */
  | { kind: "choose"; repo: string; candidates: SkillCandidate[]; selected: Set<string> }
  | { kind: "installing" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * Skills des agents : installation depuis un lien GitHub (pour le projet ou pour
 * tous les projets, chez les IA choisies), puis les skills installés.
 */
export function SkillsPanel({ root }: { root: string | null }) {
  const [list, setList] = useState<Skill[] | null>(null);
  const [link, setLink] = useState("");
  const [scope, setScope] = useState<SkillScope>(root ? "project" : "global");
  const [ais, setAis] = useState<Set<ProviderId>>(new Set(AIS));
  const [step, setStep] = useState<Step>({ kind: "idle" });

  const refresh = useCallback(() => {
    skillsApi.list(root).then(setList, () => setList([]));
  }, [root]);
  useEffect(refresh, [refresh]);
  // Projet ouvert (ou fermé) : installation pour ce projet par défaut.
  useEffect(() => setScope(root ? "project" : "global"), [root]);

  const install = async (dirs: string[]) => {
    setStep({ kind: "installing" });
    try {
      const installed = await skillsApi.install(link.trim(), dirs, scope, root, [...ais]);
      const where = scope === "project" ? "this project" : "all projects";
      setStep({ kind: "done", message: `Installed ${installed.join(", ")} for ${where}.` });
      setLink("");
      refresh();
    } catch (err) {
      setStep({ kind: "error", message: String(err) });
    }
  };

  // Lecture du lien : un seul skill s'installe directement, plusieurs se choisissent.
  const submit = async () => {
    if (!link.trim() || ais.size === 0) return;
    setStep({ kind: "reading" });
    try {
      const { repo, candidates } = await skillsApi.inspect(link.trim());
      if (candidates.length === 1) await install([candidates[0].dir]);
      else setStep({ kind: "choose", repo, candidates, selected: new Set() });
    } catch (err) {
      setStep({ kind: "error", message: String(err) });
    }
  };

  const busy = step.kind === "reading" || step.kind === "installing";
  const toggleAi = (ai: ProviderId) =>
    setAis((prev) => {
      const next = new Set(prev);
      if (next.has(ai)) next.delete(ai);
      else next.add(ai);
      return next;
    });

  return (
    <>
      <header className="panel-header">
        <span className="panel-title">Skills</span>
        <button className="title-icon-button end" title="Refresh" aria-label="Refresh skills" onClick={refresh}>
          <UiIcon name="lucide:refresh-cw" className="title-icon" />
        </button>
      </header>

      <div className="skills-body">
        <form
          className="provider-card skills-install"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="provider-card-title">
            <UiIcon name="lucide:download" className="provider-card-icon" />
            Install a skill
          </div>
          <input
            className="setting-input skills-link"
            placeholder="Paste a GitHub link…"
            value={link}
            disabled={busy}
            spellCheck={false}
            onChange={(e) => {
              setLink(e.target.value);
              if (step.kind !== "idle" && !busy) setStep({ kind: "idle" });
            }}
          />

          <div className="skills-choice" role="radiogroup" aria-label="Install for">
            <button
              type="button"
              role="radio"
              aria-checked={scope === "project"}
              className={scope === "project" ? "skills-choice-item active" : "skills-choice-item"}
              disabled={!root || busy}
              title={root ? undefined : "Open a project first"}
              onClick={() => setScope("project")}
            >
              This project
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === "global"}
              className={scope === "global" ? "skills-choice-item active" : "skills-choice-item"}
              disabled={busy}
              onClick={() => setScope("global")}
            >
              All projects
            </button>
          </div>

          <div className="skills-ais" aria-label="For these AIs">
            {AIS.map((ai) => (
              <label key={ai} className="skills-ai" title={PROVIDER_INFO[ai].label}>
                <input type="checkbox" checked={ais.has(ai)} disabled={busy} onChange={() => toggleAi(ai)} />
                <UiIcon name={PROVIDER_INFO[ai].icon} className="skills-ai-icon" />
                {PROVIDER_INFO[ai].label}
              </label>
            ))}
          </div>

          {step.kind === "choose" ? (
            <ChooseSkills
              step={step}
              onToggle={(dir) =>
                setStep((s) => {
                  if (s.kind !== "choose") return s;
                  const selected = new Set(s.selected);
                  if (selected.has(dir)) selected.delete(dir);
                  else selected.add(dir);
                  return { ...s, selected };
                })
              }
              onInstall={() => install([...step.selected])}
              onCancel={() => setStep({ kind: "idle" })}
            />
          ) : (
            <button className="thin-button" type="submit" disabled={busy || !link.trim() || ais.size === 0}>
              {step.kind === "reading" ? "Reading the link…" : step.kind === "installing" ? "Installing…" : "Install"}
            </button>
          )}
          {step.kind === "done" && <div className="provider-note">{step.message}</div>}
          {step.kind === "error" && <div className="form-error">{step.message}</div>}
          {ais.size === 0 && <div className="provider-note">Choose at least one AI.</div>}
        </form>

        {root && <SkillSection title="This project" skills={list?.filter((s) => s.scope === "project")} root={root} onChange={refresh} />}
        <SkillSection title="All projects" skills={list?.filter((s) => s.scope === "global")} root={root} onChange={refresh} />
      </div>
    </>
  );
}

/** Le lien contient plusieurs skills : cases à cocher, puis installation. */
function ChooseSkills({
  step,
  onToggle,
  onInstall,
  onCancel,
}: {
  step: Extract<Step, { kind: "choose" }>;
  onToggle: (dir: string) => void;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const count = step.selected.size;
  return (
    <div className="skills-candidates">
      <div className="provider-note">
        {step.candidates.length} skills in {step.repo}: choose the ones to install.
      </div>
      <ul>
        {step.candidates.map((c) => (
          <li key={c.dir}>
            <label className="skills-candidate" title={c.description ?? undefined}>
              <input type="checkbox" checked={step.selected.has(c.dir)} onChange={() => onToggle(c.dir)} />
              <span className="skills-row-text">
                <span className="skills-row-name">{c.name}</span>
                {c.description && <span className="skills-row-description">{c.description}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="skills-candidates-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary-button" disabled={count === 0} onClick={onInstall}>
          {count === 0 ? "Install" : `Install ${count} skill${count > 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}

function SkillSection({
  title,
  skills,
  root,
  onChange,
}: {
  title: string;
  skills: Skill[] | undefined;
  root: string | null;
  onChange: () => void;
}) {
  return (
    <section className="skills-section">
      <div className="provider-section-title">{title}</div>
      {skills === undefined ? (
        <div className="provider-note">Loading…</div>
      ) : skills.length === 0 ? (
        <div className="provider-note">No skills yet.</div>
      ) : (
        <ul className="skills-list">
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} root={root} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Un skill installé : nom, description, IA qui l'ont, origine et suppression (confirmée). */
function SkillRow({ skill, root, onChange }: { skill: Skill; root: string | null; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () =>
    skillsApi.remove(skill.id, skill.scope, root).then(onChange, (err) => {
      setError(String(err));
      setConfirming(false);
    });

  return (
    <li className="skills-row" title={skill.description ?? undefined}>
      <span className="skills-row-text">
        <span className="skills-row-name">{skill.name}</span>
        {skill.description && <span className="skills-row-description">{skill.description}</span>}
        {error && <span className="form-error">{error}</span>}
      </span>
      <span className="skills-row-ais">
        {skill.ais.map((ai) => {
          const info = PROVIDER_INFO[ai as ProviderId];
          return info ? <UiIcon key={ai} name={info.icon} className="skills-ai-icon" /> : null;
        })}
      </span>
      {skill.source && !confirming && (
        <button className="title-icon-button" title="Open on GitHub" aria-label="Open on GitHub" onClick={() => openUrl(skill.source!)}>
          <UiIcon name="lucide:external-link" className="title-icon" />
        </button>
      )}
      {confirming ? (
        <>
          <button className="secondary-button skills-confirm" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button className="secondary-button skills-confirm danger" onClick={remove}>
            Remove
          </button>
        </>
      ) : (
        <button className="title-icon-button" title="Remove" aria-label={`Remove ${skill.name}`} onClick={() => setConfirming(true)}>
          <UiIcon name="lucide:trash-2" className="title-icon" />
        </button>
      )}
    </li>
  );
}
