# Guide d'installation et d'utilisation

Guide complet : installation, configuration, utilisation, et lecture des
rapports. Comptez 10 minutes pour un premier scan.

---

## 1. Ce dont vous avez besoin

| Élément | Obligatoire ? | Pourquoi |
|---|---|---|
| **Python 3.11+** (3.12 recommandé) | ✅ oui | Le moteur |
| **Une URL RPC Solana mainnet** | ✅ oui | **La seule source de données indispensable** |
| Un token de bot Discord | ⬜ non | Uniquement pour le bot ; le CLI fonctionne sans |
| Clé API Helius | ⬜ non | Liste complète des holders + métadonnées |
| Clé API Solscan Pro | ⬜ non | Holders et labels d'adresses (secours) |
| PostgreSQL | ⬜ non | SQLite par défaut ; Postgres pour la production |
| Redis | ⬜ non | Cache mémoire par défaut |
| Docker | ⬜ non | Alternative à l'installation manuelle |

### Le point important sur le RPC

Le RPC public `https://api.mainnet-beta.solana.com` **fonctionne mais est
inadapté** : rate limit très agressif et historique tronqué. Vos scans seront
lents et incomplets.

Prenez un endpoint payant (Helius, QuickNode, Triton, Alchemy…). C'est le seul
poste de dépense réellement nécessaire. Avec une clé Helius, définissez
`HELIUS_API_KEY` : elle sert alors **à la fois** de RPC prioritaire et de source
pour les holders et métadonnées.

---

## 2. Installation

### Option A — manuelle (recommandée pour développer)

```bash
# 1. Récupérer le projet
unzip pumpfun-bundle-detector.zip
cd Bundle-Detector

# 2. Environnement virtuel
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# 3. Configuration
cp .env.example .env
nano .env          # renseignez au minimum RPC_URL

# 4. Vérifier que tout fonctionne (aucun réseau requis)
.venv/bin/python -m pytest -q
# → 118 passed

# 5. Voir à quoi ressemble un rapport (données de test, hors ligne)
.venv/bin/python -m scripts.demo_report private_bundle
```

Sous Windows, remplacez `.venv/bin/` par `.venv\Scripts\`.

> **Plus simple encore** : `./start.sh` (Linux/macOS) ou `start.bat` (Windows)
> fait les étapes 2 à 5 tout seul. Voir `docs/DEMARRAGE_RAPIDE.md`.

### Option B — Docker

```bash
cd Bundle-Detector
cp .env.example .env
nano .env                      # RPC_URL + DISCORD_TOKEN

docker compose up -d           # bot + API + PostgreSQL + Redis
docker compose logs -f bot
```

Docker Compose démarre quatre services : le bot Discord, l'API HTTP (port 8000),
PostgreSQL et Redis. Les variables `DATABASE_URL` et `REDIS_URL` sont câblées
automatiquement — ne les renseignez pas dans `.env` si vous utilisez Docker.

---

## 3. Configuration du `.env`

Le minimum vital :

```env
RPC_URL=https://votre-endpoint-rpc-solana
```

Pour le bot Discord :

```env
DISCORD_TOKEN=votre_token_de_bot
DISCORD_GUILD_IDS=123456789012345678      # sync rapide des commandes
DISCORD_AUTOSCAN_CHANNEL_ID=              # coller un mint ici lance un scan
DISCORD_ALERT_CHANNEL_ID=                 # salon des alertes
```

Accélérateurs optionnels :

```env
HELIUS_API_KEY=
SOLSCAN_API_KEY=
```

Réglages du moteur (valeurs par défaut saines) :

```env
MAX_FUNDING_HOPS=3            # profondeur de traçage A → X → Y → B
FIRST_BUYERS_LIMIT=100        # nombre d'acheteurs analysés en deepscan
RPC_REQUESTS_PER_SECOND=25    # à baisser si votre endpoint rate-limite
MAX_CONCURRENT_RPC=16
```

Seuils d'alerte (0-100) :

```env
ALERT_LOW_MAX=24
ALERT_MEDIUM_MAX=49
ALERT_HIGH_MAX=74
```

Les **poids du score** ne sont pas dans le `.env` : ils vivent dans
`app/config.py` (classe `BundleWeights`), pour rester versionnés et
relisibles. Lisez `docs/SCORING.md` avant d'y toucher.

---

## 4. Créer le bot Discord

1. https://discord.com/developers/applications → **New Application**
2. Onglet **Bot** → **Add Bot** → copiez le token dans `DISCORD_TOKEN`
3. Onglet **Bot** → **Privileged Gateway Intents** → activez
   **MESSAGE CONTENT INTENT** (nécessaire pour la détection automatique d'un
   mint collé dans un salon)
4. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot`, `applications.commands`
   - Permissions : `Send Messages`, `Embed Links`, `Attach Files`,
     `Read Message History`
