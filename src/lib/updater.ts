// Mises à jour de FAST : la dernière release est décrite par `latest.json` sur
// GitHub (voir plugins.updater dans tauri.conf.json). Le plugin vérifie la
// signature avant d'installer ; l'app redémarre ensuite sur la nouvelle version.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type { Update };

/** Au lancement : au-delà, on ouvre FAST sans attendre le réseau. */
export const STARTUP_TIMEOUT_MS = 5000;

export const currentVersion = () => getVersion();

/** Nouvelle version disponible, ou `null` (à jour, ou réponse trop lente au lancement). */
export async function findUpdate(timeoutMs?: number): Promise<Update | null> {
  const lookup = check(timeoutMs ? { timeout: timeoutMs } : undefined);
  if (!timeoutMs) return lookup;
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs + 500));
  return Promise.race([lookup, late]);
}

/** Télécharge, vérifie et installe la mise à jour, puis relance FAST. `onProgress` : 0-1, ou `null` si la taille est inconnue. */
export async function installUpdate(update: Update, onProgress: (ratio: number | null) => void) {
  let total = 0;
  let received = 0;
  await update.download((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(1, received / total) : null);
    } else {
      onProgress(1);
    }
  });
  // Agents, terminaux et serveurs arrêtés ; sous Windows, l'installeur pourra
  // survivre à la fermeture de FAST (sinon il serait arrêté avec elle).
  await invoke("prepare_update_install");
  // Windows : l'installeur remplace FAST puis la relance lui-même ; macOS : relance ici.
  await update.install();
  await relaunch();
}
