import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface Props {
  /** "vertical" : poignée entre deux colonnes (largeur) ; "horizontal" : entre
   *  deux fenêtres empilées (hauteur). */
  orientation?: "vertical" | "horizontal";
  /** Taille actuelle de la fenêtre redimensionnée, en px. */
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Taille rétablie au double-clic. */
  defaultValue: number;
  /** 1 si la fenêtre est avant la poignée (gauche / haut), -1 si elle est après. */
  direction: 1 | -1;
  label: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Poignée posée dans l'espace entre deux fenêtres : glisser pour redimensionner. */
export function ResizeHandle({
  orientation = "vertical",
  value,
  onChange,
  min,
  max,
  defaultValue,
  direction,
  label,
}: Props) {
  const vertical = orientation === "vertical";
  const drag = useRef<{ start: number; startValue: number } | null>(null);
  const position = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: position(e), startValue: value };
    document.body.classList.add(vertical ? "resizing-col" : "resizing-row");
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = (position(e) - drag.current.start) * direction;
    onChange(clamp(drag.current.startValue + delta, min, max));
  };

  const endDrag = () => {
    drag.current = null;
    document.body.classList.remove("resizing-col", "resizing-row");
  };

  // Flèches pour redimensionner au clavier.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const [less, more] = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const step = e.key === less ? -16 : e.key === more ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    onChange(clamp(value + step * direction, min, max));
  };

  return (
    <div
      className={`resize-handle ${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
    />
  );
}
