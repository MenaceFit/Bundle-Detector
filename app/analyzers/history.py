"""Historical Pump.fun behaviour per wallet (§31, §32, §33, §34).

Two questions matter here:

* Has this wallet done this before — how many Pump.fun launches has it traded,
  and how early does it usually enter?
* Do these wallets keep showing up *together* on other launches?

Measuring "entered within 10 seconds" exactly would require the creation
timestamp of every historical token — one extra lookup per token per wallet,
which does not fit a 15-second scan.  Instead the engine reads a quantity that
is already inside every ``TradeEvent``: the bonding curve's remaining real
token reserves at the moment of the trade.  Dividing by the launch's initial
reserves gives **entry depth** — the fraction of the curve already sold when
the wallet bought.  An entry depth of 0.001 means the wallet bought into the
first tenth of a percent of the curve, which is a stronger and cheaper
statement than a wall-clock estimate.

Exact second-level entry timing is still produced, for the tokens whose
creation time is already known (cached in the database from earlier scans, or
resolved on demand during a deep scan).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.wallet import WalletProfile
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import LAMPORTS_PER_SOL, PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID
from app.pumpfun.events import parse_transaction
from app.utils.concurrency import gather_limited
from app.utils.logging import get_logger
from app.utils.stats import overlap_coefficient

log = get_logger("WALLET")

#: Entry-depth thresholds, chosen to mirror the "seconds after launch" buckets
#: the spec asks for: the first ~0.5% of a curve is typically the first seconds.
ULTRA_EARLY_DEPTH = 0.005
EARLY_DEPTH = 0.02
MODERATE_DEPTH = 0.10


@dataclass
class LaunchParticipation:
    """One historical Pump.fun trade by a wallet."""

    mint: str
    signature: str
    block_time: int | None
    is_buy: bool
    quote_amount: float
    entry_depth: float | None = None


@dataclass
class WalletHistory:
    """A wallet's Pump.fun track record, as far as the sample reached."""

    wallet: str
    launches: set[str] = field(default_factory=set)
    participations: list[LaunchParticipation] = field(default_factory=list)
    ultra_early_entries: int = 0
    early_entries: int = 0
    moderate_entries: int = 0
    signatures_sampled: int = 0
    #: True when the sample was capped, so counts are lower bounds.
    partial: bool = True
    first_seen: int | None = None

    @property
    def launch_count(self) -> int:
        return len(self.launches)

    @property
    def early_ratio(self) -> float:
        if not self.launches:
            return 0.0
        return self.ultra_early_entries / len(self.launches)

    def classify(self) -> str:
        """Behavioural label. Being a specialist is not itself suspicious (§32)."""
        if self.launch_count == 0:
            return "NO PUMP.FUN HISTORY"
        if self.launch_count >= 20 and self.early_ratio >= 0.4:
            return "EARLY-LAUNCH SPECIALIST"
        if self.launch_count >= 20:
            return "RECURRING LAUNCH TRADER"
        if self.launch_count >= 5:
            return "OCCASIONAL LAUNCH TRADER"
        return "OCCASIONAL TRADER"


@dataclass
class HistoryAnalysis:
    wallets: dict[str, WalletHistory] = field(default_factory=dict)
    #: mint -> wallets from this scan that also traded it.
    shared_launches: dict[str, list[str]] = field(default_factory=dict)
    coverage: float = 0.0

    def co_occurrence(self, a: str, b: str) -> float:
        """Overlap of two wallets' historical launch sets."""
        ha, hb = self.wallets.get(a), self.wallets.get(b)
        if not ha or not hb:
            return 0.0
        return overlap_coefficient(ha.launches, hb.launches)

    def recurring_groups(self, *, min_wallets: int = 3) -> dict[str, list[str]]:
        """Tokens where several of this scan's wallets appeared together (§33)."""
        return {
            mint: sorted(wallets)
            for mint, wallets in self.shared_launches.items()
            if len(set(wallets)) >= min_wallets
        }


