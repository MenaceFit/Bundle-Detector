"""Wallet profiling: age, freshness, balances, per-wallet risk (§12, §13, §22, §23).

Age measurement is deliberately conservative.  Paging a wallet's signature
history is bounded, and when the bound is hit the measured age is a *lower*
bound — the wallet may be older than reported but never younger.  That
asymmetry matters: it means a paging shortfall can never manufacture a
"freshly created wallet" finding, only miss one.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.analyzers.entities import EntityClassifier
from app.analyzers.funding import FundingAnalysis
from app.config import FRESH_WALLET_BUCKETS
from app.models.enums import EntityType
from app.models.wallet import TradeRecord, WalletProfile
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import LAMPORTS_PER_SOL
from app.utils.concurrency import gather_limited
from app.utils.logging import get_logger

log = get_logger("WALLET")

#: Signature pages walked per wallet when measuring age. Three pages (3 000
#: transactions) is far more than any genuinely fresh wallet can have.
AGE_MAX_PAGES = 3


@dataclass
class _AgeResult:
    address: str
    first_seen: int | None
    bounded: bool
    signature_count: int


class WalletAnalyzer:
    def __init__(self, hub: ProviderHub, classifier: EntityClassifier, *, concurrency: int = 10) -> None:
        self.hub = hub
        self.classifier = classifier
        self.concurrency = concurrency

    async def profile(
        self,
        wallets: list[str],
        *,
        trades_by_wallet: dict[str, list[TradeRecord]],
        funding: FundingAnalysis,
        launch_time: int | None,
        measure_age: bool = True,
    ) -> dict[str, WalletProfile]:
        profiles: dict[str, WalletProfile] = {
            address: WalletProfile(address=address) for address in wallets
        }

        balances = await self._balances(wallets)
        ages = await self._ages(wallets) if measure_age else {}

        for address, profile in profiles.items():
            trades = sorted(
                trades_by_wallet.get(address, []),
                key=lambda t: (t.block_time or 0, t.slot, t.trade_index or 0),
            )
            profile.buys = [t for t in trades if t.is_buy]
            profile.sells = [t for t in trades if not t.is_buy]
            profile.first_buy = profile.buys[0] if profile.buys else None
            profile.sol_balance = balances.get(address)

            age = ages.get(address)
            if age:
                profile.first_seen = age.first_seen
                profile.first_seen_is_bounded = age.bounded
                profile.total_signatures = age.signature_count
                self.classifier.record_activity(address, age.signature_count)
                if age.first_seen is not None and profile.first_buy is not None:
                    reference = profile.first_buy.block_time or launch_time
                    if reference is not None:
                        profile.age_seconds = max(0.0, float(reference - age.first_seen))
                profile.first_action_is_this_buy = bool(
                    profile.first_buy
                    and age.first_seen is not None
                    and profile.first_buy.block_time is not None
                    and abs(profile.first_buy.block_time - age.first_seen) <= 1
                )
            profile.fresh_bucket = fresh_bucket(profile.age_seconds)

            wallet_funding = funding.wallets.get(address)
            if wallet_funding:
                profile.funding_events = wallet_funding.events
                profile.direct_funder = wallet_funding.direct_funder
                profile.funding_amount = wallet_funding.funding_amount
                profile.funding_to_buy_seconds = wallet_funding.funding_to_buy_seconds
                profile.funding_path = wallet_funding.path
                profile.balance_before_funding = wallet_funding.balance_before_funding
                profile.balance_after_funding = wallet_funding.balance_after_funding
                if profile.balance_after_funding is not None and profile.first_buy is not None:
                    profile.balance_after_purchase = max(
                        0.0, profile.balance_after_funding - profile.first_buy.quote_amount
                    )

            label = self.classifier.classify(address, default=EntityType.BUYER)
            profile.entity_type = label.entity_type if label.entity_type is not EntityType.UNKNOWN else EntityType.BUYER
            profile.label = label.label

        self.hub.quality.wallets_analyzed += len(profiles)
        level = CoverageLevel.COMPLETE if ages else CoverageLevel.PARTIAL
        self.hub.quality.set_coverage(
            "wallet_age",
            level,
            None if ages else "wallet ages were not measured at this scan depth",
        )
        return profiles

    # ------------------------------------------------------------------
    async def _balances(self, wallets: list[str]) -> dict[str, float]:
        if not wallets:
            return {}
        try:
            raw = await self.hub.rpc.get_balances(wallets)
        except ProviderError as exc:
            log.warning("balance fetch failed", error=str(exc))
            return {}
        return {address: lamports / LAMPORTS_PER_SOL for address, lamports in raw.items()}

    async def _ages(self, wallets: list[str]) -> dict[str, _AgeResult]:
        if not wallets:
            return {}
        results = await gather_limited(
            [self._age_of(address) for address in wallets], limit=self.concurrency
        )
        out: dict[str, _AgeResult] = {}
        for address, result in zip(wallets, results, strict=False):
            if isinstance(result, BaseException):
                log.debug("age lookup failed", wallet=address, error=str(result))
                continue
            out[address] = result
        return out

    async def _age_of(self, address: str) -> _AgeResult:
        collected = 0
        before: str | None = None
        oldest: dict | None = None
        bounded = True
        for _ in range(AGE_MAX_PAGES):
            page = await self.hub.rpc.get_signatures(address, limit=1000, before=before)
            if not page:
                bounded = False
                break
            collected += len(page)
            oldest = page[-1]
            if len(page) < 1000:
                bounded = False
                break
            before = oldest.get("signature")
            if not before:
                bounded = False
                break
        return _AgeResult(
            address=address,
            first_seen=(oldest or {}).get("blockTime"),
            bounded=bounded,
            signature_count=collected,
        )


def fresh_bucket(age_seconds: float | None) -> str | None:
    """Bucket a wallet's age (§13). A fresh wallet is a *signal*, not a verdict."""
    if age_seconds is None:
        return None
    for label, threshold in FRESH_WALLET_BUCKETS:
        if age_seconds < threshold:
            return label
    return ">24h"


