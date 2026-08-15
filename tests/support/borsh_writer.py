"""Borsh *encoder* used to build test fixtures.

Deliberately written independently of ``app.utils.borsh`` so the decoder is
tested against a separate implementation rather than against itself.  Every
fixture in the suite is therefore a genuine Anchor payload: real
discriminators, real little-endian Borsh, real base64/base58 framing — the
same bytes the Pump program emits on chain.
"""

from __future__ import annotations

import struct
from typing import Any

from app.utils.addresses import b58decode


class BorshWriter:
    def __init__(self) -> None:
        self._parts: list[bytes] = []

    def u8(self, value: int) -> BorshWriter:
        self._parts.append(struct.pack("<B", value))
        return self

    def u16(self, value: int) -> BorshWriter:
        self._parts.append(struct.pack("<H", value))
        return self

    def u32(self, value: int) -> BorshWriter:
        self._parts.append(struct.pack("<I", value))
        return self

    def u64(self, value: int) -> BorshWriter:
        self._parts.append(struct.pack("<Q", int(value)))
        return self

    def u128(self, value: int) -> BorshWriter:
        self._parts.append(int(value).to_bytes(16, "little"))
        return self

    def i64(self, value: int) -> BorshWriter:
        self._parts.append(struct.pack("<q", int(value)))
        return self

    def i128(self, value: int) -> BorshWriter:
        self._parts.append(int(value).to_bytes(16, "little", signed=True))
        return self

    def bool(self, value: bool) -> BorshWriter:
        return self.u8(1 if value else 0)

    def pubkey(self, value: str) -> BorshWriter:
        raw = b58decode(value)
        if len(raw) != 32:
            raise ValueError(f"{value} is not a 32-byte pubkey")
        self._parts.append(raw)
        return self

    def string(self, value: str) -> BorshWriter:
        encoded = value.encode("utf-8")
        self.u32(len(encoded))
        self._parts.append(encoded)
        return self

    def raw(self, value: bytes) -> BorshWriter:
        self._parts.append(value)
        return self

    def build(self) -> bytes:
        return b"".join(self._parts)


_WRITERS = {
    "u8": BorshWriter.u8,
    "u16": BorshWriter.u16,
    "u32": BorshWriter.u32,
    "u64": BorshWriter.u64,
    "u128": BorshWriter.u128,
    "i64": BorshWriter.i64,
    "i128": BorshWriter.i128,
    "bool": BorshWriter.bool,
    "pubkey": BorshWriter.pubkey,
    "string": BorshWriter.string,
}


def encode_struct(layout: list[tuple[str, str]], values: dict[str, Any]) -> bytes:
    """Encode a flat struct described the same way the constants module does."""
    writer = BorshWriter()
    for name, type_name in layout:
        if name not in values:
            raise KeyError(f"missing value for field {name!r}")
        _WRITERS[type_name](writer, values[name])
    return writer.build()
