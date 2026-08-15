"""Decoding of Pump.fun / PumpSwap Anchor events and accounts.

Two emission paths exist and both are supported:

1. ``emit!``      -> a log line ``Program data: <base64>``
2. ``emit_cpi!``  -> a self-CPI whose *instruction data* starts with the Anchor
                     CPI event prefix, then the event discriminator

Pump uses the self-CPI form for its trade events, which means the payload is
found in ``meta.innerInstructions`` (base58-encoded instruction data), not in
the log lines.  Reading both makes the parser resilient across program
versions.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

from app.pumpfun.constants import (
    ACCOUNT_DISCRIMINATORS,
    ANCHOR_CPI_EVENT_PREFIX,
    BONDING_CURVE_LAYOUT,
    DISCRIMINATOR_TO_EVENT,
    DISCRIMINATOR_TO_INSTRUCTION,
    EVENT_LAYOUTS,
    POOL_LAYOUT,
    PUMP_FUN_PROGRAM_ID,
    PUMP_SWAP_PROGRAM_ID,
    TRADE_EVENT_TAIL_LAYOUT,
)
from app.utils.addresses import b58decode
from app.utils.borsh import BorshError, BorshReader, decode_struct
from app.utils.logging import get_logger

log = get_logger("API")

_LOG_DATA_PREFIX = "Program data: "

#: Programs whose events this module knows how to decode.
KNOWN_EVENT_PROGRAMS = frozenset({PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID})


@dataclass(slots=True)
class DecodedEvent:
    """A decoded Anchor event together with its on-chain provenance."""

    name: str
    program_id: str | None
    fields: dict[str, Any]
    signature: str | None = None
    slot: int | None = None
    block_time: int | None = None
    #: Index of the emitting instruction within the transaction, when known.
    instruction_index: int | None = None

    def get(self, key: str, default: Any = None) -> Any:
        return self.fields.get(key, default)


@dataclass(slots=True)
class DecodedTransaction:
    """Everything the engine needs from one confirmed transaction."""

    signature: str
    slot: int
    block_time: int | None
    success: bool
    fee_payer: str | None
    account_keys: list[str] = field(default_factory=list)
    events: list[DecodedEvent] = field(default_factory=list)
    #: Pump instruction names invoked (``buy``, ``sell``, ``create``, ...).
    instructions: list[str] = field(default_factory=list)
    #: Every program id touched by the transaction (top-level and inner).
    programs: set[str] = field(default_factory=set)
    #: Native SOL balance delta per account (lamports), from meta.
    sol_deltas: dict[str, int] = field(default_factory=dict)
    #: Account -> (pre, post) lamport balance, for balance-trail analysis.
    sol_balances: dict[str, tuple[int, int]] = field(default_factory=dict)
    #: (owner, mint) -> raw token balance delta, from meta token balances.
    token_deltas: dict[tuple[str, str], int] = field(default_factory=dict)
    error: Any | None = None

    def events_named(self, name: str) -> list[DecodedEvent]:
        return [e for e in self.events if e.name == name]


# ---------------------------------------------------------------------------
# Payload decoding
# ---------------------------------------------------------------------------
def decode_event_payload(payload: bytes) -> tuple[str, dict[str, Any]] | None:
    """Decode a raw event payload (discriminator + borsh body).

    Accepts payloads with or without the Anchor CPI event prefix.
    Returns ``None`` when the discriminator is not one we know.
    """
    if payload.startswith(ANCHOR_CPI_EVENT_PREFIX):
        payload = payload[len(ANCHOR_CPI_EVENT_PREFIX) :]
    if len(payload) < 8:
        return None
    name = DISCRIMINATOR_TO_EVENT.get(payload[:8])
    if name is None:
        return None
    layout = EVENT_LAYOUTS.get(name)
    if layout is None:
        return None
    reader = BorshReader(payload, offset=8)
    try:
        fields = decode_struct(reader, layout, tolerant=True)
    except BorshError as exc:  # pragma: no cover - defensive
        log.debug("event decode failed", event=name, error=str(exc))
        return None
    if name == "TradeEvent" and len(fields) == len(layout):
        _decode_trade_tail(reader, fields)
    return name, fields


def _decode_trade_tail(reader: BorshReader, fields: dict[str, Any]) -> None:
    """Skip the ``shareholders`` vec, then read the quote-mint tail fields.

    The tail carries ``quote_mint`` / ``quote_amount``, which is how a
    USDC-paired coin is distinguished from a SOL-paired one.  If anything is
    short or malformed we leave the tail absent rather than guessing.
    """
    try:
        count = reader.u32()
        reader.bytes_fixed(count * 34)  # Shareholder = pubkey(32) + share_bps(u16)
        fields.update(decode_struct(reader, TRADE_EVENT_TAIL_LAYOUT, tolerant=True))
    except BorshError:
        return


def decode_events_from_logs(logs: list[str] | None) -> list[tuple[str, dict[str, Any]]]:
    """Decode every ``Program data:`` line in a transaction's logs."""
    out: list[tuple[str, dict[str, Any]]] = []
    for line in logs or []:
        if not line.startswith(_LOG_DATA_PREFIX):
            continue
        raw = line[len(_LOG_DATA_PREFIX) :].strip()
        try:
            payload = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError):
            continue
        decoded = decode_event_payload(payload)
        if decoded:
            out.append(decoded)
    return out


