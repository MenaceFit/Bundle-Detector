"""Wallet fingerprints (§64).

A fingerprint is a coarse, bucketed description of *how a wallet behaves*
rather than which address it is.  Bundlers rotate addresses freely but rarely
change their operating pattern — same funding size, same entry timing, same
hold duration — so a fingerprint keeps matching after the addresses change.

Everything is bucketed deliberately.  Exact values would make every wallet
unique and the fingerprint useless; buckets are what let two different
addresses collide when they are run the same way.
"""

from __future__ import annotations

from app.models.wallet import WalletFingerprint, WalletProfile


def build(profile: WalletProfile, *, hold_seconds: float | None = None, sold_fraction: float = 0.0) -> WalletFingerprint:
    return WalletFingerprint(
        address=profile.address,
        age_bucket=_age_bucket(profile.age_seconds),
        funding_bucket=_amount_bucket(profile.funding_amount),
        entry_timing_bucket=_entry_bucket(
            profile.first_buy.seconds_after_launch if profile.first_buy else None
        ),
        entry_size_bucket=_amount_bucket(profile.first_buy.quote_amount if profile.first_buy else None),
        holding_bucket=_hold_bucket(hold_seconds),
        sell_behavior=_sell_behavior(sold_fraction, bool(profile.sells)),
        launch_frequency_bucket=_frequency_bucket(profile.pumpfun_launches),
    )


def similarity_matrix(fingerprints: dict[str, WalletFingerprint]) -> dict[tuple[str, str], float]:
    addresses = sorted(fingerprints)
    matrix: dict[tuple[str, str], float] = {}
    for i, a in enumerate(addresses):
        for b in addresses[i + 1 :]:
            matrix[(a, b)] = fingerprints[a].similarity(fingerprints[b])
    return matrix


def _age_bucket(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    if seconds < 60:
        return "seconds"
    if seconds < 3_600:
        return "minutes"
    if seconds < 86_400:
        return "hours"
    if seconds < 604_800:
        return "days"
    return "weeks+"


def _amount_bucket(amount: float | None) -> str:
    if amount is None or amount <= 0:
        return "unknown"
    if amount < 0.1:
        return "dust"
    if amount < 0.5:
        return "small"
    if amount < 2:
        return "medium"
    if amount < 10:
        return "large"
    return "whale"


def _entry_bucket(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    if seconds <= 5:
        return "instant"
    if seconds <= 30:
        return "ultra_early"
    if seconds <= 300:
        return "early"
    if seconds <= 1_800:
        return "mid"
    return "late"


def _hold_bucket(seconds: float | None) -> str:
    if seconds is None:
        return "holding"
    if seconds < 60:
        return "flip"
    if seconds < 900:
        return "short"
    if seconds < 86_400:
        return "day"
    return "long"


def _sell_behavior(sold_fraction: float, has_sells: bool) -> str:
    if not has_sells:
        return "none"
    if sold_fraction >= 0.95:
        return "full_exit"
    if sold_fraction >= 0.4:
        return "majority_exit"
    return "partial_exit"


def _frequency_bucket(launches: int | None) -> str:
    if launches is None:
        return "unknown"
    if launches == 0:
        return "first_time"
    if launches < 5:
        return "occasional"
    if launches < 20:
        return "regular"
    if launches < 100:
        return "frequent"
    return "industrial"
