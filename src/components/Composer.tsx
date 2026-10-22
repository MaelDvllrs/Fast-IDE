import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { COMMANDS, parseCommand } from "../agents/commands";
import type { AgentModel, Attachment } from "../agents/providers";
import { basename } from "../hooks/useOpenFiles";
import { openUrl, speech, workspace } from "../lib/ipc";
import { FileIcon, UiIcon } from "./fileIcons";

interface Props {
  models: AgentModel[];
  model: string | null;
  /** Nom lisible du modèle réellement utilisé, s'il est connu (affiché avec « Default »). */
  resolvedModel: string | null;
  onModelChange: (model: string | null) => void;
  /** Niveaux d'effort proposés (réflexion avant de répondre) et niveau choisi. */
  efforts?: { id: string | null; label: string; description?: string }[];
  effort?: string | null;
  onEffortChange?: (effort: string | null) => void;
  /** Ultracode (orchestration multi-agents) ajouté à chaque message. */
  ultracode?: boolean;
  onUltracodeChange?: (on: boolean) => void;
  /** Dossier du projet : point de départ du sélecteur de fichiers. */
  root: string;
  /** Fichier ouvert dans l'éditeur, proposé dans le menu « + ». */
  activeFile: string | null;
  disabled: boolean;
  /** L'agent répond : le bouton d'envoi devient un bouton Stop. */
  busy?: boolean;
  onStop?: () => void;
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
  efforts,
  effort = null,
  onEffortChange,
  ultracode = false,
  onUltracodeChange,
  root,
  activeFile,
  disabled,
  busy = false,
  onStop,
  placeholder,
  onSubmit,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const voice = useVoiceInput(text, setText);
  // Menu des commandes « / » : ouvert tant qu'on tape le nom de la commande.
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsClosed, setCommandsClosed] = useState(false);
  const typingCommand = /^\/\w*$/.test(text);
  const commands = typingCommand ? COMMANDS.filter((c) => c.name.startsWith(text.slice(1).toLowerCase())) : [];
  const showCommands = commands.length > 0 && !commandsClosed;
  const active = parseCommand(text)?.command ?? null;
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setCommandIndex(0);
    input.current?.focus();
  };

  // Une ligne au départ, puis le champ grandit avec le texte (plafonné en CSS par
  // max-height). Fait en JS : `field-sizing: content` n'existe pas dans WebKit (macOS).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Coller des fichiers ou une image (capture d'écran) : enregistrés dans le projet,
  // puis joints comme avec « Add files… ». Du texte seul reste un collage normal.
  const pasteFiles = async (files: File[]) => {
    const added: Attachment[] = [];
    for (const [i, file] of files.entries()) {
      const isImage = file.type.startsWith("image/");
      const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
      const name = file.name && file.name !== "image.png" ? file.name : `pasted-${isImage ? "image" : "file"}-${i + 1}.${extension}`;
      try {
        const path = await workspace.saveAttachment(root, name, await toBase64(file));
        added.push({ path, name, preview: isImage ? URL.createObjectURL(file) : undefined });
      } catch {
        // Fichier illisible : ignoré, les autres sont joints.
      }
    }
    setAttachments((prev) => [...prev, ...added]);
  };

  const attach = (paths: string[]) =>
    setAttachments((prev) => [
      ...prev,
      ...paths.filter((p) => !prev.some((a) => a.path === p)).map((path) => ({ path, name: basename(path) })),
    ]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    voice.stop();
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
            <span key={a.path} className={a.preview ? "attachment with-preview" : "attachment"} title={a.path}>
              {a.preview ? <img className="attachment-preview" src={a.preview} alt="" /> : <FileIcon name={a.name} fallback />}
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

      {voice.error && (
        <div className="composer-voice-error">
          {voice.error}
          {voice.settingsPage && (
            <button className="link-button" onClick={() => openUrl(voice.settingsPage!).catch(() => {})}>
              Open settings
            </button>
          )}
        </div>
      )}

      {showCommands && (
        <div className="command-menu" role="listbox" aria-label="Commands">
          {commands.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === commandIndex}
              className={i === commandIndex ? "command-item active" : "command-item"}
              onMouseEnter={() => setCommandIndex(i)}
              onMouseDown={(e) => {
                // Avant que le champ ne perde le focus.
                e.preventDefault();
                pickCommand(c.name);
              }}
            >
              <span className="command-name">/{c.name}</span>
              <span className="command-description">{c.description}</span>
              {c.readOnly && <span className="command-badge">read-only</span>}
            </button>
          ))}
        </div>
      )}

      {/* Commande reconnue : rappel de ce qu'on peut écrire après */}
      {active && !showCommands && (
        <div className="command-active">
          <span className="command-name">/{active.name}</span>
          {active.description}
          {text.trim() === `/${active.name}` && <span className="command-hint">· add {active.hint} (optional)</span>}
        </div>
      )}

      <textarea
        ref={input}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length === 0) return;
          e.preventDefault();
          pasteFiles(files);
        }}
        onChange={(e) => {
          setText(e.target.value);
          voice.typed(e.target.value);
          setCommandsClosed(false);
          setCommandIndex(0);
        }}
        onKeyDown={(e) => {
          // Navigation dans le menu des commandes : ↑ ↓, Entrée / Tab pour choisir, Échap pour fermer.
          if (showCommands) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setCommandIndex((i) => (i + step + commands.length) % commands.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pickCommand(commands[Math.min(commandIndex, commands.length - 1)].name);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setCommandsClosed(true);
              return;
            }
          }
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

        {efforts && onEffortChange && (
          <Popover
            label="Effort"
            align="end"
            trigger={
              <>
                <UiIcon name="lucide:zap" className={ultracode ? "composer-effort-icon ultra" : "composer-effort-icon"} />
                {/* Ultracode activé : le niveau d'effort change de couleur */}
                <span className={ultracode ? "composer-effort-label ultra" : "composer-effort-label"}>
                  {(efforts.find((e) => e.id === effort) ?? efforts[0]).label}
                </span>
                {ultracode && <span className="composer-ultra">Ultracode</span>}
                <UiIcon name="lucide:chevron-down" className="composer-chevron" />
              </>
            }
            triggerClassName="composer-model"
          >
            {(close) => (
              <>
                {efforts.map((e) => (
                  <button
                    key={e.id ?? "default"}
                    className="popover-item"
                    onClick={() => {
                      close();
                      onEffortChange(e.id);
                    }}
                  >
                    <span className="popover-check">
                      {e.id === effort && <UiIcon name="lucide:check" className="popover-icon" />}
                    </span>
                    <span className="popover-text">
                      {e.label}
                      {e.description && <span className="popover-description">{e.description}</span>}
                    </span>
                  </button>
                ))}
                {onUltracodeChange && (
                  <>
                    <div className="popover-separator" />
                    {/* Case à cocher : le menu reste ouvert, l'état se voit tout de suite */}
                    <button
                      className="popover-item"
                      role="menuitemcheckbox"
                      aria-checked={ultracode}
                      onClick={() => onUltracodeChange(!ultracode)}
                    >
                      <span className={ultracode ? "popover-checkbox checked" : "popover-checkbox"}>
                        {ultracode && <UiIcon name="lucide:check" className="popover-checkbox-icon" />}
                      </span>
                      <span className="popover-text">
                        Ultracode
                        <span className="popover-description">Multi-agent orchestration on every message · many more tokens</span>
                      </span>
                    </button>
                  </>
                )}
              </>
            )}
          </Popover>
        )}

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

        <button
          className={voice.listening ? "composer-button composer-mic listening" : "composer-button composer-mic"}
          title={voice.listening ? "Stop dictation" : "Dictate"}
          aria-label={voice.listening ? "Stop dictation" : "Dictate"}
          aria-pressed={voice.listening}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            voice.toggle();
          }}
        >
          <UiIcon name="lucide:mic" className="composer-icon" />
        </button>

        {busy && onStop ? (
          <button
            className="composer-send stop"
            title="Stop"
            aria-label="Stop"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            <UiIcon name="lucide:square" className="composer-icon" />
          </button>
        ) : (
          <button className="composer-send" aria-label="Send" disabled={disabled || !text.trim()} onClick={submit}>
            <UiIcon name="lucide:arrow-up" className="composer-icon" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Réglages de Windows à ouvrir selon l'erreur de dictée (confidentialité). */
const SETTINGS_FOR_ERROR: [string, string][] = [
  ["Online speech recognition", "ms-settings:privacy-speech"],
  ["microphone access", "ms-settings:privacy-microphone"],
];

/**
 * Dictée dans le champ de saisie : le texte dit s'ajoute à ce qui est déjà
 * écrit. La phrase en cours s'affiche en direct (hypothèse), puis est remplacée
 * par sa version définitive. Une seule dictée à la fois dans toute l'app.
 */
function useVoiceInput(text: string, setText: (value: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Texte acquis (écrit ou dicté) et phrase en cours de reconnaissance.
  const base = useRef("");
  const partial = useRef("");
  const active = useRef(false);

  const join = (a: string, b: string) => (!a || !b ? a + b : /\s$/.test(a) ? a + b : `${a} ${b}`);
  const show = () => setText(join(base.current, partial.current));

  useEffect(() => {
    const unlisten = speech.onEvent((event) => {
      if (!active.current) return;
      if (event.type === "partial") {
        partial.current = event.data;
        show();
      } else if (event.type === "final") {
        base.current = join(base.current, event.data);
        partial.current = "";
        show();
      } else {
        active.current = false;
        partial.current = "";
        setListening(false);
        if (event.data) setError(event.data);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (active.current) speech.stop().catch(() => {});
    };
  }, []);

  const stop = () => {
    if (!active.current) return;
    active.current = false;
    // Garde la phrase en cours telle qu'affichée.
    base.current = join(base.current, partial.current);
    partial.current = "";
    setListening(false);
    speech.stop().catch(() => {});
  };

  const start = () => {
    setError(null);
    base.current = text;
    partial.current = "";
    active.current = true;
    setListening(true);
    speech.start().catch((e) => {
      active.current = false;
      setListening(false);
      setError(String(e));
    });
  };

  const settingsPage = error ? (SETTINGS_FOR_ERROR.find(([hint]) => error.includes(hint))?.[1] ?? null) : null;

  return {
    listening,
    error,
    settingsPage,
    toggle: () => (active.current ? stop() : start()),
    stop,
    /** Saisie au clavier pendant la dictée : elle devient le texte acquis. */
    typed: (value: string) => {
      base.current = value;
      partial.current = "";
    },
  };
}

/** Contenu d'un fichier en base64 (sans l'en-tête « data: »), pour l'envoyer au cœur Rust. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
/** Menu déroulant ancré à son bouton (au-dessus par défaut). */
export function Popover({ label, trigger, triggerClassName, align = "start", children }: PopoverProps) {
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
