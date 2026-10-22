import { AgentMascot } from "./AgentMascot";
import { FastLogo } from "./FastLogo";

/** Écran d'accueil (aucun dossier ouvert) : grand logo FAST au centre, et la
 *  mascotte de FAST en bas à droite avec une bulle de bienvenue. */
export function WelcomeScreen({ onOpenFolder, onClone }: { onOpenFolder: () => void; onClone: () => void }) {
  return (
    <main className="window welcome-screen">
      <FastLogo />

      <div className="welcome-mascot">
        <div className="welcome-bubble" role="status">
          <strong>Welcome to FAST!</strong>
          <span>
            Open a folder to start coding with your agents.{" "}
            <button className="welcome-link" onClick={onOpenFolder}>
              Open Folder
            </button>{" "}
            or{" "}
            <button className="welcome-link" onClick={onClone}>
              clone a repository
            </button>
          </span>
        </div>
        <AgentMascot color="var(--primary)" working={false} size={44} />
      </div>
    </main>
  );
}