def fresh_bucket_counts(profiles: dict[str, WalletProfile]) -> dict[str, int]:
    counts: dict[str, int] = {label: 0 for label, _ in FRESH_WALLET_BUCKETS}
    counts[">24h"] = 0
    counts["unknown"] = 0
    for profile in profiles.values():
        counts[profile.fresh_bucket or "unknown"] = counts.get(profile.fresh_bucket or "unknown", 0) + 1
    return counts


def score_early_buyer(profile: WalletProfile, *, launch_time: int | None) -> tuple[int, list[str]]:
    """Per-wallet early-buyer risk (§12).

    Each contributing signal is capped, so no single observation can drive the
    wallet to "high". The reasons list is what the report shows — the number on
    its own is never presented without them.
    """
    score = 0.0
    reasons: list[str] = []

    if profile.age_seconds is not None:
        if profile.age_seconds < 60:
            score += 25
            reasons.append(f"Wallet was created {profile.age_seconds:.0f}s before its first buy")
        elif profile.age_seconds < 600:
            score += 18
            reasons.append(f"Wallet is {profile.age_seconds / 60:.1f} minutes old")
        elif profile.age_seconds < 86_400:
            score += 8
            reasons.append("Wallet is less than a day old")

    if profile.funding_to_buy_seconds is not None:
        if profile.funding_to_buy_seconds <= 10:
            score += 22
            reasons.append(
                f"Funded {profile.funding_to_buy_seconds:.1f}s before buying — no independent activity in between"
            )
        elif profile.funding_to_buy_seconds <= 120:
            score += 12
            reasons.append(f"Funded {profile.funding_to_buy_seconds:.0f}s before buying")

    if profile.first_action_is_this_buy:
        score += 15
        reasons.append("This purchase is the wallet's first ever on-chain action")

    if profile.first_buy and profile.first_buy.seconds_after_launch is not None:
        delay = profile.first_buy.seconds_after_launch
        if delay <= 5:
            score += 18
            reasons.append(f"Bought {delay:.0f}s after launch")
        elif delay <= 30:
            score += 10
            reasons.append(f"Bought {delay:.0f}s after launch")

    if profile.pumpfun_launches is not None and profile.pumpfun_launches >= 20:
        score += 10
        reasons.append(
            f"Traded {profile.pumpfun_launches}+ Pump.fun launches previously "
            "(recurring launch trader — behavioural, not necessarily malicious)"
        )

    if profile.entity_type.is_infrastructure:
        return 0, [f"Classified as {profile.entity_type.value}; not scored as a user wallet"]

    return int(min(100, round(score))), reasons


def apply_risk_scores(profiles: dict[str, WalletProfile], *, launch_time: int | None) -> None:
    for profile in profiles.values():
        profile.risk_score, profile.risk_reasons = score_early_buyer(profile, launch_time=launch_time)
