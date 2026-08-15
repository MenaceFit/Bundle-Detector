# API capability matrix

Which data the engine needs, where it comes from, and what happens when that
source is unavailable.

**The rule that shapes this table: Solana RPC is authoritative, everything else
is an accelerator.** With `RPC_URL` alone the engine performs every analysis in
this document. Helius and Solscan make some of them faster or wider, and their
absence lowers the *confidence* score rather than breaking a scan.

Capabilities of third-party APIs change. Before relying on a row marked
"verify", check it against the provider's current documentation with your own
key — `app/providers/` isolates each provider so a shape change is a one-file
fix.

---

## Data → provider matrix

| Data | Primary | Fallback | Endpoint / method | Cost | Rate limit | Latency | If missing |
|---|---|---|---|---|---|---|---|
| Pump.fun origin proof | RPC | — | `getAccountInfo` on the bonding-curve PDA | 1 call | endpoint | ~50-150 ms | Scan aborts (by design) |
| Coin creation tx + `CreateEvent` | RPC | — | `getSignaturesForAddress` on the metadata PDA → `getTransaction` | 2 calls | endpoint | ~150 ms | Creation time unknown → all "seconds after launch" figures unavailable |
| Bonding-curve state | RPC | — | `getAccountInfo`, decoded with the IDL `BondingCurve` layout | 1 call | endpoint | ~50 ms | `bonding_curve` coverage → missing |
| Graduation threshold denominator | RPC | — | `getAccountInfo` on the Pump `global` PDA | 1 call (cached) | endpoint | ~50 ms | Graduation progress reported as unknown, never guessed |
| Trade tape (all buys/sells) | RPC | — | `getSignaturesForAddress` on the curve → batched `getTransaction` | 1 call / 1 000 sigs + 1 batch / 40 txs | endpoint | 0.3-3 s | `launch_trades` coverage → missing |
| PumpSwap pool + post-graduation trades | RPC | — | mint signatures → `BuyEvent`/`SellEvent`/`CreatePoolEvent`, confirmed by decoding the `Pool` account | 2-5 calls | endpoint | ~200 ms | Lifecycle reported as `GRADUATED` without a pool address |
| Wallet funding history | RPC | — | `getSignaturesForAddress(wallet, before=<first buy>)` → `getTransaction`, read as balance deltas | ~2 calls / wallet | endpoint | ~100 ms/wallet | `funding` coverage → partial; funding signals drop out |
| Wallet age | RPC | — | `getSignaturesForAddress` paged to the oldest (bounded at 3 pages) | 1-3 calls / wallet | endpoint | ~100 ms/wallet | Age reported as unknown; freshness signals drop out |
| Wallet SOL balances | RPC | — | batched `getBalance` | 1 batch | endpoint | ~100 ms | Balance columns blank |
| Historical Pump.fun behaviour | RPC | — | wallet signatures → `TradeEvent`s on other mints | 1 + n/40 calls / wallet | endpoint | 0.5-3 s | `historical` coverage → missing; repeat-behaviour signals drop out |
| Creator launch history | RPC | — | creator signatures → `CreateEvent`s | 1 + n/40 calls | endpoint | 0.3-2 s | `creator_history` → partial |
| Previous launches' graduation status | RPC | — | batched `getMultipleAccounts` on their curve PDAs | 1 call / 100 | endpoint | ~150 ms | Graduation counts omitted |
| Holder distribution (full) | **Helius DAS** | Solscan → RPC | `getTokenAccounts` (DAS) | paid tier | provider | ~200 ms | Falls back to RPC's top-20 → `holders` coverage → partial |
| Holder distribution (top 20) | RPC | — | `getTokenLargestAccounts` + owner resolution | 2 calls | endpoint | ~150 ms | `holders` → missing |
| Token metadata / socials | **Helius DAS** | Solscan → on-chain `CreateEvent` | `getAsset` | paid tier | provider | ~150 ms | Name/symbol still read from `CreateEvent`; `social_data` → missing |
| Address labels (exchanges etc.) | Bundled registry | Solscan `/account/detail` → behavioural inference | `app/data/known_entities.json` | free | — | 0 ms | Behavioural inference still catches shared infrastructure |
| New-launch feed | RPC WebSocket | RPC polling | `logsSubscribe` on the Pump program | 1 socket | endpoint | <1 s | Falls back to a ~6 s poll |