class HistoryAnalyzer:
    def __init__(
        self,
        hub: ProviderHub,
        *,
        sample_size: int = 100,
        max_wallets: int = 40,
        concurrency: int = 6,
        initial_real_tokens: int | None = None,
    ) -> None:
        self.hub = hub
        self.sample_size = sample_size
        self.max_wallets = max_wallets
        self.concurrency = concurrency
        self.initial_real_tokens = initial_real_tokens

    async def analyze(self, wallets: list[str], *, current_mint: str) -> HistoryAnalysis:
        analysis = HistoryAnalysis()
        targets = wallets[: self.max_wallets]
        if not targets:
            return analysis

        results = await gather_limited(
            [self._history_of(wallet, current_mint) for wallet in targets], limit=self.concurrency
        )
        for wallet, result in zip(targets, results, strict=False):
            if isinstance(result, BaseException):
                log.debug("history failed", wallet=wallet, error=str(result))
                continue
            analysis.wallets[wallet] = result
            for mint in result.launches:
                analysis.shared_launches.setdefault(mint, []).append(wallet)

        analysis.coverage = len(analysis.wallets) / len(wallets) if wallets else 0.0
        level = (
            CoverageLevel.COMPLETE
            if analysis.coverage >= 0.8
            else CoverageLevel.PARTIAL
            if analysis.coverage > 0
            else CoverageLevel.MISSING
        )
        self.hub.quality.set_coverage(
            "historical",
            level,
            f"Pump.fun history sampled for {len(analysis.wallets)}/{len(wallets)} wallets "
            f"({self.sample_size} most recent transactions each)",
        )
        log.info("history analyzed", wallets=len(analysis.wallets), launches=len(analysis.shared_launches))
        return analysis

    # ------------------------------------------------------------------
    async def _history_of(self, wallet: str, current_mint: str) -> WalletHistory:
        history = WalletHistory(wallet=wallet)
        try:
            signatures = await self.hub.rpc.get_signatures(wallet, limit=self.sample_size)
        except ProviderError as exc:
            log.debug("history signatures failed", wallet=wallet, error=str(exc))
            return history

        history.signatures_sampled = len(signatures)
        history.partial = len(signatures) >= self.sample_size
        if signatures:
            history.first_seen = signatures[-1].get("blockTime")
        sigs = [s["signature"] for s in signatures if s.get("signature")]
        if not sigs:
            return history

        raw_map = await self.hub.rpc.get_transactions(sigs)
        for signature, raw in raw_map.items():
            parsed = parse_transaction(raw, signature)
            if parsed is None or not parsed.success:
                continue
            if not (PUMP_FUN_PROGRAM_ID in parsed.programs or PUMP_SWAP_PROGRAM_ID in parsed.programs):
                continue
            for event in parsed.events:
                participation = self._participation(event, wallet)
                if participation is None or participation.mint == current_mint:
                    continue
                history.launches.add(participation.mint)
                history.participations.append(participation)
                depth = participation.entry_depth
                if depth is None:
                    continue
                if depth <= ULTRA_EARLY_DEPTH:
                    history.ultra_early_entries += 1
                elif depth <= EARLY_DEPTH:
                    history.early_entries += 1
                elif depth <= MODERATE_DEPTH:
                    history.moderate_entries += 1
        return history

    def _participation(self, event, wallet: str) -> LaunchParticipation | None:
        if event.name != "TradeEvent" or event.get("user") != wallet:
            return None
        mint = event.get("mint")
        if not mint:
            return None
        depth = None
        remaining = event.get("real_token_reserves")
        if remaining is not None and self.initial_real_tokens:
            depth = max(0.0, min(1.0, 1.0 - (remaining / self.initial_real_tokens)))
        return LaunchParticipation(
            mint=mint,
            signature=event.signature or "",
            block_time=event.get("timestamp") or event.block_time,
            is_buy=bool(event.get("is_buy")),
            quote_amount=(event.get("sol_amount") or 0) / LAMPORTS_PER_SOL,
            entry_depth=depth,
        )


def apply_history(profiles: dict[str, WalletProfile], analysis: HistoryAnalysis) -> None:
    """Fold history results back into the wallet profiles."""
    for wallet, history in analysis.wallets.items():
        profile = profiles.get(wallet)
        if profile is None:
            continue
        profile.pumpfun_launches = history.launch_count
        profile.pumpfun_launches_sampled = sorted(history.launches)[:25]
        profile.early_entries_10s = history.ultra_early_entries
        profile.early_entries_30s = history.early_entries
        profile.early_entries_60s = history.moderate_entries
        profile.history_is_partial = history.partial
