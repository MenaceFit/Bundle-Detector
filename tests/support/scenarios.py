"""Regression scenarios (§87, §107).

Each scenario builds a complete, self-consistent chain state that reproduces
one of the situations the engine must tell apart.  They exist to prove the
engine does not collapse every "several wallets bought early" pattern into
"bundle".
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from tests.support.chain import SyntheticChain, address

#: A curated CEX address from the bundled registry (Binance hot wallet).
KNOWN_CEX = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"

LAUNCH_TIME = 1_750_000_000


@dataclass
class Scenario:
    name: str
    chain: SyntheticChain
    mint: str
    creator: str
    buyers: list[str] = field(default_factory=list)
    expected: str = ""


def _age_wallet(chain: SyntheticChain, wallet: str, *, days_old: float) -> None:
    """Give a wallet a history so it is not measured as freshly created."""
    chain.unrelated_activity(
        wallet=wallet, block_time=int(LAUNCH_TIME - days_old * 86_400), count=3
    )


def independent_buyers(count: int = 20) -> Scenario:
    """Case 1 — unrelated wallets, unrelated funders, scattered timing and sizing."""
    chain = SyntheticChain()
    mint, creator = address("indep-mint"), address("indep-creator")
    _age_wallet(chain, creator, days_old=200)
    chain.create_coin(mint=mint, creator=creator, symbol="INDEP", block_time=LAUNCH_TIME)

    rng = random.Random(17)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"indep-buyer-{i}")
        funder = address(f"indep-funder-{i}")  # a different funder for each wallet
        _age_wallet(chain, wallet, days_old=rng.uniform(20, 400))
        chain.fund(
            source=funder,
            recipient=wallet,
            sol=rng.uniform(0.3, 14.0),
            block_time=int(LAUNCH_TIME - rng.uniform(3_600, 400_000)),
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(rng.uniform(0.05, 6.0), 4),
            block_time=int(LAUNCH_TIME + rng.uniform(5, 2_400)),
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 1_000_000) for w in buyers[:10]])
    return Scenario("independent", chain, mint, creator, buyers, "NORMAL EARLY BUYERS")


def private_bundle(count: int = 8) -> Scenario:
    """Case 2 — one private funder, fresh wallets, matched sizes, synchronised entries."""
    chain = SyntheticChain()
    mint, creator = address("bundle-mint"), address("bundle-creator")
    funder = address("bundle-funder")
    _age_wallet(chain, creator, days_old=90)
    chain.fund(source=funder, recipient=creator, sol=12.0, block_time=LAUNCH_TIME - 900)
    chain.create_coin(mint=mint, creator=creator, symbol="BUNDL", block_time=LAUNCH_TIME)

    rng = random.Random(3)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"bundle-buyer-{i}")
        # Freshly created: the funding transfer is the wallet's first transaction.
        chain.fund(
            source=funder,
            recipient=wallet,
            sol=round(5.0 + rng.uniform(-0.02, 0.02), 4),
            block_time=LAUNCH_TIME - 40 + i,
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(1.0 + rng.uniform(-0.01, 0.01), 4),
            block_time=LAUNCH_TIME + 3 + i,
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 5_000_000) for w in buyers])
    return Scenario("private_bundle", chain, mint, creator, buyers, "BUNDLE-LIKE PATTERN")


def cex_funded(count: int = 12) -> Scenario:
    """Case 3 — many wallets withdrawing from the same exchange. Not a bundle."""
    chain = SyntheticChain()
    mint, creator = address("cex-mint"), address("cex-creator")
    _age_wallet(chain, creator, days_old=150)
    chain.create_coin(mint=mint, creator=creator, symbol="CEXF", block_time=LAUNCH_TIME)

    rng = random.Random(11)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"cex-buyer-{i}")
        _age_wallet(chain, wallet, days_old=rng.uniform(30, 500))
        chain.fund(
            source=KNOWN_CEX,
            recipient=wallet,
            sol=round(rng.uniform(1.0, 8.0), 3),
            block_time=int(LAUNCH_TIME - rng.uniform(600, 90_000)),
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(rng.uniform(0.2, 3.0), 3),
            block_time=int(LAUNCH_TIME + rng.uniform(10, 900)),
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 2_000_000) for w in buyers[:8]])
    return Scenario("cex_funded", chain, mint, creator, buyers, "CEX-FUNDED USERS")


def same_block_automation(count: int = 6) -> Scenario:
    """Case 4 — bots racing the same block, each independently funded long before."""
    chain = SyntheticChain()
    mint, creator = address("mev-mint"), address("mev-creator")
    _age_wallet(chain, creator, days_old=60)
    chain.create_coin(mint=mint, creator=creator, symbol="MEV", block_time=LAUNCH_TIME)

    shared_slot = chain.next_slot()
    rng = random.Random(5)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"mev-buyer-{i}")
        _age_wallet(chain, wallet, days_old=rng.uniform(90, 600))
        chain.fund(
            source=address(f"mev-funder-{i}"),
            recipient=wallet,
            sol=round(rng.uniform(5, 60), 2),
            block_time=int(LAUNCH_TIME - rng.uniform(200_000, 900_000)),
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(rng.uniform(0.4, 3.5), 3),
            block_time=LAUNCH_TIME + 1,
            creator=creator,
            slot=shared_slot,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 3_000_000) for w in buyers])
    return Scenario("automation", chain, mint, creator, buyers, "MEV / AUTOMATED ACTIVITY")


def mayhem_launch(count: int = 8) -> Scenario:
    """Case 5 — Mayhem Mode: protocol-automated trades that mimic coordination."""
    chain = SyntheticChain()
    mint, creator = address("mayhem-mint"), address("mayhem-creator")
    _age_wallet(chain, creator, days_old=45)
    chain.create_coin(mint=mint, creator=creator, symbol="MAYH", block_time=LAUNCH_TIME, mayhem=True)

    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"mayhem-buyer-{i}")
        chain.fund(
            source=address(f"mayhem-funder-{i}"),
            recipient=wallet,
            sol=2.0,
            block_time=LAUNCH_TIME - 5_000 - i,
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=1.0,
            block_time=LAUNCH_TIME + 2 + i,
            creator=creator,
            mayhem=True,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 4_000_000) for w in buyers])
    return Scenario("mayhem", chain, mint, creator, buyers, "MAYHEM ACTIVITY")


def professional_snipers(count: int = 6) -> Scenario:
    """Case 6 — experienced, independently funded snipers who are always early."""
    chain = SyntheticChain()
    mint, creator = address("sniper-mint"), address("sniper-creator")
    _age_wallet(chain, creator, days_old=300)
    chain.create_coin(mint=mint, creator=creator, symbol="SNIP", block_time=LAUNCH_TIME)

    rng = random.Random(23)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"sniper-{i}")
        _age_wallet(chain, wallet, days_old=rng.uniform(120, 700))
        # Each sniper has its own long trading history across other coins.
        for j in range(30):
            other = address(f"other-coin-{j}")
            chain.buy(
                mint=other,
                wallet=wallet,
                sol=round(rng.uniform(0.5, 4), 3),
                block_time=int(LAUNCH_TIME - 86_400 * (j + 1)),
                creator=address(f"other-creator-{j}"),
                real_token_reserves=790_000_000_000_000,
            )
        chain.fund(
            source=address(f"sniper-funder-{i}"),
            recipient=wallet,
            sol=round(rng.uniform(20, 90), 2),
            block_time=int(LAUNCH_TIME - rng.uniform(400_000, 900_000)),
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(rng.uniform(0.8, 4.0), 3),
            block_time=LAUNCH_TIME + 2 + i,
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 3_500_000) for w in buyers])
    return Scenario("snipers", chain, mint, creator, buyers, "PROFESSIONAL SNIPERS")


def identical_amounts_only(count: int = 6) -> Scenario:
    """Case 7 — the spec's §17 trap: matching sizes and nothing else."""
    chain = SyntheticChain()
    mint, creator = address("amt-mint"), address("amt-creator")
    _age_wallet(chain, creator, days_old=100)
    chain.create_coin(mint=mint, creator=creator, symbol="AMT", block_time=LAUNCH_TIME)

    rng = random.Random(31)
    buyers: list[str] = []
    for i in range(count):
        wallet = address(f"amt-buyer-{i}")
        _age_wallet(chain, wallet, days_old=rng.uniform(50, 600))
        chain.fund(
            source=address(f"amt-funder-{i}"),  # every wallet has its own funder
            recipient=wallet,
            sol=5.0,  # identical funding size
            block_time=int(LAUNCH_TIME - rng.uniform(50_000, 900_000)),  # scattered in time
        )
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=1.0,  # identical buy size
            block_time=int(LAUNCH_TIME + rng.uniform(60, 3_000)),  # scattered in time
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 1_500_000) for w in buyers])
    return Scenario("identical_amounts", chain, mint, creator, buyers, "NORMAL EARLY BUYERS")


