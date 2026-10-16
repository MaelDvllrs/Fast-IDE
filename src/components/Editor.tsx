import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { editorTheme } from "../theme/editor";

interface Props {
  path: string;
  /** Onglet affiché. Les éditeurs inactifs restent montés (historique, curseur, défilement). */
  active: boolean;
  initialContent: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

/** Éditeur CodeMirror 6. Recréé à chaque changement de fichier. */
export function Editor({ path, active, initialContent, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  useEffect(() => {
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          basicSetup,
          editorTheme,
          language.of([]),
          Prec.high(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacks.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });

    viewRef.current = view;
    let disposed = false;
    LanguageDescription.matchFilename(languages, path)
      ?.load()
      .then((support) => {
        if (!disposed) view.dispatch({ effects: language.reconfigure(support) });
      });

    return () => {
      disposed = true;
      view.destroy();
    };
    // Le contenu initial n'est lu qu'à l'ouverture du fichier.
  }, [path]);

  useEffect(() => {
    if (active) viewRef.current?.focus();
  }, [active]);

  return <div className="editor" ref={host} hidden={!active} />;
}
