import { useEffect, useRef, useState } from "react";
import { setAccount } from "../lib/githubAccount";
import { github, openUrl, type GithubDeviceCode } from "../lib/ipc";
import { UiIcon } from "./fileIcons";

/** Message du cœur Rust quand la connexion est annulée depuis FAST. */
const CANCELLED = "Sign-in cancelled.";

type Step = { kind: "idle" } | { kind: "starting" } | { kind: "waiting"; code: GithubDeviceCode } | { kind: "error"; message: string };

/**
 * Connexion à GitHub (device flow) : FAST affiche un code, l'ouvre dans le
 * navigateur (code déjà copié), puis attend que l'utilisateur le valide.
 */
/** `wide` : bouton fin sur toute la largeur (panneaux latéraux). */
export function GithubSignIn({ description, wide = false }: { description?: string; wide?: boolean }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const waiting = useRef(false);

  // Fermeture du composant pendant l'attente : la connexion est abandonnée.
  useEffect(
    () => () => {
      if (waiting.current) github.loginCancel().catch(() => {});
    },
    [],
  );

  const copy = (code: string) =>
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => {},
    );

  const start = async () => {
    setStep({ kind: "starting" });
    setCopied(false);
    try {
      const code = await github.loginStart();
      setStep({ kind: "waiting", code });
      waiting.current = true;
      await copy(code.userCode);
      openUrl(code.verificationUri).catch(() => {});
      const account = await github.loginFinish(code);
      waiting.current = false;
      setAccount(account);
    } catch (e) {
      waiting.current = false;
      const message = String(e);
      // Annulée depuis FAST : retour au bouton, sans message d'erreur.
      setStep(message === CANCELLED ? { kind: "idle" } : { kind: "error", message });
    }
  };

  const cancel = () => {
    github.loginCancel().catch(() => {});
    waiting.current = false;
    setStep({ kind: "idle" });
  };

  if (step.kind === "waiting") {
    const { code } = step;
    return (
      <div className={wide ? "github-signin wide" : "github-signin"}>
        <div className="setting-description">Enter this code on GitHub to connect FAST:</div>
        <div className="github-code">{code.userCode}</div>
        <div className="github-signin-actions">
          <button className="thin-button" onClick={() => copy(code.userCode)}>
            <UiIcon name={copied ? "lucide:check" : "lucide:copy"} className="thin-button-icon" />
            {copied ? "Copied" : "Copy code"}
          </button>
          <button className="thin-button" onClick={() => openUrl(code.verificationUri).catch(() => {})}>
            <UiIcon name="lucide:external-link" className="thin-button-icon" />
            Open GitHub
          </button>
        </div>
        <div className="github-waiting">
          <UiIcon name="lucide:loader-circle" className="spin github-waiting-icon" />
          Waiting for approval on GitHub…
          <button className="link-button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={wide ? "github-signin wide" : "github-signin"}>
      {description && <div className="setting-description">{description}</div>}
      <button className={wide ? "thin-button" : "primary-button"} disabled={step.kind === "starting"} onClick={start}>
        <UiIcon name="lucide:github" className={wide ? "thin-button-icon" : "primary-button-icon"} />
        {step.kind === "starting" ? "Connecting…" : "Sign in with GitHub"}
      </button>
      {step.kind === "error" && <div className="form-error">{step.message}</div>}
    </div>
  );
}