def graduated_coin() -> Scenario:
    """Case 8 — a coin that completed its bonding curve."""
    chain = SyntheticChain()
    mint, creator = address("grad-mint"), address("grad-creator")
    _age_wallet(chain, creator, days_old=30)
    chain.create_coin(
        mint=mint, creator=creator, symbol="GRAD", block_time=LAUNCH_TIME, complete=True
    )
    buyers: list[str] = []
    rng = random.Random(41)
    for i in range(6):
        wallet = address(f"grad-buyer-{i}")
        _age_wallet(chain, wallet, days_old=rng.uniform(10, 300))
        chain.buy(
            mint=mint,
            wallet=wallet,
            sol=round(rng.uniform(0.5, 4), 3),
            block_time=int(LAUNCH_TIME + rng.uniform(20, 3_000)),
            creator=creator,
        )
        buyers.append(wallet)
    chain.set_holders(mint, [(w, 2_500_000) for w in buyers])
    return Scenario("graduated", chain, mint, creator, buyers, "")


ALL_SCENARIOS = {
    "independent": independent_buyers,
    "private_bundle": private_bundle,
    "cex_funded": cex_funded,
    "automation": same_block_automation,
    "mayhem": mayhem_launch,
    "snipers": professional_snipers,
    "identical_amounts": identical_amounts_only,
    "graduated": graduated_coin,
}
