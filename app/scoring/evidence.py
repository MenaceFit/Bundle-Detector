"""Evidence system (§60, §113).

Evidence comes before the verdict.  Every finding names the wallets it
concerns, carries the transaction signatures that back it, and states its own
caveat — what it does *not* prove.  A finding that cannot be traced to a
signature is still allowed, but it says so, and it is weighted lower.
"""

from __future__ import annotations

from app.analyzers.entities import EntityClassifier
from app.analyzers.funding import FundingAnalysis
from app.analyzers.history import HistoryAnalysis
from app.analyzers.sell_behavior import SellAnalysis
from app.graph.builder import GraphBundle
from app.models.cluster import Cluster
from app.models.scoring import Evidence
from app.models.token import MayhemInfo
from app.models.wallet import CreatorProfile, WalletProfile
from app.utils.addresses import shorten
from app.utils.stats import describe
from app.utils.timefmt import human_duration


def build(
    *,
    cluster: Cluster | None,
    profiles: dict[str, WalletProfile],
    funding: FundingAnalysis,
    graph: GraphBundle,
    classifier: EntityClassifier,
    history: HistoryAnalysis | None = None,
    creator: CreatorProfile | None = None,
    sells: SellAnalysis | None = None,
    mayhem: MayhemInfo | None = None,
) -> list[Evidence]:
    members = cluster.members if cluster else list(profiles)
    member_set = set(members)
    evidence: list[Evidence] = []

    evidence.extend(_funding_evidence(members, member_set, funding, graph, classifier))
    evidence.extend(_timing_evidence(members, profiles, funding))
    evidence.extend(_amount_evidence(members, profiles))
    evidence.extend(_freshness_evidence(members, profiles))
    if history:
        evidence.extend(_history_evidence(member_set, history))
    if creator:
        evidence.extend(_creator_evidence(member_set, creator))
    if sells:
        evidence.extend(_sell_evidence(sells, member_set))
    if mayhem and mayhem.enabled:
        evidence.append(_mayhem_evidence(mayhem))

    evidence.sort(key=lambda e: e.strength, reverse=True)
    return evidence


# ---------------------------------------------------------------------------
def _funding_evidence(
    members: list[str],
    member_set: set[str],
    funding: FundingAnalysis,
    graph: GraphBundle,
    classifier: EntityClassifier,
) -> list[Evidence]:
    out: list[Evidence] = []

    for funder, wallets in graph.private_funder_groups.items():
        shared = sorted(set(wallets) & member_set)
        if len(shared) < 2:
            continue
        signatures = [
            f.events[0].signature
            for w in shared
            if (f := funding.wallets.get(w)) and f.events and f.events[0].signature
        ]
        out.append(
            Evidence(
                code="COMMON_FUNDER",
                title="Common funding source",
                detail=(
                    f"{len(shared)} wallets were funded by {shorten(funder)}, which shows no exchange, "
                    "program or high-fan-out characteristics and therefore looks like a private wallet."
                ),
                wallets=shared,
                signatures=signatures,
                strength=min(1.0, 0.5 + 0.1 * len(shared)),
                caveat=(
                    "Shared funding proves a payment relationship, not common ownership. One person "
                    "funding several friends produces the same pattern."
                ),
            )
        )

    for funder, assessment in graph.infrastructure_funders.items():
        shared = sorted(
            w for w in member_set if (f := funding.wallets.get(w)) and f.direct_funder == funder
        )
        if len(shared) < 2:
            continue
        out.append(
            Evidence(
                code="INFRASTRUCTURE_FUNDER",
                title="Shared funding source is infrastructure (weak signal)",
                detail=(
                    f"{len(shared)} wallets were funded from {assessment.label or shorten(funder)}. "
                    f"{assessment.reason}"
                ),
                wallets=shared,
                signatures=[
                    f.events[0].signature
                    for w in shared
                    if (f := funding.wallets.get(w)) and f.events and f.events[0].signature
                ],
                strength=0.15,
                caveat=(
                    "This is explicitly NOT treated as bundle evidence. Unrelated users routinely "
                    "withdraw from the same exchange."
                ),
            )
        )

    for hop, wallets in graph.intermediary_groups.items():
        shared = sorted(set(wallets) & member_set)
        if len(shared) < 3:
            continue
        out.append(
            Evidence(
                code="COMMON_INTERMEDIARY",
                title="Common intermediary in the funding path",
                detail=(
                    f"{len(shared)} wallets trace back through {shorten(hop)} within the configured "
                    "hop limit, rather than being funded by it directly."
                ),
                wallets=shared,
                signatures=[],
                strength=min(0.9, 0.4 + 0.08 * len(shared)),
                caveat="Multi-hop paths are reconstructed from balance movements and may include unrelated relaying.",
            )
        )

    delays = [
        f.funding_to_buy_seconds
        for m in members
        if (f := funding.wallets.get(m)) and f.funding_to_buy_seconds is not None
    ]
    if len(delays) >= 3:
        stats = describe(delays)
        if stats.maximum <= 60:
            out.append(
                Evidence(
                    code="FUNDING_WINDOW",
                    title="Funding arrived immediately before buying",
                    detail=(
                        f"{len(delays)} wallets bought within {human_duration(stats.maximum)} of being funded "
                        f"(median {human_duration(stats.median)}). None of them did anything else in between."
                    ),
                    wallets=members[: len(delays)],
                    signatures=[
                        f.events[0].signature
                        for m in members
                        if (f := funding.wallets.get(m)) and f.events and f.events[0].signature
                    ][:8],
                    strength=0.75,
                    caveat="Fast funding-to-buy is also normal for a trader topping up a hot wallet to snipe.",
                )
            )
    return out


