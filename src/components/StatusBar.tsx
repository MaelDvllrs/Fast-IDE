import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { basename, type OpenFile } from "../hooks/useOpenFiles";

/** Nom complet du langage par extension, quand celui de CodeMirror est une abréviation. */
const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript React",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript React",
  json: "JSON",
  md: "Markdown",
  rs: "Rust",
  py: "Python",
  css: "CSS",
  scss: "Sass",
  html: "HTML",
  toml: "TOML",
  yml: "YAML",
  yaml: "YAML",
  sh: "Shell",
  cs: "C#",
  cpp: "C++",
  h: "C",
};

function languageName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return LANGUAGE_NAMES[ext] ?? LanguageDescription.matchFilename(languages, fileName)?.name ?? "Plain Text";
}

/** Bas de la fenêtre code : langage, nombre de lignes, encodage du fichier actif. */
export function StatusBar({ file }: { file: OpenFile }) {
  const lines = file.content.split("\n").length;
  return (
    <footer className="status-bar">
      <span>{languageName(basename(file.path))}</span>
      <span>
        {lines} {lines > 1 ? "lines" : "line"}
      </span>
      <span>UTF-8</span>
    </footer>
  );
}
