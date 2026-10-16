import { useState } from "react";
import { fs } from "../lib/ipc";

export interface OpenFile {
  path: string;
  /** Contenu sur disque, pour savoir si l'onglet a des modifications non enregistrées. */
  savedContent: string;
  content: string;
}

export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export const isDirty = (file: OpenFile) => file.content !== file.savedContent;

/** Fichiers ouverts dans des onglets, et onglet actif. */
export function useOpenFiles() {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  /** Ouvre un fichier dans un nouvel onglet, ou active son onglet s'il est déjà ouvert. */
  const open = async (path: string) => {
    if (!files.some((f) => f.path === path)) {
      const content = await fs.readFile(path);
      setFiles((prev) =>
        prev.some((f) => f.path === path) ? prev : [...prev, { path, savedContent: content, content }],
      );
    }
    setActivePath(path);
  };

  const update = (path: string, content: string) =>
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));

  const save = async (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    await fs.writeFile(path, file.content);
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, savedContent: file.content } : f)));
  };

  /** Ferme un onglet ; demande confirmation s'il a des modifications non enregistrées. */
  const close = (path: string) => {
    const index = files.findIndex((f) => f.path === path);
    const file = files[index];
    if (!file) return;
    if (isDirty(file) && !window.confirm(`Close "${basename(path)}" without saving changes?`)) return;

    const remaining = files.filter((f) => f.path !== path);
    setFiles(remaining);
    // Comme dans la plupart des éditeurs : on active l'onglet voisin.
    if (activePath === path) setActivePath(remaining[Math.min(index, remaining.length - 1)]?.path ?? null);
  };

  const closeAll = () => {
    setFiles([]);
    setActivePath(null);
  };

  return { files, activePath, setActivePath, open, update, save, close, closeAll };
}
