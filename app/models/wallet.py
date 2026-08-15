"""Wallet-side domain models: trades, funding, profiles, fingerprints."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.enums import EntityType


class TradeRecord(BaseModel):
    """One buy or sell of the analysed token, decoded from a TradeEvent."""

    wallet: str
    signature: str
    slot: int
    block_time: int | None = None
    is_buy: bool = True
    #: Quote spent/received in UI units (SOL or USDC depending on the pair).
    quote_amount: float = 0.0
    #: Tokens received/sold in UI units.
    token_amount: float = 0.0
    #: Seconds between coin creation and this trade.
    seconds_after_launch: float | None = None
    #: Position within the ordered list of trades for this token (0-based).
    trade_index: int | None = None
    #: True when the emitting TradeEvent carried ``mayhem_mode``.
    mayhem: bool = False
    venue: str = "bonding_curve"  # or "pumpswap"

    @property
    def implied_price(self) -> float | None:
        if self.token_amount <= 0:
            return None
        return self.quote_amount / self.token_amount


class FundingEvent(BaseModel):
    """A value transfer into a wallet, observed before its first buy (§14)."""

    recipient: str
    source: str | None = None
    signature: str
    slot: int
    block_time: int | None = None
    amount: float = 0.0
    asset: str = "SOL"
    #: Seconds between this funding and the recipient's first buy.
    seconds_before_buy: float | None = None
    #: Hop distance from the recipient (1 = direct funder).
    hop: int = 1
    source_type: EntityType = EntityType.UNKNOWN
    #: Recipient's SOL balance immediately before/after the transfer (§22),
    #: when the transaction metadata makes it observable.
    recipient_balance_before: float | None = None
    recipient_balance_after: float | None = None


class FundingPath(BaseModel):
    """A traced chain ``root -> ... -> wallet`` (§24: A -> X -> Y -> B)."""

    wallet: str
    #: Ordered addresses from the furthest known source down to the wallet.
    path: list[str] = Field(default_factory=list)
    signatures: list[str] = Field(default_factory=list)
    root: str | None = None
    root_type: EntityType = EntityType.UNKNOWN
    hops: int = 0
    total_amount: float = 0.0
    asset: str = "SOL"


class WalletProfile(BaseModel):
    """Everything the engine learned about one wallet during a scan."""

    address: str
    entity_type: EntityType = EntityType.UNKNOWN
    label: str | None = None

    #: Timestamp of the earliest signature seen for this address.
    first_seen: int | None = None
    #: True when history paging hit its bound. The measured age is then a
    #: *lower* bound: the wallet may be older than reported, never younger —
    #: so a "fresh wallet" verdict is never produced by a paging shortfall.
    first_seen_is_bounded: bool = False
    age_seconds: float | None = None
    total_signatures: int | None = None

    sol_balance: float | None = None
    balance_before_funding: float | None = None
    balance_after_funding: float | None = None
    balance_after_purchase: float | None = None

    first_buy: TradeRecord | None = None
    buys: list[TradeRecord] = Field(default_factory=list)
    sells: list[TradeRecord] = Field(default_factory=list)

    funding_events: list[FundingEvent] = Field(default_factory=list)
    funding_path: FundingPath | None = None
    direct_funder: str | None = None
    funding_amount: float | None = None
    funding_to_buy_seconds: float | None = None

    #: Pump.fun launches this wallet has traded before (§31).
    pumpfun_launches: int | None = None
    pumpfun_launches_sampled: list[str] = Field(default_factory=list)
    early_entries_10s: int = 0
    early_entries_30s: int = 0
    early_entries_60s: int = 0
    history_is_partial: bool = True

    #: True when the wallet's first observed action is buying this token.
    first_action_is_this_buy: bool = False
    fresh_bucket: str | None = None

    risk_score: int = 0
    risk_reasons: list[str] = Field(default_factory=list)
    cluster_id: int | None = None

    @property
    def is_fresh(self) -> bool:
        return self.age_seconds is not None and self.age_seconds < 86_400

    @property
    def token_position(self) -> float:
        bought = sum(t.token_amount for t in self.buys)
        sold = sum(t.token_amount for t in self.sells)
        return bought - sold


class WalletFingerprint(BaseModel):
    """Behavioural signature that survives an address change (§64)."""

    address: str
    age_bucket: str
    funding_bucket: str
    entry_timing_bucket: str
    entry_size_bucket: str
    holding_bucket: str
    sell_behavior: str
    launch_frequency_bucket: str

    def vector(self) -> tuple[str, ...]:
        return (
            self.age_bucket,
            self.funding_bucket,
            self.entry_timing_bucket,
            self.entry_size_bucket,
            self.holding_bucket,
            self.sell_behavior,
            self.launch_frequency_bucket,
        )

    def similarity(self, other: WalletFingerprint) -> float:
        mine, theirs = self.vector(), other.vector()
        matches = sum(1 for a, b in zip(mine, theirs, strict=True) if a == b)
        return matches / len(mine)


class CreatorProfile(BaseModel):
    """The launching wallet and its Pump.fun track record (§35-§40)."""

    address: str
    wallet: WalletProfile | None = None
    previous_launches: list[str] = Field(default_factory=list)
    launches_total: int = 0
    launches_graduated: int = 0
    launches_abandoned: int = 0
    graduation_rate: float | None = None
    history_is_partial: bool = True
    signatures_sampled: int = 0

    funding_source: str | None = None
    funding_time: int | None = None
    funding_amount: float | None = None
    funding_path: FundingPath | None = None

    #: Buyer wallets reachable from the creator within `max_funding_hops`.
    linked_buyers: list[str] = Field(default_factory=list)
    link_paths: dict[str, list[str]] = Field(default_factory=dict)

    #: Post-graduation behaviour on previous launches (§40).
    post_graduation_sells: int = 0
    post_graduation_notes: list[str] = Field(default_factory=list)

    risk_score: int = 0
    risk_reasons: list[str] = Field(default_factory=list)