5. Ouvrez l'URL générée et invitez le bot sur votre serveur
6. Lancez le bot :

```bash
.venv/bin/python -m app.main bot
```

Les commandes slash apparaissent immédiatement si `DISCORD_GUILD_IDS` est
renseigné ; sinon la synchronisation globale prend jusqu'à une heure (limite
Discord).

---

## 5. Utilisation

### En ligne de commande (sans Discord)

```bash
# Scan complet
.venv/bin/python -m scripts.cli <MINT_PUMPFUN>

# Rapide / complet / approfondi
.venv/bin/python -m scripts.cli <MINT> --depth quick
.venv/bin/python -m scripts.cli <MINT> --depth full
.venv/bin/python -m scripts.cli <MINT> --depth deep

# Avec export JSON / CSV / HTML / PNG
.venv/bin/python -m scripts.cli <MINT> --depth deep --export
```

Les exports atterrissent dans `exports/<MINT>/`.

### Sur Discord

| Commande | Ce qu'elle fait |
|---|---|
| `/scan <token>` | Analyse complète (~15 s visé) |
| `/quickscan <token>` | Acheteurs, funding, score de base (~5 s visé) |
| `/deepscan <token>` | Historique complet + clusters récurrents (~30 s visé) |
| `/bundle <token>` | Détail bundle + décomposition du score |
| `/graph <token>` | Bubble map (PNG + HTML interactif hors ligne) |
| `/export <token>` | JSON, CSV, rapport HTML autonome, PNG |
| `/compare <t1> <t2>` | Acheteurs et créateur communs entre deux launches |
| `/wallet <adresse>` | Profil d'un wallet et son comportement Pump.fun |
| `/dev <adresse>` | Historique de launches d'un créateur |
| `/history <adresse>` | Participations Pump.fun récentes d'un wallet |
| `/watch <token>` | Alertes sur variation de score, nouveaux liens, graduation, sorties coordonnées |
| `/unwatch <token>` | Arrêter la surveillance |
| `/autoscan` | Mode découverte sur les nouveaux launches, avec filtres |
| `/settings` | Configuration, poids, seuils, santé des providers |

Coller un mint dans le salon `DISCORD_AUTOSCAN_CHANNEL_ID` déclenche aussi un
scan.

### Via l'API HTTP

```bash
.venv/bin/python -m app.main api --port 8000

curl localhost:8000/health
curl localhost:8000/validate/<MINT>          # test d'origine Pump.fun seul
curl localhost:8000/scan/<MINT>?depth=full   # rapport JSON
open http://localhost:8000/report/<MINT>     # rapport HTML dans le navigateur
```

---

## 6. Quelle profondeur choisir ?

| Profondeur | Acheteurs | Historique | Créateur | Clusters récurrents | Usage |
|---|---|---|---|---|---|
| `quick` | 25 | ❌ | ❌ | ❌ | Triage, mode découverte |
| `full` | 50 | échantillonné | ✅ | ✅ | Usage courant |
| `deep` | 100 | profond | complet | ✅ | Enquête sérieuse |

Une profondeur réduite ne fabrique jamais de données : la couverture manquante
est signalée et **fait baisser la confiance**. Un `quickscan` affichera
`❌ historical` et une confiance moindre — c'est voulu.

---

## 7. Lire un rapport

### L'ordre est délibéré : preuves d'abord, verdict ensuite

```
🚨 PUMP.FUN TOKEN ANALYSIS   $BUNDL
Status: BONDING CURVE   Pair: SOL   Mayhem: NO
────────────────────────────────────────────
EVIDENCE                     ← ce qui a été observé
  #1 Common funding source
     8 wallets financés par 3dpS…9djt
     txs: B1cpbJ…zRQJkU, 5wacr1…pPYWD4, …
     caveat: un funding partagé prouve une relation de paiement,
             pas une propriété commune.
────────────────────────────────────────────
CLUSTER                      ← le groupe détecté
SCORES                       ← les chiffres, décomposés
DATA QUALITY                 ← ce qui a répondu, ce qui manque
VERDICT                      ← la conclusion, en dernier
```

Chaque preuve porte **ses signatures de transaction** et **son propre caveat**.
Un rapport dont les preuves ne citent aucune transaction est un rapport faible :
c'est écrit noir sur blanc dans la sortie.

### Les scores