def _timing_evidence(
    members: list[str], profiles: dict[str, WalletProfile], funding: FundingAnalysis
) -> list[Evidence]:
    entries = [
        (m, profiles[m].first_buy)
        for m in members
        if m in profiles and profiles[m].first_buy and profiles[m].first_buy.block_time
    ]
    if len(entries) < 3:
        return []
    times = sorted(float(t.block_time) for _, t in entries)
    span = times[-1] - times[0]
    if span > 120:
        return []
    return [
        Evidence(
            code="ENTRY_SYNCHRONISATION",
            title="Entries clustered in time",
            detail=f"{len(entries)} wallets made their first purchase within {human_duration(span)} of each other.",
            wallets=[m for m, _ in entries],
            signatures=[t.signature for _, t in entries if t.signature][:10],
            strength=0.7 if span <= 15 else 0.5,
            caveat=(
                "Every sniper targets the same moment, so tight entry timing alone does not distinguish "
                "a bundle from a crowd of independent bots."
            ),
        )
    ]


def _amount_evidence(members: list[str], profiles: dict[str, WalletProfile]) -> list[Evidence]:
    amounts = [
        (m, profiles[m].first_buy.quote_amount)
        for m in members
        if m in profiles and profiles[m].first_buy and profiles[m].first_buy.quote_amount > 0
    ]
    if len(amounts) < 3:
        return []
    stats = describe([a for _, a in amounts])
    if stats.cv > 0.15:
        return []
    return [
        Evidence(
            code="BUY_SIZE_SIMILARITY",
            title="Near-identical purchase sizes",
            detail=(
                f"{len(amounts)} wallets each bought around {stats.median:.4g} "
                f"(coefficient of variation {stats.cv:.3f}, range {stats.spread:.4g})."
            ),
            wallets=[m for m, _ in amounts],
            signatures=[
                profiles[m].first_buy.signature for m, _ in amounts if profiles[m].first_buy.signature
            ][:10],
            strength=0.45,
            caveat=(
                "Round, similar buy sizes are extremely common — this signal alone is explicitly "
                "insufficient to call a bundle."
            ),
        )
    ]


