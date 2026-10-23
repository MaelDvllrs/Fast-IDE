// Compte GitHub connecté, partagé par toute l'interface (préférences, panneau
// Git, dialogues) : une connexion ou déconnexion se voit partout à la fois.
import { useEffect, useState } from "react";
import { github, patchSettings, settings, type GithubAccount } from "./ipc";

type AccountState = { loading: boolean; account: GithubAccount | null };

let state: AccountState = { loading: true, account: null };
let loaded = false;
const listeners = new Set<(s: AccountState) => void>();

function set(next: AccountState) {
  state = next;
  listeners.forEach((l) => l(state));
}

/** Garde le compte en cache (préférences) pour l'afficher dès le prochain lancement. */
const cache = (account: GithubAccount | null) => patchSettings({ githubAccount: account }).catch(() => {});

export async function refreshAccount() {
  loaded = true;
  // 1. Le compte du dernier lancement, affiché sans attendre le réseau.
  const cached = await settings.load().then((s) => s.githubAccount ?? null, () => null);
  if (cached && state.loading) set({ loading: false, account: cached });
  // 2. La réponse de GitHub : à jour, ou plus connecté (jeton révoqué, déconnexion).
  return github.account().then(
    (account) => {
      set({ loading: false, account });
      cache(account);
    },
    (err) => {
      // Jeton refusé par GitHub (session expirée, accès retiré) : FAST est déconnecté.
      if (String(err).includes("session expired")) {
        setAccount(null);
        return;
      }
      // Pas de réseau : le compte en cache reste affiché.
      set({ loading: false, account: cached });
    },
  );
}

export const setAccount = (account: GithubAccount | null) => {
  set({ loading: false, account });
  cache(account);
};

export async function signOut() {
  await github.signOut();
  setAccount(null);
}

export function useGithubAccount(): AccountState {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    if (!loaded) refreshAccount();
    else setValue(state);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
