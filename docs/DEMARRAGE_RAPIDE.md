# Démarrage rapide — lancer le bot

Tutoriel le plus court possible. 4 étapes, environ 10 minutes.

Si quelque chose ne marche pas, sautez directement à la section **« Ça ne
démarre pas »** en bas : une commande vous dira exactement quoi corriger.

---

## Étape 1 — Installer Python

Il faut **Python 3.11 ou plus récent** (3.12 recommandé).

Vérifiez ce que vous avez :

```bash
python3 --version
```

Si la commande échoue ou affiche moins que 3.11, installez-le depuis
<https://www.python.org/downloads/>.

> **Windows** : pendant l'installation, cochez la case
> **« Add python.exe to PATH »**. C'est l'oubli le plus fréquent, et sans elle
> rien ne fonctionnera ensuite.

---

## Étape 2 — Obtenir une URL RPC Solana

C'est **la seule chose réellement indispensable**. Le bot lit la blockchain
Solana à travers un « endpoint RPC ».

Le plus simple : créez un compte gratuit sur <https://helius.dev>, puis
copiez votre clé API. Vous obtiendrez une clé qui ressemble à
`a1b2c3d4-e5f6-...`.

> Vous pouvez démarrer sans, avec l'endpoint public gratuit de Solana. Mais il
> est très limité : les scans seront lents et incomplets. C'est bon pour un
> premier essai, pas pour un usage réel.

---

## Étape 3 — Créer le bot Discord

1. Allez sur <https://discord.com/developers/applications>
2. Cliquez **New Application**, donnez-lui un nom, validez
3. Dans le menu de gauche, cliquez sur **Bot**
4. Cliquez **Reset Token**, puis **Copy**
   → c'est votre `DISCORD_TOKEN`, gardez-le de côté

   ⚠️ **Attention, c'est l'erreur numéro un.** Le token du bot n'est **pas**
   l'*Application ID*, ni le *Public Key*, ni le *Client Secret*. C'est une
   longue chaîne avec **deux points** dedans, du genre
   `MTIzNDU2Nzg5.GaBcDe.fGhIjKlMnOpQrStUvWxYz...`

5. Toujours dans l'onglet **Bot**, descendez jusqu'à
   **Privileged Gateway Intents** et activez **MESSAGE CONTENT INTENT**,
   puis **Save Changes**
6. Menu de gauche → **OAuth2** → **URL Generator** :
   - **Scopes** : cochez `bot` et `applications.commands`
   - **Bot permissions** : cochez `Send Messages`, `Embed Links`,
     `Attach Files`, `Read Message History`
7. Copiez l'URL générée en bas de page, ouvrez-la dans votre navigateur, et
   invitez le bot sur votre serveur

**Bonus utile** : dans Discord, allez dans Paramètres → Avancés → activez
**Mode développeur**. Puis clic droit sur votre serveur → **Copier
l'identifiant du serveur**. Gardez ce nombre : il rend les commandes slash
disponibles instantanément au lieu d'attendre une heure.

---

## Étape 4 — Lancer

### Linux / macOS

```bash
cd Bundle-Detector
./start.sh
```

### Windows

Ouvrez le dossier `Bundle-Detector` dans l'explorateur, puis double-cliquez sur
**`start.bat`**.

---

**Au premier lancement**, le script installe tout et s'arrête en vous disant de
remplir le fichier `.env`. C'est normal.

Ouvrez le fichier `.env` (Bloc-notes, TextEdit, `nano .env`…) et renseignez
trois lignes :

```env
DISCORD_TOKEN=collez_ici_le_token_de_l_etape_3
RPC_URL=https://mainnet.helius-rpc.com/?api-key=votre_cle_de_l_etape_2
DISCORD_GUILD_IDS=collez_ici_l_identifiant_de_votre_serveur
```

Enregistrez, puis relancez :

```bash
./start.sh
```

Vous devriez voir :

```
✅ Python              Python 3.12.3
✅ Dépendances         toutes les bibliothèques sont installées
✅ Fichier .env        /chemin/vers/.env
✅ URL RPC             https://mainnet.helius-rpc.com/
✅ Connexion RPC       répond en 84 ms
✅ Token Discord       format valide (72 caractères)
✅ Connexion Discord   connecté en tant que « MonBot »
✅ DISCORD_GUILD_IDS   1 serveur(s) — sync immédiate
────────────────────────────────────────────────────────────────────

✅ Tout est prêt. Lancez le bot :

      python -m app.main bot

→ Démarrage du bot… (Ctrl+C pour arrêter)
```

Dans Discord, tapez `/scan` suivi d'une adresse de token Pump.fun.

---

## Ça ne démarre pas

**Une seule commande vous dira pourquoi :**

```bash
./start.sh doctor          # Linux / macOS
start.bat doctor           # Windows
```

Elle vérifie tout — Python, dépendances, `.env`, format du token, connexion
réelle à Discord et au RPC, base de données, cache — et pour chaque problème,
affiche l'action exacte à faire.

### « No module named pip » / « L'installation des dépendances a échoué »

L'environnement virtuel a été créé **sans pip**. Cela arrive quand une première
tentative a été interrompue, ou avec certaines installations de Python
(notamment celle du Microsoft Store).

