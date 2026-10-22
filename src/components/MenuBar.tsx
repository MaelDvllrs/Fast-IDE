import { useEffect, useRef, useState } from "react";
import type { Menu } from "../lib/menu";

/** Menus déroulants (File, Settings…). Une fois un menu ouvert, survoler
 *  un autre libellé bascule dessus, comme dans les menus natifs. */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Fermeture au clic à l'extérieur ou avec Échap.
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menubar" ref={ref} role="menubar">
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu">
          <button
            className={open === i ? "menu-trigger open" : "menu-trigger"}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
          >
            {menu.label}
          </button>

          {open === i && (
            <div className="menu-dropdown" role="menu">
              {menu.items.map((item, j) =>
                item === "separator" ? (
                  <div key={j} className="menu-separator" role="separator" />
                ) : (
                  <button
                    key={j}
                    className="menu-item"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.onSelect();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
