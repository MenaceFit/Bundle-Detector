"""Provider hub: failover, coverage accounting, single entry point.

Analyzers depend on this class only.  Priority follows the spec:

    holders       Helius DAS  ->  Solscan  ->  RPC (top-20 only)
    metadata      Helius DAS  ->  Solscan  ->  on-chain CreateEvent
    everything    RPC (authoritative)

Whichever path answered is recorded in :class:`DataQuality`, so a report can
honestly say "holder coverage: partial" instead of pretending it saw
everything.
"""

from __future__ import annotations

from typing import Any

from app.config import Settings, get_settings
from app.providers.base import CoverageLevel, DataQuality, ProviderError, ProviderStatus
from app.providers.helius import HeliusProvider
from app.providers.rpc import SolanaRpcClient
from app.providers.solscan import SolscanProvider
from app.utils.logging import get_logger

log = get_logger("API")


class ProviderHub:
    """Owns every provider instance for the lifetime of a scan (or a bot)."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        cache: Any | None = None,
        quality: DataQuality | None = None,
        rpc: Any | None = None,
    ) -> None:
        """``rpc`` may be supplied to substitute the chain source.

        Production always leaves it unset and gets :class:`SolanaRpcClient`.
        The regression suite injects a replayable in-memory chain so the whole
        pipeline can be exercised deterministically without a live endpoint.
        """
        self.settings = settings or get_settings()
        self.quality = quality or DataQuality()
        self.cache = cache
        self.rpc = rpc or SolanaRpcClient(
            self.settings.rpc_endpoints,
            quality=self.quality,
            cache=cache,
            requests_per_second=self.settings.rpc_requests_per_second,
            max_concurrent=self.settings.max_concurrent_rpc,
        )
        self.helius = HeliusProvider(self.settings.helius_api_key, quality=self.quality, cache=cache)
        self.solscan = SolscanProvider(self.settings.solscan_api_key, quality=self.quality, cache=cache)

    async def aclose(self) -> None:
        closer = getattr(self.rpc, "aclose", None)
        if closer is not None:
            await closer()
        await self.helius.aclose()
        await self.solscan.aclose()

    async def __aenter__(self) -> ProviderHub:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    async def get_token_holders(self, mint: str, *, limit: int = 50) -> list[dict[str, Any]]:
        """Holder distribution with provider failover and honest coverage flags."""
        if self.helius.enabled:
            try:
                holders = await self.helius.get_token_holders(mint, limit=limit)
                if holders:
                    self.quality.set_coverage("holders", CoverageLevel.COMPLETE)
                    return holders
            except ProviderError as exc:
                log.warning("helius holders failed", mint=mint, error=str(exc))

        if self.solscan.enabled:
            holders = await self.solscan.get_token_holders(mint, limit=limit)
            if holders:
                self.quality.set_coverage("holders", CoverageLevel.COMPLETE)
                return holders

        try:
            holders = await self.rpc.get_token_holders(mint, limit=limit)
        except ProviderError as exc:
            log.warning("rpc holders failed", mint=mint, error=str(exc))
            self.quality.set_coverage("holders", CoverageLevel.MISSING, "holder list unavailable")
            return []
        # getTokenLargestAccounts is capped at 20 accounts by the RPC spec.
        self.quality.set_coverage(
            "holders",
            CoverageLevel.PARTIAL if holders else CoverageLevel.MISSING,
            "holders limited to the top 20 accounts (no Helius/Solscan key configured)"
            if holders
            else "holder list unavailable",
        )
        return holders

    async def get_token_metadata(self, mint: str) -> dict[str, Any] | None:
        """Off-chain metadata (name, symbol, image, socials)."""
        if self.helius.enabled:
            meta = await self.helius.get_token_metadata(mint)
            if meta:
                self.quality.set_coverage("social_data", CoverageLevel.COMPLETE)
                return meta
        if self.solscan.enabled:
            meta = await self.solscan.get_token_meta(mint)
            if meta:
                self.quality.set_coverage("social_data", CoverageLevel.PARTIAL)
                return {
                    "name": meta.get("name"),
                    "symbol": meta.get("symbol"),
                    "description": None,
                    "uri": meta.get("metadata_uri") or meta.get("uri"),
                    "image": meta.get("icon"),
                    "external_url": None,
                    "socials": {},
                    "supply": meta.get("supply"),
                    "decimals": meta.get("decimals"),
                    "source": "solscan",
                }
        self.quality.set_coverage("social_data", CoverageLevel.MISSING, "no metadata provider configured")
        return None

    async def get_account_label(self, address: str) -> str | None:
        """Provider-supplied label for an address (used to confirm CEX/infra)."""
        if not self.solscan.enabled:
            return None
        detail = await self.solscan.get_account_detail(address)
        if not detail:
            return None
        for key in ("account_label", "label", "name", "tag"):
            value = detail.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    # ------------------------------------------------------------------
    def provider_report(self) -> list[tuple[str, ProviderStatus]]:
        return [(name, health.status) for name, health in sorted(self.quality.providers.items())]
