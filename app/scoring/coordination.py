"""Coordination sub-scores (§19, §47, §111).

These are reported alongside the bundle score so a reader can see *which kind*
of coordination the engine actually observed.  They are descriptive: unlike the
bundle score they carry no independence rule, because they are not verdicts.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.analyzers.funding import FundingAnalysis
from app.models.cluster import ClusterSignals
from app.models.wallet import WalletProfile
from app.utils.stats import amount_similarity, describe, scale_to_100, timing_similarity


@dataclass
class CoordinationScores:
    funding: int = 0
    buying: int = 0
    temporal: int = 0
    cluster: int = 0
    notes: list[str] | None = None


def funding_coordination(signals: ClusterSignals) -> int:
    """Blend of funder topology and funding pattern.

    Topology is weighted heaviest: *who paid* is a structural fact, while
    matching amounts and timings are its expected side effects.
    """
    value = (
        0.45 * signals.common_funder
        + 0.20 * signals.common_intermediary
        + 0.20 * signals.funding_timing_similarity
        + 0.15 * signals.funding_amount_similarity
    )
    return scale_to_100(value)


def buy_coordination(signals: ClusterSignals) -> int:
    value = 0.6 * signals.buy_timing_similarity + 0.4 * signals.buy_amount_similarity
    return scale_to_100(value)


def temporal_coordination(profiles: list[WalletProfile], *, window_seconds: float = 60.0) -> tuple[int, dict]:
    """Tightness of the group's entries, plus the inter-buy gap statistics (§19)."""
    times = [
        float(p.first_buy.block_time)
        for p in profiles
        if p.first_buy and p.first_buy.block_time is not None
    ]
    if len(times) < 2:
        return 0, {"samples": len(times)}
    score, gaps = timing_similarity(times, window_seconds=window_seconds)
    ordered = sorted(times)
    return scale_to_100(score), {
        "samples": len(times),
        "span_seconds": ordered[-1] - ordered[0],
        "median_gap_seconds": gaps.median,
        "max_gap_seconds": gaps.maximum,
    }


def funding_window_stats(funding: FundingAnalysis, members: list[str]) -> dict:
    """Funding→buy delay distribution (§15)."""
    delays = [
        f.funding_to_buy_seconds
        for m in members
        if (f := funding.wallets.get(m)) and f.funding_to_buy_seconds is not None
    ]
    distribution = describe(delays)
    return {
        **distribution.as_dict(),
        "samples": [
            {"wallet": m, "seconds_before_buy": funding.wallets[m].funding_to_buy_seconds}
            for m in members
            if m in funding.wallets and funding.wallets[m].funding_to_buy_seconds is not None
        ][:10],
    }


def funding_amount_stats(funding: FundingAnalysis, members: list[str]) -> dict:
    """Funding size distribution (§16) — mean, median, stdev, CV, range, percentiles."""
    amounts = [
        f.funding_amount for m in members if (f := funding.wallets.get(m)) and f.funding_amount
    ]
    similarity, distribution = amount_similarity(amounts)
    return {**distribution.as_dict(), "similarity": similarity}


def purchase_amount_stats(profiles: list[WalletProfile]) -> dict:
    amounts = [p.first_buy.quote_amount for p in profiles if p.first_buy and p.first_buy.quote_amount > 0]
    similarity, distribution = amount_similarity(amounts)
    return {**distribution.as_dict(), "similarity": similarity}


def wallet_age_stats(profiles: list[WalletProfile]) -> dict:
    ages = [p.age_seconds for p in profiles if p.age_seconds is not None]
    similarity, distribution = amount_similarity(ages, cv_identical=0.05, cv_unrelated=1.0)
    return {**distribution.as_dict(), "similarity": similarity}
