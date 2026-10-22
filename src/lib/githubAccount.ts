// Compte GitHub connecté, partagé par toute l'interface (préférences, panneau
// Git, dialogues) : une connexion ou déconnexion se voit partout à la fois.
import { useEffect, useState } from "react";
import { github, type GithubAccount } from "./ipc";

type AccountState = { loading: boolean; account: GithubAccount | null };

let state: AccountState = { loading: true, account: null };
let loaded = false;
const listeners = new Set<(s: AccountState) => void>();

function set(next: AccountState) {
  state = next;
  listeners.forEach((l) => l(state));
}

export function refreshAccount() {
  loaded = true;
  return github.account().then(
    (account) => set({ loading: false, account }),
    () => set({ loading: false, account: null }),
  );
}

export const setAccount = (account: GithubAccount | null) => set({ loading: false, account });

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
