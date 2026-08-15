"""Database schema (§62, §63, §100).

The cross-launch tables are the reason this database exists.  A single scan can
be computed entirely from RPC; what it *cannot* do is answer "have these
wallets done this together before?".  ``wallet_launch_history`` and
``cluster_fingerprints`` accumulate that memory across scans, which is what
turns the tool from a snapshot into an intelligence engine.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Token(Base):
    __tablename__ = "tokens"

    mint: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(128))
    symbol: Mapped[str | None] = mapped_column(String(32))
    creator: Mapped[str | None] = mapped_column(String(64), index=True)
    creation_time: Mapped[int | None] = mapped_column(BigInteger, index=True)
    creation_signature: Mapped[str | None] = mapped_column(String(128))
    bonding_curve: Mapped[str | None] = mapped_column(String(64))
    pair: Mapped[str] = mapped_column(String(16), default="SOL")
    quote_mint: Mapped[str | None] = mapped_column(String(64))
    decimals: Mapped[int | None] = mapped_column(Integer)
    initial_supply: Mapped[int | None] = mapped_column(BigInteger)
    lifecycle: Mapped[str] = mapped_column(String(32), default="BONDING_CURVE")
    mayhem_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    metadata_uri: Mapped[str | None] = mapped_column(Text)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    launches: Mapped[list[Launch]] = relationship(back_populates="token", cascade="all, delete-orphan")


class Launch(Base):
    """A token's launch record, including graduation facts."""

    __tablename__ = "launches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(ForeignKey("tokens.mint", ondelete="CASCADE"), index=True)
    creator: Mapped[str | None] = mapped_column(String(64), index=True)
    created_at: Mapped[int | None] = mapped_column(BigInteger)
    graduated: Mapped[bool] = mapped_column(Boolean, default=False)
    graduation_time: Mapped[int | None] = mapped_column(BigInteger)
    graduation_signature: Mapped[str | None] = mapped_column(String(128))
    pumpswap_pool: Mapped[str | None] = mapped_column(String(64))
    progress: Mapped[float | None] = mapped_column(Float)

    token: Mapped[Token] = relationship(back_populates="launches")

    __table_args__ = (UniqueConstraint("mint", name="uq_launch_mint"),)


class Creator(Base):
    __tablename__ = "creators"

    address: Mapped[str] = mapped_column(String(64), primary_key=True)
    launches_total: Mapped[int] = mapped_column(Integer, default=0)
    launches_graduated: Mapped[int] = mapped_column(Integer, default=0)
    launches_abandoned: Mapped[int] = mapped_column(Integer, default=0)
    funding_source: Mapped[str | None] = mapped_column(String(64), index=True)
    risk_score: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class CreatorLaunch(Base):
    __tablename__ = "creator_launches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    creator: Mapped[str] = mapped_column(String(64), index=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[int | None] = mapped_column(BigInteger)
    graduated: Mapped[bool | None] = mapped_column(Boolean)

    __table_args__ = (UniqueConstraint("creator", "mint", name="uq_creator_launch"),)


class BondingCurveState(Base):
    __tablename__ = "bonding_curves"

    address: Mapped[str] = mapped_column(String(64), primary_key=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    complete: Mapped[bool] = mapped_column(Boolean, default=False)
    virtual_quote_reserves: Mapped[int | None] = mapped_column(BigInteger)
    virtual_token_reserves: Mapped[int | None] = mapped_column(BigInteger)
    real_quote_reserves: Mapped[int | None] = mapped_column(BigInteger)
    real_token_reserves: Mapped[int | None] = mapped_column(BigInteger)
    quote_mint: Mapped[str | None] = mapped_column(String(64))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Pool(Base):
    __tablename__ = "pools"

    address: Mapped[str] = mapped_column(String(64), primary_key=True)
    base_mint: Mapped[str] = mapped_column(String(64), index=True)
    quote_mint: Mapped[str | None] = mapped_column(String(64))
    coin_creator: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[int | None] = mapped_column(BigInteger)
    is_mayhem_mode: Mapped[bool] = mapped_column(Boolean, default=False)


class Wallet(Base):
    __tablename__ = "wallets"

    address: Mapped[str] = mapped_column(String(64), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32), default="UNKNOWN", index=True)
    label: Mapped[str | None] = mapped_column(String(128))
    first_seen: Mapped[int | None] = mapped_column(BigInteger)
    first_seen_is_bounded: Mapped[bool] = mapped_column(Boolean, default=False)
    total_signatures: Mapped[int | None] = mapped_column(Integer)
    pumpfun_launches: Mapped[int | None] = mapped_column(Integer)
    fingerprint: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class WalletLaunchHistory(Base):
    """wallet -> launch participation. The backbone of cross-launch analysis."""

    __tablename__ = "wallet_launch_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    wallet: Mapped[str] = mapped_column(String(64), index=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    first_buy_time: Mapped[int | None] = mapped_column(BigInteger)
    seconds_after_launch: Mapped[float | None] = mapped_column(Float)
    quote_amount: Mapped[float | None] = mapped_column(Float)
    entry_depth: Mapped[float | None] = mapped_column(Float)
    sold: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        UniqueConstraint("wallet", "mint", name="uq_wallet_launch"),
        Index("ix_wallet_launch_mint_wallet", "mint", "wallet"),
    )


