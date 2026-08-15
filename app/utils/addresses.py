"""Base58 / Solana address helpers.

Implemented without third-party dependencies so the protocol layer and its
tests stay importable in a bare environment.
"""

from __future__ import annotations

import re

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {c: i for i, c in enumerate(_ALPHABET)}

#: A base58 string of plausible pubkey length. Length is *not* proof of validity;
#: `is_valid_pubkey` decodes to confirm the 32-byte payload.
BASE58_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")


def b58encode(data: bytes) -> str:
    if not data:
        return ""
    n = int.from_bytes(data, "big")
    out: list[str] = []
    while n > 0:
        n, rem = divmod(n, 58)
        out.append(_ALPHABET[rem])
    # leading zero bytes become '1'
    pad = 0
    for byte in data:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + "".join(reversed(out))


def b58decode(s: str) -> bytes:
    if s == "":
        return b""
    n = 0
    for ch in s:
        try:
            n = n * 58 + _INDEX[ch]
        except KeyError as exc:  # pragma: no cover - defensive
            raise ValueError(f"invalid base58 character {ch!r}") from exc
    pad = 0
    for ch in s:
        if ch == "1":
            pad += 1
        else:
            break
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\x00" * pad + body


def is_valid_pubkey(value: str) -> bool:
    """True when `value` decodes to exactly 32 bytes of base58."""
    if not value or len(value) < 32 or len(value) > 44:
        return False
    try:
        return len(b58decode(value)) == 32
    except ValueError:
        return False


def extract_candidate_mints(text: str) -> list[str]:
    """Pull plausible Solana addresses out of free-form text (Discord messages)."""
    seen: set[str] = set()
    out: list[str] = []
    for match in BASE58_RE.findall(text or ""):
        if match in seen or not is_valid_pubkey(match):
            continue
        seen.add(match)
        out.append(match)
    return out


def shorten(address: str, head: int = 4, tail: int = 4) -> str:
    if not address or len(address) <= head + tail + 1:
        return address
    return f"{address[:head]}…{address[-tail:]}"
