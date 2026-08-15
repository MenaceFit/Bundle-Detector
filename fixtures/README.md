# Fixtures

Regression fixtures are **generated**, not stored as captured JSON blobs, and
they live in [`tests/support/`](../tests/support/):

| File | What it provides |
|---|---|
| `borsh_writer.py` | A Borsh *encoder*, written independently of the decoder in `app/utils/borsh.py` |
| `chain.py` | `SyntheticChain` — builds RPC-shaped accounts, transactions and signature histories containing genuine Anchor payloads; `FakeRpc` serves them through the engine's RPC surface |
| `scenarios.py` | The eight regression scenarios of the specification (§87, §107) |

## Why generated rather than recorded

A recorded mainnet transaction pins one moment of one program version. A
generator pins the *layout*: it encodes against the same IDL-derived layouts the
decoder reads, so the pair stays in sync when Pump appends a field, and any
scenario can be varied (wallet count, funder topology, timing spread, Mayhem
flags) without another capture.

Because the encoder is written separately from the decoder, the decoder is
tested against an independent implementation rather than against itself.

## What is *not* faked

Only the transport. Every test that consumes these fixtures runs the real
orchestrator: real base58, real PDA derivation, real Borsh decoding, real
balance-delta reading, real graph construction, real clustering, real scoring.
No score, similarity or classification is ever stubbed.

Two derivations are additionally pinned to values verifiable on any public
explorer, which anchors the crypto layer to reality:

* Pump `global` PDA → `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`
* Metaplex metadata PDA for the USDC mint → `5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq`

## Adding a scenario

Add a builder to `scenarios.py` returning a `Scenario`, then assert on the
*classification*, not on an exact score — scores move when weights are tuned,
but "an exchange-funded crowd must never be called a bundle" is the invariant
worth pinning.

```python
def my_case() -> Scenario:
    chain = SyntheticChain()
    mint, creator = address("my-mint"), address("my-creator")
    chain.create_coin(mint=mint, creator=creator, block_time=LAUNCH_TIME)
    ...
    return Scenario("my_case", chain, mint, creator, buyers, "NORMAL EARLY BUYERS")
```

## Capturing real transactions

To debug against a real transaction, save the raw `getTransaction` result and
feed it straight to the parser — no fixture plumbing required:

```python
from app.pumpfun.events import parse_transaction

parsed = parse_transaction(json.load(open("tx.json")), "<signature>")
print(parsed.instructions, [e.name for e in parsed.events])
```
