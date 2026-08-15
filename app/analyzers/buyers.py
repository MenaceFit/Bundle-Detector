"""First-buyer engine (§10, §11, §18, §19, §20, §21).

Reconstructs the launch's trade tape in chronological order and derives the
early-activity views the rest of the engine depends on.

Cost strategy
-------------
Signature pages are cheap (1 000 signatures per call); transaction bodies are
expensive.  So the engine walks the bonding curve's signature history to its
oldest page first — signatures only — then reverses it and fetches *only* the
earliest transactions.  That is what makes "first 100 buyers" affordable on a
coin that already has tens of thousands of trades, and it is why the first
buyers are genuinely the first ones rather than the earliest ones inside an
arbitrary recent window.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from app.config import TIMELINE_CHECKPOINTS, AnalysisWindows
from app.models.enums import PairType
from app.models.token import TokenProfile
from app.models.wallet import TradeRecord
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import SOL_DECIMALS, quote_decimals, to_ui_amount
from app.pumpfun.events import DecodedEvent, DecodedTransaction, parse_transaction
from app.utils.logging import get_logger
from app.utils.stats import describe

log = get_logger("SCAN")

#: How many signature pages to walk before declaring history coverage partial.
MAX_SIGNATURE_PAGES = 60
#: Transactions fetched per buyer slot requested (some txs are not trades).
FETCH_MULTIPLIER = 2.0


@dataclass
class LaunchTape:
    """The launch's decoded activity, in chronological order."""

    mint: str
    trades: list[TradeRecord] = field(default_factory=list)
    creation_event: DecodedEvent | None = None
    graduation_events: list[DecodedEvent] = field(default_factory=list)
    all_events: list[DecodedEvent] = field(default_factory=list)
    transactions: dict[str, DecodedTransaction] = field(default_factory=dict)
    #: True when the whole trade history was reached (no page cap hit).
    complete_history: bool = True
    total_signatures: int = 0
    failed_transactions: int = 0

    @property
    def buys(self) -> list[TradeRecord]:
        return [t for t in self.trades if t.is_buy]

    @property
    def sells(self) -> list[TradeRecord]:
        return [t for t in self.trades if not t.is_buy]

    def first_buyers(self, limit: int) -> list[str]:
        """Distinct wallets in the order they first bought."""
        seen: list[str] = []
        for trade in self.buys:
            if trade.wallet not in seen:
                seen.append(trade.wallet)
                if len(seen) >= limit:
                    break
        return seen

    def trades_by_wallet(self) -> dict[str, list[TradeRecord]]:
        grouped: dict[str, list[TradeRecord]] = {}
        for trade in self.trades:
            grouped.setdefault(trade.wallet, []).append(trade)
        return grouped


