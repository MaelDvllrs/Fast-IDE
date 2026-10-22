import { useCallback, useEffect, useRef, useState } from "react";
import { useGithubAccount } from "../lib/githubAccount";
import { openUrl, scm, type ScmBranches, type ScmChange, type ScmCommit, type ScmStatus } from "../lib/ipc";
import { FileIcon, UiIcon } from "./fileIcons";
import { GithubSignIn } from "./GithubSignIn";

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  onPublish: () => void;
}

/** Intervalle de rafraîchissement de l'état pendant que le panneau est affiché. */
const POLL_MS = 4000;

// Message de commit en cours de saisie, par dossier : il survit au changement de vue.
const drafts = new Map<string, string>();

/** Lettre affichée et classe de couleur pour un état git. */
function statusBadge(change: ScmChange, conflict = false): { letter: string; tone: string; label: string } {
  if (conflict) return { letter: "!", tone: "conflict", label: "Conflict" };
  switch (change.status) {
    case "?":
      return { letter: "U", tone: "added", label: "Untracked" };
    case "A":
      return { letter: "A", tone: "added", label: "Added" };
    case "D":
      return { letter: "D", tone: "deleted", label: "Deleted" };
    case "R":
      return { letter: "R", tone: "renamed", label: "Renamed" };
    default:
      return { letter: change.status, tone: "modified", label: "Modified" };
  }
}

