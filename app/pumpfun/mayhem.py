"""Mayhem Mode detection and isolation (§41, §88).

Mayhem Mode is a Pump feature that can introduce protocol-driven automated
trading and adjust a launch's virtual parameters.  Its footprint is observable
directly in the IDL:

* ``BondingCurve.is_mayhem_mode`` / ``Pool.is_mayhem_mode`` — the flag itself
* ``TradeEvent.mayhem_mode`` — set on trades executed while the mode is on
* ``UpdateMayhemVirtualParamsEvent`` — virtual reserve adjustments

Why this module exists: automated activity produces *exactly* the surface
pattern a bundle produces — many trades, tight timing, similar sizes.  Scoring
them as human coordination would be a systematic false positive, so
Mayhem-flagged activity is measured separately and removed from the
coordination inputs, and the report says so out loud.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.token import MayhemInfo
from app.models.wallet import TradeRecord
from app.pumpfun.events import DecodedEvent
from app.utils.logging import get_logger

log = get_logger("SCAN")

MAYHEM_WARNING = (
    "⚠️ MAYHEM MODE\n\n"
    "Automated activity may be present.\n"
    "Do not interpret all early trades as human wallet coordination."
)


@dataclass
class MayhemSeparation:
    """Result of splitting observed trades into human vs protocol-automated."""

    info: MayhemInfo
    human_trades: list[TradeRecord] = field(default_factory=list)
    automated_trades: list[TradeRecord] = field(default_factory=list)
    #: Wallets whose *every* observed trade was Mayhem-flagged.
    automated_wallets: set[str] = field(default_factory=set)
    activity_score: int = 0

    @property
    def any_automated(self) -> bool:
        return bool(self.automated_trades)


def detect(
    events: list[DecodedEvent],
    trades: list[TradeRecord],
    existing: MayhemInfo | None = None,
) -> MayhemSeparation:
    """Split trades and quantify Mayhem activity.

    A wallet is only classed as automated when *all* of its observed trades
    carry the flag.  A wallet that also trades outside Mayhem-flagged
    transactions stays in the human set — being present during Mayhem is not
    evidence of being a bot.
    """
    info = existing.model_copy(deep=True) if existing else MayhemInfo()

    param_updates = sum(1 for e in events if e.name == "UpdateMayhemVirtualParamsEvent")
    if param_updates:
        info.enabled = True
        info.source = info.source or "UpdateMayhemVirtualParamsEvent"
        info.virtual_param_updates = param_updates

    flagged = [t for t in trades if t.mayhem]
    if flagged:
        info.enabled = True
        info.source = info.source or "TradeEvent.mayhem_mode"
    info.flagged_trades = len(flagged)

    by_wallet: dict[str, list[TradeRecord]] = {}
    for trade in trades:
        by_wallet.setdefault(trade.wallet, []).append(trade)

    automated_wallets = {
        wallet for wallet, wallet_trades in by_wallet.items() if wallet_trades and all(t.mayhem for t in wallet_trades)
    }
    info.flagged_wallets = sorted(automated_wallets)

    human = [t for t in trades if t.wallet not in automated_wallets]
    automated = [t for t in trades if t.wallet in automated_wallets]

    separation = MayhemSeparation(
        info=info,
        human_trades=human,
        automated_trades=automated,
        automated_wallets=automated_wallets,
        activity_score=_activity_score(info, trades),
    )
    if info.enabled:
        log.info(
            "mayhem detected",
            flagged_trades=info.flagged_trades,
            automated_wallets=len(automated_wallets),
            source=info.source,
        )
    return separation


def _activity_score(info: MayhemInfo, trades: list[TradeRecord]) -> int:
    """0-100 measure of how much of the observed activity is protocol-automated.

    Reported as its own dimension (§111) and never folded into the bundle score.
    """
    if not info.enabled:
        return 0
    if not trades:
        return 50 if info.enabled else 0
    share = info.flagged_trades / len(trades)
    return int(round(min(1.0, share) * 100))
