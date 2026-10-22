# fast — Règles d'usage du logo (v2)

## 1. Le logo
- **Idée** : c'est la mascotte des agents. Ses yeux forment « // », comme un commentaire en code, et sont inclinés vers l'avant : l'agent regarde où il va. Le logo et le personnage ne font qu'un.
- **Versions** : horizontale (principale) · empilée · symbole seul · mot seul · icône d'app.
- **Règle d'or** : le lime est réservé aux **yeux**. Le cadre, l'écran et le mot restent dans les neutres.

| Fichier | Usage |
|---|---|
| `fast-horizontal-dark.svg` | Logo principal sur fond sombre : cadre clair, écran noir, yeux lime |
| `fast-horizontal-light.svg` | Sur fond clair : écran entièrement noir, yeux lime |
| `fast-stacked-*.svg` | Formats carrés ou verticaux (affiche, sticker, réseaux sociaux) |
| `fast-symbol-dark.svg` / `-light.svg` | Symbole seul, à partir de 48 px |
| `fast-symbol-small-*.svg` | Version simplifiée pour 16–40 px (cadre plus épais, yeux plus larges) |
| `fast-app-icon.svg` | Icône d'app : la mascotte en pleine tuile |
| `fast-wordmark-*.svg` | Mot seul, quand le symbole est déjà présent à proximité |
| `*-black.svg` / `*-white.svg` | Une couleur (cadre + yeux) : impression, gravure, documents en noir et blanc |
| `exports/symbol/` | `favicon.ico` / `.svg`, icônes PWA, `apple-touch-icon`, `site.webmanifest`, `head-snippet.html` |

## 2. Zone de protection
Laissez un espace libre d'**une épaisseur de cadre × 2** tout autour du logo, ce qui correspond à peu près à la largeur d'un œil. Cet espace grandit avec le logo.

## 3. Tailles minimales
| Version | Écran | Impression |
|---|---|---|
| Horizontale | 96 px de large | 25 mm |
| Empilée | 64 px de large | 18 mm |
| Symbole | 16 px (utiliser `fast-symbol-small-*`) | 6 mm |

## 4. Couleurs
| Nom | HEX | RGB | CMYK (approx.) | Rôle |
|---|---|---|---|---|
| Encre | `#0B0C10` | 11 12 16 | 60 40 40 100 (noir riche) | Écran de la mascotte, fonds sombres, mot sur fond clair |
| Cadre | `#E6E8EE` | 230 232 238 | 3 3 0 7 | Cadre de la mascotte sur fond sombre |
| Lime | `#C6FF3D` | 198 255 61 | 22 0 76 0 | Yeux, états « agent actif » dans l'interface |
| Lime profond | `#4D7A00` | 77 122 0 | 37 0 100 52 | Texte ou icônes lime sur fond clair (interface uniquement, pas dans le logo) |

Les valeurs CMYK sont approximatives : le lime est fluo et sort de la gamme CMYK standard. Faites une épreuve chez l'imprimeur, ou choisissez une encre spéciale (Pantone fluo). Aucune référence Pantone n'est encore définie.

**Contrastes (WCAG)** : lime sur encre 16,5:1 · cadre sur encre 16:1 · lime profond sur blanc 5,1:1. **Le lime sur fond blanc (1,2:1) est illisible** : n'utilisez jamais de lime directement sur un fond clair. Sur fond clair, le lime n'apparaît qu'à l'intérieur de l'écran noir.

**Associations autorisées** : version `dark` sur Encre ou sur tout fond sombre · version `light` sur blanc ou fond clair · `black` ou `white` en une couleur · symbole en lime une couleur (`mono-c6ff3d`) uniquement sur fond Encre.

## 5. Dans l'interface
- Les yeux de la mascotte servent d'indicateur d'état d'un agent : **lime** quand il est actif, **gris `#6B7080`** au repos, **rouge** en cas d'erreur. Les couleurs de repos et d'erreur sont à définir dans le design system.
- Le cadre et le mot ne changent jamais de couleur.

## 6. Typographie
- Le mot **fast** est dessiné sur mesure, sans police associée. Utilisez toujours les fichiers, ne le retapez jamais au clavier.
- Pour l'interface et la documentation, je recommande deux polices sous licence libre (OFL) : **Inter** pour les titres et le texte, **JetBrains Mono** pour le code et le terminal.

## 7. À ne pas faire
Ne pas redresser les yeux à la verticale (on retomberait sur le bouton pause) · ne pas mettre le cadre ou le mot en lime · ne pas poser de lime sur un fond clair · ne pas étirer, faire pivoter ni déformer le logo · ne pas ajouter d'ombre, de lueur, de dégradé ni de contour · ne pas modifier l'écart entre les yeux et le cadre · ne pas utiliser le symbole normal en dessous de 48 px (prendre la version `small`).

## 8. Notes de passation
- **Construction** (sur 256) : tuile de 176 px, rayon 48 ; cadre de 22 ; écran de 132 px, rayon 26 ; yeux en pilule de 56 × 22, inclinés à 15°, centrés en (112, 118) et (150, 118), légèrement au-dessus et à droite du centre pour que la mascotte « regarde devant ». La version small a un cadre de 28 et des yeux de 60 × 28.
- **Sources** : `fast_v2/build_final.py` régénère tous les fichiers maîtres ; le mot « fast » est défini dans `fast_v2/build.py`. Modifiez ces scripts plutôt que les SVG.
- **Tests effectués** : audit SVG 100/100 ; tests à 16, 32 et 96 px ; versions une couleur et inversée ; planche de maquettes (README, terminal, icône d'app, site, onglet, sticker).
- **Points ouverts** :
  - **Recherche de marque à faire.** « Fast » est un mot courant, et fast.com appartient à Netflix.
  - Pas encore d'export PDF ou EPS pour l'impression.
  - Les couleurs d'état de la mascotte (repos, erreur) restent à définir.