def _freshness_evidence(members: list[str], profiles: dict[str, WalletProfile]) -> list[Evidence]:
    fresh = [
        (m, profiles[m].age_seconds)
        for m in members
        if m in profiles and profiles[m].age_seconds is not None and profiles[m].age_seconds < 3600
    ]
    if len(fresh) < 3:
        return []
    ages = [a for _, a in fresh]
    stats = describe(ages)
    return [
        Evidence(
            code="FRESH_WALLETS",
            title="Wallets created shortly before the launch",
            detail=(
                f"{len(fresh)} wallets were first seen on chain a median of {human_duration(stats.median)} "
                "before their purchase."
            ),
            wallets=[m for m, _ in fresh],
            signatures=[],
            strength=0.4,
            caveat=(
                "A new wallet is a signal, never a verdict: privacy-conscious and first-time users also "
                "create wallets immediately before trading."
            ),
        )
    ]


def _history_evidence(member_set: set[str], history: HistoryAnalysis) -> list[Evidence]:
    out: list[Evidence] = []
    for mint, wallets in history.recurring_groups(min_wallets=3).items():
        shared = sorted(set(wallets) & member_set)
        if len(shared) < 3:
            continue
        out.append(
            Evidence(
                code="REPEATED_CO_PARTICIPATION",
                title="Same wallets appeared together on a previous launch",
                detail=f"{len(shared)} of these wallets also traded Pump.fun coin {shorten(mint)} together.",
                wallets=shared,
                signatures=[],
                strength=min(0.9, 0.45 + 0.1 * len(shared)),
                caveat=(
                    "Active launch traders overlap constantly by chance; repetition is meaningful only "
                    "alongside a funding or timing relationship."
                ),
            )
        )
    return out[:4]


def _creator_evidence(member_set: set[str], creator: CreatorProfile) -> list[Evidence]:
    linked = sorted(set(creator.linked_buyers) & member_set)
    if not linked:
        return []
    paths = [" → ".join(shorten(a) for a in creator.link_paths.get(w, [])) for w in linked[:5]]
    return [
        Evidence(
            code="CREATOR_LINK",
            title="Creator is connected to buyer wallets",
            detail=(
                f"{len(linked)} buyer wallet(s) share a funding relationship with the creator "
                f"{shorten(creator.address)}. Paths: " + "; ".join(p for p in paths if p)
            ),
            wallets=linked,
            signatures=[],
            strength=0.9,
            caveat=(
                "The path is reconstructed from observed value movements. A shared funder does not "
                "establish that the creator controls those wallets."
            ),
        )
    ]


def _sell_evidence(sells, member_set: set[str]) -> list[Evidence]:
    groups = [g for g in sells.synchronized_groups if len(set(g) & member_set) >= 3]
    if not groups:
        return []
    largest = max(groups, key=len)
    shared = sorted(set(largest) & member_set)
    return [
        Evidence(
            code="EXIT_COORDINATION",
            title="Coordinated exit",
            detail=(
                f"{len(shared)} wallets first sold within the same short window, with "
                f"{sells.size_similarity * 100:.0f}% similarity in the proportion of their position sold."
            ),
            wallets=shared,
            signatures=[
                sig for w in shared for sig in sells.exits[w].signatures if w in sells.exits
            ][:10],
            strength=0.8,
            caveat="A sharp price move makes many independent holders exit at once.",
        )
    ]


def _mayhem_evidence(mayhem: MayhemInfo) -> Evidence:
    return Evidence(
        code="MAYHEM_MODE",
        title="Mayhem Mode is active on this launch",
        detail=(
            f"{mayhem.flagged_trades} trade(s) were flagged as Mayhem activity "
            f"(detected via {mayhem.source}). Automated protocol trading may be present."
        ),
        wallets=mayhem.flagged_wallets[:20],
        signatures=[],
        strength=0.0,
        caveat=(
            "Mayhem activity is measured separately and removed from the coordination signals. "
            "Do not read all early trades on this launch as human wallet coordination."
        ),
    )