Le lanceur détecte et répare ce cas tout seul : il teste pip, tente
`ensurepip`, et reconstruit l'environnement si nécessaire. Si le message
persiste :

```
start.bat reset       ou      ./start.sh reset
```

puis relancez. Cela supprime `.venv` et repart de zéro.

Si même après un `reset` pip reste introuvable, votre Python n'inclut pas
`ensurepip`. Désinstallez-le et réinstallez **Python 3.12 depuis
python.org** (pas la version du Microsoft Store), en cochant
« Add python.exe to PATH ».

> Ce message parlait à tort d'espace disque dans une version précédente. Il
> nomme désormais les vraies causes.

### « Le bot démarre puis se ferme »

Le diagnostic est vert, les commandes apparaissent dans Discord, mais le
programme s'arrête et Discord répond **« L'application ne répond pas »**.

Cela veut dire que le processus n'est plus là pour répondre. Pour voir
pourquoi :

```bash
# Linux / macOS
LOG_LEVEL=DEBUG ./start.sh

# Windows (PowerShell)
$env:LOG_LEVEL="DEBUG"; .\start.bat
```

Le bot affiche maintenant explicitement son état :

```
✅ Bot en ligne : Bundle Detector  (1 serveur(s))
   Tapez /scan dans Discord. Ctrl+C pour arrêter.
```

**Si vous ne voyez jamais cette ligne**, la connexion n'a pas abouti — le
message d'erreur juste au-dessus vous dira laquelle des trois causes
habituelles s'applique (token, intent, réseau).

**Si vous la voyez puis que le bot s'arrête**, un message explique la cause à
la fermeture (token réinitialisé pendant l'exécution, bot expulsé du serveur,
coupure réseau).

> **Windows** : lancez `start.bat` depuis une invite de commandes plutôt qu'en
> double-cliquant. En double-clic, la fenêtre se refermait avant que vous ne
> puissiez lire l'erreur — le script se met désormais en pause, mais une
> console ouverte reste plus confortable.

### « La commande met longtemps puis ne répond pas »

Un scan qui dépasse `SCAN_TIMEOUT_SECONDS` (180 s par défaut) s'arrête
maintenant avec un message clair au lieu de laisser Discord attendre.

C'est presque toujours le RPC public : il est rate-limité, donc chaque requête
est retentée plusieurs fois et un scan complet peut dépasser les trois minutes.
Deux solutions :

- utilisez `/quickscan` au lieu de `/scan` ;
- ou mettez un endpoint payant dans `RPC_URL` (c'est la vraie solution).

C'est exactement ce que signale l'avertissement `⚠️ URL RPC — RPC public` du
diagnostic.

### Les cas les plus fréquents

| Ce que vous voyez | Ce que ça veut dire | Quoi faire |
|---|---|---|
| `❌ Token Discord — format invalide` | Vous avez copié l'Application ID ou le Public Key | Developer Portal → onglet **Bot** → **Reset Token** |
| `❌ Connexion Discord — 401` | Token faux, expiré, ou réinitialisé depuis | Régénérez-le et recopiez-le dans `.env` |
| `❌ L'intent MESSAGE CONTENT n'est pas activé` | Étape 3.5 oubliée | Developer Portal → Bot → Privileged Gateway Intents |
| `❌ Connexion RPC — injoignable` | URL RPC fausse, ou réseau bloqué | Vérifiez `RPC_URL` ; testez sans VPN/pare-feu |
| `❌ Python — trop ancien` | Python < 3.11 | Installez Python 3.12 puis supprimez le dossier `.venv` |
| `python: command not found` (Windows) | « Add to PATH » non coché | Réinstallez Python en cochant la case |
| Les commandes `/scan` n'apparaissent pas | Sync globale en cours | Renseignez `DISCORD_GUILD_IDS` puis redémarrez |
| Le bot est en ligne mais ne répond pas | Permissions manquantes sur le salon | Vérifiez que le bot peut écrire et joindre des fichiers |

---

## Tester sans rien configurer

Pour voir à quoi ressemble un rapport **avant** de configurer quoi que ce soit
(aucune connexion internet requise) :

```bash
./start.sh demo            # Linux / macOS
start.bat demo             # Windows
```

Un rapport complet s'affiche, calculé par le vrai moteur sur des données de
test. C'est aussi un bon moyen de vérifier que l'installation Python est saine.

---

## Utiliser sans Discord

Le bot est optionnel. Tout fonctionne depuis le terminal, avec seulement
`RPC_URL` :

```bash
./start.sh scan VOTRE_ADRESSE_DE_TOKEN
./start.sh scan VOTRE_ADRESSE_DE_TOKEN --depth deep --export
```

Les exports (JSON, CSV, rapport HTML, bubble map PNG) atterrissent dans
`exports/`.

---

## Et ensuite

- `docs/GUIDE_FR.md` — guide complet : toutes les commandes, comment lire un
  rapport en détail, modes surveillance et découverte
- `docs/SCORING.md` — comment le moteur décide, et pourquoi il refuse de crier
  au bundle sur un seul signal