/** Page web d'un commit si le remote est sur github.com, sinon `null`. */
const githubCommitUrl = (remote: string | null, hash: string) => {
  const match = remote?.match(/github\.com[/:]([^/]+\/[^/]+?)(\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/commit/${hash}` : null;
};

const relativeTime = (seconds: number) => {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d`;
  if (diff < 365 * 86_400) return `${Math.floor(diff / (30 * 86_400))}mo`;
  return `${Math.floor(diff / (365 * 86_400))}y`;
};

const splitPath = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
};

/**
 * Panneau Git : branche et synchronisation avec le remote, message et commit,
 * fichiers indexés / modifiés / en conflit. L'état est relu régulièrement :
 * les agents modifient aussi le projet.
 */
export function GitPanel({ root, onOpenFile, onPublish }: Props) {
  const [status, setStatus] = useState<ScmStatus | null>(null);
  const [commits, setCommits] = useState<ScmCommit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessageState] = useState(() => drafts.get(root) ?? "");
  const [branchMenu, setBranchMenu] = useState(false);
  const { loading: accountLoading, account } = useGithubAccount();
  // Pas connecté à GitHub : bouton de connexion en haut du panneau, quel que soit l'état du dépôt.
  const signIn = !accountLoading && !account && (
    <div className="scm-signin">
      <GithubSignIn wide />
    </div>
  );

  const setMessage = (value: string) => {
    drafts.set(root, value);
    setMessageState(value);
  };

  const refresh = useCallback(() => {
    scm.log(root).then(setCommits, () => setCommits([]));
    return scm.status(root).then(setStatus, (e) => setError(String(e)));
  }, [root]);

  useEffect(() => {
    refresh();
    // Avance / retard par rapport au remote : un fetch silencieux à l'ouverture.
    scm.fetch(root).then(refresh, () => {});
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [root, refresh]);

  /** Action git : libellé de progression, erreur affichée, état relu à la fin. */
  const act = async (label: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const commit = () =>
    act("Committing…", async () => {
      const hash = await scm.commit(root, message);
      setMessage("");
      setNotice(`Committed ${hash}`);
    });

  if (!status) {
    return (
      <>
        <GitHeader onRefresh={refresh} />
        {signIn}
        {error && <div className="scm-error">{error}</div>}
      </>
    );
  }

  if (!status.isRepo) {
    return (
      <>
        <GitHeader onRefresh={refresh} />
        {signIn}
        <div className="scm-empty">
          <p>This folder isn't a Git repository yet.</p>
          <button className="thin-button" disabled={!!busy} onClick={() => act("Initializing…", () => scm.init(root))}>
            Initialize Repository
          </button>
          <button className="thin-button" disabled={!!busy} onClick={onPublish}>
            <UiIcon name="lucide:github" className="thin-button-icon" />
            Publish to GitHub
          </button>
        </div>
        {error && <div className="scm-error">{error}</div>}
      </>
    );
  }

  // Pas (encore) connecté à GitHub : seul le bouton de connexion, sans branche ni commit.
  if (accountLoading || !account) {
    return (
      <>
        <GitHeader onRefresh={refresh} />
        {signIn}
      </>
    );
  }

  const total = status.staged.length + status.changes.length + status.conflicts.length;
  const branchLabel = status.branch ?? "Detached HEAD";
  const canCommit = !busy && message.trim() !== "" && total > 0;

  return (
    <>
      <GitHeader onRefresh={() => act("Fetching…", () => scm.fetch(root))} />

      <div className="scm-branch-row">
        <div className="scm-branch-anchor">
          <button
            className="scm-branch"
            title="Switch branch"
            aria-expanded={branchMenu}
            onClick={() => setBranchMenu((open) => !open)}
          >
            <UiIcon name="lucide:git-branch" className="scm-branch-icon" />
            <span className="scm-branch-name">{branchLabel}</span>
            <UiIcon name="lucide:chevron-down" className="scm-branch-chevron" />
          </button>
          {branchMenu && (
            <BranchMenu
              root={root}
              onClose={() => setBranchMenu(false)}
              onSwitch={(branch) => act(`Switching to ${branch}…`, () => scm.checkout(root, branch))}
              onCreate={(name) => act(`Creating ${name}…`, () => scm.createBranch(root, name))}
            />
          )}
        </div>

        {status.remote ? (
          <div className="scm-sync">
            <button
              className="scm-sync-button"
              title={status.upstream ? `Pull from ${status.upstream}` : "Pull"}
              disabled={!!busy || !status.upstream}
              onClick={() => act("Pulling…", () => scm.pull(root), "Pulled")}
            >
              <UiIcon name="lucide:arrow-down" className="scm-sync-icon" />
              {status.behind > 0 && status.behind}
            </button>
            <button
              className="scm-sync-button"
              title={status.upstream ? `Push to ${status.upstream}` : "Push this branch to origin"}
              disabled={!!busy || !status.hasCommits}
              onClick={() => act("Pushing…", () => scm.push(root), "Pushed")}
            >
              <UiIcon name="lucide:arrow-up" className="scm-sync-icon" />
              {status.ahead > 0 && status.ahead}
            </button>
          </div>
        ) : null}
      </div>

      {!status.remote && (
        <div className="scm-publish">
          <button className="thin-button" disabled={!!busy} onClick={onPublish}>
            <UiIcon name="lucide:cloud-upload" className="thin-button-icon" />
            Publish to GitHub
          </button>
        </div>
      )}

      <div className="scm-commit">
        <textarea
          className="scm-message"
          value={message}
          rows={Math.min(6, Math.max(2, message.split("\n").length))}
          spellCheck={false}
          placeholder={`Message (Ctrl+Enter to commit on "${branchLabel}")`}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button className="primary-button wide" disabled={!canCommit} onClick={commit}>
          <UiIcon name="lucide:check" className="primary-button-icon" />
          {status.staged.length === 0 && total > 0 ? "Commit All" : "Commit"}
        </button>
      </div>

      {(busy || error || notice) && (
        <div className={error ? "scm-error" : "scm-notice"}>
          {busy ? (
            <>
              <UiIcon name="lucide:loader-circle" className="spin scm-notice-icon" />
              {busy}
            </>
          ) : (
            (error ?? notice)
          )}
        </div>
      )}
      {status.merging && <div className="scm-notice">Merge in progress: resolve the conflicts, then commit.</div>}

      <div className="scm-lists">
        {status.conflicts.length > 0 && (
          <ChangeList
            title="Merge Conflicts"
            changes={status.conflicts}
            conflict
            onOpen={onOpenFile}
            action={{ icon: "lucide:plus", label: "Mark as resolved", run: (paths) => act("Staging…", () => scm.stage(root, paths)) }}
          />
        )}
        {status.staged.length > 0 && (
          <ChangeList
            title="Staged Changes"
            changes={status.staged}
            onOpen={onOpenFile}
            action={{ icon: "lucide:minus", label: "Unstage", run: (paths) => act("Unstaging…", () => scm.unstage(root, paths)) }}
          />
        )}
        <ChangeList
          title="Changes"
          changes={status.changes}
          onOpen={onOpenFile}
          action={{ icon: "lucide:plus", label: "Stage", run: (paths) => act("Staging…", () => scm.stage(root, paths)) }}
        />
        {total === 0 && <p className="scm-clean">No changes.</p>}
      </div>

      <CommitList commits={commits} remote={status.remote} />
    </>
  );
}

/** Derniers commits, en bas du panneau ; un clic ouvre le commit sur GitHub. */
function CommitList({ commits, remote }: { commits: ScmCommit[]; remote: string | null }) {
  const [open, setOpen] = useState(true);

  return (
    <section className={open ? "scm-history open" : "scm-history"}>
      <div className="scm-section-header">
        <button className="scm-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <UiIcon name="material-symbols:arrow-forward-ios-rounded" className={open ? "tree-arrow open" : "tree-arrow"} />
          Commits
        </button>
        <span className="scm-count">{commits.length}</span>
      </div>
      {open && (
        <ul className="scm-history-list">
          {commits.length === 0 && <li className="scm-clean">No commits yet.</li>}
          {commits.map((commit) => {
            const url = githubCommitUrl(remote, commit.hash);
            const date = new Date(commit.time * 1000).toLocaleString("en-US");
            return (
              <li key={commit.hash}>
                <button
                  className="scm-commit-row"
                  disabled={!url}
                  title={`${commit.subject}\n${commit.shortHash} · ${commit.author} · ${date}${commit.unpushed ? "\nNot pushed yet" : ""}`}
                  onClick={() => url && openUrl(url).catch(() => {})}
                >
                  <span className={commit.unpushed ? "scm-commit-dot unpushed" : "scm-commit-dot"} />
                  <span className="scm-commit-subject">{commit.subject}</span>
                  <span className="scm-commit-time">{relativeTime(commit.time)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function GitHeader({ onRefresh }: { onRefresh: () => void }) {
  return (
    <header className="panel-header">
      <span className="panel-title">Git</span>
      <button className="title-icon-button end" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
        <UiIcon name="lucide:refresh-cw" className="title-icon" />
      </button>
    </header>
  );
}

interface ListAction {
  icon: "lucide:plus" | "lucide:minus";
  label: string;
  /** `paths` vide = tous les fichiers de la liste. */
  run: (paths: string[]) => void;
}

function ChangeList({
  title,
  changes,
  conflict = false,
  onOpen,
  action,
}: {
  title: string;
  changes: ScmChange[];
  conflict?: boolean;
  onOpen: (path: string) => void;
  action: ListAction;
}) {
  const [open, setOpen] = useState(true);
  // Toute la liste : chemins explicites pour les conflits (seuls ceux-là sont marqués résolus).
  const all = conflict ? changes.map((c) => c.path) : [];

  return (
    <section className="scm-section">
      <div className="scm-section-header">
        <button className="scm-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <UiIcon name="material-symbols:arrow-forward-ios-rounded" className={open ? "tree-arrow open" : "tree-arrow"} />
          {title}
        </button>
        {changes.length > 0 && (
          <button className="scm-row-action" title={`${action.label} All`} aria-label={`${action.label} All`} onClick={() => action.run(all)}>
            <UiIcon name={action.icon} className="scm-row-action-icon" />
          </button>
        )}
        <span className="scm-count">{changes.length}</span>
      </div>
      {open && (
        <ul>
          {changes.map((change) => {
            const { name, dir } = splitPath(change.path);
            const badge = statusBadge(change, conflict);
            const deleted = change.status === "D";
            return (
              <li key={change.path} className="scm-row">
                <button
                  className={deleted ? "scm-file deleted" : "scm-file"}
                  title={change.from ? `${change.from} → ${change.path}` : change.path}
                  disabled={deleted}
                  onClick={() => onOpen(change.absPath)}
                >
                  <FileIcon name={name} />
                  <span className="scm-file-name">{name}</span>
                  {dir && <span className="scm-file-dir">{dir}</span>}
                </button>
                <button className="scm-row-action" title={action.label} aria-label={`${action.label} ${name}`} onClick={() => action.run([change.path])}>
                  <UiIcon name={action.icon} className="scm-row-action-icon" />
                </button>
                <span className={`scm-badge ${badge.tone}`} title={badge.label}>
                  {badge.letter}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Menu des branches : recherche / création, branches locales puis distantes. */
function BranchMenu({
  root,
  onClose,
  onSwitch,
  onCreate,
}: {
  root: string;
  onClose: () => void;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
}) {
  const [branches, setBranches] = useState<ScmBranches | null>(null);
  const [query, setQuery] = useState("");
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scm.branches(root).then(setBranches, () => setBranches({ current: null, local: [], remote: [] }));
  }, [root]);

  // Clic en dehors ou Échap : fermeture.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const match = (b: string) => b.toLowerCase().includes(q);
  const exists = !!branches && [...branches.local, ...branches.remote].some((b) => b === query.trim());
  const pick = (run: () => void) => {
    onClose();
    run();
  };

  return (
    <div className="scm-branch-menu" ref={menu}>
      <input
        className="scm-branch-search"
        autoFocus
        value={query}
        spellCheck={false}
        placeholder="Switch or create a branch…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.trim() && !exists) pick(() => onCreate(query.trim()));
        }}
      />
      <div className="scm-branch-list">
        {q && !exists && (
          <button className="scm-branch-item create" onClick={() => pick(() => onCreate(query.trim()))}>
            <UiIcon name="lucide:plus" className="scm-branch-item-icon" />
            Create branch "{query.trim()}"
          </button>
        )}
        {branches?.local.filter(match).map((b) => (
          <button
            key={b}
            className={b === branches.current ? "scm-branch-item current" : "scm-branch-item"}
            onClick={() => pick(() => b !== branches.current && onSwitch(b))}
          >
            <UiIcon name={b === branches.current ? "lucide:check" : "lucide:git-branch"} className="scm-branch-item-icon" />
            {b}
          </button>
        ))}
        {branches && branches.remote.filter(match).length > 0 && <div className="scm-branch-group">Remote</div>}
        {branches?.remote.filter(match).map((b) => (
          <button key={b} className="scm-branch-item" onClick={() => pick(() => onSwitch(b))}>
            <UiIcon name="lucide:globe" className="scm-branch-item-icon" />
            {b}
          </button>
        ))}
        {!branches && <div className="scm-branch-group">Loading…</div>}
      </div>
    </div>
  );
}
