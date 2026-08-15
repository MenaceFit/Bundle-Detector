"""Program-derived address computation (pure Python, no solana-py dependency).

Deriving the bonding-curve PDA locally is what lets the validator answer
"is this a Pump.fun mint?" with a *single* RPC call instead of trawling the
account's whole transaction history.
"""

from __future__ import annotations

import hashlib
from functools import lru_cache

from app.pumpfun.constants import (
    BONDING_CURVE_SEED,
    GLOBAL_CONFIG_SEED,
    GLOBAL_SEED,
    METADATA_SEED,
    MINT_AUTHORITY_SEED,
    MPL_TOKEN_METADATA_PROGRAM_ID,
    POOL_SEED,
    PUMP_FUN_PROGRAM_ID,
    PUMP_SWAP_PROGRAM_ID,
)
from app.utils.addresses import b58decode, b58encode

_PDA_MARKER = b"ProgramDerivedAddress"
_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


class PdaError(ValueError):
    pass


def _is_on_curve(compressed: bytes) -> bool:
    """True if a 32-byte value is a valid ed25519 point (i.e. NOT a valid PDA)."""
    if len(compressed) != 32:
        return False
    y = int.from_bytes(compressed, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    sign = compressed[31] >> 7

    y2 = (y * y) % _P
    u = (y2 - 1) % _P
    v = (_D * y2 + 1) % _P
    if v == 0:
        return False

    # x = u * v^3 * (u * v^7)^((p-5)/8)
    v3 = (v * v % _P) * v % _P
    v7 = (v3 * v3 % _P) * v % _P
    x = (u * v3) % _P * pow((u * v7) % _P, (_P - 5) // 8, _P) % _P

    vxx = (v * x % _P) * x % _P
    if (vxx - u) % _P != 0:
        if (vxx + u) % _P == 0:
            # multiply by sqrt(-1)
            x = x * pow(2, (_P - 1) // 4, _P) % _P
        else:
            return False
    if x == 0 and sign:
        return False
    return True


def create_program_address(seeds: list[bytes], program_id: str) -> str:
    hasher = hashlib.sha256()
    for seed in seeds:
        if len(seed) > 32:
            raise PdaError(f"seed too long ({len(seed)} bytes)")
        hasher.update(seed)
    hasher.update(b58decode(program_id))
    hasher.update(_PDA_MARKER)
    digest = hasher.digest()
    if _is_on_curve(digest):
        raise PdaError("derived address lies on the ed25519 curve")
    return b58encode(digest)


def find_program_address(seeds: list[bytes], program_id: str) -> tuple[str, int]:
    for bump in range(255, -1, -1):
        try:
            return create_program_address([*seeds, bytes([bump])], program_id), bump
        except PdaError:
            continue
    raise PdaError("no valid bump found")  # pragma: no cover - statistically impossible


@lru_cache(maxsize=4096)
def bonding_curve_pda(mint: str) -> str:
    """PDA holding a coin's bonding-curve state: seeds ``["bonding-curve", mint]``."""
    return find_program_address([BONDING_CURVE_SEED, b58decode(mint)], PUMP_FUN_PROGRAM_ID)[0]


@lru_cache(maxsize=1)
def global_pda() -> str:
    return find_program_address([GLOBAL_SEED], PUMP_FUN_PROGRAM_ID)[0]


@lru_cache(maxsize=1)
def mint_authority_pda() -> str:
    return find_program_address([MINT_AUTHORITY_SEED], PUMP_FUN_PROGRAM_ID)[0]


@lru_cache(maxsize=1)
def amm_global_config_pda() -> str:
    return find_program_address([GLOBAL_CONFIG_SEED], PUMP_SWAP_PROGRAM_ID)[0]


@lru_cache(maxsize=4096)
def metadata_pda(mint: str) -> str:
    """Metaplex metadata PDA: ``["metadata", metadata_program, mint]``."""
    return find_program_address(
        [METADATA_SEED, b58decode(MPL_TOKEN_METADATA_PROGRAM_ID), b58decode(mint)],
        MPL_TOKEN_METADATA_PROGRAM_ID,
    )[0]


def pool_pda(index: int, creator: str, base_mint: str, quote_mint: str) -> str:
    """Canonical PumpSwap pool: ``["pool", index_u16_le, creator, base, quote]``."""
    return find_program_address(
        [
            POOL_SEED,
            index.to_bytes(2, "little"),
            b58decode(creator),
            b58decode(base_mint),
            b58decode(quote_mint),
        ],
        PUMP_SWAP_PROGRAM_ID,
    )[0]
