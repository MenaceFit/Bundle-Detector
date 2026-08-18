# Pump.fun Bundle Detector

An on-chain forensics engine for **Pump.fun launches only**. Give it a mint
address and it answers: who bought, when, how much, where their SOL came from,
whether they are linked, whether they have done this before, whether they are
connected to the creator — and how strong that evidence actually is.

It follows a coin through its whole lifecycle: bonding curve → graduation →
PumpSwap.

```
/scan <PUMP_FUN_MINT>
```

---

## What makes it different

Most "bundle checkers" fire on a single surface pattern — same funder, same
amount, same second — and are therefore wrong most of the time. This engine is
built around the opposite constraint.

**One signal is never a bundle.** Signals are grouped into families that
measure genuinely different things (who paid, who signed, how the payments
looked, how the buys looked, what the wallets are, what they've done before,
creator linkage). The bundle score is hard-capped unless several *independent*
families agree. Five wallets funded with ~5 SOL each cannot reach a high score,
however identical those amounts are.

**Signatures outrank transfers.** A shared funder can be a generous friend; a
shared *fee payer* cannot — on Solana that wallet signed someone else's
purchase. And several distinct buyers inside one transaction is not a
coincidence at all: the transaction only executes once every one of their
signatures was collected. That case is escalated explicitly, and only once the
independence rule above is already satisfied.

**Shared infrastructure is detected behaviourally, not from a list.** Forty
wallets funded by an exchange is not a forty-wallet bundle. The engine ships a
curated label registry *and* infers shared infrastructure from behaviour — an
address that fanned out to 60+ distinct wallets is a shared service whether or
not anyone has labelled it. A label list is always incomplete; the behavioural
layer is what makes this hold for the exchange nobody has labelled yet.

**Automation is separated from coordination.** Mayhem Mode produces tight
timing and uniform sizing by construction, so it is measured on its own axis and
removed from the coordination inputs. MEV bots racing the same block are
classified as automation, not as one operator — bundlers fund their wallets,
bots do not need to.

**Evidence comes before the verdict.** Every finding names its wallets, cites
its transaction signatures, and states what it does *not* prove. The score is
fully attributed: every point traces to a named contribution.

**Nothing is invented.** Program addresses, account layouts and event
discriminators are transcribed from Pump's official Anchor IDLs. Data that
cannot be retrieved lowers the confidence score instead of being assumed. There
is no synthetic scoring anywhere in the engine.

---

## Quick start

Simplest path — the launcher handles venv, dependencies, config and diagnostics:

```bash
./start.sh          # Linux/macOS  (start.bat on Windows)
```

Step-by-step French walkthrough: [`docs/DEMARRAGE_RAPIDE.md`](docs/DEMARRAGE_RAPIDE.md).

Manual equivalent:

```bash
git clone <repo> && cd Bundle-Detector
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # set RPC_URL (and DISCORD_TOKEN for the bot)

# scan from the terminal — no Discord token needed
.venv/bin/python -m scripts.cli <MINT> --depth full --export

# or run the bot
.venv/bin/python -m app.main bot
```

The only required setting is `RPC_URL`. A paid mainnet endpoint is strongly
recommended: the public one is heavily rate-limited and lacks deep history.
`HELIUS_API_KEY` and `SOLSCAN_API_KEY` are optional accelerators — without them
the engine still performs every analysis, with reduced holder coverage and a
correspondingly lower confidence score.

### Docker

```bash
cp .env.example .env
docker compose up -d          # bot + API + PostgreSQL + Redis
docker compose run --rm bot python -m scripts.cli <MINT> --depth deep
```

---

## Discord commands

| Command | What it does |
|---|---|
| `/scan <token>` | Full analysis (~15 s target) |
| `/quickscan <token>` | Buyers, funding, basic bundle score (~5 s target) |
| `/deepscan <token>` | Full history, cross-launch cluster matching (~30 s target) |
| `/bundle <token>` | Bundle detail with the explainable score breakdown |
| `/graph <token>` | Bubble map (PNG + interactive offline HTML) |
| `/export <token>` | JSON, CSV, self-contained HTML report, PNG |
| `/compare <t1> <t2>` | Shared buyers and creator between two launches |
| `/wallet <address>` | Wallet profile and Pump.fun behaviour |
| `/dev <address>` | Creator launch history and graduation record |
| `/history <address>` | A wallet's recent Pump.fun participation |
| `/watch <token>` | Alert on score changes, new linked buyers, graduation, coordinated exits |
| `/unwatch <token>` | Stop watching |
| `/autoscan` | Discovery mode over new launches, with filters |
| `/settings` | Engine configuration, weights, thresholds, provider health |

