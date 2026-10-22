import { AccountMenu } from "./AccountMenu";
import { UiIcon } from "./fileIcons";

export type SidebarView = "explorer" | "search" | "git" | "ai" | "agents";

// Icônes Lucide (trait de 1,6, voir mapping.json > strokeWidths).
const ITEMS: { view: SidebarView; label: string; icon: string }[] = [
  { view: "explorer", label: "Explorer", icon: "lucide:files" },
  { view: "search", label: "Search", icon: "lucide:search" },
  { view: "git", label: "Git", icon: "lucide:git-branch" },
  { view: "ai", label: "AI & Models", icon: "lucide:sparkles" },
  { view: "agents", label: "Agents", icon: "fast:mascot" },
];

interface Props {
  /** Vue affichée dans le panneau latéral, `null` si le panneau est replié. */
  active: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  /** Barre dépliée : icônes + libellés. Les fenêtres de droite se resserrent. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Ouvre les préférences sur la section Accounts. */
  onOpenAccounts: () => void;
}

/** Barre verticale d'icônes qui choisit le contenu du panneau latéral. */
export function ActivityBar({ active, onSelect, expanded, onToggleExpanded, onOpenAccounts }: Props) {
  const toggleLabel = expanded ? "Collapse sidebar" : "Expand sidebar";

  return (
    <nav className={expanded ? "activity-bar expanded" : "activity-bar"}>
      {ITEMS.map(({ view, label, icon }) => (
        <button
          key={view}
          className={view === active ? "activity-item active" : "activity-item"}
          // Le libellé est déjà visible quand la barre est dépliée.
          title={expanded ? undefined : label}
          aria-label={label}
          aria-pressed={view === active}
          onClick={() => onSelect(view)}
        >
          <UiIcon name={icon} className="activity-icon" />
          <span className="activity-label">{label}</span>
        </button>
      ))}

      <button
        className="activity-item activity-toggle"
        title={expanded ? undefined : toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <UiIcon
          name={expanded ? "lucide:arrow-left-from-line" : "lucide:arrow-right-from-line"}
          className="activity-icon"
        />
        <span className="activity-label">Collapse</span>
      </button>

      {/* Profil GitHub, tout en bas */}
      <AccountMenu expanded={expanded} onOpenAccounts={onOpenAccounts} />
    </nav>
  );
}
