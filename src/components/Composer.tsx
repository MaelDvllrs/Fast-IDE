import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentModel, Attachment } from "../agents/providers";
import { basename } from "../hooks/useOpenFiles";
import { workspace } from "../lib/ipc";
import { FileIcon, UiIcon } from "./fileIcons";

interface Props {
  models: AgentModel[];
  model: string | null;
  /** Nom lisible du modèle réellement utilisé, s'il est connu (affiché avec « Default »). */
  resolvedModel: string | null;
  onModelChange: (model: string | null) => void;
  /** Dossier du projet : point de départ du sélecteur de fichiers. */
  root: string;
  /** Fichier ouvert dans l'éditeur, proposé dans le menu « + ». */
  activeFile: string | null;
  disabled: boolean;
  placeholder: string;
  onSubmit: (text: string, attachments: Attachment[]) => void;
}

/** Champ de saisie d'un agent, indépendant de l'IA : texte, contexte joint
 *  (menu « + »), choix du modèle et envoi. */
export function Composer({
  models,
  model,
  resolvedModel,
  onModelChange,
  root,
  activeFile,
  disabled,
  placeholder,
  onSubmit,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);

  // Une ligne au départ, puis le champ grandit avec le texte (plafonné en CSS par
  // max-height). Fait en JS : `field-sizing: content` n'existe pas dans WebKit (macOS).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const attach = (paths: string[]) =>
    setAttachments((prev) => [
      ...prev,
      ...paths.filter((p) => !prev.some((a) => a.path === p)).map((path) => ({ path, name: basename(path) })),
    ]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSubmit(value, attachments);
    setText("");
    setAttachments([]);
  };

  const current = models.find((m) => m.id === model) ?? models[0];
  // « Default » ne dit pas quel modèle tourne : on le précise dès qu'il est connu.
  const label = (m: AgentModel) => (m.id === null && resolvedModel ? `${m.label} · ${resolvedModel}` : m.label);

  return (
    <div className={disabled ? "composer disabled" : "composer"} onClick={() => input.current?.focus()}>
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <span key={a.path} className="attachment" title={a.path}>
              <FileIcon name={a.name} fallback />
              <span className="attachment-name">{a.name}</span>
              <button
                className="attachment-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
              >
                <UiIcon name="lucide:x" className="attachment-remove-icon" />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={input}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="composer-toolbar">
        <Popover
          label="Add context"
          trigger={<UiIcon name="lucide:plus" className="composer-icon" />}
          triggerClassName="composer-button"
        >
          {(close) => (
            <>
              <button
                className="popover-item"
                onClick={() => {
                  close();
                  workspace.pickFiles(root).then(attach, () => {});
                }}
              >
                <UiIcon name="lucide:file-plus" className="popover-icon" />
                Add files…
              </button>
              <button
                className="popover-item"
                disabled={!activeFile}
                onClick={() => {
                  close();
                  if (activeFile) attach([activeFile]);
                }}
              >
                <UiIcon name="lucide:file-text" className="popover-icon" />
                Add current file
                {activeFile && <span className="popover-hint">{basename(activeFile)}</span>}
              </button>
            </>
          )}
        </Popover>

        <span className="composer-spacer" />

        <Popover
          label="Model"
          align="end"
          trigger={
            <>
              {label(current)}
              <UiIcon name="lucide:chevron-down" className="composer-chevron" />
            </>
          }
          triggerClassName="composer-model"
        >
          {(close) =>
            models.map((m) => (
              <button
                key={m.id ?? "default"}
                className="popover-item"
                onClick={() => {
                  close();
                  onModelChange(m.id);
                }}
              >
                <span className="popover-check">
                  {m.id === current.id && <UiIcon name="lucide:check" className="popover-icon" />}
                </span>
                <span className="popover-text">
                  {label(m)}
                  {m.description && <span className="popover-description">{m.description}</span>}
                </span>
              </button>
            ))
          }
        </Popover>

        <button className="composer-send" aria-label="Send" disabled={disabled || !text.trim()} onClick={submit}>
          <UiIcon name="lucide:arrow-up" className="composer-icon" />
        </button>
      </div>
    </div>
  );
}

interface PopoverProps {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  /** Côté d'alignement du menu par rapport au bouton. */
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
}

/** Bouton qui ouvre un petit menu au-dessus de lui ; se ferme au clic extérieur ou avec Échap. */
function Popover({ label, trigger, triggerClassName, align = "start", children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        className={triggerClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className={`popover ${align}`} role="menu" onClick={(e) => e.stopPropagation()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
