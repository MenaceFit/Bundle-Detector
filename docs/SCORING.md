# How the scoring engine decides

This document explains the reasoning, not the code. Read it before changing any
weight — the weights are the least important part of the design.

## The problem

Every surface pattern that indicates a bundle also has an innocent
explanation:

| Observation | Bundle explanation | Innocent explanation |
|---|---|---|
| 8 wallets share a funder | one operator funded them all | they all withdrew from Binance |
| Buys within 3 seconds | one bundled submission | eight snipers racing the same block |
| Identical 1.00 SOL buys | one script, one config | a common preset amount |
| Fresh wallets | burner set created for this launch | privacy-conscious or first-time users |
| Same wallets on many launches | a crew that works together | active launch traders overlap constantly |

A detector that fires on any one of these is wrong most of the time. The whole
design exists to avoid that.

## The independence rule

Signals are grouped into **families** that measure genuinely different things:

| Family | Signals | Question it answers |
|---|---|---|
| `funding_topology` | common funder, common intermediary | Who paid for these wallets? |
| `execution` | shared transaction signer | Who *built and signed* the buys? |
| `funding_pattern` | funding amount similarity, funding synchronisation | Did the payments look alike? |
| `trade_pattern` | buy amount similarity, buy synchronisation | Did the buys look alike? |
| `wallet_provenance` | wallet age similarity | What are these wallets? |
| `history` | historical overlap, repeated cluster | Have they done this before? |
| `creator` | creator linkage | Is the launcher connected to them? |

Signals *inside* a family are strongly correlated — wallets funded by one
person naturally receive similar amounts at similar times, so `funding_pattern`
adds almost no information once `funding_topology` has fired. The score is
therefore capped by how many **families** agree, not by how loud any one signal
is:

| Families that fired | Ceiling |
|---|---|
| 0-1 | 35 |
| 2 | 55 |
| 3+ | none |

There is exactly one escalation in the other direction, described under
[the atomic floor](#the-atomic-floor), and it is gated on this rule already
being satisfied.

This is the direct implementation of §17/§46 of the specification: *five
wallets funded with about 5 SOL each is not a bundle*, and the engine is
structurally incapable of calling it one until independent evidence joins it.
The test `test_matching_amounts_alone_cannot_reach_high_risk` pins this
behaviour.

## The execution family

`execution` is the newest family and the strongest one, because it is the only
one whose innocent explanation is thin.

On Solana a transaction is valid only once **every account that spends has
signed it**. A buyer necessarily signs their own purchase. So:

* If the **fee payer** of a buy is a *different* wallet, two keys signed that
  transaction. That is not "someone sent me SOL" — it is a second party
  participating in the purchase itself.
* If several **distinct buyers appear inside one transaction**, every one of
  their signatures was collected before submission. One party assembled them.

Both are measured by `app.analyzers.buyers.execution_links`, from the parsed
transactions the engine already fetched — no extra RPC calls. A fee payer who
sponsored only *one* buyer is discarded: it links nothing to nothing.

### The atomic floor

Atomicity is treated differently from every other signal. When a single
transaction contains at least `atomic_execution_share` (50%) of a cluster's
members, and the independence rule is *already* satisfied, the score is raised
to `atomic_execution_floor` (78) and the reason is printed in the breakdown.

The gate matters as much as the floor. Atomic execution alone stays capped at
35 like any other lone family — the escalation only lifts a case that several
independent families already support. It can raise a score, never lower one,
and it never overrides a ceiling. `TestAtomicExecutionFloor` pins all four
properties, including `test_atomicity_alone_cannot_defeat_the_independence_rule`.

Both findings are surfaced as traceable evidence (`ATOMIC_EXECUTION`,
`SHARED_FEE_PAYER`) carrying the signatures that establish them, and each states
its own limit: shared execution proves a single *operator*, not a single
*owner* — fee sponsorship is sold as a service.

## Damping

Two contexts reduce a signal before it contributes points:

**Shared infrastructure.** If the common funder is an exchange or behaves like
a shared service, its coordination weight is multiplied by `infra_damping`
(0.2). Detection is two-layered: a curated label list *and* behavioural
inference (an address that fanned out to 60+ distinct wallets, or has 5 000+
transactions, is shared infrastructure whether or not anyone has labelled it).
The behavioural layer is the important one — a label list is always incomplete,
and §43 must hold for the exchange nobody has labelled yet.

**Mayhem Mode.** Protocol-automated trades produce tight timing and uniform
sizing by construction. Trade-pattern signals are damped in proportion to the
share of Mayhem-flagged activity, and wallets whose *every* trade is flagged are
excluded from the human set entirely. A wallet that also trades outside flagged
transactions stays in — being present during Mayhem is not evidence of being a
bot.

## Continuous, never boolean

Every similarity is a continuous function with no cliffs. `similarity_from_cv`
maps a coefficient of variation through a cosine easing curve, so a small
measurement change never swings the score. There is no `if amount1 == amount2`
anywhere in the engine, and `test_similarity_is_continuous_not_a_cliff` enforces
that.

A single observation returns similarity `0.0`, not `1.0`. Claiming perfect
similarity from one sample is the classic way a detector manufactures findings.

## Classification before verdict

A high coordination score has several possible causes, and the engine ranks
explanations from the most specific benign one to the least, so a benign
explanation that fits the evidence wins:

1. `INSUFFICIENT DATA` — too few wallets, or confidence below 25
2. `MAYHEM ACTIVITY` — protocol automation accounts for the activity
3. `CEX-FUNDED USERS` — the shared funder is an exchange and nothing else fired
4. `MEV / AUTOMATED ACTIVITY` — same-block entries with no funding relationship
5. `PROFESSIONAL SNIPERS` — experienced, independently funded, always early
6. `BUNDLE-LIKE PATTERN` — score ≥ 70 *and* 3+ independent families
7. `POSSIBLE COORDINATION` — score ≥ 45
8. `NORMAL EARLY BUYERS`

Note what distinguishes 4 from 6: bundlers *fund* their wallets, bots do not
need to. Same-block execution without a funding relationship is automation.

## Confidence is a separate axis

Confidence answers "how much should you trust that number", built from sample
size, data coverage, provider health, signal coherence and history depth. A
high bundle score on thin data is reported as exactly that — high score, low
confidence — never quietly suppressed or quietly trusted.

Fewer wallets than `low_data_wallet_threshold` caps confidence into the LOW
band regardless of how clean the data for those few wallets is. Perfect
coverage of a tiny sample is still a tiny sample.

## Evidence before verdict

The report always shows *what was observed*, with transaction signatures,
before it shows *what the engine concluded*. Every evidence item carries a
`caveat` stating what it does not prove. This ordering is enforced in the
Discord embeds, the HTML export and the CLI, and tested in
`test_export.py::TestExports::test_html_places_evidence_before_the_verdict_sections`.

## Changing the weights

Weights live in `app/config.py::BundleWeights` and sum to 100. Changing them
changes how loud a signal is, but it cannot break the independence rule, the
damping or the classification ranking — those are structural. If you find
yourself raising a weight to make a case score higher, the honest fix is
usually a new *independent* signal, not a louder existing one.