class BuyerAnalyzer:
    def __init__(self, hub: ProviderHub, windows: AnalysisWindows | None = None) -> None:
        self.hub = hub
        self.windows = windows or AnalysisWindows()

    # ------------------------------------------------------------------
    async def build_tape(
        self,
        profile: TokenProfile,
        *,
        buyer_limit: int = 100,
        include_recent: int = 0,
    ) -> LaunchTape:
        """Fetch and decode the launch tape.

        ``include_recent`` additionally pulls the N most recent transactions so
        sell-behaviour and post-graduation analysis have data even on a coin
        whose early window is far in the past.
        """
        tape = LaunchTape(mint=profile.mint)
        curve = profile.bonding_curve
        if not curve:
            self.hub.quality.set_coverage("launch_trades", CoverageLevel.MISSING, "no bonding curve address")
            return tape

        signatures, complete = await self._collect_signatures(curve)
        tape.total_signatures = len(signatures)
        tape.complete_history = complete

        if not signatures:
            self.hub.quality.set_coverage(
                "launch_trades", CoverageLevel.MISSING, "no transactions found on the bonding curve"
            )
            return tape

        # Oldest-first: the launch window is at the tail of the paged results.
        chronological = list(reversed(signatures))
        target = max(1, int(buyer_limit * FETCH_MULTIPLIER))
        head = chronological[:target]
        tail = chronological[-include_recent:] if include_recent else []
        wanted = _dedupe([s.get("signature") for s in head + tail if s.get("signature")])

        await self._decode_into(tape, wanted)

        # PumpSwap activity lives on the pool, not the curve.
        pool = profile.graduation.pumpswap_pool
        if pool and include_recent:
            pool_sigs = await self._safe_signatures(pool, limit=min(include_recent, 1000))
            pool_wanted = [s["signature"] for s in pool_sigs if s.get("signature")]
            await self._decode_into(tape, pool_wanted, venue="pumpswap")

        tape.trades.sort(key=lambda t: (t.block_time or 0, t.slot, t.signature))
        for index, trade in enumerate(tape.trades):
            trade.trade_index = index

        creation_time = profile.creation_time or (
            tape.creation_event.get("timestamp") if tape.creation_event else None
        )
        if creation_time:
            for trade in tape.trades:
                if trade.block_time is not None:
                    trade.seconds_after_launch = max(0.0, float(trade.block_time - creation_time))

        level = CoverageLevel.COMPLETE if complete else CoverageLevel.PARTIAL
        self.hub.quality.set_coverage(
            "launch_trades",
            level,
            None
            if complete
            else "trade history exceeded the page limit; the earliest buyers may be incomplete",
        )
        log.info(
            "tape built",
            token=profile.mint,
            stage="buyers",
            trades=len(tape.trades),
            signatures=tape.total_signatures,
            complete=complete,
        )
        return tape

    # ------------------------------------------------------------------
    async def _collect_signatures(self, address: str) -> tuple[list[dict], bool]:
        collected: list[dict] = []
        before: str | None = None
        for _ in range(MAX_SIGNATURE_PAGES):
            page = await self._safe_signatures(address, limit=1000, before=before)
            if not page:
                return collected, True
            collected.extend(page)
            if len(page) < 1000:
                return collected, True
            before = page[-1].get("signature")
            if not before:
                return collected, True
        return collected, False

    async def _safe_signatures(self, address: str, *, limit: int, before: str | None = None) -> list[dict]:
        try:
            return await self.hub.rpc.get_signatures(address, limit=limit, before=before)
        except ProviderError as exc:
            log.warning("signature page failed", address=address, error=str(exc))
            return []

    async def _decode_into(self, tape: LaunchTape, signatures: list[str], venue: str = "bonding_curve") -> None:
        pending = [s for s in signatures if s not in tape.transactions]
        if not pending:
            return
        raw_map = await self.hub.rpc.get_transactions(pending)
        for signature, raw in raw_map.items():
            parsed = parse_transaction(raw, signature)
            if parsed is None:
                continue
            tape.transactions[signature] = parsed
            if not parsed.success:
                tape.failed_transactions += 1
                continue
            for event in parsed.events:
                tape.all_events.append(event)
                if event.name == "CreateEvent" and tape.creation_event is None:
                    tape.creation_event = event
                elif event.name in {"CompleteEvent", "CompletePumpAmmMigrationEvent"}:
                    tape.graduation_events.append(event)
                record = _trade_from_event(event, tape.mint, venue=venue)
                if record is not None:
                    tape.trades.append(record)


def _trade_from_event(event: DecodedEvent, mint: str, *, venue: str) -> TradeRecord | None:
    """Convert a decoded event into a :class:`TradeRecord`, or ``None``."""
    if event.name == "TradeEvent":
        if event.get("mint") != mint:
            return None
        quote_mint = event.get("quote_mint")
        decimals = quote_decimals(quote_mint)
        # Pre-USDC events only populate `sol_amount`; newer ones also carry
        # `quote_amount`. Prefer the explicit quote field when present.
        raw_quote = event.get("quote_amount")
        if not raw_quote:
            raw_quote = event.get("sol_amount")
            decimals = SOL_DECIMALS if not quote_mint else decimals
        return TradeRecord(
            wallet=event.get("user") or "",
            signature=event.signature or "",
            slot=event.slot or 0,
            block_time=event.get("timestamp") or event.block_time,
            is_buy=bool(event.get("is_buy")),
            quote_amount=to_ui_amount(raw_quote, decimals),
            token_amount=float(event.get("token_amount") or 0),
            mayhem=bool(event.get("mayhem_mode")),
            venue=venue,
        )

    if event.name in {"BuyEvent", "SellEvent"}:
        is_buy = event.name == "BuyEvent"
        raw_quote = event.get("quote_amount_in") if is_buy else event.get("quote_amount_out")
        raw_base = event.get("base_amount_out") if is_buy else event.get("base_amount_in")
        return TradeRecord(
            wallet=event.get("user") or "",
            signature=event.signature or "",
            slot=event.slot or 0,
            block_time=event.get("timestamp") or event.block_time,
            is_buy=is_buy,
            # PumpSwap events do not carry the quote mint; the caller knows the
            # pair from the pool, and SOL is the overwhelmingly common case.
            quote_amount=to_ui_amount(raw_quote, SOL_DECIMALS),
            token_amount=float(raw_base or 0),
            venue="pumpswap",
        )
    return None


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    return [x for x in items if not (x in seen or seen.add(x))]


