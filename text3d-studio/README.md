# Text3D Studio

Suite locale de création visuelle. Application desktop (Electron + React +
TypeScript + Vite) organisée en deux ateliers :

- **Text 3D** — typographie 3D animée, exportée en **PNG transparent**, WebP,
  WebM, GIF ou séquence PNG.
- **Video Captions** — importer un MP4, transcrire la parole en local, obtenir
  des **timestamps mot par mot**, générer des sous-titres dynamiques animés,
  puis exporter un MP4 avec les sous-titres incrustés et les fichiers SRT / VTT
  / ASS / JSON.

Les deux ateliers partagent le même moteur de rendu : un sous-titre est un
calque texte du moteur 3D, pas un second moteur graphique.

Tout fonctionne **100 % en local** : aucun serveur, aucune API externe, aucun
compte, aucune base distante. Les fichiers générés restent sur la machine, et
la vidéo source n'est jamais modifiée.

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

## Video Captions

### Ce qu'il faut installer

| Dépendance | Rôle | Installation |
| --- | --- | --- |
| **FFmpeg** | lire, décoder, recadrer et réencoder la vidéo | requis — voir ci-dessous |
| Modèle Whisper | transcription locale | téléchargé une fois au premier usage |

L'atelier détecte FFmpeg au démarrage : d'abord un binaire configuré, puis
`ffmpeg-static` s'il est installé, puis le `ffmpeg` du système. S'il reste
introuvable, le panneau affiche l'erreur et propose de désigner le binaire à la
main. Sous Linux : `apt install ffmpeg` ; sous macOS : `brew install ffmpeg` ;
sous Windows : [ffmpeg.org](https://ffmpeg.org/download.html), puis ajoutez-le
au PATH ou indiquez son chemin dans l'application.

Le modèle de transcription est téléchargé au premier lancement d'une analyse
(75 à 480 Mo selon le niveau choisi), puis mis en cache : les analyses
suivantes fonctionnent hors ligne. L'audio ne quitte jamais la machine.

**Cet atelier ne fonctionne que dans l'application de bureau** : piloter FFmpeg
et lire un fichier local depuis le disque est hors de portée d'un navigateur.

### Le déroulé

1. **Importer** un MP4/MOV/WebM/MKV (bouton ou glisser-déposer). L'application
   affiche résolution, durée, FPS, codecs, canaux audio et poids.
2. **Analyser** : l'audio est extrait en 16 kHz mono, puis transcrit localement.
   Trois niveaux — *Fast*, *Balanced*, *Accurate* — avec estimation du temps de
   traitement et annulation possible.
3. **Relire** : les mots de faible confiance sont listés en premier. Double-clic
   pour corriger un mot, réglage des timestamps au centième, découpe et fusion
   des sous-titres.
4. **Styler** : 13 presets, du classique au « viral ». Le mot prononcé peut
   changer de couleur, grossir, recevoir un fond arrondi ou un halo.
5. **Exporter** : MP4 avec sous-titres incrustés, et/ou SRT, VTT, ASS, JSON.

### Synchronisation

C'est le critère prioritaire du moteur, avant tout effet visuel :

- la transcription produit des timestamps **par mot**, pas par phrase ;
- les timings sont normalisés une seule fois — jamais d'inversion, jamais de
  chevauchement, un mot sans timestamp est interpolé plutôt que perdu, car le
  supprimer désynchroniserait tout ce qui suit ;
- l'aperçu prend son temps depuis l'élément vidéo lui-même, donc image, son et
  texte ne peuvent pas dériver ;
- l'entrée animée d'un mot est calée sur l'instant où il est prononcé :
  l'animation décore un timing, elle ne le déplace jamais.

### Découpage automatique

Le mode *Auto* déduit le nombre de mots par sous-titre du **débit de parole
réel**, pour viser une durée lisible : un rap rapide et un podcast lent
produisent des sous-titres de durée comparable. Les coupures suivent, par ordre
de priorité : un silence assez long pour être une vraie pause, la ponctuation de
fin de phrase, puis les budgets de durée, de caractères et de mots.

### Conversion verticale

Une vidéo horizontale peut être portée en 9:16 avec quatre cadrages : recadrer,
contenir, étirer, ou **fond flouté** (la source agrandie et floutée remplit le
cadre, la vidéo d'origine reste centrée et intacte).

### Formats de sortie

| Format | Contenu |
| --- | --- |
| MP4 | vidéo + sous-titres incrustés, **audio d'origine copié sans réencodage** |
| SRT | sous-titres standard |
| VTT | WebVTT |
| ASS | conserve police, taille, couleurs, contour, ombre et position |
| JSON | conserve les **timings mot par mot** |

Le projet se sauvegarde en `.video-project.json` : il ne contient que le chemin
de la vidéo, la transcription, les styles et les réglages — jamais la vidéo.

### Ce qui n'est pas encore fait

Conformément à la règle « aucun bouton fictif », les sections suivantes ne sont
pas présentes dans l'interface tant qu'elles ne font rien de réel : Audio
Enhancer, Video Enhancer, upscaling, export en lot, synchronisation au beat,
traduction et sous-titres bilingues.

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
├── ffmpeg/        Constructeurs de commandes et lecture ffprobe (purs, testés)
├── transcription/ Interface moteur, Whisper local, normalisation des timings
├── captions/      Modèle, segmentation, styles, presets, rendu, SRT/VTT/ASS/JSON
├── videoproject/  Store de l'atelier vidéo, pipeline d'export, format projet
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
  intermédiaires sont recyclés dans un pool indexé par dimensions exactes.
  Ombres et halos sont calculés en résolution réduite — flouter à 1/N puis
  agrandir donne le même résultat qu'un flou pleine résolution, pour un coût
  N² fois moindre, puisque le flou a déjà supprimé tout détail plus fin que son
  rayon.
- **Qualité de lecture adaptative.** Pendant la lecture, la boucle mesure la
  cadence réellement obtenue et ajuste la résolution interne de l'aperçu pour
  la tenir. La pleine résolution revient dès l'arrêt : une image fixe est
  toujours rendue au maximum, et l'export n'est jamais concerné.

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
