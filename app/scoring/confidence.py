"""Confidence engine (§48, §49, §86).

Confidence answers a different question from the bundle score: not "how
coordinated does this look" but "how much should you trust that number".

It is built from five factors, all multiplicative in effect:

``sample``       how many wallets were analysed
``coverage``     how much of the needed data was actually retrievable
``providers``    how healthy the providers were during the scan
``coherence``    whether the signals agree with each other
``history``      how deep the historical lookback went

A high bundle score with thin data is reported as exactly that — a high score
with low confidence — rather than being quietly suppressed or quietly trusted.
"""

from __future__ import annotations

from app.config import ScoringConfig
from app.models.cluster import ClusterSignals
from app.models.scoring import ConfidenceReport
from app.providers.base import DataQuality
from app.utils.stats import clamp, logistic_confidence, normalized_entropy, scale_to_100

#: Hard ceiling applied when fewer wallets than `low_data_wallet_threshold`
#: were analysed. 0.49 keeps the result inside the LOW band (< 50).
SMALL_SAMPLE_CEILING = 0.49


def compute(
    *,
    wallets_analyzed: int,
    signals: ClusterSignals | None,
    quality: DataQuality,
    history_coverage: float,
    contradictions: list[str] | None = None,
    config: ScoringConfig | None = None,
) -> ConfidenceReport:
    config = config or ScoringConfig()
    contradictions = contradictions or []

    sample = logistic_confidence(
        wallets_analyzed,
        midpoint=(config.low_data_wallet_threshold + config.high_data_wallet_threshold) / 2.0,
        steepness=0.30,
    )
    coverage = clamp(_coverage_score(quality))
    providers = clamp(_provider_score(quality))
    coherence = clamp(_coherence(signals))
    history = clamp(history_coverage)

    factors = {
        "sample_size": round(sample, 3),
        "data_coverage": round(coverage, 3),
        "provider_health": round(providers, 3),
        "signal_coherence": round(coherence, 3),
        "history_depth": round(history, 3),
    }

    # Weighted mean; coverage and sample size dominate because everything else
    # is computed *from* them.
    weighted = (
        0.30 * sample + 0.28 * coverage + 0.17 * providers + 0.15 * coherence + 0.10 * history
    )
    penalty = min(0.35, 0.12 * len(contradictions))
    score = clamp(weighted - penalty)

    limitations: list[str] = []
    if wallets_analyzed < config.low_data_wallet_threshold:
        # §86: a handful of wallets can never support a confident group verdict,
        # however clean the data for those few wallets happens to be. Perfect
        # coverage of a tiny sample is still a tiny sample, so the score is
        # capped into the LOW band rather than merely nudged down.
        score = min(score, SMALL_SAMPLE_CEILING)
        limitations.append(
            f"Only {wallets_analyzed} wallet(s) could be analysed — too few for a reliable group judgement."
        )
    if coverage < 0.7:
        limitations.extend(
            f"{key.replace('_', ' ')}: {level.value}"
            for key, level in quality.coverage.items()
            if level.weight < 1.0
        )
    if history < 0.5:
        limitations.append("Historical Pump.fun lookback was shallow; repeat-behaviour signals are weak.")
    limitations.extend(contradictions)

    return ConfidenceReport(
        score=scale_to_100(score),
        level=level_for(scale_to_100(score)),
        factors=factors,
        limitations=limitations,
    )


def level_for(score: int) -> str:
    if score >= 75:
        return "HIGH"
    if score >= 50:
        return "MEDIUM"
    if score >= 25:
        return "LOW"
    return "VERY LOW"


def _coverage_score(quality: DataQuality) -> float:
    if not quality.coverage:
        return 0.0
    return sum(level.weight for level in quality.coverage.values()) / len(quality.coverage)


def _provider_score(quality: DataQuality) -> float:
    used = [h for h in quality.providers.values() if h.requests > 0]
    if not used:
        return 0.0
    return sum(h.success_rate for h in used) / len(used)


def _coherence(signals: ClusterSignals | None) -> float:
    """Do the signals tell a consistent story?

    A few strong signals and many zeros is a *sharper* finding than a uniform
    grey smear across every signal, which usually means noise.  Entropy over
    the non-zero signals captures that: low entropy (concentrated) reads as
    coherent, high entropy (evenly spread weak values) reads as noise.
    """
    if signals is None:
        return 0.0
    values = [v for v in signals.as_dict().values() if v > 0.05]
    if not values:
        return 0.0
    if len(values) == 1:
        return 0.35
    strength = sum(values) / len(values)
    concentration = 1.0 - normalized_entropy(values)
    return clamp(0.6 * strength + 0.4 * concentration)


def detect_contradictions(
    *,
    signals: ClusterSignals | None,
    infrastructure_funder: bool,
    mayhem_enabled: bool,
    unobserved_funding_share: float,
    bounded_ages: int,
) -> list[str]:
    """Facts that actively argue against the coordination reading."""
    out: list[str] = []
    if infrastructure_funder:
        out.append(
            "The shared funding source looks like an exchange or shared service, which is a common "
            "explanation for unrelated wallets sharing a funder."
        )
    if mayhem_enabled:
        out.append(
            "Mayhem Mode was active on this launch; part of the early activity may be protocol-driven "
            "rather than human."
        )
    if unobserved_funding_share > 0.4:
        out.append(
            f"Funding history was unreadable for {unobserved_funding_share * 100:.0f}% of the wallets."
        )
    if bounded_ages:
        out.append(
            f"{bounded_ages} wallet age(s) hit the history paging limit and are reported as lower bounds."
        )
    if signals and signals.common_funder == 0 and signals.buy_amount_similarity > 0.8:
        out.append(
            "Buy sizes are very similar but no shared funding source was found — similar sizing alone is "
            "a weak signal and is common among independent snipers using the same preset."
        )
    return out
