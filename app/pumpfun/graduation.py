"""Graduation tracking: bonding curve → PumpSwap canonical pool (§39, §69).

Pump closes the bonding curve when the coin reaches the graduation threshold
and migrates liquidity to the canonical PumpSwap pool.  On chain this shows up
as three observable facts, in order of strength:

1. ``CompletePumpAmmMigrationEvent`` — carries the pool address directly.
2. ``CompleteEvent`` — the curve was marked complete (timestamp of graduation).
3. ``BondingCurve.complete == true`` — the current state flag.

The word "migration" is used only for the on-chain migrate instruction; the
lifecycle state is called GRADUATED, per Pump's own terminology.
"""

from __future__ import annotations

from typing import Any

from app.models.token import GraduationInfo
from app.providers.base import ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import PUMP_SWAP_PROGRAM_ID
from app.pumpfun.events import decode_account_data, decode_pool, parse_transaction
from app.pumpfun.pda import global_pda
from app.utils.logging import get_logger

log = get_logger("SCAN")


async def read_global_initial_reserves(hub: ProviderHub) -> int | None:
    """``Global.initial_real_token_reserves`` — the denominator for progress.

    Read from chain rather than hardcoded, because Pump can change it via
    ``set_params`` and a stale constant would silently skew every progress
    figure in every report.
    """
    from app.pumpfun.constants import ACCOUNT_DISCRIMINATORS
    from app.utils.borsh import BorshError, BorshReader

    try:
        account = await hub.rpc.get_account_info(global_pda())
    except ProviderError:
        return None
    raw = decode_account_data(account)
    if not raw or raw[:8] != ACCOUNT_DISCRIMINATORS["Global"]:
        return None
    reader = BorshReader(raw, offset=8)
    try:
        reader.bool()  # initialized
        reader.pubkey()  # authority
        reader.pubkey()  # fee_recipient
        reader.u64()  # initial_virtual_token_reserves
        reader.u64()  # initial_virtual_sol_reserves
        return reader.u64()  # initial_real_token_reserves
    except BorshError:  # pragma: no cover - defensive
        return None


def compute_progress(curve_state: dict[str, Any] | None, initial_real_tokens: int | None) -> float | None:
    """Graduation progress in ``[0, 1]`` from the curve's remaining reserves."""
    if not curve_state:
        return None
    if curve_state.get("complete"):
        return 1.0
    remaining = curve_state.get("real_token_reserves")
    if remaining is None or not initial_real_tokens:
        return None
    sold_fraction = 1.0 - (remaining / initial_real_tokens)
    return max(0.0, min(1.0, sold_fraction))


async def find_pumpswap_pool(hub: ProviderHub, mint: str, *, scan_limit: int = 60) -> dict[str, Any] | None:
    """Locate the canonical PumpSwap pool for a graduated coin.

    The pool PDA depends on the migration authority and a pool index, so it
    cannot be derived from the mint alone.  Instead we read recent activity on
    the mint and pull the pool address straight out of a PumpSwap event, then
    confirm it by decoding the ``Pool`` account.
    """
    try:
        signatures = await hub.rpc.get_signatures(mint, limit=scan_limit)
    except ProviderError:
        return None
    sigs = [s["signature"] for s in signatures if s.get("signature")]
    if not sigs:
        return None
    transactions = await hub.rpc.get_transactions(sigs)

    candidate: str | None = None
    created_at: int | None = None
    for sig, raw in transactions.items():
        parsed = parse_transaction(raw, sig)
        if not parsed or PUMP_SWAP_PROGRAM_ID not in parsed.programs:
            continue
        for event in parsed.events:
            if event.name in {"BuyEvent", "SellEvent", "CreatePoolEvent"}:
                pool = event.get("pool")
                if pool:
                    candidate = pool
                    if event.name == "CreatePoolEvent":
                        created_at = event.get("timestamp")
                    break
        if candidate:
            break

    if not candidate:
        return None

    account = await hub.rpc.get_account_info(candidate)
    pool_state = decode_pool(decode_account_data(account) or b"")
    if not pool_state or pool_state.get("base_mint") != mint:
        # An event referenced a pool that is not this coin's — do not report it.
        return None
    return {"pool": candidate, "state": pool_state, "created_at": created_at}


async def build_graduation_info(
    hub: ProviderHub,
    mint: str,
    curve_state: dict[str, Any] | None,
    *,
    creation_time: int | None = None,
    initial_real_tokens: int | None = None,
    look_for_pool: bool = True,
) -> GraduationInfo:
    info = GraduationInfo()
    if curve_state:
        info.complete_flag = bool(curve_state.get("complete"))
        info.graduated = info.complete_flag
    info.progress = compute_progress(curve_state, initial_real_tokens)

    if info.graduated and look_for_pool:
        pool = await find_pumpswap_pool(hub, mint)
        if pool:
            info.pumpswap_pool = pool["pool"]
            info.pool_created_time = pool.get("created_at")
            if info.graduation_time is None:
                info.graduation_time = pool.get("created_at")

    if info.graduation_time and creation_time:
        info.time_to_graduation = int(info.graduation_time - creation_time)
    return info


def apply_graduation_events(info: GraduationInfo, events: list[Any]) -> GraduationInfo:
    """Refine graduation timing from decoded ``CompleteEvent`` / migration events.

    Called by the buyer engine, which has already fetched the launch's
    transactions — no extra RPC round trip.
    """
    for event in events:
        if event.name == "CompletePumpAmmMigrationEvent":
            info.graduated = True
            info.graduation_time = event.get("timestamp") or info.graduation_time
            info.graduation_signature = event.signature or info.graduation_signature
            info.pumpswap_pool = event.get("pool") or info.pumpswap_pool
        elif event.name == "CompleteEvent":
            info.graduated = True
            info.complete_flag = True
            if info.graduation_time is None:
                info.graduation_time = event.get("timestamp")
            if info.graduation_signature is None:
                info.graduation_signature = event.signature
    return info
