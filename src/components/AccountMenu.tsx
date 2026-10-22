import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { signOut, useGithubAccount } from "../lib/githubAccount";
import { openUrl } from "../lib/ipc";
import { UiIcon } from "./fileIcons";
import { GithubSignIn } from "./GithubSignIn";

/**
 * Profil GitHub en bas de la barre d'activité : photo ronde (ou icône si l'on
 * n'est pas connecté) qui ouvre un menu d'options. Le menu est rendu hors de la
 * barre (qui masque ce qui dépasse), collé à droite du bouton.
 */
export function AccountMenu({ expanded, onOpenAccounts }: { expanded: boolean; onOpenAccounts: () => void }) {
  const { loading, account } = useGithubAccount();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const label = account ? (account.name ?? account.login) : "GitHub account";

  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPosition({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom });
    setOpen((o) => !o);
  };

  // Clic en dehors (hors bouton et menu) ou Échap : fermeture.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <>
      <button
        ref={button}
        className="activity-item account-button"
        title={expanded ? undefined : label}
        aria-label={label}
        aria-expanded={open}
        onClick={toggle}
      >
        {account ? (
          <img className="account-button-avatar" src={account.avatarUrl} alt="" />
        ) : (
          <UiIcon name="lucide:user" className="activity-icon" />
        )}
        <span className="activity-label">{account ? account.login : "Account"}</span>
      </button>

      {open &&
        position &&
        createPortal(
          <div className="account-menu" ref={menu} role="menu" style={{ left: position.left, bottom: position.bottom }}>
            {account ? (
              <>
                <div className="account-menu-header">
                  <img className="account-avatar" src={account.avatarUrl} alt="" />
                  <div className="account-text">
                    <div className="account-name">{account.name ?? account.login}</div>
                    <div className="account-login">@{account.login}</div>
                  </div>
                </div>
                <div className="account-menu-separator" />
                <button
                  className="account-menu-item"
                  role="menuitem"
                  onClick={() => run(() => openUrl(`https://github.com/${account.login}`).catch(() => {}))}
                >
                  <UiIcon name="lucide:external-link" className="account-menu-icon" />
                  View profile on GitHub
                </button>
                <button className="account-menu-item" role="menuitem" onClick={() => run(onOpenAccounts)}>
                  <UiIcon name="lucide:settings" className="account-menu-icon" />
                  Account settings
                </button>
                <div className="account-menu-separator" />
                <button className="account-menu-item" role="menuitem" onClick={() => run(() => signOut().catch(() => {}))}>
                  <UiIcon name="lucide:log-out" className="account-menu-icon" />
                  Sign out
                </button>
              </>
            ) : loading ? null : (
              <div className="account-menu-signin">
                <GithubSignIn wide description="Sign in to push, pull, clone and publish your repositories." />
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
