"""New-launch feed (§94).

Two sources, in order of preference:

* **WebSocket** ``logsSubscribe`` on the Pump program — sub-second latency, and
  the reason the architecture can meet the "detect within the first seconds"
  requirement rather than relying on periodic scraping.
* **Polling** ``getSignaturesForAddress`` on the Pump program — a fallback for
  endpoints without WebSocket support, or when the socket drops.

Both yield the same :class:`NewLaunch` records, so the consumer never has to
care which path produced them.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

from app.providers.base import ProviderError
from app.providers.registry import ProviderHub
from app.pumpfun.constants import PUMP_FUN_PROGRAM_ID
from app.pumpfun.events import decode_events_from_logs, parse_transaction
from app.utils.logging import get_logger

log = get_logger("WATCH")

#: Seconds between polls when running in fallback mode.
POLL_INTERVAL = 6.0
#: Signatures pulled per poll.
POLL_LIMIT = 60


@dataclass(slots=True)
class NewLaunch:
    mint: str
    creator: str | None
    symbol: str | None
    name: str | None
    signature: str
    block_time: int | None
    mayhem: bool = False
    source: str = "poll"


class LaunchFeed:
    """Emits newly created Pump.fun coins."""

    def __init__(self, hub: ProviderHub, *, ws_url: str | None = None) -> None:
        self.hub = hub
        self.ws_url = ws_url
        self._seen: set[str] = set()

    async def stream(self) -> AsyncIterator[NewLaunch]:
        if self.ws_url:
            try:
                async for launch in self._stream_ws():
                    yield launch
                return
            except Exception as exc:  # noqa: BLE001 - fall back to polling
                log.warning("websocket feed unavailable, falling back to polling", error=str(exc))
        async for launch in self._stream_poll():
            yield launch

    # ------------------------------------------------------------------
    async def _stream_ws(self) -> AsyncIterator[NewLaunch]:
        import websockets

        subscribe = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "logsSubscribe",
                "params": [{"mentions": [PUMP_FUN_PROGRAM_ID]}, {"commitment": "confirmed"}],
            }
        )
        async with websockets.connect(self.ws_url, ping_interval=20, max_size=8_000_000) as socket:
            await socket.send(subscribe)
            log.info("websocket subscribed", program=PUMP_FUN_PROGRAM_ID)
            while True:
                raw = await socket.recv()
                try:
                    message = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                value = ((message.get("params") or {}).get("result") or {}).get("value") or {}
                logs = value.get("logs")
                signature = value.get("signature")
                if not logs or not signature or signature in self._seen:
                    continue
                for name, fields in decode_events_from_logs(logs):
                    if name != "CreateEvent":
                        continue
                    self._seen.add(signature)
                    yield NewLaunch(
                        mint=fields.get("mint", ""),
                        creator=fields.get("creator") or fields.get("user"),
                        symbol=fields.get("symbol"),
                        name=fields.get("name"),
                        signature=signature,
                        block_time=fields.get("timestamp"),
                        mayhem=bool(fields.get("is_mayhem_mode")),
                        source="websocket",
                    )

    async def _stream_poll(self) -> AsyncIterator[NewLaunch]:
        while True:
            try:
                for launch in await self.poll_once():
                    yield launch
            except ProviderError as exc:
                log.warning("launch poll failed", error=str(exc))
            await asyncio.sleep(POLL_INTERVAL)

    async def poll_once(self) -> list[NewLaunch]:
        """One polling pass. Exposed separately so it is directly testable."""
        signatures = await self.hub.rpc.get_signatures(PUMP_FUN_PROGRAM_ID, limit=POLL_LIMIT)
        fresh = [
            s["signature"]
            for s in signatures
            if s.get("signature") and s["signature"] not in self._seen and not s.get("err")
        ]
        if not fresh:
            return []
        raw_map = await self.hub.rpc.get_transactions(fresh)
        launches: list[NewLaunch] = []
        for signature, raw in raw_map.items():
            self._seen.add(signature)
            parsed = parse_transaction(raw, signature)
            if parsed is None or not parsed.success:
                continue
            for event in parsed.events_named("CreateEvent"):
                mint = event.get("mint")
                if not mint:
                    continue
                launches.append(
                    NewLaunch(
                        mint=mint,
                        creator=event.get("creator") or event.get("user"),
                        symbol=event.get("symbol"),
                        name=event.get("name"),
                        signature=signature,
                        block_time=event.get("timestamp") or parsed.block_time,
                        mayhem=bool(event.get("is_mayhem_mode")),
                    )
                )
        # Keep the dedupe set bounded on a long-running bot.
        if len(self._seen) > 20_000:
            self._seen = set(list(self._seen)[-10_000:])
        return launches


@contextlib.asynccontextmanager
async def launch_feed(hub: ProviderHub, ws_url: str | None):
    feed = LaunchFeed(hub, ws_url=ws_url)
    try:
        yield feed
    finally:
        feed._seen.clear()