Pasting a bare mint into the channel set by `DISCORD_AUTOSCAN_CHANNEL_ID` also
triggers a scan.

The report is delivered as an ordered set of embeds — overview, token status,
**evidence**, bundle detail, creator, **verdict** — with buttons for the bubble
map, the wallet table, per-cluster detail, data quality and export.

---

## Pump.fun only

The scanner refuses anything that is not a Pump.fun launch:

```
❌ NOT A PUMP.FUN TOKEN

This scanner only analyzes Pump.fun launches.
```

Origin is proven, not guessed. The bonding-curve address is a PDA of the Pump
program derived from the mint (`["bonding-curve", mint]`); if that account
exists, is owned by `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` and decodes
against the IDL `BondingCurve` layout, the coin came from Pump.fun. No other
program can write to that address. A graduated coin keeps its curve account, so
graduated coins still validate and remain analysable on PumpSwap.

---

## What a scan produces

```
TOKEN · CREATOR · LIFECYCLE · PAIR (SOL/USDC) · MAYHEM STATUS
GRADUATION STATUS · PUMPSWAP STATUS
FIRST BUYERS · TOP HOLDERS · BUY TIMING · BUY AMOUNTS · SLOT ANALYSIS
FUNDING · FUNDING GRAPH · INTERMEDIARIES · WALLET AGES
HISTORICAL PUMP.FUN ACTIVITY · CREATOR HISTORY · SELL COORDINATION
WALLET CLUSTERS · BUBBLE MAP
BUNDLE SCORE · COORDINATION SCORES · CONFIDENCE · EVIDENCE · VERDICT
```

Multi-dimensional, because a single number hides the reasoning:

```
Bundle Score             88     Sell Coordination     70
Funding Coordination     94     Mayhem Activity        0
Buy Coordination         91     Early Buyer Risk      76
Wallet Cluster           87     Dev Risk              63
Creator Link             63     Overall               81
Historical Pattern       81     Confidence            93
```

Every point is attributed:

```
+20 Common funding source
+15 Common intermediary
+12 Purchase timing
+11 Funding timing
...
```

And every report carries both disclaimers:

> This is a probabilistic analysis based on observable on-chain patterns.
> It does not prove wallet ownership or intent.
>
> Cette analyse est probabiliste et repose sur des comportements observables
> on-chain. Elle ne constitue pas une preuve certaine que plusieurs wallets
> appartiennent à la même personne.

---

## Architecture

```
Discord bot / FastAPI / CLI
            │
            ▼
      Scan orchestrator ──────── 28-step pipeline (app/orchestrator.py)
            │
   ┌────────┴─────────┐
   ▼                  ▼
Pump.fun validator   Provider hub ── RPC (authoritative) · Helius · Solscan
                          │
                          ▼
                  Transaction engine (IDL-based Borsh decoding)
                          │
        ┌─────────┬───────┴────────┬──────────┐
        ▼         ▼                ▼          ▼
     Buyers    Funding         Holders     History
        └─────────┴───────┬────────┴──────────┘
                          ▼
                    Graph engine  (NetworkX)
                          ▼
                   Cluster engine (components + Louvain + DBSCAN)
                          ▼
                     Risk engine  (independence rule, damping, confidence)
                          ▼
                Evidence → report → Discord / HTML / JSON / CSV / PNG
```

