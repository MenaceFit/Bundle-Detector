"""Token profile assembly (§8).

Builds a :class:`TokenProfile` from on-chain state first, off-chain metadata
second.  Anything that cannot be read is left ``None`` — never invented — so
the confidence engine can see the gap.
"""

from __future__ import annotations

from typing import Any

from app.models.enums import PairType
from app.models.token import MayhemInfo, TokenProfile, ValidationResult
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import (
    SOL_DECIMALS,
    SYSTEM_PROGRAM_ID,
    USDC_MINT,
    WSOL_MINT,
    quote_decimals,
    quote_symbol,
    to_ui_amount,
)
from app.pumpfun.events import decode_account_data, decode_bonding_curve
from app.pumpfun.graduation import build_graduation_info, read_global_initial_reserves
from app.pumpfun.lifecycle import determine_state
from app.utils.logging import get_logger

log = get_logger("SCAN")


def resolve_pair(quote_mint: str | None) -> PairType:
    """Which asset the coin is paired against (§89).

    Pump writes ``Pubkey::default()`` in ``quote_mint`` for every coin created
    before USDC pairs existed and for SOL-paired coins, so the default value
    means SOL.
    """
    if not quote_mint or quote_mint == SYSTEM_PROGRAM_ID or quote_mint == WSOL_MINT:
        return PairType.SOL
    if quote_mint == USDC_MINT:
        return PairType.USDC
    return PairType.UNKNOWN


async def build_token_profile(
    hub: ProviderHub,
    validation: ValidationResult,
    *,
    fetch_metadata: bool = True,
    look_for_pool: bool = True,
) -> TokenProfile:
    mint = validation.mint
    profile = TokenProfile(
        mint=mint,
        creator=validation.creator,
        creation_time=validation.creation_time,
        creation_signature=validation.creation_signature,
        bonding_curve=validation.bonding_curve,
    )

    curve_state = await _read_curve(hub, validation.bonding_curve)
    profile.bonding_curve_state = curve_state
    if curve_state:
        profile.complete = bool(curve_state.get("complete"))
        profile.creator = curve_state.get("creator") or profile.creator
        quote_mint = curve_state.get("quote_mint")
        profile.quote_mint = quote_mint
        profile.pair = resolve_pair(quote_mint)
        profile.quote_decimals = quote_decimals(quote_mint)
        profile.mayhem = MayhemInfo(
            enabled=bool(curve_state.get("is_mayhem_mode")),
            source="bonding_curve.is_mayhem_mode" if curve_state.get("is_mayhem_mode") else None,
        )
        profile.virtual_quote_reserves = to_ui_amount(
            curve_state.get("virtual_quote_reserves"), profile.quote_decimals
        )
        profile.real_quote_reserves = to_ui_amount(
            curve_state.get("real_quote_reserves"), profile.quote_decimals
        )
        hub.quality.set_coverage("bonding_curve", CoverageLevel.COMPLETE)
    else:
        hub.quality.set_coverage(
            "bonding_curve", CoverageLevel.MISSING, "bonding curve account could not be read"
        )

    supply = await _read_supply(hub, mint)
    if supply:
        profile.decimals = supply.get("decimals")
        profile.current_supply = int(supply.get("amount") or 0)
    if curve_state and curve_state.get("token_total_supply"):
        profile.initial_supply = int(curve_state["token_total_supply"])
    if profile.decimals is not None and curve_state:
        profile.virtual_token_reserves = to_ui_amount(
            curve_state.get("virtual_token_reserves"), profile.decimals
        )
        profile.real_token_reserves = to_ui_amount(
            curve_state.get("real_token_reserves"), profile.decimals
        )

    initial_real_tokens = await read_global_initial_reserves(hub)
    profile.graduation = await build_graduation_info(
        hub,
        mint,
        curve_state,
        creation_time=profile.creation_time,
        initial_real_tokens=initial_real_tokens,
        look_for_pool=look_for_pool,
    )

    if profile.graduation.pumpswap_pool:
        pool_state = await _read_pool(hub, profile.graduation.pumpswap_pool)
        if pool_state:
            if pool_state.get("is_mayhem_mode"):
                profile.mayhem.enabled = True
                profile.mayhem.source = profile.mayhem.source or "pool.is_mayhem_mode"
            pool_quote = pool_state.get("quote_mint")
            if pool_quote and profile.pair is PairType.UNKNOWN:
                profile.pair = resolve_pair(pool_quote)
                profile.quote_mint = pool_quote
                profile.quote_decimals = quote_decimals(pool_quote)

    if fetch_metadata:
        metadata = await hub.get_token_metadata(mint)
        if metadata:
            profile.name = metadata.get("name") or profile.name
            profile.symbol = metadata.get("symbol") or profile.symbol
            profile.description = metadata.get("description")
            profile.metadata_uri = metadata.get("uri")
            profile.image = metadata.get("image")
            socials = metadata.get("socials") or {}
            profile.socials = {k: v for k, v in socials.items() if isinstance(v, str) and v}
            if profile.decimals is None and metadata.get("decimals") is not None:
                profile.decimals = int(metadata["decimals"])

    profile.lifecycle = determine_state(
        graduation=profile.graduation,
        age_seconds=profile.age_seconds,
        trade_count=0,
        has_pumpswap_pool=bool(profile.graduation.pumpswap_pool),
    )
    return profile


