"""Program addresses, discriminators and account layouts.

Source of truth: the official Anchor IDLs published by Pump at
https://github.com/pump-fun/pump-public-docs

  * ``idl/pump.json``      -> program ``6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P``
  * ``idl/pump_amm.json``  -> program ``pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA``

Layouts are transcribed field-for-field, in IDL order.  Because Pump appends
new fields to the end of events and accounts as the program evolves, decoding
is tolerant of short payloads (see ``app.utils.borsh.decode_struct``): an old
transaction decoded against the current layout still yields correct values for
the fields it actually contains.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Program addresses
# --------------------------------------------------------------------------
PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_SWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
PUMP_SWAP_GLOBAL_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"

MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"
TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111"

WSOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

LAMPORTS_PER_SOL = 1_000_000_000
USDC_DECIMALS = 6
SOL_DECIMALS = 9

#: Mints Pump supports as a quote asset. Anything else is not a Pump.fun pair.
QUOTE_MINTS: dict[str, tuple[str, int]] = {
    WSOL_MINT: ("SOL", SOL_DECIMALS),
    USDC_MINT: ("USDC", USDC_DECIMALS),
}

# --------------------------------------------------------------------------
# PDA seeds
# --------------------------------------------------------------------------
BONDING_CURVE_SEED = b"bonding-curve"
GLOBAL_SEED = b"global"
MINT_AUTHORITY_SEED = b"mint-authority"
METADATA_SEED = b"metadata"
POOL_SEED = b"pool"
POOL_LP_MINT_SEED = b"pool_lp_mint"
GLOBAL_CONFIG_SEED = b"global_config"

# --------------------------------------------------------------------------
# Anchor discriminators (8 bytes each)
# --------------------------------------------------------------------------
#: Prefix emitted by Anchor's ``emit_cpi!`` self-CPI event wrapper.  The real
#: event discriminator follows these 8 bytes.
ANCHOR_CPI_EVENT_PREFIX = bytes([228, 69, 165, 46, 81, 203, 154, 29])

ACCOUNT_DISCRIMINATORS: dict[str, bytes] = {
    "BondingCurve": bytes([23, 183, 248, 55, 96, 216, 172, 96]),
    "Global": bytes([167, 232, 232, 177, 200, 108, 114, 127]),
    "Pool": bytes([241, 154, 109, 4, 17, 177, 109, 188]),
    "GlobalConfig": bytes([149, 8, 156, 202, 160, 252, 176, 217]),
}

PUMP_EVENT_DISCRIMINATORS: dict[str, bytes] = {
    "CreateEvent": bytes([27, 114, 169, 77, 222, 235, 99, 118]),
    "TradeEvent": bytes([189, 219, 127, 211, 78, 230, 97, 238]),
    "CompleteEvent": bytes([95, 114, 97, 156, 212, 46, 152, 8]),
    "CompletePumpAmmMigrationEvent": bytes([189, 233, 93, 185, 92, 148, 234, 148]),
    "SetCreatorEvent": bytes([237, 52, 123, 37, 245, 251, 72, 210]),
    "UpdateMayhemVirtualParamsEvent": bytes([117, 123, 228, 182, 161, 168, 220, 214]),
}

PUMP_AMM_EVENT_DISCRIMINATORS: dict[str, bytes] = {
    "BuyEvent": bytes([103, 244, 82, 31, 44, 245, 119, 119]),
    "SellEvent": bytes([62, 47, 55, 10, 165, 3, 220, 42]),
    "CreatePoolEvent": bytes([177, 49, 12, 210, 160, 118, 167, 116]),
}

#: Instruction discriminators we care about when classifying a transaction.
PUMP_INSTRUCTIONS: dict[str, bytes] = {
    "create": bytes([24, 30, 200, 40, 5, 28, 7, 119]),
    "create_v2": bytes([214, 144, 76, 236, 95, 139, 49, 180]),
    "buy": bytes([102, 6, 61, 18, 1, 218, 235, 234]),
    "buy_v2": bytes([184, 23, 238, 97, 103, 197, 211, 61]),
    "buy_exact_sol_in": bytes([56, 252, 116, 8, 158, 223, 205, 95]),
    "buy_exact_quote_in_v2": bytes([194, 171, 28, 70, 104, 77, 91, 47]),
    "sell": bytes([51, 230, 133, 164, 1, 127, 131, 173]),
    "sell_v2": bytes([93, 246, 130, 60, 231, 233, 64, 178]),
    "migrate": bytes([155, 234, 231, 146, 236, 158, 162, 30]),
    "migrate_v2": bytes([187, 203, 18, 31, 206, 237, 254, 41]),
    "toggle_mayhem_mode": bytes([1, 9, 111, 208, 100, 31, 255, 163]),
    "set_mayhem_virtual_params": bytes([61, 169, 188, 191, 153, 149, 42, 97]),
}

PUMP_BUY_INSTRUCTIONS = frozenset({"buy", "buy_v2", "buy_exact_sol_in", "buy_exact_quote_in_v2"})
PUMP_SELL_INSTRUCTIONS = frozenset({"sell", "sell_v2"})

# --------------------------------------------------------------------------
# Layouts — ``[(field_name, borsh_type), ...]`` in IDL order
# --------------------------------------------------------------------------
BONDING_CURVE_LAYOUT: list[tuple[str, str]] = [
    ("virtual_token_reserves", "u64"),
    ("virtual_quote_reserves", "u64"),
    ("real_token_reserves", "u64"),
    ("real_quote_reserves", "u64"),
    ("token_total_supply", "u64"),
    ("complete", "bool"),
    ("creator", "pubkey"),
    ("is_mayhem_mode", "bool"),
    ("is_cashback_coin", "bool"),
    ("quote_mint", "pubkey"),
]

CREATE_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("name", "string"),
    ("symbol", "string"),
    ("uri", "string"),
    ("mint", "pubkey"),
    ("bonding_curve", "pubkey"),
    ("user", "pubkey"),
    ("creator", "pubkey"),
    ("timestamp", "i64"),
    ("virtual_token_reserves", "u64"),
    ("virtual_sol_reserves", "u64"),
    ("real_token_reserves", "u64"),
    ("token_total_supply", "u64"),
    ("token_program", "pubkey"),
    ("is_mayhem_mode", "bool"),
    ("is_cashback_enabled", "bool"),
    ("quote_mint", "pubkey"),
    ("virtual_quote_reserves", "u64"),
]

#: TradeEvent up to (and excluding) the ``shareholders`` vec.  The vec cannot be
#: expressed as a flat scalar layout, so it is decoded separately when the tail
#: is needed; every field the engine uses sits before it.
TRADE_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("mint", "pubkey"),
    ("sol_amount", "u64"),
    ("token_amount", "u64"),
    ("is_buy", "bool"),
    ("user", "pubkey"),
    ("timestamp", "i64"),
    ("virtual_sol_reserves", "u64"),
    ("virtual_token_reserves", "u64"),
    ("real_sol_reserves", "u64"),
    ("real_token_reserves", "u64"),
    ("fee_recipient", "pubkey"),
    ("fee_basis_points", "u64"),
    ("fee", "u64"),
    ("creator", "pubkey"),
    ("creator_fee_basis_points", "u64"),
    ("creator_fee", "u64"),
    ("track_volume", "bool"),
    ("total_unclaimed_tokens", "u64"),
    ("total_claimed_tokens", "u64"),
    ("current_sol_volume", "u64"),
    ("last_update_timestamp", "i64"),
    ("ix_name", "string"),
    ("mayhem_mode", "bool"),
    ("cashback_fee_basis_points", "u64"),
    ("cashback", "u64"),
    ("buyback_fee_basis_points", "u64"),
    ("buyback_fee", "u64"),
]

#: Fields that follow the ``shareholders`` vec in TradeEvent.
TRADE_EVENT_TAIL_LAYOUT: list[tuple[str, str]] = [
    ("quote_mint", "pubkey"),
    ("quote_amount", "u64"),
    ("virtual_quote_reserves", "u64"),
    ("real_quote_reserves", "u64"),
]

COMPLETE_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("user", "pubkey"),
    ("mint", "pubkey"),
    ("bonding_curve", "pubkey"),
    ("timestamp", "i64"),
    ("quote_mint", "pubkey"),
]

MIGRATION_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("user", "pubkey"),
    ("mint", "pubkey"),
    ("mint_amount", "u64"),
    ("sol_amount", "u64"),
    ("pool_migration_fee", "u64"),
    ("bonding_curve", "pubkey"),
    ("timestamp", "i64"),
    ("pool", "pubkey"),
    ("quote_mint", "pubkey"),
]

SET_CREATOR_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("timestamp", "i64"),
    ("mint", "pubkey"),
    ("bonding_curve", "pubkey"),
    ("creator", "pubkey"),
]

POOL_LAYOUT: list[tuple[str, str]] = [
    ("pool_bump", "u8"),
    ("index", "u16"),
    ("creator", "pubkey"),
    ("base_mint", "pubkey"),
    ("quote_mint", "pubkey"),
    ("lp_mint", "pubkey"),
    ("pool_base_token_account", "pubkey"),
    ("pool_quote_token_account", "pubkey"),
    ("lp_supply", "u64"),
    ("coin_creator", "pubkey"),
    ("is_mayhem_mode", "bool"),
    ("is_cashback_coin", "bool"),
    ("virtual_quote_reserves", "i128"),
]

#: PumpSwap BuyEvent / SellEvent share their leading fields; the engine only
#: needs the head (amounts, pool, user) plus ``coin_creator``.
AMM_BUY_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("timestamp", "i64"),
    ("base_amount_out", "u64"),
    ("max_quote_amount_in", "u64"),
    ("user_base_token_reserves", "u64"),
    ("user_quote_token_reserves", "u64"),
    ("pool_base_token_reserves", "u64"),
    ("pool_quote_token_reserves", "u64"),
    ("quote_amount_in", "u64"),
    ("lp_fee_basis_points", "u64"),
    ("lp_fee", "u64"),
    ("protocol_fee_basis_points", "u64"),
    ("protocol_fee", "u64"),
    ("quote_amount_in_with_lp_fee", "u64"),
    ("user_quote_amount_in", "u64"),
    ("pool", "pubkey"),
    ("user", "pubkey"),
    ("user_base_token_account", "pubkey"),
    ("user_quote_token_account", "pubkey"),
    ("protocol_fee_recipient", "pubkey"),
    ("protocol_fee_recipient_token_account", "pubkey"),
    ("coin_creator", "pubkey"),
]

AMM_SELL_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("timestamp", "i64"),
    ("base_amount_in", "u64"),
    ("min_quote_amount_out", "u64"),
    ("user_base_token_reserves", "u64"),
    ("user_quote_token_reserves", "u64"),
    ("pool_base_token_reserves", "u64"),
    ("pool_quote_token_reserves", "u64"),
    ("quote_amount_out", "u64"),
    ("lp_fee_basis_points", "u64"),
    ("lp_fee", "u64"),
    ("protocol_fee_basis_points", "u64"),
    ("protocol_fee", "u64"),
    ("quote_amount_out_without_lp_fee", "u64"),
    ("user_quote_amount_out", "u64"),
    ("pool", "pubkey"),
    ("user", "pubkey"),
    ("user_base_token_account", "pubkey"),
    ("user_quote_token_account", "pubkey"),
    ("protocol_fee_recipient", "pubkey"),
    ("protocol_fee_recipient_token_account", "pubkey"),
    ("coin_creator", "pubkey"),
]

CREATE_POOL_EVENT_LAYOUT: list[tuple[str, str]] = [
    ("timestamp", "i64"),
    ("index", "u16"),
    ("creator", "pubkey"),
    ("base_mint", "pubkey"),
    ("quote_mint", "pubkey"),
    ("base_mint_decimals", "u8"),
    ("quote_mint_decimals", "u8"),
    ("base_amount_in", "u64"),
    ("quote_amount_in", "u64"),
    ("pool_base_amount", "u64"),
    ("pool_quote_amount", "u64"),
    ("minimum_liquidity", "u64"),
    ("initial_liquidity", "u64"),
    ("lp_token_amount_out", "u64"),
    ("pool_bump", "u8"),
    ("pool", "pubkey"),
    ("lp_mint", "pubkey"),
    ("user_base_token_account", "pubkey"),
    ("user_quote_token_account", "pubkey"),
    ("coin_creator", "pubkey"),
    ("is_mayhem_mode", "bool"),
]

EVENT_LAYOUTS: dict[str, list[tuple[str, str]]] = {
    "CreateEvent": CREATE_EVENT_LAYOUT,
    "TradeEvent": TRADE_EVENT_LAYOUT,
    "CompleteEvent": COMPLETE_EVENT_LAYOUT,
    "CompletePumpAmmMigrationEvent": MIGRATION_EVENT_LAYOUT,
    "SetCreatorEvent": SET_CREATOR_EVENT_LAYOUT,
    "BuyEvent": AMM_BUY_EVENT_LAYOUT,
    "SellEvent": AMM_SELL_EVENT_LAYOUT,
    "CreatePoolEvent": CREATE_POOL_EVENT_LAYOUT,
}

#: discriminator -> event name, across both programs.
DISCRIMINATOR_TO_EVENT: dict[bytes, str] = {
    **{disc: name for name, disc in PUMP_EVENT_DISCRIMINATORS.items()},
    **{disc: name for name, disc in PUMP_AMM_EVENT_DISCRIMINATORS.items()},
}

#: instruction discriminator -> name, for transaction classification.
DISCRIMINATOR_TO_INSTRUCTION: dict[bytes, str] = {
    disc: name for name, disc in PUMP_INSTRUCTIONS.items()
}


def quote_symbol(mint: str | None) -> str:
    """`SOL` / `USDC` / `UNKNOWN` for a quote mint (default-pubkey means SOL)."""
    if not mint or mint == SYSTEM_PROGRAM_ID:
        return "SOL"
    return QUOTE_MINTS.get(mint, ("UNKNOWN", 0))[0]


def quote_decimals(mint: str | None) -> int:
    if not mint or mint == SYSTEM_PROGRAM_ID:
        return SOL_DECIMALS
    return QUOTE_MINTS.get(mint, ("UNKNOWN", SOL_DECIMALS))[1]


def to_ui_amount(raw: int | None, decimals: int) -> float:
    if raw is None:
        return 0.0
    return raw / (10**decimals)
