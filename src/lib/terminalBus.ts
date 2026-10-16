// Point de contact avec le terminal intégré : le terminal y déclare comment
// écrire dans son shell, les autres composants s'en servent pour lancer une
// commande visible par l'utilisateur (installation, connexion…).

type Writer = (data: string) => void;

let writer: Writer | null = null;

/** Appelé par le terminal quand son shell est prêt ; renvoie la fonction de désinscription. */
export function registerTerminal(write: Writer): () => void {
  writer = write;
  return () => {
    if (writer === write) writer = null;
  };
}

/** Lance une commande dans le terminal intégré. `false` si aucun terminal n'est prêt. */
export function runInTerminal(command: string): boolean {
  if (!writer) return false;
  writer(`${command}\r`);
  return true;
}
