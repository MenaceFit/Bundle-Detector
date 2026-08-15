# Text3D Studio

Éditeur local de texte 3D et de typographie animée. Application desktop
(Electron + React + TypeScript + Vite) qui génère des textes graphiques
stylisés — style « 3D cartoon » massif, extrudé, avec contour, ombre et glow —
et les exporte en **PNG transparent**, WebP, WebM, GIF ou séquence PNG.

Tout fonctionne **100 % en local** : aucun serveur, aucune API externe, aucun
compte, aucune base distante. Les fichiers générés restent sur la machine.

---

## Installation

```bash
cd text3d-studio
npm install
```

Aucune police n'est embarquée : l'application utilise les polices déjà
installées sur le système, plus celles que vous importez vous-même.

## Lancement en développement

```bash
npm run dev
```

Démarre Vite, compile les entrées Electron et ouvre la fenêtre native.
Sur une machine sans affichage graphique (conteneur, SSH sans X), le script le
détecte et se contente de servir l'application dans le navigateur en affichant
l'URL.

```bash
npm run dev:web     # force le mode navigateur (Chrome / Edge recommandés)
```

Node 20 ou plus récent est requis.

### Si la fenêtre native ne s'ouvre pas

Le serveur de développement n'est jamais coupé par un échec côté bureau : si
Electron ne démarre pas (installation incomplète, pilote graphique, machine
sans affichage), le script affiche la raison et l'application reste accessible
à l'URL indiquée dans le terminal. Vous pouvez continuer à travailler dans
Chrome ou Edge — seuls les dialogues de fichiers natifs changent (le navigateur
utilise téléchargements et sélecteur de fichiers à la place).

## Build production

```bash
npm run build         # typecheck + bundle web + compilation Electron
npm run build:desktop # + packaging natif via electron-builder (release/)
```

`build:desktop` produit un AppImage sous Linux, un `.dmg` sous macOS et un
installeur NSIS sous Windows.

## Tests

```bash
npm test          # suite unitaire (vitest)
npm run typecheck # TypeScript strict, sans émission
```

---

## Structure du projet

```text
electron/          Process principal + preload (contextBridge, IPC whitelisté)
scripts/           Script de dev (Vite + Electron) et finalisation du build
src/
├── components/    Interface React
│   ├── Canvas/        Aperçu temps réel, zoom, pan, damier, grille, guides
│   ├── Toolbar/       Barre supérieure (fichier, undo/redo, export)
│   ├── Sidebar/       Navigation entre les panneaux d'outils
│   ├── Properties/    Panneaux Texte, Style, 3D, Ombre, Animation, Effets
│   ├── Timeline/      Règle temporelle, pistes, keyframes déplaçables
│   ├── Presets/       Bibliothèque de styles + vignettes rendues par le moteur
│   ├── Export/        Fenêtre d'export
│   ├── ColorPicker/   Sélecteur HEX / RGB / HSL / alpha, pipette, favoris
│   └── ui/            Contrôles génériques (slider, toggle, section, champ…)
│
├── engine/        Moteur de rendu (aucune dépendance à React)
│   ├── text/          Layout paramétrique glyphe par glyphe
│   └── renderer/      Extrusion, remplissages, contour, gloss, ombre, glow,
│                      warp de perspective, pool de canvas
│
├── animation/     Easing, interpolation, keyframes, évaluation, presets,
│                  animation par lettre (stagger)
│
├── export/        PNG / WebP / WebM / GIF / séquence PNG
│   ├── gif/           Quantification median-cut + encodeur LZW GIF89a maison
│   └── zip.ts         Écriture ZIP « stored » pour la séquence en navigateur
│
├── state/         Store Zustand : document unique + historique undo/redo
├── project/       Schéma, defaults, sérialisation, presets, randomize
├── fonts/         Polices système + import local persistant (IndexedDB)
├── types/         Modèle de données
└── utils/         Couleur, maths, chemins de propriétés, logs, formatage
```

### Principes d'architecture

- **Un seul document, entièrement paramétrique.** Le texte n'est jamais stocké
  comme bitmap : `Project` contient le texte, la typographie, le style,
  les transformations et les keyframes. Sauvegarder = `JSON.stringify`.
  Rouvrir reproduit le rendu à l'identique.
- **UI, moteur de rendu, moteur d'animation, export et gestion de projet sont
  séparés.** `engine/` et `animation/` n'importent rien de React ; les tests
  unitaires tournent sous Node sans DOM.
- **Le rendu ne connaît pas l'aperçu.** `renderProject()` ne dessine que le
  contenu des calques. Le damier, la grille et les guides sont dessinés par le
  composant Canvas *autour* de cet appel — c'est la garantie qu'ils ne peuvent
  jamais se retrouver dans un export.
- **Multi-calques prêt.** Le modèle, le renderer et les exporteurs itèrent déjà
  sur une liste de calques ; ajouter d'autres types de calques ne demande pas
  de refonte.
- **Performance.** Aucun re-render React pendant la lecture : le canvas lit le
  store directement dans sa boucle `requestAnimationFrame`. Les canvas
  intermédiaires sont recyclés dans un pool, et l'aperçu limite
  automatiquement sa résolution interne au-delà d'un budget de pixels.

---

## Utilisation