# ---------------------------------------------------------------------------
# Derived views
# ---------------------------------------------------------------------------
def window_counts(tape: LaunchTape, windows: AnalysisWindows) -> dict[str, int]:
    """Distinct buyers inside each configured analysis window."""
    counts: dict[str, int] = {}
    for name, seconds in windows.as_ordered():
        wallets = {
            t.wallet
            for t in tape.buys
            if t.seconds_after_launch is not None and t.seconds_after_launch <= seconds
        }
        counts[name] = len(wallets)
    return counts


def timeline_counts(tape: LaunchTape) -> dict[str, int]:
    """Cumulative distinct buyers at each timeline checkpoint (§10)."""
    out: dict[str, int] = {}
    for checkpoint in TIMELINE_CHECKPOINTS:
        wallets = {
            t.wallet
            for t in tape.buys
            if t.seconds_after_launch is not None and t.seconds_after_launch <= checkpoint
        }
        out[f"T+{checkpoint}s"] = len(wallets)
    return out


def slot_analysis(tape: LaunchTape, *, first_n: int = 30) -> dict:
    """Slot co-occurrence among the earliest buys (§20).

    Same-slot inclusion is a strong hint of a single bundled submission, but it
    is *only* a hint: an atomic bundle and several independent snipers racing
    the same block look identical here.  The number is reported with that
    caveat and never treated as proof on its own.
    """
    buys = tape.buys[:first_n]
    if not buys:
        return {"buys_considered": 0}

    slots: dict[int, list[str]] = {}
    for trade in buys:
        slots.setdefault(trade.slot, []).append(trade.wallet)

    shared = {slot: wallets for slot, wallets in slots.items() if len(set(wallets)) > 1}
    ordered_slots = sorted(slots)
    gaps = [b - a for a, b in zip(ordered_slots, ordered_slots[1:], strict=False)]
    intervals = [
        b.block_time - a.block_time
        for a, b in zip(buys, buys[1:], strict=False)
        if a.block_time is not None and b.block_time is not None
    ]

    return {
        "buys_considered": len(buys),
        "distinct_slots": len(slots),
        "slots": ordered_slots[:20],
        "shared_slots": {str(slot): sorted(set(wallets)) for slot, wallets in shared.items()},
        "wallets_sharing_a_slot": len({w for wallets in shared.values() for w in wallets}),
        "adjacent_slot_pairs": sum(1 for g in gaps if g == 1),
        "median_slot_gap": describe(gaps).median if gaps else None,
        "median_interval_seconds": describe(intervals).median if intervals else None,
        "caveat": (
            "Buys sharing a slot were included in the same block. That is consistent with an atomic "
            "bundle, but also with independent snipers competing for the same block."
        ),
    }


def purchase_distribution(tape: LaunchTape, *, first_n: int = 50) -> dict:
    """Descriptive stats of early buy sizes (§18)."""
    amounts = [t.quote_amount for t in tape.buys[:first_n] if t.quote_amount > 0]
    return describe(amounts).as_dict()


def transaction_order(tape: LaunchTape, *, first_n: int = 20) -> list[dict]:
    """Ordered reconstruction of the earliest transactions (§21)."""
    rows: list[dict] = []
    for index, trade in enumerate(tape.buys[:first_n], start=1):
        parsed = tape.transactions.get(trade.signature)
        rows.append(
            {
                "position": index,
                "wallet": trade.wallet,
                "signature": trade.signature,
                "slot": trade.slot,
                "block_time": trade.block_time,
                "seconds_after_launch": trade.seconds_after_launch,
                "quote_amount": trade.quote_amount,
                "instructions": parsed.instructions if parsed else [],
                "programs": sorted(parsed.programs) if parsed else [],
                "account_count": len(parsed.account_keys) if parsed else None,
            }
        )
    return rows


def pair_of(profile: TokenProfile) -> str:
    return profile.pair.value if profile.pair is not PairType.UNKNOWN else "UNKNOWN"


def launch_age_seconds(profile: TokenProfile) -> float | None:
    if profile.creation_time is None:
        return None
    return max(0.0, time.time() - profile.creation_time)
