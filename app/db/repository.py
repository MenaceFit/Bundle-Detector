"""Persistence helpers.

Two responsibilities:

* write a completed scan down (tokens, trades, funding, clusters, scores);
* read the *cross-launch memory* back — which launches a wallet has traded, and
  which cluster fingerprints have been seen before.

Every function tolerates a ``None`` session so callers never have to branch on
whether persistence is configured.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Alert,
    ClusterMember,
    ClusterRow,
    Creator,
    CreatorLaunch,
    FundingEventRow,
    Launch,
    RiskScore,
    ScanJob,
    Token,
    Trade,
    Wallet,
    WalletLaunchHistory,
    WalletRelationship,
    WatchSubscription,
)
from app.models.cluster import ClusterFingerprint
from app.models.scoring import ScanReport
from app.utils.logging import get_logger

log = get_logger("DB")


async def save_report(session: AsyncSession | None, report: ScanReport) -> None:
    """Persist a completed scan. Never raises — persistence is best-effort."""
    if session is None:
        return
    try:
        await _save_token(session, report)
        await _save_wallets(session, report)
        await _save_trades(session, report)
        await _save_funding(session, report)
        await _save_clusters(session, report)
        await _save_scores(session, report)
        await session.flush()
    except Exception as exc:  # noqa: BLE001
        log.warning("save_report failed", mint=report.mint, error=str(exc))


async def _save_token(session: AsyncSession, report: ScanReport) -> None:
    token = report.token
    row = await session.get(Token, token.mint)
    if row is None:
        row = Token(mint=token.mint)
        session.add(row)
    row.name = token.name
    row.symbol = token.symbol
    row.creator = token.creator
    row.creation_time = token.creation_time
    row.creation_signature = token.creation_signature
    row.bonding_curve = token.bonding_curve
    row.pair = token.pair.value
    row.quote_mint = token.quote_mint
    row.decimals = token.decimals
    row.initial_supply = token.initial_supply
    row.lifecycle = token.lifecycle.value
    row.mayhem_enabled = token.mayhem.enabled
    row.metadata_uri = token.metadata_uri

    launch = (
        await session.execute(select(Launch).where(Launch.mint == token.mint))
    ).scalar_one_or_none()
    if launch is None:
        launch = Launch(mint=token.mint)
        session.add(launch)
    launch.creator = token.creator
    launch.created_at = token.creation_time
    launch.graduated = token.graduation.graduated
    launch.graduation_time = token.graduation.graduation_time
    launch.graduation_signature = token.graduation.graduation_signature
    launch.pumpswap_pool = token.graduation.pumpswap_pool
    launch.progress = token.graduation.progress

    if token.creator:
        creator = await session.get(Creator, token.creator)
        if creator is None:
            creator = Creator(address=token.creator)
            session.add(creator)
        if report.creator:
            creator.launches_total = report.creator.launches_total
            creator.launches_graduated = report.creator.launches_graduated
            creator.launches_abandoned = report.creator.launches_abandoned
            creator.funding_source = report.creator.funding_source
            creator.risk_score = report.creator.risk_score
            for mint in report.creator.previous_launches:
                await _upsert_creator_launch(session, token.creator, mint)
        await _upsert_creator_launch(session, token.creator, token.mint)


async def _upsert_creator_launch(session: AsyncSession, creator: str, mint: str) -> None:
    existing = (
        await session.execute(
            select(CreatorLaunch).where(CreatorLaunch.creator == creator, CreatorLaunch.mint == mint)
        )
    ).scalar_one_or_none()
    if existing is None:
        session.add(CreatorLaunch(creator=creator, mint=mint))


async def _save_wallets(session: AsyncSession, report: ScanReport) -> None:
    for profile in report.wallets:
        row = await session.get(Wallet, profile.address)
        if row is None:
            row = Wallet(address=profile.address)
            session.add(row)
        row.entity_type = profile.entity_type.value
        row.label = profile.label
        row.first_seen = profile.first_seen
        row.first_seen_is_bounded = profile.first_seen_is_bounded
        row.total_signatures = profile.total_signatures
        row.pumpfun_launches = profile.pumpfun_launches

        if profile.first_buy:
            await _upsert_wallet_launch(session, report.mint, profile)


async def _upsert_wallet_launch(session: AsyncSession, mint: str, profile) -> None:
    existing = (
        await session.execute(
            select(WalletLaunchHistory).where(
                WalletLaunchHistory.wallet == profile.address, WalletLaunchHistory.mint == mint
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = WalletLaunchHistory(wallet=profile.address, mint=mint)
        session.add(existing)
    existing.first_buy_time = profile.first_buy.block_time
    existing.seconds_after_launch = profile.first_buy.seconds_after_launch
    existing.quote_amount = profile.first_buy.quote_amount
    existing.sold = bool(profile.sells)


async def _save_trades(session: AsyncSession, report: ScanReport) -> None:
    seen: set[tuple[str, str, str, bool]] = set()
    for profile in report.wallets:
        for trade in [*profile.buys, *profile.sells]:
            key = (trade.signature, trade.wallet, report.mint, trade.is_buy)
            if not trade.signature or key in seen:
                continue
            seen.add(key)
            exists = (
                await session.execute(
                    select(Trade.id).where(
                        Trade.signature == trade.signature,
                        Trade.wallet == trade.wallet,
                        Trade.mint == report.mint,
                        Trade.is_buy == trade.is_buy,
                    )
                )
            ).first()
            if exists:
                continue
            session.add(
                Trade(
                    signature=trade.signature,
                    mint=report.mint,
                    wallet=trade.wallet,
                    is_buy=trade.is_buy,
                    quote_amount=trade.quote_amount,
                    token_amount=trade.token_amount,
                    slot=trade.slot,
                    block_time=trade.block_time,
                    seconds_after_launch=trade.seconds_after_launch,
                    venue=trade.venue,
                    mayhem=trade.mayhem,
                )
            )


async def _save_funding(session: AsyncSession, report: ScanReport) -> None:
    for profile in report.wallets:
        for event in profile.funding_events[:3]:
            if not event.signature:
                continue
            exists = (
                await session.execute(
                    select(FundingEventRow.id).where(
                        FundingEventRow.signature == event.signature,
                        FundingEventRow.recipient == event.recipient,
                    )
                )
            ).first()
            if exists:
                continue
            session.add(
                FundingEventRow(
                    recipient=event.recipient,
                    source=event.source,
                    signature=event.signature,
                    amount=event.amount,
                    asset=event.asset,
                    block_time=event.block_time,
                    seconds_before_buy=event.seconds_before_buy,
                    hop=event.hop,
                    mint=report.mint,
                )
            )
        if profile.direct_funder:
            await _upsert_relationship(
                session, profile.direct_funder, profile.address, "FUNDED", 1.0, report.mint
            )


async def _upsert_relationship(
    session: AsyncSession, source: str, target: str, relation: str, weight: float, mint: str | None
) -> None:
    exists = (
        await session.execute(
            select(WalletRelationship.id).where(
                WalletRelationship.source == source,
                WalletRelationship.target == target,
                WalletRelationship.relation == relation,
                WalletRelationship.mint == mint,
            )
        )
    ).first()
    if not exists:
        session.add(
            WalletRelationship(
                source=source, target=target, relation=relation, weight=weight, mint=mint
            )
        )


async def _save_clusters(session: AsyncSession, report: ScanReport) -> None:
    await session.execute(
        delete(ClusterMember).where(
            ClusterMember.cluster_id.in_(select(ClusterRow.id).where(ClusterRow.mint == report.mint))
        )
    )
    await session.execute(delete(ClusterRow).where(ClusterRow.mint == report.mint))
    for cluster in report.clusters:
        row = ClusterRow(
            mint=report.mint,
            cluster_index=cluster.cluster_id,
            score=cluster.score,
            confidence=cluster.confidence,
            method=cluster.method,
            signals=cluster.signals.as_dict(),
            fingerprint=None,
            members_hash=None,
        )
        session.add(row)
        await session.flush()
        for member in cluster.members:
            session.add(ClusterMember(cluster_id=row.id, wallet=member))


async def _save_scores(session: AsyncSession, report: ScanReport) -> None:
    risk = report.risk
    session.add(
        RiskScore(
            mint=report.mint,
            bundle_score=risk.bundle.score,
            coordination_score=max(risk.funding_coordination, risk.buy_coordination),
            wallet_cluster_score=risk.wallet_cluster,
            creator_score=risk.dev_risk,
            overall_risk=risk.overall_risk,
            confidence=risk.confidence.score,
            classification=risk.classification.value,
            breakdown=risk.bundle.model_dump(),
        )
    )


async def store_cluster_fingerprint(
    session: AsyncSession | None, mint: str, cluster_index: int, fingerprint: ClusterFingerprint
) -> None:
    if session is None:
        return
    try:
        row = (
            await session.execute(
                select(ClusterRow).where(
                    ClusterRow.mint == mint, ClusterRow.cluster_index == cluster_index
                )
            )
        ).scalar_one_or_none()
    except Exception as exc:  # noqa: BLE001
        log.debug("fingerprint store skipped", error=str(exc))
        return
    if row is None:
        return
    row.fingerprint = fingerprint.model_dump()
    row.members_hash = fingerprint.members_hash


# ---------------------------------------------------------------------------
# Cross-launch reads (§63)
# ---------------------------------------------------------------------------
async def known_cluster_fingerprints(
    session: AsyncSession | None, *, exclude_mint: str, limit: int = 500
) -> list[tuple[str, ClusterFingerprint]]:
    """Previously stored cluster fingerprints, for recurring-cluster matching.

    Returns an empty list when the store is unavailable or has not been
    migrated yet — a missing memory is a missing *signal*, never an error.
    """
    if session is None:
        return []
    try:
        rows = (
            await session.execute(
                select(ClusterRow)
                .where(ClusterRow.mint != exclude_mint, ClusterRow.fingerprint.is_not(None))
                .order_by(ClusterRow.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    except Exception as exc:  # noqa: BLE001 - reads must never break a scan
        log.debug("fingerprint lookup unavailable", error=str(exc))
        return []
    out: list[tuple[str, ClusterFingerprint]] = []
    for row in rows:
        try:
            out.append((row.mint, ClusterFingerprint.model_validate(row.fingerprint)))
        except Exception:  # noqa: BLE001 - schema drift on old rows
            continue
    return out


async def wallet_launch_counts(
    session: AsyncSession | None, wallets: list[str]
) -> dict[str, list[str]]:
    """wallet -> mints it has been recorded on by previous scans."""
    if session is None or not wallets:
        return {}
    rows = (
        await session.execute(
            select(WalletLaunchHistory.wallet, WalletLaunchHistory.mint).where(
                WalletLaunchHistory.wallet.in_(wallets)
            )
        )
    ).all()
    out: dict[str, list[str]] = {}
    for wallet, mint in rows:
        out.setdefault(wallet, []).append(mint)
    return out


async def creator_launch_history(session: AsyncSession | None, creator: str) -> list[str]:
    if session is None:
        return []
    rows = (
        await session.execute(select(CreatorLaunch.mint).where(CreatorLaunch.creator == creator))
    ).scalars()
    return list(rows)


async def recent_scores(session: AsyncSession | None, mint: str, limit: int = 5) -> list[RiskScore]:
    if session is None:
        return []
    rows = (
        await session.execute(
            select(RiskScore)
            .where(RiskScore.mint == mint)
            .order_by(RiskScore.created_at.desc())
            .limit(limit)
        )
    ).scalars()
    return list(rows)


# ---------------------------------------------------------------------------
# Jobs, watches, alerts
# ---------------------------------------------------------------------------
async def create_job(
    session: AsyncSession | None, mint: str, depth: str, requested_by: str | None
) -> int | None:
    if session is None:
        return None
    job = ScanJob(mint=mint, depth=depth, status="queued", requested_by=requested_by)
    session.add(job)
    await session.flush()
    return job.id


async def update_job(
    session: AsyncSession | None,
    job_id: int | None,
    *,
    status: str,
    error: str | None = None,
    duration: float | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    if session is None or job_id is None:
        return
    job = await session.get(ScanJob, job_id)
    if job is None:
        return
    job.status = status
    job.error = error
    job.duration_seconds = duration
    job.result = result
    if status in {"completed", "failed"}:
        from datetime import UTC, datetime

        job.finished_at = datetime.now(UTC)


async def add_watch(
    session: AsyncSession | None, mint: str, channel_id: int, requested_by: str | None
) -> bool:
    if session is None:
        return False
    existing = (
        await session.execute(
            select(WatchSubscription).where(
                WatchSubscription.mint == mint, WatchSubscription.channel_id == channel_id
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.active = True
        return False
    session.add(
        WatchSubscription(mint=mint, channel_id=channel_id, requested_by=requested_by, active=True)
    )
    return True


async def active_watches(session: AsyncSession | None) -> list[WatchSubscription]:
    if session is None:
        return []
    try:
        rows = (
            await session.execute(select(WatchSubscription).where(WatchSubscription.active.is_(True)))
        ).scalars()
    except Exception as exc:  # noqa: BLE001
        log.debug("watch lookup unavailable", error=str(exc))
        return []
    return list(rows)


async def stop_watch(session: AsyncSession | None, mint: str, channel_id: int) -> bool:
    if session is None:
        return False
    existing = (
        await session.execute(
            select(WatchSubscription).where(
                WatchSubscription.mint == mint, WatchSubscription.channel_id == channel_id
            )
        )
    ).scalar_one_or_none()
    if not existing:
        return False
    existing.active = False
    return True


async def record_alert(
    session: AsyncSession | None,
    *,
    mint: str,
    level: str,
    bundle_score: int,
    confidence: int,
    reason: str,
    channel_id: int | None,
) -> None:
    if session is None:
        return
    session.add(
        Alert(
            mint=mint,
            level=level,
            bundle_score=bundle_score,
            confidence=confidence,
            reason=reason,
            channel_id=channel_id,
        )
    )


async def stats(session: AsyncSession | None) -> dict[str, int]:
    if session is None:
        return {}

    async def count(model) -> int:
        return int((await session.execute(select(func.count()).select_from(model))).scalar() or 0)

    try:
        return {
            "tokens": await count(Token),
            "wallets": await count(Wallet),
            "clusters": await count(ClusterRow),
            "wallet_launch_history": await count(WalletLaunchHistory),
            "scans": await count(RiskScore),
        }
    except Exception as exc:  # noqa: BLE001
        log.debug("stats unavailable", error=str(exc))
        return {}
