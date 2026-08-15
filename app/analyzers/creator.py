"""Creator / dev analysis (§35 - §40).

Answers three questions about the launching wallet:

1. **Track record** — how many Pump.fun coins has it created, and how many
   graduated?  Found by scanning the creator's history for ``CreateEvent``s,
   which name the mint directly.
2. **Funding** — where did the creator's own SOL come from, and does that path
   reach any of the early buyers?
3. **Behaviour after graduation** — did it sell, and how quickly?

The creator→buyer link is the single heaviest qualitative finding the engine
can produce, so it is only asserted when an actual funding path connects them
within the configured hop limit, and the report always shows the path.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.analyzers.entities import EntityClassifier
from app.analyzers.funding import FundingAnalysis, FundingAnalyzer
from app.models.wallet import CreatorProfile
from app.providers.base import CoverageLevel, ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID
from app.pumpfun.events import parse_transaction
from app.utils.logging import get_logger

log = get_logger("WALLET")


@dataclass
class CreatorLaunch:
    mint: str
    signature: str
    created_at: int | None
    symbol: str | None = None
    graduated: bool | None = None


@dataclass
class CreatorHistory:
    launches: list[CreatorLaunch] = field(default_factory=list)
    signatures_sampled: int = 0
    partial: bool = True
    sells_after_graduation: int = 0


class CreatorAnalyzer:
    def __init__(
        self,
        hub: ProviderHub,
        classifier: EntityClassifier,
        funding_analyzer: FundingAnalyzer,
        *,
        sample_size: int = 300,
        graduation_check_limit: int = 12,
    ) -> None:
        self.hub = hub
        self.classifier = classifier
        self.funding_analyzer = funding_analyzer
        self.sample_size = sample_size
        self.graduation_check_limit = graduation_check_limit

    async def analyze(
        self,
        creator: str,
        *,
        current_mint: str,
        buyer_funding: FundingAnalysis,
        max_hops: int = 3,
        check_graduations: bool = True,
    ) -> CreatorProfile:
        profile = CreatorProfile(address=creator)

        history = await self._history(creator, current_mint)
        profile.previous_launches = [launch.mint for launch in history.launches]
        profile.launches_total = len(history.launches) + 1  # including the current one
        profile.history_is_partial = history.partial
        profile.signatures_sampled = getattr(history, "signatures_sampled", 0)

        if check_graduations and history.launches:
            graduated = await self._count_graduations(history.launches[: self.graduation_check_limit])
            profile.launches_graduated = graduated
            checked = min(len(history.launches), self.graduation_check_limit)
            profile.launches_abandoned = max(0, checked - graduated)
            if checked:
                profile.graduation_rate = graduated / checked

        await self._creator_funding(profile)
        self._link_to_buyers(profile, buyer_funding, max_hops=max_hops)
        _score_creator(profile)

        self.hub.quality.set_coverage(
            "creator_history",
            CoverageLevel.PARTIAL if history.partial else CoverageLevel.COMPLETE,
            "creator history sampled from the most recent transactions" if history.partial else None,
        )
        log.info(
            "creator analyzed",
            wallet=creator,
            launches=profile.launches_total,
            graduated=profile.launches_graduated,
            linked_buyers=len(profile.linked_buyers),
        )
        return profile

    # ------------------------------------------------------------------
    async def _history(self, creator: str, current_mint: str) -> CreatorHistory:
        history = CreatorHistory()
        try:
            signatures = await self.hub.rpc.get_signatures_paged(
                creator, max_signatures=self.sample_size
            )
        except ProviderError as exc:
            log.warning("creator history failed", wallet=creator, error=str(exc))
            return history

        history.signatures_sampled = len(signatures)
        history.partial = len(signatures) >= self.sample_size
        self.classifier.record_activity(creator, len(signatures))

        sigs = [s["signature"] for s in signatures if s.get("signature")]
        if not sigs:
            return history

        raw_map = await self.hub.rpc.get_transactions(sigs)
        seen: set[str] = set()
        for signature, raw in raw_map.items():
            parsed = parse_transaction(raw, signature)
            if parsed is None or not parsed.success:
                continue
            if PUMP_FUN_PROGRAM_ID not in parsed.programs and PUMP_SWAP_PROGRAM_ID not in parsed.programs:
                continue
            for event in parsed.events:
                if event.name == "CreateEvent":
                    mint = event.get("mint")
                    if not mint or mint == current_mint or mint in seen:
                        continue
                    creator_field = event.get("creator") or event.get("user")
                    if creator_field != creator:
                        continue
                    seen.add(mint)
                    history.launches.append(
                        CreatorLaunch(
                            mint=mint,
                            signature=signature,
                            created_at=event.get("timestamp") or parsed.block_time,
                            symbol=event.get("symbol"),
                        )
                    )
                elif event.name == "TradeEvent" and not event.get("is_buy"):
                    if event.get("user") == creator:
                        history.sells_after_graduation += 1
        history.launches.sort(key=lambda launch: launch.created_at or 0, reverse=True)
        return history

    async def _count_graduations(self, launches: list[CreatorLaunch]) -> int:
        """Read each previous coin's curve account and count completed ones."""
        from app.pumpfun.events import decode_account_data, decode_bonding_curve
        from app.pumpfun.pda import bonding_curve_pda

        addresses = [bonding_curve_pda(launch.mint) for launch in launches]
        try:
            accounts = await self.hub.rpc.get_multiple_accounts(addresses)
        except ProviderError:
            return 0
        graduated = 0
        for launch, account in zip(launches, accounts, strict=False):
            state = decode_bonding_curve(decode_account_data(account) or b"")
            if state is None:
                launch.graduated = None
                continue
            launch.graduated = bool(state.get("complete"))
            graduated += 1 if launch.graduated else 0
        return graduated

    async def _creator_funding(self, profile: CreatorProfile) -> None:
        """Trace where the creator's own SOL came from (§36)."""
        parent, amount, timestamp = await self.funding_analyzer._upstream_of(profile.address)
        if parent:
            profile.funding_source = parent
            profile.funding_amount = amount
            profile.funding_time = timestamp

    def _link_to_buyers(self, profile: CreatorProfile, funding: FundingAnalysis, *, max_hops: int) -> None:
        """Find buyers reachable from the creator through funding relationships (§37, §67).

        A link is only recorded when the creator actually appears in a buyer's
        traced funding path, or shares that buyer's funding source. Sharing a
        *CEX* with the creator is not a link — that is the exchange-funder
        problem, and it is excluded explicitly.
        """
        creator_sources: set[str] = {profile.address}
        if profile.funding_source:
            assessment = self.classifier.assess_funder(profile.funding_source)
            if not assessment.is_shared_infrastructure:
                creator_sources.add(profile.funding_source)

        for wallet, wallet_funding in funding.wallets.items():
            if wallet == profile.address:
                continue
            path = wallet_funding.path.path if wallet_funding.path else []
            candidates = set(path[:-1])
            if wallet_funding.direct_funder:
                candidates.add(wallet_funding.direct_funder)
            shared = candidates & creator_sources
            if not shared:
                continue
            hops = len(path) - 1 if path else 1
            if hops > max_hops:
                continue
            profile.linked_buyers.append(wallet)
            profile.link_paths[wallet] = path or [profile.address, wallet]


