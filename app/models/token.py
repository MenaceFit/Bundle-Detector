"""Token-side domain models: validation result, profile, lifecycle, Mayhem."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.models.enums import LifecycleState, PairType


class ValidationResult(BaseModel):
    """Outcome of the Pump.fun origin check (§7). The gate for every scan."""

    mint: str
    is_pumpfun_token: bool = False
    launch_source: str | None = None
    creator: str | None = None
    creation_time: int | None = None
    creation_signature: str | None = None
    bonding_curve: str | None = None
    bonding_curve_exists: bool = False
    pumpfun_program_activity: bool = False
    graduation_status: str | None = None
    reason: str | None = None
    #: Which checks passed, for transparency in the failure message.
    checks: dict[str, bool] = Field(default_factory=dict)


class MayhemInfo(BaseModel):
    """Mayhem Mode status (§41, §88).

    Pump's IDL exposes ``is_mayhem_mode`` on ``BondingCurve``/``Pool`` and a
    ``mayhem_mode`` flag on every ``TradeEvent``, so this is read from chain
    state rather than inferred.
    """

    enabled: bool = False
    #: Detected from bonding-curve state, pool state, or per-trade flags.
    source: str | None = None
    #: Trades whose TradeEvent carried ``mayhem_mode = true``.
    flagged_trades: int = 0
    #: Wallets appearing only in Mayhem-flagged trades.
    flagged_wallets: list[str] = Field(default_factory=list)
    #: Virtual-parameter updates observed (UpdateMayhemVirtualParamsEvent).
    virtual_param_updates: int = 0


class GraduationInfo(BaseModel):
    """Bonding-curve completion and the move to the canonical PumpSwap pool."""

    graduated: bool = False
    complete_flag: bool = False
    graduation_time: int | None = None
    graduation_signature: str | None = None
    pumpswap_pool: str | None = None
    pool_created_time: int | None = None
    #: Progress towards graduation in ``[0, 1]``, derived from curve reserves.
    progress: float | None = None
    time_to_graduation: int | None = None


class TokenProfile(BaseModel):
    """Everything known about the coin itself (§8)."""

    mint: str
    name: str | None = None
    symbol: str | None = None
    creator: str | None = None
    creation_time: int | None = None
    creation_signature: str | None = None
    creation_slot: int | None = None

    bonding_curve: str | None = None
    bonding_curve_state: dict[str, Any] | None = None
    complete: bool = False

    initial_supply: int | None = None
    current_supply: int | None = None
    decimals: int | None = None

    pair: PairType = PairType.SOL
    quote_mint: str | None = None
    quote_decimals: int = 9

    lifecycle: LifecycleState = LifecycleState.BONDING_CURVE
    graduation: GraduationInfo = Field(default_factory=GraduationInfo)
    mayhem: MayhemInfo = Field(default_factory=MayhemInfo)

    metadata_uri: str | None = None
    image: str | None = None
    description: str | None = None
    socials: dict[str, str] = Field(default_factory=dict)

    #: Live curve reserves, in UI units, when the curve is still active.
    virtual_quote_reserves: float | None = None
    virtual_token_reserves: float | None = None
    real_quote_reserves: float | None = None
    real_token_reserves: float | None = None

    @property
    def age_seconds(self) -> float | None:
        if self.creation_time is None:
            return None
        import time

        return max(0.0, time.time() - self.creation_time)

    @property
    def display_symbol(self) -> str:
        return f"${self.symbol}" if self.symbol else self.mint[:6]