```
app/
├── config.py           weights, windows, thresholds
├── orchestrator.py     the pipeline
├── pumpfun/            constants (from IDL), pda, events, validator, token,
│                       lifecycle, graduation, mayhem
├── providers/          base (interfaces + data quality), rpc, helius, solscan, registry
├── analyzers/          buyers, funding, wallet, history, creator, holders,
│                       sell_behavior, entities
├── graph/              builder, clustering, fingerprints, renderer
├── scoring/            bundle, coordination, confidence, evidence, risk
├── models/             enums, token, wallet, cluster, scoring
├── db/                 models, session, repository
├── cache/              redis + in-memory fallback
├── discord/            bot, commands, embeds, views, progress
├── monitoring/         watch mode, discovery mode, launch feed
└── export.py           JSON / CSV / HTML / PNG
```

Design constraints held throughout:

* The scoring engine never imports a concrete provider.
* Analyzers measure; only `app/scoring/` decides.
* The database is a *memory*, never a dependency — an unreachable one costs the
  cross-launch signal and nothing else.
* Read-only. The bot never asks for a seed phrase, private key or signature,
  and never trades.

Deeper reading: [`docs/GUIDE_FR.md`](docs/GUIDE_FR.md) — guide complet en français
(installation, utilisation, lecture des rapports).
[`docs/SCORING.md`](docs/SCORING.md) for how the engine
decides, [`docs/API_MATRIX.md`](docs/API_MATRIX.md) for data sources, costs and
fallbacks.

---

## Cross-launch intelligence

A single scan can be computed entirely from RPC. What it cannot do is answer
*"have these wallets done this together before?"* — that needs memory.
`wallet_launch_history` and stored cluster fingerprints accumulate across scans,
so the engine recognises a returning crew even when some addresses have been
rotated out. Cluster fingerprints blend membership overlap with structural
similarity (size, topology, timing, sizing, age profile) for exactly that
reason.

Wallet fingerprints do the same at the individual level: bundlers rotate
addresses freely but rarely change how they operate.

---

## Testing

```bash
.venv/bin/python -m pytest -q     # 117 tests
.venv/bin/ruff check app scripts tests
```

The suite runs the **real** orchestrator — real Borsh decoding, real PDA
derivation, real funding tracing, real clustering, real scoring — against an
in-memory chain that emits genuine Anchor payloads. Only the transport is
replaced. The Borsh *encoder* used to build fixtures is written independently of
the decoder, so the decoder is tested against a separate implementation rather
than against itself.

Two PDA derivations are pinned to values verifiable on any explorer (the Pump
`global` account and the USDC metadata PDA), which anchors the whole crypto
layer.

The false-positive scenarios of the specification each have a test:

| Scenario | Must be classified as |
|---|---|
| 20 independent wallets | not a bundle |
| 8 wallets, one private funder, fresh, synchronised | bundle |
| 12 wallets funded by a known exchange | CEX-funded users |
| 6 bots in one block, independently funded | automation |
| Mayhem Mode launch | Mayhem activity, damped |
| 6 experienced snipers | professional snipers |
| Identical amounts and nothing else | **not** a bundle |
| Graduated coin | tracked through to PumpSwap |

---

## Status and limitations

Verified offline against the replayable chain fixtures; **not yet exercised
against live mainnet data** — the environment this was built in blocks outbound
access to Solana RPC and Solscan. Before trusting production output, run
`python -m scripts.cli <known mint> --depth deep` against a real endpoint and
check the report against an explorer.

Known limitations, all surfaced in the report rather than hidden:

* **Historical entry timing** uses *entry depth* (the fraction of the bonding
  curve already sold when a wallet bought, read from `TradeEvent` reserves)
  rather than wall-clock seconds. Exact per-token creation timestamps would cost
  one extra lookup per token per wallet, which does not fit a 15-second scan.
  Entry depth is cheaper and arguably sharper.
* **Wallet age** is paged with a bound. When the bound is hit the measured age
  is a *lower* bound — a wallet may be older than reported, never younger — so a
  paging shortfall can never manufacture a "fresh wallet" finding.
* **Holder coverage** without a Helius or Solscan key is the top 20 accounts
  only, and is reported as partial.
* **Exchange labels** in `app/data/known_entities.json` marked `"verify": true`
  are community-sourced starting points. The behavioural inference layer means
  correctness does not depend on them.

---

## Security

Read-only by construction. No private keys, no seed phrases, no signing, no
trading. Credentials come from the environment; none are hardcoded.