---

## Provider priority

```
holders     Helius DAS  →  Solscan  →  RPC (top 20 only)
metadata    Helius DAS  →  Solscan  →  on-chain CreateEvent
labels      registry    →  Solscan  →  behavioural inference
everything  RPC (authoritative)
```

Failover is implemented in `app/providers/registry.py`. Each provider has its
own token bucket, circuit breaker and retry policy (`app/utils/concurrency.py`),
so one provider degrading never stalls the others.

---

## Endpoints used, by provider

### Solana JSON-RPC (required)

| Method | Used for | Notes |
|---|---|---|
| `getAccountInfo` | curve, pool, global, token accounts | `base64` encoding, decoded against the IDL |
| `getMultipleAccounts` | batched curve reads | 100-account limit respected |
| `getBalance` | wallet balances | issued as a JSON-RPC batch |
| `getSignaturesForAddress` | history walking | 1 000/page; `before` used for paging |
| `getTransaction` | trade/funding decoding | `jsonParsed`, `maxSupportedTransactionVersion: 0` |
| `getTokenLargestAccounts` | holder fallback | capped at 20 accounts by the RPC spec |
| `getTokenSupply` | supply/decimals | |
| `logsSubscribe` (WS) | new-launch feed | optional |

Any mainnet endpoint works. Public `api.mainnet-beta.solana.com` is heavily
rate-limited and lacks deep history — usable for a smoke test, not for real
work.

### Helius (optional — `HELIUS_API_KEY`)

| Endpoint | Used for | Verify |
|---|---|---|
| `getTokenAccounts` (DAS, `mainnet.helius-rpc.com`) | full holder list | ✅ stable |
| `getAsset` (DAS) | metadata, image, socials | ✅ stable |
| `POST /v0/transactions` (Enhanced) | optional cross-check of the funding tracer | verify — plan-gated |

Setting `HELIUS_API_KEY` also prepends the Helius RPC endpoint to the RPC
failover list, so it doubles as a higher-quality chain source.

### Solscan Pro (optional — `SOLSCAN_API_KEY`)

| Endpoint | Used for | Verify |
|---|---|---|
| `GET /v2.0/token/holders` | holder distribution | verify — response shape is versioned |
| `GET /v2.0/token/meta` | metadata fallback | verify |
| `GET /v2.0/account/detail` | `account_label` for entity classification | verify |

Authentication is the `token` header. Responses are normalised defensively in
`app/providers/solscan.py` (`_items`) because the Pro API wraps payloads
inconsistently between endpoints.

---

## Cost profile of one scan

Measured in RPC calls, for a coin with ~40 early buyers:

| Depth | Signature pages | Transaction batches | Account reads | Typical total |
|---|---|---|---|---|
| `quick` | ~30 | ~4 | ~4 | ~60 calls |
| `full` | ~90 | ~12 | ~8 | ~150 calls |
| `deep` | ~180 | ~30 | ~15 | ~350 calls |

Two mechanisms keep this bounded:

* **Signatures before bodies.** Signature pages are cheap (1 000 per call) and
  transaction bodies are expensive, so the engine walks the full signature
  history first and then fetches only the transactions it actually needs. This
  is what makes "the first 100 buyers" affordable on a coin with 50 000 trades.
* **De-duplication and caching.** Identical in-flight requests are collapsed
  (`SingleFlight`), and confirmed transactions are cached for a week — they are
  immutable, so a re-scan is dominated by cache hits.

---

## Data quality reporting

Every scan reports which sources answered and how complete each data class was
(`DataQuality` in `app/providers/base.py`), surfaced in the report as:

```
DATA QUALITY: 91%
✅ rpc:...          142 req, 63ms avg
➖ helius           not configured
❌ solscan          HTTP 401
✅ bonding_curve
✅ launch_trades
⚠️ holders          limited to the top 20 accounts
❌ historical       skipped at this scan depth
```

Missing data reduces the confidence score and is listed under "Limitations". It
is never silently substituted with an assumption.