def apply_creation_event(profile: TokenProfile, event: Any) -> TokenProfile:
    """Fill name/symbol/creator/pair from the on-chain ``CreateEvent``.

    On-chain data wins over provider metadata for identity fields: it is what
    the program actually recorded at launch.
    """
    profile.name = event.get("name") or profile.name
    profile.symbol = event.get("symbol") or profile.symbol
    profile.metadata_uri = profile.metadata_uri or event.get("uri")
    profile.creator = event.get("creator") or event.get("user") or profile.creator
    profile.creation_time = profile.creation_time or event.get("timestamp")
    profile.creation_signature = profile.creation_signature or event.signature
    profile.creation_slot = profile.creation_slot or event.slot
    if event.get("is_mayhem_mode"):
        profile.mayhem.enabled = True
        profile.mayhem.source = profile.mayhem.source or "CreateEvent.is_mayhem_mode"
    quote_mint = event.get("quote_mint")
    if quote_mint:
        profile.quote_mint = profile.quote_mint or quote_mint
        if profile.pair is PairType.UNKNOWN:
            profile.pair = resolve_pair(quote_mint)
            profile.quote_decimals = quote_decimals(quote_mint)
    if profile.initial_supply is None and event.get("token_total_supply"):
        profile.initial_supply = int(event["token_total_supply"])
    return profile


def pair_label(profile: TokenProfile) -> str:
    return quote_symbol(profile.quote_mint) if profile.pair is not PairType.UNKNOWN else "UNKNOWN"


async def _read_curve(hub: ProviderHub, address: str | None) -> dict[str, Any] | None:
    if not address:
        return None
    try:
        account = await hub.rpc.get_account_info(address)
    except ProviderError as exc:
        log.warning("curve read failed", address=address, error=str(exc))
        return None
    return decode_bonding_curve(decode_account_data(account) or b"")


async def _read_pool(hub: ProviderHub, address: str) -> dict[str, Any] | None:
    from app.pumpfun.events import decode_pool

    try:
        account = await hub.rpc.get_account_info(address)
    except ProviderError:
        return None
    return decode_pool(decode_account_data(account) or b"")


async def _read_supply(hub: ProviderHub, mint: str) -> dict[str, Any] | None:
    try:
        return await hub.rpc.get_token_supply(mint)
    except ProviderError:
        return None


def sol_to_ui(lamports: int | None) -> float:
    return to_ui_amount(lamports, SOL_DECIMALS)