### Créer un texte 3D

1. Panneau **Texte** → saisir le contenu (Entrée pour une nouvelle ligne).
2. Panneau **Presets** → cliquer sur *3D Yellow* (le style de référence).
3. Panneau **3D** → ajuster profondeur, direction et nombre de couches.
4. Panneau **Ombre** → ombre portée et glow.

Changer le texte ne touche jamais au style : `TEXTE` → `VINTED` → `LUXE`
conserve exactement le même rendu.

### Créer un preset

1. Régler le style voulu (remplissage, contour, extrusion, gloss, ombre, glow).
2. Panneau **Presets** → *Enregistrer le style* → donner un nom.

Le preset est stocké localement (`localStorage`) et apparaît dans la grille avec
une vignette rendue par le moteur lui-même. Chaque preset peut être renommé,
dupliqué, mis en favori, exporté en `.preset.json` et réimporté (bouton
*Importer* ou glisser-déposer du fichier sur la fenêtre).

### Animer

**Avec un preset d'animation** — panneau **Animation** → catégorie
*Entrées* / *Sorties* / *Boucles* / *3D* → cliquer sur une animation.

**À la main** :

1. Placer la tête de lecture sur la timeline.
2. Modifier une propriété.
3. Cliquer sur le bouton keyframe ◆ à gauche de cette propriété.
4. Déplacer la tête de lecture, modifier à nouveau — un keyframe est créé
   automatiquement sur une propriété déjà animée.

Dans la timeline, les keyframes se déplacent à la souris ; le keyframe
sélectionné peut changer d'interpolation (Linear, Ease In/Out, Cubic, Back,
Elastic, Bounce, Hold, Bézier), être dupliqué ou supprimé.

**Animation par lettre** — panneau **Animation** → *Animation par lettre* :
choisir l'effet, l'ordre (normal, inversé, aléatoire, depuis le centre, depuis
les bords) et le décalage (stagger) entre deux caractères.

### Exporter

`Ctrl + E` ou le bouton **Exporter**.

| Format | Transparence | Notes |
| --- | --- | --- |
| PNG | oui | canal alpha complet, jusqu'à 8192 × 8192 |
| WebP | oui | qualité réglable |
| WebM | oui (VP9/VP8) | FPS, résolution et débit configurables |
| GIF | oui (1 index) | palette median-cut de 8 à 255 couleurs |
| Séquence PNG | oui | dossier sur desktop, ZIP dans le navigateur |

En mode transparent, l'export ne contient **que** le texte et ses effets :
pas de fond, pas de damier. Le damier de l'aperçu est purement visuel.

La composition est rendue à son propre rapport d'aspect puis centrée dans le
format de sortie : un projet 1200 × 800 exporté en 2048 × 2048 n'est pas
déformé.

### Projets

Format `.project.json` : texte, polices, styles, transformations, animations,
keyframes, résolution, FPS, durée et paramètres d'export. Les fichiers sont
lus de façon tolérante — un projet incomplet ou modifié à la main s'ouvre avec
les valeurs par défaut pour ce qui manque, au lieu d'échouer.

Une **sauvegarde automatique locale** conserve la session en cours ; elle est
proposée à la restauration au démarrage suivant si l'application s'est fermée
avec des modifications non enregistrées.

### Glisser-déposer

Déposez sur la fenêtre : un projet `.project.json`, un preset `.preset.json`,
une police `.ttf/.otf/.woff/.woff2`, ou une image (elle devient l'image de
référence, dont la palette dominante peut être extraite en un clic).

### Raccourcis clavier

| Raccourci | Action |
| --- | --- |
| `Ctrl + N` / `O` / `S` / `Maj + S` | Nouveau / Ouvrir / Sauvegarder / Sauvegarder sous |
| `Ctrl + Z` / `Ctrl + Y` | Annuler / Rétablir |
| `Ctrl + E` | Exporter |
| `Ctrl + D` | Dupliquer le calque |
| `Espace` | Lecture / Pause |
| `←` / `→` | Image précédente / suivante |
| `Début` / `Fin` | Début / fin de la timeline |
| `Suppr` | Supprimer le calque |
| `Ctrl + molette` | Zoom · `Maj + glisser` : déplacer le canvas · `0` : vue 100 % |

---

## Debug

Les logs restent hors de l'interface. Dans la console de développement
(`Ctrl + Maj + I` dans Electron) :

```js
__text3d.dump()      // tout le journal de la session, en texte
__text3d.entries()   // les entrées structurées
```

En développement, les logs sont aussi affichés dans la console au fil de l'eau.
Les erreurs de rendu d'un calque sont isolées : elles sont journalisées et le
reste de la composition continue de s'afficher.

## Sécurité

L'application est locale, mais le process de rendu est traité comme non fiable :

- `contextIsolation` activé, `nodeIntegration` désactivé ;
- aucun accès direct à Node depuis le renderer — uniquement les méthodes
  explicitement exposées par le preload via `contextBridge` ;
- IPC limité à une liste blanche de canaux ; les chemins d'écriture sont
  résolus et les noms de fichiers d'une séquence réduits à leur `basename` ;
- Content-Security-Policy restrictive, liens externes ouverts dans le
  navigateur système ;
- aucune requête réseau n'est nécessaire au fonctionnement.
