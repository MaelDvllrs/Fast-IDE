import { useEffect, useId, useRef, useState } from "react";

interface Props {
  /** Couleur du contour : elle distingue les agents entre eux. */
  color: string;
  /** L'agent travaille : anneau de chargement à la place des yeux. */
  working: boolean;
  /** Taille affichée en px (le dessin est vectoriel). */
  size?: number;
}

/** Délai aléatoire entre deux clignements d'yeux (ms). */
const nextBlink = () => 2500 + Math.random() * 3500;

/**
 * Mascotte d'un agent IA (viewBox 396 × 396, d'après les icônes « normal » et
 * « loading »). Au repos elle cligne des yeux de temps en temps ; pendant le
 * travail un anneau tourne ; à la fin du travail elle fait un petit saut.
 */
export function AgentMascot({ color, working, size = 16 }: Props) {
  const [blinking, setBlinking] = useState(false);
  const [jumping, setJumping] = useState(false);
  const wasWorking = useRef(working);
  const gradient = useId();

  // Fin du travail (true -> false) : saut, puis retour au repos (onAnimationEnd).
  useEffect(() => {
    if (wasWorking.current && !working) setJumping(true);
    wasWorking.current = working;
  }, [working]);

  // Clignements à intervalles irréguliers, seulement quand les yeux sont visibles.
  useEffect(() => {
    if (working) return;
    let timer = setTimeout(function blink() {
      setBlinking(true);
      timer = setTimeout(() => {
        setBlinking(false);
        timer = setTimeout(blink, nextBlink());
      }, 140);
    }, nextBlink());
    return () => clearTimeout(timer);
  }, [working]);

  return (
    <svg
      className={jumping ? "mascot jumping" : "mascot"}
      viewBox="0 0 396 396"
      width={size}
      height={size}
      aria-hidden="true"
      onAnimationEnd={(e) => e.animationName === "mascot-jump" && setJumping(false)}
    >
      <rect width="396" height="396" rx="40" fill={color} />
      <rect x="29" y="29" width="338" height="338" rx="20" fill="#000" />

      {working ? (
        <g className="mascot-ring">
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Arc des trois quarts du cercle, qui s'estompe vers sa fin */}
          <circle
            cx="198"
            cy="198"
            r="75"
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth="22"
            strokeLinecap="round"
            strokeDasharray="330 471"
          />
        </g>
      ) : (
        <g className={blinking ? "mascot-eyes blinking" : "mascot-eyes"} fill="#fff">
          <rect x="123" y="125" width="39" height="145" rx="19.5" ry="17.5" />
          <rect x="233" y="125" width="39" height="145" rx="19.5" ry="17.5" />
        </g>
      )}
    </svg>
  );
}
