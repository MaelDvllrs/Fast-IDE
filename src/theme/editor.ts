import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Habillage de CodeMirror branché sur les variables CSS du thème. */
const chrome = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--syntax-text)",
      backgroundColor: "var(--bg-editor)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-code)",
      fontSize: "13.5px",
      lineHeight: "1.75",
    },
    // Numéros de ligne plus petits ; largeur réservée pour 4 chiffres (ch = largeur
    // d'un chiffre à cette taille), pour que la marge ne bouge pas en dépassant 999 lignes.
    ".cm-lineNumbers": { fontSize: "11px", minWidth: "calc(4ch + 36px)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 16px 0 20px" },
    ".cm-content": { caretColor: "var(--primary)", padding: "12px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--selection)" },
    ".cm-gutters": {
      color: "var(--line-number)",
      backgroundColor: "var(--bg-editor)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { color: "var(--text)", backgroundColor: "transparent" },
    ".cm-selectionMatch": { backgroundColor: "var(--bg-active)" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--bg-active)", outline: "1px solid var(--border-strong)" },
    ".cm-foldPlaceholder": { color: "var(--text-dim)", backgroundColor: "var(--bg-elevated)", border: "none" },
    ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--border-strong)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--bg-active)", color: "var(--text-strong)" },
    ".cm-panels": { backgroundColor: "var(--bg-elevated)", color: "var(--text)" },
  },
  { dark: true },
);

/**
 * Couleurs du code : chaque type de jeton lit une variable `--syntax-*` du
 * thème (voir theme/themes/*.css). CodeMirror choisit la règle la plus précise,
 * par exemple `function(variableName)` avant `name`.
 */
const syntax = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syntax-keyword)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "var(--syntax-name)" },
  { tag: t.propertyName, color: "var(--syntax-property)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--syntax-function)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--syntax-constant)" },
  { tag: [t.definition(t.name), t.separator], color: "var(--syntax-definition)" },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--syntax-type)" },
  { tag: t.number, color: "var(--syntax-number)" },
  { tag: [t.operator, t.operatorKeyword], color: "var(--syntax-operator)" },
  { tag: [t.url, t.escape, t.regexp, t.special(t.string)], color: "var(--syntax-special)" },
  { tag: [t.meta, t.comment], color: "var(--syntax-comment)", fontStyle: "var(--syntax-comment-style)" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--syntax-comment)", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "var(--syntax-heading)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--syntax-constant)" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "var(--syntax-string)" },
  { tag: t.tagName, color: "var(--syntax-tag)" },
  { tag: t.attributeName, color: "var(--syntax-attribute)", fontStyle: "var(--syntax-attribute-style)" },
  { tag: t.invalid, color: "var(--syntax-invalid)" },
]);

export const editorTheme = [chrome, syntaxHighlighting(syntax)];
