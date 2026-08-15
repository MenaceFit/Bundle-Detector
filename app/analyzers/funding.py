"""Funding analysis (§14 - §17, §22, §24, §25).

For every early buyer the engine walks backwards from that wallet's first
purchase and answers: where did the money come from, when did it arrive, and
how much was it?

The source of truth is the **native balance delta** recorded in each
transaction's metadata, not a parsed "transfer" instruction.  Deltas capture
value movement regardless of how it was routed — a plain system transfer, a
CPI from a program, a token-account close — so a funder cannot hide behind an
unusual instruction shape.  Token (USDC) funding is read from the pre/post
token balances the same way.

Multi-hop tracing (§24) follows ``A -> X -> B`` and ``A -> X -> Y -> B`` up to
``max_funding_hops``, and stops as soon as it reaches an exchange or piece of
infrastructure: an exchange's own funder is not part of anyone's bundle.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from app.analyzers.entities import EntityClassifier
from app.models.enums import EntityType
from app.models.wallet import FundingEvent, FundingPath, TradeRecord
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import LAMPORTS_PER_SOL, USDC_DECIMALS, USDC_MINT
from app.pumpfun.events import DecodedTransaction, parse_transaction
from app.utils.concurrency import gather_limited
from app.utils.logging import get_logger

log = get_logger("FUNDING")

#: How many transactions before the first buy to inspect for inflows.
DEFAULT_LOOKBACK = 20
#: Minimum SOL inflow that counts as "funding" (below this is dust/rent).
MIN_SOL_FUNDING = 0.001
#: Minimum USDC inflow that counts as funding.
MIN_USDC_FUNDING = 0.5


@dataclass
class WalletFunding:
    """Funding facts for one wallet."""

    wallet: str
    events: list[FundingEvent] = field(default_factory=list)
    direct_funder: str | None = None
    funding_amount: float | None = None
    funding_time: int | None = None
    funding_to_buy_seconds: float | None = None
    asset: str = "SOL"
    path: FundingPath | None = None
    balance_before_funding: float | None = None
    balance_after_funding: float | None = None
    #: True when we could see the wallet's pre-buy history at all.
    observed: bool = False


@dataclass
class FundingAnalysis:
    """Funding view of the whole buyer set."""

    wallets: dict[str, WalletFunding] = field(default_factory=dict)
    #: direct funder -> wallets it funded (only wallets in this scan).
    funder_groups: dict[str, list[str]] = field(default_factory=dict)
    #: any address appearing anywhere in a funding path -> wallets downstream.
    intermediary_groups: dict[str, list[str]] = field(default_factory=dict)
    coverage: float = 0.0

    def funded_wallets(self) -> list[str]:
        return [w for w, f in self.wallets.items() if f.direct_funder]

    def largest_funder_group(self, exclude_infrastructure: set[str] | None = None) -> tuple[str | None, list[str]]:
        excluded = exclude_infrastructure or set()
        best: tuple[str | None, list[str]] = (None, [])
        for funder, members in self.funder_groups.items():
            if funder in excluded:
                continue
            if len(members) > len(best[1]):
                best = (funder, members)
        return best


class FundingAnalyzer:
    def __init__(
        self,
        hub: ProviderHub,
        classifier: EntityClassifier,
        *,
        max_hops: int = 3,
        lookback: int = DEFAULT_LOOKBACK,
        concurrency: int = 8,
    ) -> None:
        self.hub = hub
        self.classifier = classifier
        self.max_hops = max(1, max_hops)
        self.lookback = lookback
        self.concurrency = concurrency
        self._path_cache: dict[str, tuple[str | None, float, int | None]] = {}

    # ------------------------------------------------------------------
    async def analyze(
        self, first_buys: dict[str, TradeRecord], *, trace_hops: bool = True
    ) -> FundingAnalysis:
        analysis = FundingAnalysis()
        if not first_buys:
            return analysis

        results = await gather_limited(
            [self._analyze_wallet(wallet, trade) for wallet, trade in first_buys.items()],
            limit=self.concurrency,
        )
        for result in results:
            if isinstance(result, BaseException):
                log.warning("wallet funding failed", error=str(result))
                continue
            analysis.wallets[result.wallet] = result

        for wallet, funding in analysis.wallets.items():
            if funding.direct_funder:
                analysis.funder_groups.setdefault(funding.direct_funder, []).append(wallet)
                self.classifier.record_funding(funding.direct_funder, wallet)

        if trace_hops:
            await self._trace_paths(analysis)

        for wallet, funding in analysis.wallets.items():
            if not funding.path:
                continue
            for hop_address in funding.path.path[:-1]:
                analysis.intermediary_groups.setdefault(hop_address, []).append(wallet)
                self.classifier.record_funding(hop_address, wallet)

        observed = sum(1 for f in analysis.wallets.values() if f.observed)
        analysis.coverage = observed / len(analysis.wallets) if analysis.wallets else 0.0
        level = (
            CoverageLevel.COMPLETE
            if analysis.coverage >= 0.8
            else CoverageLevel.PARTIAL
            if analysis.coverage > 0.2
            else CoverageLevel.MISSING
        )
        self.hub.quality.set_coverage(
            "funding",
            level,
            None
            if level is CoverageLevel.COMPLETE
            else f"pre-purchase history was readable for {observed}/{len(analysis.wallets)} wallets",
        )
        log.info(
            "funding analyzed",
            wallets=len(analysis.wallets),
            funded=len(analysis.funded_wallets()),
            funders=len(analysis.funder_groups),
        )
        return analysis

    # ------------------------------------------------------------------
    async def _analyze_wallet(self, wallet: str, first_buy: TradeRecord) -> WalletFunding:
        funding = WalletFunding(wallet=wallet)
        try:
            signatures = await self.hub.rpc.get_signatures(
                wallet, limit=self.lookback, before=first_buy.signature or None
            )
        except ProviderError as exc:
            log.debug("pre-buy history failed", wallet=wallet, error=str(exc))
            return funding

        funding.observed = True
        if not signatures:
            # The first buy is the wallet's first ever transaction: it was
            # funded inside the buy transaction itself, or paid by another
            # signer. Inspect the buy transaction to find out which.
            await self._inspect_buy_transaction(funding, first_buy)
            return funding

        sigs = [s["signature"] for s in signatures if s.get("signature")]
        raw_map = await self.hub.rpc.get_transactions(sigs)
        parsed_list = [
            parsed
            for sig, raw in raw_map.items()
            if (parsed := parse_transaction(raw, sig)) is not None and parsed.success
        ]
        parsed_list.sort(key=lambda p: (p.block_time or 0, p.slot), reverse=True)

        for parsed in parsed_list:
            event = _inflow_event(parsed, wallet)
            if event is None:
                continue
            if first_buy.block_time is not None and event.block_time is not None:
                event.seconds_before_buy = float(first_buy.block_time - event.block_time)
            funding.events.append(event)

        if funding.events:
            # The most recent inflow before the buy is the operative funding.
            primary = funding.events[0]
            funding.direct_funder = primary.source
            funding.funding_amount = primary.amount
            funding.funding_time = primary.block_time
            funding.funding_to_buy_seconds = primary.seconds_before_buy
            funding.asset = primary.asset
            funding.balance_before_funding = primary.recipient_balance_before
            funding.balance_after_funding = primary.recipient_balance_after
        else:
            await self._inspect_buy_transaction(funding, first_buy)
        return funding

    async def _inspect_buy_transaction(self, funding: WalletFunding, first_buy: TradeRecord) -> None:
        """Handle wallets whose very first transaction is the buy itself.

        Funding delivered inside the same transaction is a strong pattern, so
        it must be captured rather than recorded as "no funding found".
        """
        if not first_buy.signature:
            return
        raw = await self.hub.rpc.get_transaction(first_buy.signature)
        parsed = parse_transaction(raw, first_buy.signature)
        if parsed is None:
            return
        funding.observed = True
        if parsed.fee_payer and parsed.fee_payer != funding.wallet:
            # Someone else paid for and signed this wallet's purchase.
            funding.direct_funder = parsed.fee_payer
            funding.funding_time = parsed.block_time
            funding.funding_to_buy_seconds = 0.0
            funding.funding_amount = abs(parsed.sol_deltas.get(parsed.fee_payer, 0)) / LAMPORTS_PER_SOL
            funding.events.append(
                FundingEvent(
                    recipient=funding.wallet,
                    source=parsed.fee_payer,
                    signature=parsed.signature,
                    slot=parsed.slot,
                    block_time=parsed.block_time,
                    amount=funding.funding_amount or 0.0,
                    asset="SOL",
                    seconds_before_buy=0.0,
                    hop=1,
                )
            )

    # ------------------------------------------------------------------
    async def _trace_paths(self, analysis: FundingAnalysis) -> None:
        """Follow each direct funder upstream, up to ``max_hops``."""
        direct_funders = {
            f.direct_funder for f in analysis.wallets.values() if f.direct_funder
        }
        upstream: dict[str, tuple[str | None, float, int | None]] = {}
        if direct_funders and self.max_hops > 1:
            ordered = sorted(direct_funders)
            results = await gather_limited(
                [self._upstream_of(addr) for addr in ordered], limit=self.concurrency
            )
            for addr, result in zip(ordered, results, strict=False):
                upstream[addr] = (None, 0.0, None) if isinstance(result, BaseException) else result

        for wallet, funding in analysis.wallets.items():
            if not funding.direct_funder:
                continue
            chain = [funding.direct_funder]
            signatures = [e.signature for e in funding.events[:1]]
            current = funding.direct_funder
            for _ in range(self.max_hops - 1):
                assessment = self.classifier.assess_funder(current)
                if assessment.entity_type in {EntityType.CEX} or assessment.entity_type.is_infrastructure:
                    break
                parent, _amount, _ts = upstream.get(current, (None, 0.0, None))
                if not parent or parent in chain:
                    break
                chain.append(parent)
                current = parent

            root = chain[-1]
            funding.path = FundingPath(
                wallet=wallet,
                path=[*list(reversed(chain)), wallet],
                signatures=[s for s in signatures if s],
                root=root,
                root_type=self.classifier.assess_funder(root).entity_type,
                hops=len(chain),
                total_amount=funding.funding_amount or 0.0,
                asset=funding.asset,
            )

    async def _upstream_of(self, address: str) -> tuple[str | None, float, int | None]:
        """Most recent significant inflow into ``address`` (its own funder)."""
        if address in self._path_cache:
            return self._path_cache[address]
        result: tuple[str | None, float, int | None] = (None, 0.0, None)
        try:
            signatures = await self.hub.rpc.get_signatures(address, limit=self.lookback)
        except ProviderError:
            self._path_cache[address] = result
            return result
        self.classifier.record_activity(address, len(signatures))
        sigs = [s["signature"] for s in signatures if s.get("signature")]
        if sigs:
            raw_map = await self.hub.rpc.get_transactions(sigs)
            parsed_list = [
                parsed
                for sig, raw in raw_map.items()
                if (parsed := parse_transaction(raw, sig)) is not None and parsed.success
            ]
            parsed_list.sort(key=lambda p: (p.block_time or 0, p.slot), reverse=True)
            for parsed in parsed_list:
                event = _inflow_event(parsed, address)
                if event and event.source:
                    result = (event.source, event.amount, event.block_time)
                    break
        self._path_cache[address] = result
        return result


# ---------------------------------------------------------------------------
# Inflow extraction
# ---------------------------------------------------------------------------
def _inflow_event(parsed: DecodedTransaction, wallet: str) -> FundingEvent | None:
    """Extract a value inflow into ``wallet`` from a decoded transaction.

    Returns ``None`` when the transaction moved no meaningful value into the
    wallet — outbound transfers, program interactions and dust are ignored.
    """
    sol_delta = parsed.sol_deltas.get(wallet, 0)
    sol_amount = sol_delta / LAMPORTS_PER_SOL
    if sol_amount >= MIN_SOL_FUNDING:
        source = _largest_payer(parsed, exclude=wallet)
        before, after = parsed.sol_balances.get(wallet, (None, None))
        return FundingEvent(
            recipient=wallet,
            source=source,
            signature=parsed.signature,
            slot=parsed.slot,
            block_time=parsed.block_time,
            amount=sol_amount,
            asset="SOL",
            hop=1,
            recipient_balance_before=None if before is None else before / LAMPORTS_PER_SOL,
            recipient_balance_after=None if after is None else after / LAMPORTS_PER_SOL,
        )

    usdc_delta = parsed.token_deltas.get((wallet, USDC_MINT), 0)
    usdc_amount = usdc_delta / (10**USDC_DECIMALS)
    if usdc_amount >= MIN_USDC_FUNDING:
        source = _largest_token_payer(parsed, USDC_MINT, exclude=wallet)
        return FundingEvent(
            recipient=wallet,
            source=source,
            signature=parsed.signature,
            slot=parsed.slot,
            block_time=parsed.block_time,
            amount=usdc_amount,
            asset="USDC",
            hop=1,
        )
    return None


def _largest_payer(parsed: DecodedTransaction, *, exclude: str) -> str | None:
    """The account that lost the most SOL — the payer of an inflow."""
    candidates = [
        (address, delta)
        for address, delta in parsed.sol_deltas.items()
        if delta < 0 and address != exclude
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[1])[0]


def _largest_token_payer(parsed: DecodedTransaction, mint: str, *, exclude: str) -> str | None:
    candidates = [
        (owner, delta)
        for (owner, token_mint), delta in parsed.token_deltas.items()
        if token_mint == mint and delta < 0 and owner != exclude
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[1])[0]


async def measure_balances(hub: ProviderHub, wallets: list[str]) -> dict[str, float]:
    """Current SOL balance for each wallet (§22)."""
    if not wallets:
        return {}
    try:
        raw = await hub.rpc.get_balances(wallets)
    except ProviderError:
        return {}
    return {address: lamports / LAMPORTS_PER_SOL for address, lamports in raw.items()}


async def sleep_yield() -> None:  # pragma: no cover - scheduling helper
    await asyncio.sleep(0)
