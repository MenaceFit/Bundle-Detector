"""Minimal Borsh reader for Anchor account and event payloads.

Only the subset used by the Pump.fun / PumpSwap IDLs is implemented.  Every
read is bounds-checked so a truncated or unexpected payload raises
`BorshError` instead of silently producing wrong numbers — wrong numbers would
propagate into scores, which is the one thing this project must never do.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.utils.addresses import b58encode


class BorshError(ValueError):
    """Raised when a payload cannot be decoded against the expected layout."""


class BorshReader:
    __slots__ = ("data", "offset")

    def __init__(self, data: bytes, offset: int = 0) -> None:
        self.data = data
        self.offset = offset

    @property
    def remaining(self) -> int:
        return len(self.data) - self.offset

    def _take(self, n: int) -> bytes:
        if n < 0 or self.remaining < n:
            raise BorshError(
                f"truncated payload: need {n} bytes at offset {self.offset}, "
                f"{self.remaining} available"
            )
        chunk = self.data[self.offset : self.offset + n]
        self.offset += n
        return chunk

    # --- scalars ---------------------------------------------------------
    def u8(self) -> int:
        return self._take(1)[0]

    def u16(self) -> int:
        return int.from_bytes(self._take(2), "little")

    def u32(self) -> int:
        return int.from_bytes(self._take(4), "little")

    def u64(self) -> int:
        return int.from_bytes(self._take(8), "little")

    def u128(self) -> int:
        return int.from_bytes(self._take(16), "little")

    def i64(self) -> int:
        return int.from_bytes(self._take(8), "little", signed=True)

    def i128(self) -> int:
        return int.from_bytes(self._take(16), "little", signed=True)

    def bool(self) -> bool:
        v = self.u8()
        if v not in (0, 1):
            raise BorshError(f"invalid bool byte {v}")
        return v == 1

    def pubkey(self) -> str:
        return b58encode(self._take(32))

    def string(self) -> str:
        length = self.u32()
        if length > self.remaining:
            raise BorshError(f"string length {length} exceeds remaining {self.remaining}")
        return self._take(length).decode("utf-8", errors="replace")

    def bytes_fixed(self, n: int) -> bytes:
        return self._take(n)

    # --- containers ------------------------------------------------------
    def vec(self, item: Callable[[BorshReader], Any]) -> list[Any]:
        length = self.u32()
        return [item(self) for _ in range(length)]

    def option(self, item: Callable[[BorshReader], Any]) -> Any | None:
        return item(self) if self.bool() else None

    def array(self, item: Callable[[BorshReader], Any], n: int) -> list[Any]:
        return [item(self) for _ in range(n)]


#: Field-type name -> reader method name.  Used by `decode_struct`.
_SCALARS: dict[str, str] = {
    "u8": "u8",
    "u16": "u16",
    "u32": "u32",
    "u64": "u64",
    "u128": "u128",
    "i64": "i64",
    "i128": "i128",
    "bool": "bool",
    "pubkey": "pubkey",
    "string": "string",
}


def decode_struct(
    reader: BorshReader,
    layout: list[tuple[str, str]],
    *,
    tolerant: bool = True,
) -> dict[str, Any]:
    """Decode a flat struct described as ``[(field_name, type_name), ...]``.

    Pump's IDL is append-only: new fields are added at the end of events and
    accounts as the program evolves.  With ``tolerant=True`` (the default) a
    payload that ends early simply yields the fields that were present, so an
    older transaction decoded against a newer layout still produces correct
    values for every field it does contain.  Anything already read stays valid
    because Borsh is positional.
    """
    out: dict[str, Any] = {}
    for name, type_name in layout:
        method = _SCALARS.get(type_name)
        if method is None:
            raise BorshError(f"unsupported field type {type_name!r} for {name!r}")
        try:
            out[name] = getattr(reader, method)()
        except BorshError:
            if tolerant:
                return out
            raise
    return out