class Transaction(Base):
    __tablename__ = "transactions"

    signature: Mapped[str] = mapped_column(String(128), primary_key=True)
    slot: Mapped[int] = mapped_column(BigInteger, index=True)
    block_time: Mapped[int | None] = mapped_column(BigInteger, index=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    fee_payer: Mapped[str | None] = mapped_column(String(64), index=True)
    programs: Mapped[dict | None] = mapped_column(JSON)


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    signature: Mapped[str] = mapped_column(String(128), index=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    wallet: Mapped[str] = mapped_column(String(64), index=True)
    is_buy: Mapped[bool] = mapped_column(Boolean, default=True)
    quote_amount: Mapped[float] = mapped_column(Float, default=0.0)
    token_amount: Mapped[float] = mapped_column(Float, default=0.0)
    slot: Mapped[int] = mapped_column(BigInteger, default=0)
    block_time: Mapped[int | None] = mapped_column(BigInteger)
    seconds_after_launch: Mapped[float | None] = mapped_column(Float)
    venue: Mapped[str] = mapped_column(String(32), default="bonding_curve")
    mayhem: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (UniqueConstraint("signature", "wallet", "mint", "is_buy", name="uq_trade"),)


class FundingEventRow(Base):
    __tablename__ = "funding_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    recipient: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str | None] = mapped_column(String(64), index=True)
    signature: Mapped[str] = mapped_column(String(128), index=True)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    asset: Mapped[str] = mapped_column(String(16), default="SOL")
    block_time: Mapped[int | None] = mapped_column(BigInteger)
    seconds_before_buy: Mapped[float | None] = mapped_column(Float)
    hop: Mapped[int] = mapped_column(Integer, default=1)
    mint: Mapped[str | None] = mapped_column(String(64), index=True)

    __table_args__ = (UniqueConstraint("signature", "recipient", name="uq_funding_event"),)


class Holder(Base):
    __tablename__ = "holders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ClusterRow(Base):
    __tablename__ = "clusters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    cluster_index: Mapped[int] = mapped_column(Integer)
    score: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[int] = mapped_column(Integer, default=0)
    method: Mapped[str] = mapped_column(String(64), default="graph")
    signals: Mapped[dict | None] = mapped_column(JSON)
    fingerprint: Mapped[dict | None] = mapped_column(JSON)
    members_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    members: Mapped[list[ClusterMember]] = relationship(
        back_populates="cluster", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("mint", "cluster_index", name="uq_cluster_per_mint"),)


class ClusterMember(Base):
    __tablename__ = "cluster_members"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cluster_id: Mapped[int] = mapped_column(ForeignKey("clusters.id", ondelete="CASCADE"), index=True)
    wallet: Mapped[str] = mapped_column(String(64), index=True)

    cluster: Mapped[ClusterRow] = relationship(back_populates="members")


class WalletRelationship(Base):
    __tablename__ = "wallet_relationships"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str] = mapped_column(String(64), index=True)
    relation: Mapped[str] = mapped_column(String(32))
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    mint: Mapped[str | None] = mapped_column(String(64), index=True)

    __table_args__ = (
        UniqueConstraint("source", "target", "relation", "mint", name="uq_wallet_relationship"),
    )


class RiskScore(Base):
    __tablename__ = "risk_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    bundle_score: Mapped[int] = mapped_column(Integer, default=0)
    coordination_score: Mapped[int] = mapped_column(Integer, default=0)
    wallet_cluster_score: Mapped[int] = mapped_column(Integer, default=0)
    creator_score: Mapped[int] = mapped_column(Integer, default=0)
    overall_risk: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[int] = mapped_column(Integer, default=0)
    classification: Mapped[str] = mapped_column(String(64), default="INSUFFICIENT DATA")
    breakdown: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class ScanJob(Base):
    __tablename__ = "scan_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    depth: Mapped[str] = mapped_column(String(16), default="full")
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    requested_by: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    duration_seconds: Mapped[float | None] = mapped_column(Float)
    result: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KnownEntity(Base):
    """Operator-editable overrides on top of the bundled registry (§101)."""

    __tablename__ = "known_entities"

    address: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str | None] = mapped_column(String(128))
    entity_type: Mapped[str] = mapped_column(String(32), default="UNKNOWN")
    source: Mapped[str] = mapped_column(String(64), default="manual")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    level: Mapped[str] = mapped_column(String(16), default="LOW")
    bundle_score: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str | None] = mapped_column(Text)
    channel_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class WatchSubscription(Base):
    __tablename__ = "watch_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    channel_id: Mapped[int] = mapped_column(BigInteger, index=True)
    requested_by: Mapped[str | None] = mapped_column(String(64))
    last_bundle_score: Mapped[int] = mapped_column(Integer, default=0)
    last_checked: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (UniqueConstraint("mint", "channel_id", name="uq_watch"),)
