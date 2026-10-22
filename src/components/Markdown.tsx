import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "../lib/ipc";

// Liens : ouverts dans le navigateur (le webview de l'app ne doit pas naviguer).
// Le HTML brut éventuel des réponses n'est jamais interprété (comportement par défaut).
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  // Blocs de code : le langage annoncé (```ts) en en-tête discret.
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
  code: ({ className, children }) => {
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    return language ? (
      <code className={className} data-language={language}>
        {children}
      </code>
    ) : (
      <code className={className}>{children}</code>
    );
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/** Texte Markdown d'une réponse d'IA (titres, listes, code, tableaux, liens). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