```
Bundle                 70/100     ← le score principal
Funding coordination   80/100     ← qui a payé, et comment
Buy coordination       98/100     ← comment les achats se ressemblent
Wallet cluster         66/100
Creator link          100/100     ← lien créateur → acheteurs
Historical pattern      0/100     ← ces wallets ont-ils déjà opéré ensemble
Sell coordination       0/100     ← sont-ils sortis ensemble
Mayhem activity         0/100     ← activité automatisée du protocole
Overall                43/100
Confidence             48%  (LOW) ← à quel point croire le reste
```

**Le score seul ne suffit jamais.** Regardez toujours :

1. **La confiance.** Un bundle à 90 avec 30 % de confiance, c'est « peut-être,
   mais on a vu trop peu ». La confiance est plafonnée en dessous de 5 wallets
   analysés, quelle que soit la qualité des données sur ces wallets.
2. **Le nombre de familles de signaux indépendantes.** Affiché dans l'embed
   bundle. En dessous de 3, le score est plafonné par construction.
3. **La classification.** Elle distingue explicitement :

| Classification | Signification |
|---|---|
| `BUNDLE-LIKE PATTERN` | Coordination privée probable |
| `POSSIBLE COORDINATION` | Signaux présents, corroboration insuffisante |
| `CEX-FUNDED USERS` | Source commune = exchange → **pas** un bundle |
| `PROFESSIONAL SNIPERS` | Wallets expérimentés, financés indépendamment |
| `MEV / AUTOMATED ACTIVITY` | Même bloc, aucun lien de funding = bots |
| `MAYHEM ACTIVITY` | Trades automatisés par le protocole |
| `NORMAL EARLY BUYERS` | Rien d'anormal |
| `INSUFFICIENT DATA` | Trop peu de données pour conclure |

### Décomposition du score

```
Contributors:
  +16 Common funding source
  +12 Shared transaction signer
   +9 Purchase synchronisation
   +7 Funding size similarity
   +7 Creator linkage
```

Chaque point est attribué à un signal nommé. Si une contribution a été atténuée
(exchange, Mayhem), la raison est affichée.

**« Shared transaction signer »** mérite une explication, parce que c'est le
signal le plus fort du moteur. Sur Solana, une transaction n'est valide que
lorsque **tous les comptes qui dépensent l'ont signée**. Un acheteur signe donc
forcément son propre achat. Deux conséquences :

* Si le **payeur de frais** d'un achat est un *autre* wallet, deux clés ont
  signé cette transaction. Ce n'est plus « quelqu'un m'a envoyé des SOL » :
  c'est une seconde partie impliquée dans l'achat lui-même.
* Si **plusieurs acheteurs distincts figurent dans une même transaction**,
  toutes leurs signatures ont été réunies avant l'envoi. Un seul opérateur l'a
  construite. Il n'y a pas d'explication innocente à ce cas — c'est la
  définition même d'un bundle.

Ce second cas déclenche une **remontée explicite du score** (plancher à 78),
signalée en clair dans la décomposition :

```
Score raised to 78: 5 distinct buyers executed inside a single transaction
(100% of the cluster). A transaction is only valid once every spending account
has signed it, so one party assembled all of those signatures.
```

La remontée reste soumise à la règle d'indépendance : sans au moins trois
familles de signaux, le plafond normal s'applique quand même. Elle ne peut que
faire monter un score déjà corroboré, jamais en fabriquer un.

### Qualité des données

```
DATA QUALITY: 81%
  ➖ helius          non configuré
  ✅ bonding_curve
  ✅ launch_trades
  ⚠️ holders         limité aux 20 plus gros comptes
  ❌ social_data
```

Une donnée manquante **abaisse la confiance** ; elle n'est jamais remplacée par
une hypothèse.

---

## 8. Comment ça marche, en bref

```
Adresse fournie
   ↓
1. Validation Pump.fun    → PDA de bonding curve, une lecture de compte.
                             Sinon : ❌ NOT A PUMP.FUN TOKEN, scan arrêté.
   ↓
2. Profil du token        → curve, supply, paire (SOL/USDC), Mayhem, graduation
   ↓
3. Bande de trades        → signatures de la curve paginées jusqu'à la plus
                             ancienne, puis SEULES les premières transactions
                             sont téléchargées (les signatures sont bon marché,
                             les transactions coûteuses)
   ↓
4. Funding                → pour chaque acheteur, on remonte avant son 1er achat
                             et on lit les DELTAS de solde (pas les instructions
                             « transfer » : un funder ne peut pas se cacher
                             derrière une instruction inhabituelle)
   ↓
5. Multi-hop              → A → X → B, A → X → Y → B, jusqu'à MAX_FUNDING_HOPS.
                             On s'arrête à un exchange : le funder d'un exchange
                             ne fait partie du bundle de personne.
   ↓
6. Profils wallets        → âge, fraîcheur, soldes, historique Pump.fun
   ↓
7. Créateur               → launches précédents, taux de graduation, funding,
                             lien éventuel avec les acheteurs
   ↓
8. Graphes                → graphe complet (bubble map) + graphe d'association
                             (l'infrastructure n'y crée aucune arête)
   ↓
9. Clusters               → composantes connexes + Louvain + DBSCAN.
                             Un groupe proposé par plusieurs méthodes est
                             plus crédible, et c'est enregistré.
   ↓
10. Scoring               → règle d'indépendance, atténuations, confiance
   ↓
11. Preuves + verdict     → avec signatures et caveats
```

