"""Sell-side behaviour and exit coordination (§68, §70).

Buying together is one signal; *leaving* together is a much harder one to
produce by coincidence.  Independent traders exit on their own triggers —
price, time, news — and their exits scatter.  A group that dumps inside the
same few seconds, in similar proportions, is behaving like one hand.

The analyzer measures three things and keeps them separate:

* whether a wallet sold at all, and how much of its position;
* how long it held;
* how tightly the group's exits cluster in time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.wallet import WalletProfile
from app.utils.logging import get_logger
from app.utils.stats import amount_similarity, describe, timing_similarity

log = get_logger("CLUSTER")

#: Window within which exits are considered "together".
EXIT_WINDOW_SECONDS = 120.0


@dataclass
class WalletExit:
    wallet: str
    first_sell_time: int | None
    hold_seconds: float | None
    sold_fraction: float
    exit_kind: str  # "full", "partial", "holding"
    signatures: list[str] = field(default_factory=list)


@dataclass
class SellAnalysis:
    exits: dict[str, WalletExit] = field(default_factory=dict)
    #: 0-1 coordination of the observed exits.
    coordination: float = 0.0
    timing_similarity: float = 0.0
    size_similarity: float = 0.0
    sellers: int = 0
    holders: int = 0
    median_hold_seconds: float | None = None
    #: Groups of wallets that sold inside the same window.
    synchronized_groups: list[list[str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def analyze_sells(profiles: dict[str, WalletProfile], *, members: list[str] | None = None) -> SellAnalysis:
    analysis = SellAnalysis()
    targets = members or list(profiles)
    considered = [profiles[w] for w in targets if w in profiles]
    if not considered:
        return analysis

    for profile in considered:
        bought = sum(t.token_amount for t in profile.buys)
        sold = sum(t.token_amount for t in profile.sells)
        fraction = (sold / bought) if bought > 0 else 0.0
        first_sell = profile.sells[0] if profile.sells else None
        hold = None
        if first_sell and profile.first_buy and first_sell.block_time and profile.first_buy.block_time:
            hold = float(first_sell.block_time - profile.first_buy.block_time)
        analysis.exits[profile.address] = WalletExit(
            wallet=profile.address,
            first_sell_time=first_sell.block_time if first_sell else None,
            hold_seconds=hold,
            sold_fraction=min(1.0, fraction),
            exit_kind="full" if fraction >= 0.95 else "partial" if fraction > 0.01 else "holding",
            signatures=[t.signature for t in profile.sells][:5],
        )

    sellers = [e for e in analysis.exits.values() if e.exit_kind != "holding"]
    analysis.sellers = len(sellers)
    analysis.holders = len(analysis.exits) - len(sellers)

    holds = [e.hold_seconds for e in analysis.exits.values() if e.hold_seconds is not None]
    analysis.median_hold_seconds = describe(holds).median if holds else None

    sell_times = [float(e.first_sell_time) for e in sellers if e.first_sell_time is not None]
    if len(sell_times) >= 2:
        analysis.timing_similarity, _ = timing_similarity(sell_times, window_seconds=EXIT_WINDOW_SECONDS)
        analysis.synchronized_groups = _group_by_window(
            [(e.wallet, float(e.first_sell_time)) for e in sellers if e.first_sell_time is not None],
            window=EXIT_WINDOW_SECONDS,
        )

    fractions = [e.sold_fraction for e in sellers]
    if len(fractions) >= 2:
        analysis.size_similarity, _ = amount_similarity(fractions)

    if len(sellers) >= 2:
        # Coordination needs both dimensions: same moment *and* same proportion.
        # Either alone is common in a falling market.
        analysis.coordination = analysis.timing_similarity * (0.6 + 0.4 * analysis.size_similarity)
        largest = max((len(g) for g in analysis.synchronized_groups), default=0)
        if largest >= 3:
            analysis.notes.append(
                f"{largest} wallets first sold within {EXIT_WINDOW_SECONDS:.0f}s of each other"
            )
    elif analysis.sellers == 0:
        analysis.notes.append("No sells observed yet for the wallets analysed")

    return analysis


def _group_by_window(entries: list[tuple[str, float]], *, window: float) -> list[list[str]]:
    """Cluster wallets whose exits fall inside a rolling time window."""
    ordered = sorted(entries, key=lambda item: item[1])
    groups: list[list[str]] = []
    current: list[str] = []
    anchor: float | None = None
    for wallet, timestamp in ordered:
        if anchor is None or timestamp - anchor <= window:
            if anchor is None:
                anchor = timestamp
            current.append(wallet)
        else:
            if len(current) > 1:
                groups.append(current)
            current = [wallet]
            anchor = timestamp
    if len(current) > 1:
        groups.append(current)
    return groups


def post_graduation_behavior(
    profiles: dict[str, WalletProfile], *, graduation_time: int | None
) -> dict[str, list[str]]:
    """Split wallets by what they did after graduation (§70)."""
    result: dict[str, list[str]] = {"sold_after": [], "held": [], "sold_before": []}
    if graduation_time is None:
        return result
    for address, profile in profiles.items():
        sells_after = [t for t in profile.sells if (t.block_time or 0) >= graduation_time]
        sells_before = [t for t in profile.sells if (t.block_time or 0) < graduation_time]
        if sells_after:
            result["sold_after"].append(address)
        elif sells_before:
            result["sold_before"].append(address)
        else:
            result["held"].append(address)
    return result
