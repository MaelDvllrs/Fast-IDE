# FAST

IDE minimaliste pour le vibe coding, avec le véritable agent **Claude Code** intégré.
Cibles : **Windows** et **macOS**.

| Couche | Techno | Rôle |
| --- | --- | --- |
| Cœur natif | Rust + Tauri 2 | Fichiers, processus, événements, fenêtre |
| Interface | React + TypeScript + Vite | Affichage uniquement, aucune logique système |
| Éditeur | CodeMirror 6 | Édition, coloration chargée à la demande |
| Agent | CLI `claude` (stream-json) | Lancé et piloté par Rust |

## Structure

```
.
├── index.html, vite.config.ts, tsconfig.json, package.json
├── src/                         # Interface React
│   ├── main.tsx, App.tsx, styles.css
│   ├── components/              # FileTree, Editor, ClaudePanel
│   ├── lib/ipc.ts               # Seul point d'appel vers Rust (invoke/listen typés)
│   └── platform/                # Différences d'UI par OS
│       ├── index.ts             #   API commune
│       ├── windows.ts
│       └── macos.ts
└── src-tauri/                   # Cœur Rust
    ├── tauri.conf.json          # Config commune
    ├── tauri.windows.conf.json  # Surcharges Windows (fusionnées automatiquement par Tauri)
    ├── tauri.macos.conf.json    # Surcharges macOS
    ├── capabilities/            # Permissions IPC
    ├── icons/
    └── src/
        ├── main.rs, lib.rs, error.rs
        ├── commands/            # Commandes Tauri (couche IPC fine)
        ├── fs/                  # Lecture / écriture des fichiers
        ├── claude/              # Sessions Claude Code (processus + événements)
        └── platform/            # Différences natives par OS
            ├── mod.rs           #   API commune
            ├── windows.rs
            └── macos.rs
```

### Règle : commun d'un côté, spécifique à l'OS dans `platform/`

- Le code **identique** sur les deux OS reste à sa place normale.
- Le code **différent** va dans `platform/` (`src/platform/` pour l'UI, `src-tauri/src/platform/` pour le natif).
- `platform/mod.rs` (ou `index.ts`) expose une API commune ; `windows.*` et `macos.*` fournissent
  la même liste de fonctions. Le reste du code n'importe **que** l'API commune, jamais `windows`/`macos` directement.
- Les dépendances Rust propres à un OS se déclarent dans `[target.'cfg(target_os = "...")'.dependencies]`.
- Seule exception : les fichiers `tauri.<os>.conf.json` doivent rester à côté de `tauri.conf.json`,
  car Tauri ne les détecte qu'à cet emplacement.

Différences déjà gérées :

| | Windows | macOS |
| --- | --- | --- |
| Processus enfants | `CREATE_NO_WINDOW` (pas de console qui s'ouvre) | — |
| PATH | hérité | récupéré depuis le shell de connexion (les apps lancées depuis le Finder ont un PATH minimal) |
| Emplacements de `claude` | `~\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd` | `~/.local/bin`, `~/.claude/local`, Homebrew |
| Fenêtre | sans décorations natives : barre de titre et boutons dessinés par l'app (`platform/windows.tsx`) | `titleBarStyle: Overlay`, boutons natifs conservés |
| Shell du terminal | `pwsh` s'il est installé, sinon `powershell.exe` | `$SHELL` en mode login (`-l`) |
| Processus enfants à la fermeture | Job Object « kill on close » : shells et Claude s'arrêtent même si l'app plante | arrêtés à la sortie normale de l'app |
| Raccourcis affichés | `Ctrl+S` | `⌘S` |
| Bundles | `nsis`, `msi` | `app`, `dmg` |

## Intégration Claude Code

Rust lance une session par workspace :

```
claude -p --input-format stream-json --output-format stream-json --verbose
```

- les messages de l'utilisateur sont écrits sur **stdin** (une ligne JSON par message) ;
- chaque ligne de **stdout** est relayée à React via l'événement `claude://event` ;
- fermer la session (ou changer de dossier) tue le processus (`kill_on_drop`).

## Prérequis

Communs :
- [Rust](https://rustup.rs) (stable)
- Node.js 20+
- [Claude Code](https://docs.claude.com/claude-code) installé et connecté (`claude` doit marcher dans un terminal)

Windows :
- Microsoft C++ Build Tools (« Développement Desktop en C++ »)
- WebView2 (déjà présent sur Windows 10/11 à jour)

macOS :
- Xcode Command Line Tools : `xcode-select --install`

## Commandes

```bash
npm install          # dépendances frontend
npm run tauri dev    # lance l'app en développement
npm run tauri build  # produit l'installeur de l'OS courant
npm run typecheck    # vérifie le TypeScript
```

## Images et icônes

- `src/assets/` : images de l'app, importées dans le code (`import logo from "./assets/logo.svg"`).
- `src/assets/app-icon.svg` (ou `.png`, carré 1024×1024) : source de l'icône de l'app.
  `npm run app-icon` régénère toutes les variantes dans `src-tauri/icons/` (`.ico`, `.icns`, PNG) —
  ne pas modifier ce dossier à la main.
- Icônes d'interface (fichiers, dossiers…) : générées depuis Iconify, voir `src/components/fileIcons/mapping.json`
  puis `npm run icons`.