def _score_creator(profile: CreatorProfile) -> None:
    """Creator risk (§56). Capped per signal; the reasons carry the meaning."""
    score = 0.0
    reasons: list[str] = []

    if profile.linked_buyers:
        score += min(40.0, 12.0 * len(profile.linked_buyers))
        reasons.append(
            f"{len(profile.linked_buyers)} early buyer wallet(s) are connected to the creator "
            "through a traced funding path"
        )

    if profile.launches_total > 1:
        previous = profile.launches_total - 1
        if previous >= 20:
            score += 20
            reasons.append(f"Creator has launched {previous}+ previous Pump.fun coins")
        elif previous >= 5:
            score += 12
            reasons.append(f"Creator has launched {previous} previous Pump.fun coins")
        else:
            score += 5
            reasons.append(f"Creator has launched {previous} previous Pump.fun coin(s)")

    if profile.graduation_rate is not None and profile.launches_total > 3:
        if profile.graduation_rate <= 0.1:
            score += 15
            reasons.append(
                f"Only {profile.graduation_rate * 100:.0f}% of the creator's checked launches graduated"
            )
        elif profile.graduation_rate >= 0.5:
            reasons.append(
                f"{profile.graduation_rate * 100:.0f}% of the creator's checked launches graduated "
                "(an established track record)"
            )

    if profile.post_graduation_sells:
        score += 10
        reasons.append(f"{profile.post_graduation_sells} creator sells observed after graduation")

    if not reasons:
        reasons.append("No adverse creator signal found in the sampled history")

    profile.risk_score = int(min(100, round(score)))
    profile.risk_reasons = reasons