def decode_instruction_name(data_b58: str) -> str | None:
    """Map base58 instruction data to a known Pump instruction name."""
    try:
        raw = b58decode(data_b58)
    except ValueError:
        return None
    if len(raw) < 8:
        return None
    return DISCRIMINATOR_TO_INSTRUCTION.get(raw[:8])


# ---------------------------------------------------------------------------
# Account decoding
# ---------------------------------------------------------------------------
def decode_bonding_curve(data: bytes) -> dict[str, Any] | None:
    """Decode a ``BondingCurve`` account (discriminator-checked)."""
    if len(data) < 8 or data[:8] != ACCOUNT_DISCRIMINATORS["BondingCurve"]:
        return None
    try:
        return decode_struct(BorshReader(data, offset=8), BONDING_CURVE_LAYOUT, tolerant=True)
    except BorshError:  # pragma: no cover - defensive
        return None


def decode_pool(data: bytes) -> dict[str, Any] | None:
    """Decode a PumpSwap ``Pool`` account (discriminator-checked)."""
    if len(data) < 8 or data[:8] != ACCOUNT_DISCRIMINATORS["Pool"]:
        return None
    try:
        return decode_struct(BorshReader(data, offset=8), POOL_LAYOUT, tolerant=True)
    except BorshError:  # pragma: no cover - defensive
        return None


def decode_account_data(account: dict[str, Any] | None) -> bytes | None:
    """Extract raw bytes from an RPC ``account.data`` field (base64 or base58)."""
    if not account:
        return None
    data = account.get("data")
    if isinstance(data, list) and data:
        raw, encoding = data[0], (data[1] if len(data) > 1 else "base64")
        try:
            if encoding == "base64":
                return base64.b64decode(raw)
            if encoding == "base58":
                return b58decode(raw)
        except (ValueError, TypeError):
            return None
    if isinstance(data, str):
        try:
            return base64.b64decode(data)
        except (ValueError, TypeError):
            return None
    return None


# ---------------------------------------------------------------------------
# Transaction parsing
# ---------------------------------------------------------------------------
def _account_keys(tx: dict[str, Any]) -> list[str]:
    message = (tx.get("transaction") or {}).get("message") or {}
    keys: list[str] = []
    for key in message.get("accountKeys") or []:
        if isinstance(key, str):
            keys.append(key)
        elif isinstance(key, dict) and "pubkey" in key:
            keys.append(key["pubkey"])
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    keys.extend(loaded.get("writable") or [])
    keys.extend(loaded.get("readonly") or [])
    return keys


def _program_id_for(instruction: dict[str, Any], keys: list[str]) -> str | None:
    if "programId" in instruction:
        return instruction["programId"]
    idx = instruction.get("programIdIndex")
    if isinstance(idx, int) and 0 <= idx < len(keys):
        return keys[idx]
    return None


def _iter_instructions(tx: dict[str, Any]) -> list[tuple[dict[str, Any], int]]:
    """Yield ``(instruction, top_level_index)`` for outer and inner instructions."""
    message = (tx.get("transaction") or {}).get("message") or {}
    meta = tx.get("meta") or {}
    out: list[tuple[dict[str, Any], int]] = []
    for i, ix in enumerate(message.get("instructions") or []):
        out.append((ix, i))
    for inner in meta.get("innerInstructions") or []:
        parent = inner.get("index", -1)
        for ix in inner.get("instructions") or []:
            out.append((ix, parent))
    return out


