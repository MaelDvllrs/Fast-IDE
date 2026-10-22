import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGithubAccount } from "../lib/githubAccount";
import { github, scm, workspace, type GithubRepo } from "../lib/ipc";
import { UiIcon } from "./fileIcons";
import { GithubSignIn } from "./GithubSignIn";

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Nom de dépôt GitHub valide à partir d'un nom de dossier. */
const repoName = (folder: string) =>
  folder
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "my-project";

/** Fenêtre modale simple : titre, contenu, fermeture par Échap ou clic à côté. */
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <header className="preferences-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <UiIcon name="lucide:x" className="icon-button-icon" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** Publie le projet ouvert dans un nouveau dépôt GitHub. */
export function PublishDialog({ root, onClose, onPublished }: { root: string; onClose: () => void; onPublished: (repo: GithubRepo) => void }) {
  const { loading, account } = useGithubAccount();
  const [name, setName] = useState(() => repoName(basename(root)));
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      onPublished(await scm.publish(root, name, isPrivate, description.trim() || null));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Publish to GitHub" onClose={onClose}>
      {loading ? null : !account ? (
        <GithubSignIn description="Sign in to GitHub to create a repository for this project." />
      ) : (
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && name.trim()) publish();
          }}
        >
          <label className="field">
            <span className="setting-label">Repository name</span>
            <div className="field-row">
              <span className="field-prefix">{account.login} /</span>
              <input className="setting-input" value={name} autoFocus spellCheck={false} onChange={(e) => setName(e.target.value)} />
            </div>
          </label>
          <label className="field">
            <span className="setting-label">
              Description <span className="field-optional">(optional)</span>
            </span>
            <input className="setting-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="choice-group" role="radiogroup" aria-label="Visibility">
            <Choice checked={isPrivate} onSelect={() => setPrivate(true)} icon="lucide:lock" title="Private" text="Only you and people you invite can see it." />
            <Choice checked={!isPrivate} onSelect={() => setPrivate(false)} icon="lucide:globe" title="Public" text="Anyone on the internet can see it." />
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
              {busy && <UiIcon name="lucide:loader-circle" className="spin primary-button-icon" />}
              {busy ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function Choice({
  checked,
  onSelect,
  icon,
  title,
  text,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: "lucide:lock" | "lucide:globe";
  title: string;
  text: string;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={checked ? "choice active" : "choice"} onClick={onSelect}>
      <UiIcon name={icon} className="choice-icon" />
      <span>
        <span className="choice-title">{title}</span>
        <span className="choice-text">{text}</span>
      </span>
    </button>
  );
}

/** Une URL de dépôt collée dans la recherche (https ou ssh). */
const looksLikeUrl = (text: string) => /^(https?:\/\/|git@)\S+$/.test(text.trim());

const folderFromUrl = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .pop()!
    .replace(/\.git$/, "");

const relativeTime = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!iso || Number.isNaN(days)) return "";
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

/** Clone un de ses dépôts GitHub (ou une URL collée) dans un dossier choisi, puis l'ouvre. */
export function CloneDialog({ onClose, onCloned }: { onClose: () => void; onCloned: (path: string) => void }) {
  const { loading, account } = useGithubAccount();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setRepos(null);
    github.repos().then(setRepos, (e) => {
      setRepos([]);
      setError(String(e));
    });
  }, [account]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
  }, [repos, query]);

  const clone = async (url: string, label: string) => {
    setError(null);
    const parent = await workspace.pickFolder().catch(() => null);
    if (!parent) return;
    setBusy(`Cloning ${label}…`);
    try {
      onCloned(await scm.clone(url, parent, folderFromUrl(url)));
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  };

  const url = looksLikeUrl(query) ? query.trim() : null;

  return (
    <Dialog title="Clone from GitHub" onClose={onClose}>
      <input
        className="setting-input dialog-search"
        autoFocus
        value={query}
        spellCheck={false}
        disabled={!!busy}
        placeholder={account ? "Search your repositories or paste a URL" : "Paste a repository URL"}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && url) clone(url, folderFromUrl(url));
        }}
      />

      {url && (
        <button className="thin-button" disabled={!!busy} onClick={() => clone(url, folderFromUrl(url))}>
          <UiIcon name="lucide:download" className="thin-button-icon" />
          Clone {folderFromUrl(url)}
        </button>
      )}

      {busy && (
        <div className="scm-notice">
          <UiIcon name="lucide:loader-circle" className="spin scm-notice-icon" />
          {busy}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}

      {!loading && !account && !url && (
        <GithubSignIn description="Sign in to GitHub to browse your repositories, including private ones." />
      )}

      {account && !url && (
        <div className="repo-list">
          {!repos && <div className="repo-empty">Loading repositories…</div>}
          {repos && filtered.length === 0 && <div className="repo-empty">No repositories found.</div>}
          {filtered.map((repo) => (
            <button key={repo.fullName} className="repo-item" disabled={!!busy} onClick={() => clone(repo.cloneUrl, repo.fullName)}>
              <span className="repo-main">
                <span className="repo-name">
                  <span className="repo-owner">{repo.owner} /</span> {repo.name}
                  {repo.private && <UiIcon name="lucide:lock" className="repo-lock" />}
                </span>
                {repo.description && <span className="repo-description">{repo.description}</span>}
              </span>
              <span className="repo-updated">{relativeTime(repo.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
