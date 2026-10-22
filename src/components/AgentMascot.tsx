import { useEffect, useId, useRef, useState } from "react";

interface Props {
  /** Couleur du contour : elle distingue les agents entre eux. Une valeur CSS
   *  (ex. `var(--primary)`) est acceptée : elle suit alors le thème. */
  color: string;
  /** L'agent travaille : anneau de chargement à la place des yeux. */
  working: boolean;
  /** Taille affichée en px (le dessin est vectoriel). */
  size?: number;
}

/** Délai aléatoire entre deux clignements d'yeux (ms). */
const nextBlink = () => 2500 + Math.random() * 3500;

/** Délai aléatoire avant de regarder sur le côté (ms), et durée du regard. */
const nextLook = () => 3000 + Math.random() * 4000;
const LOOK_HOLD_MS = 1100;

/** Décalage du regard (unités du viewBox) : les yeux plus que le carré noir,
 *  ce qui donne l'impression que la tête tourne. Moins en vertical : les yeux
 *  sont hauts et doivent rester dans le carré. */
const EYES_SHIFT = { x: 34, y: 26 };
const FACE_SHIFT = { x: 12, y: 9 };

type Look = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
const FRONT: Look = { x: 0, y: 0 };

/** Les 8 directions autour du centre : côtés, haut, bas et diagonales. */
const DIRECTIONS: Look[] = [-1, 0, 1].flatMap((x) =>
  [-1, 0, 1].filter((y) => x !== 0 || y !== 0).map((y) => ({ x, y }) as Look),
);

/**
 * Mascotte d'un agent IA (viewBox 396 × 396, d'après les icônes « normal » et
 * « loading »). Au repos elle cligne des yeux de temps en temps ; pendant le
 * travail un anneau tourne ; à la fin du travail elle fait un petit saut.
 */
export function AgentMascot({ color, working, size = 16 }: Props) {
  const [blinking, setBlinking] = useState(false);
  // Direction du regard : x -1 gauche / 1 droite, y -1 haut / 1 bas, {0, 0} de face.
  const [look, setLook] = useState<Look>(FRONT);
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

  // De temps en temps, un coup d'œil dans une direction au hasard, puis retour de face.
  useEffect(() => {
    if (working) {
      setLook(FRONT);
      return;
    }
    let timer = setTimeout(function glance() {
      setLook(DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)]);
      timer = setTimeout(() => {
        setLook(FRONT);
        timer = setTimeout(glance, nextLook());
      }, LOOK_HOLD_MS);
    }, nextLook());
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
      {/* En style et non en attribut `fill` : un attribut n'accepte pas var(--…) */}
      <rect width="396" height="396" rx="40" style={{ fill: color }} />
      <rect
        className="mascot-face"
        x="29"
        y="29"
        width="338"
        height="338"
        rx="20"
        fill="#000"
        style={{ transform: `translate(${look.x * FACE_SHIFT.x}px, ${look.y * FACE_SHIFT.y}px)` }}
      />

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
        // Deux groupes : le regard déplace les yeux, le clignement les écrase.
        <g
          className="mascot-look"
          style={{ transform: `translate(${look.x * EYES_SHIFT.x}px, ${look.y * EYES_SHIFT.y}px)` }}
        >
          <g className={blinking ? "mascot-eyes blinking" : "mascot-eyes"} fill="#fff">
            <rect x="123" y="125" width="39" height="145" rx="19.5" ry="17.5" />
            <rect x="233" y="125" width="39" height="145" rx="19.5" ry="17.5" />
          </g>
        </g>
      )}
    </svg>
  );
}