def _sol_balances(tx: dict[str, Any], keys: list[str]) -> tuple[dict[str, int], dict[str, tuple[int, int]]]:
    meta = tx.get("meta") or {}
    pre, post = meta.get("preBalances") or [], meta.get("postBalances") or []
    deltas: dict[str, int] = {}
    balances: dict[str, tuple[int, int]] = {}
    for i, key in enumerate(keys):
        if i >= len(pre) or i >= len(post):
            continue
        before, after = int(pre[i]), int(post[i])
        balances.setdefault(key, (before, after))
        delta = after - before
        if delta:
            deltas[key] = deltas.get(key, 0) + delta
    return deltas, balances


def _token_deltas(tx: dict[str, Any]) -> dict[tuple[str, str], int]:
    meta = tx.get("meta") or {}
    balances: dict[tuple[str, str], int] = {}
    for entry in meta.get("preTokenBalances") or []:
        key = (entry.get("owner") or "", entry.get("mint") or "")
        amount = int((entry.get("uiTokenAmount") or {}).get("amount") or 0)
        balances[key] = balances.get(key, 0) - amount
    for entry in meta.get("postTokenBalances") or []:
        key = (entry.get("owner") or "", entry.get("mint") or "")
        amount = int((entry.get("uiTokenAmount") or {}).get("amount") or 0)
        balances[key] = balances.get(key, 0) + amount
    return {k: v for k, v in balances.items() if v and k[0] and k[1]}


def parse_transaction(tx: dict[str, Any] | None, signature: str | None = None) -> DecodedTransaction | None:
    """Normalise a ``getTransaction`` result into a :class:`DecodedTransaction`.

    Works with ``jsonParsed`` and plain ``json`` encodings.  Events are read
    from inner-instruction data first (the self-CPI path Pump actually uses)
    and from log lines second, de-duplicated by ``(name, payload)``.
    """
    if not tx:
        return None
    meta = tx.get("meta") or {}
    keys = _account_keys(tx)
    sig = signature or (tx.get("transaction") or {}).get("signatures", [None])[0]
    if not sig:
        return None

    sol_deltas, sol_balances = _sol_balances(tx, keys)
    decoded = DecodedTransaction(
        signature=sig,
        slot=int(tx.get("slot") or 0),
        block_time=tx.get("blockTime"),
        success=meta.get("err") is None,
        fee_payer=keys[0] if keys else None,
        account_keys=keys,
        error=meta.get("err"),
        sol_deltas=sol_deltas,
        sol_balances=sol_balances,
        token_deltas=_token_deltas(tx),
    )

    seen_payloads: set[bytes] = set()
    for ix, parent_index in _iter_instructions(tx):
        program_id = _program_id_for(ix, keys)
        if program_id:
            decoded.programs.add(program_id)
        data = ix.get("data")
        if not isinstance(data, str) or not data:
            continue
        if program_id in KNOWN_EVENT_PROGRAMS:
            name = decode_instruction_name(data)
            if name:
                decoded.instructions.append(name)
            try:
                raw = b58decode(data)
            except ValueError:
                raw = b""
            if raw and raw not in seen_payloads:
                event = decode_event_payload(raw)
                if event:
                    seen_payloads.add(raw)
                    decoded.events.append(
                        DecodedEvent(
                            name=event[0],
                            program_id=program_id,
                            fields=event[1],
                            signature=sig,
                            slot=decoded.slot,
                            block_time=decoded.block_time,
                            instruction_index=parent_index,
                        )
                    )

    for name, fields in decode_events_from_logs(meta.get("logMessages")):
        if any(e.name == name and e.fields == fields for e in decoded.events):
            continue
        decoded.events.append(
            DecodedEvent(
                name=name,
                program_id=None,
                fields=fields,
                signature=sig,
                slot=decoded.slot,
                block_time=decoded.block_time,
            )
        )

    # Log-only fallback for program detection when encoding hides program ids.
    for line in meta.get("logMessages") or []:
        if line.startswith("Program ") and " invoke [" in line:
            decoded.programs.add(line.split(" ")[1])

    return decoded