**Le principe qui gouverne tout** : chaque motif de surface a une explication
innocente. Un funder commun ? Peut-être Binance. Des achats à 3 secondes
d'écart ? Peut-être huit snipers qui visent le même bloc. Des montants
identiques ? Un preset répandu. Un détecteur qui se déclenche sur un seul de ces
motifs se trompe la plupart du temps — d'où la règle d'indépendance.

Détail complet du raisonnement : `docs/SCORING.md`.
Sources de données, coûts, fallbacks : `docs/API_MATRIX.md`.

---

## 9. Mode surveillance et découverte

**Surveiller un token** — alerte uniquement quand quelque chose *change* (score
qui bouge d'au moins 8 points, nouveaux wallets liés, graduation, sortie
coordonnée). Republier le même score toutes les deux minutes apprendrait aux
gens à ignorer les alertes.

```
/watch <token>
```

**Mode découverte** — surveille tous les nouveaux launches Pump.fun via
WebSocket (repli sur polling), avec un entonnoir :

```
/autoscan enabled:True min_buyers:8 min_bundle_score:60 max_age_seconds:900
```

```
1000 détectés → 300 valides → 100 avec activité → 35 analysés
             → 8 suspects → 3 alertes
```

Seule la dernière étape arrive sur Discord. Les launches classés
`CEX-FUNDED USERS`, `MAYHEM ACTIVITY` ou `INSUFFICIENT DATA` ne déclenchent
jamais d'alerte : le moteur a trouvé une explication bénigne.

---

## 10. Problèmes courants

**`❌ NOT A PUMP.FUN TOKEN`**
Attendu si le token ne vient pas de Pump.fun. C'est la contrainte principale du
projet. Un token gradué reste valide (son compte de courbe subsiste).

**Scans lents, ou `HTTP 429`**
Votre endpoint RPC rate-limite. Baissez `RPC_REQUESTS_PER_SECOND` (essayez 10)
et `MAX_CONCURRENT_RPC` (essayez 8), ou passez à un endpoint payant.

**`⚠️ holders — limité aux 20 plus gros comptes`**
Normal sans clé Helius ou Solscan : le RPC standard ne renvoie que le top 20.

**Confiance systématiquement basse**
Regardez la section « Limitations » du rapport, qui dit précisément pourquoi.
Causes fréquentes : peu de wallets analysés, historique ignoré en `quickscan`,
ou funding illisible.

**Les commandes slash n'apparaissent pas**
Renseignez `DISCORD_GUILD_IDS` pour une synchronisation immédiate. En global,
Discord peut prendre jusqu'à une heure.

**`Trade history exceeded the page limit`**
Le token a plus de 60 000 transactions. Les tout premiers acheteurs peuvent être
incomplets — c'est signalé dans les avertissements du rapport.

---

## 11. À savoir avant la production

- **Non encore validé sur mainnet.** L'environnement de développement bloquait
  l'accès sortant vers le RPC Solana. Faites un `deepscan` sur un token connu et
  recoupez avec un explorer avant de vous fier aux chiffres.
- **Les labels d'exchanges** marqués `"verify": true` dans
  `app/data/known_entities.json` sont d'origine communautaire. La détection
  comportementale (fan-out) fait que la justesse du moteur n'en dépend pas, mais
  vérifiez-les si un cas précis compte.
- **Le timing historique** utilise l'« entry depth » (fraction de courbe déjà
  vendue au moment de l'achat) plutôt que des secondes. C'est gratuit — la
  donnée est déjà dans chaque `TradeEvent` — et plus précis qu'une estimation.
- **L'outil est en lecture seule.** Il ne demande jamais de seed phrase, de clé
  privée ni de signature, et ne trade pas.
- **L'analyse est probabiliste.** Elle ne prouve pas qu'un même individu contrôle
  plusieurs wallets. Chaque rapport le rappelle, en anglais et en français.
