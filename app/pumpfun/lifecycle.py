"""Lifecycle state machine (§9).

    CREATED -> BONDING_CURVE -> NEAR_GRADUATION -> GRADUATED -> PUMPSWAP

The state is *derived*, never stored: it is a pure function of the curve
account, the graduation facts and the coin's age.
"""

from __future__ import annotations

from app.models.enums import LifecycleState
from app.models.token import GraduationInfo

#: Progress above which a coin is reported as approaching graduation.
NEAR_GRADUATION_PROGRESS = 0.80
#: A coin younger than this with no trades yet is still merely CREATED.
JUST_CREATED_SECONDS = 60


def determine_state(
    *,
    graduation: GraduationInfo,
    age_seconds: float | None,
    trade_count: int,
    has_pumpswap_pool: bool,
) -> LifecycleState:
    if graduation.graduated:
        return LifecycleState.PUMPSWAP if has_pumpswap_pool else LifecycleState.GRADUATED
    if graduation.progress is not None and graduation.progress >= NEAR_GRADUATION_PROGRESS:
        return LifecycleState.NEAR_GRADUATION
    if trade_count == 0 and (age_seconds is None or age_seconds < JUST_CREATED_SECONDS):
        return LifecycleState.CREATED
    return LifecycleState.BONDING_CURVE


def describe_state(state: LifecycleState, graduation: GraduationInfo) -> str:
    """One-line status used in the Discord embeds (§90)."""
    if state is LifecycleState.PUMPSWAP:
        return "GRADUATED → PUMPSWAP"
    if state is LifecycleState.GRADUATED:
        return "GRADUATED (PumpSwap pool not located yet)"
    if graduation.progress is not None:
        return f"{state.label} · graduation {graduation.progress * 100:.0f}% complete"
    return state.label
