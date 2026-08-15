"""HTTP API.

A thin wrapper over the same orchestrator the bot uses — useful for health
checks, for driving scans from other tooling, and for serving the HTML report
without Discord.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse

from app.cache import build_cache
from app.config import get_settings
from app.db import init_db
from app.export import _render_report_html  # noqa: PLC2701 - internal renderer reuse is intentional
from app.graph.renderer import graph_payload
from app.models.enums import ScanDepth
from app.orchestrator import NotPumpFunError, ScanOrchestrator
from app.providers.registry import ProviderHub
from app.utils.addresses import is_valid_pubkey
from app.utils.logging import configure_logging, get_logger

log = get_logger("API")

_state: dict[str, object] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    cache = await build_cache(settings.redis_url)
    await init_db()
    hub = ProviderHub(settings, cache=cache)
    _state["hub"] = hub
    _state["cache"] = cache
    _state["orchestrator"] = ScanOrchestrator(hub, settings)
    try:
        yield
    finally:
        await hub.aclose()
        await cache.aclose()


app = FastAPI(
    title="Pump.fun Bundle Detector",
    version="0.1.0",
    description="On-chain forensics for Pump.fun launches: wallet clustering, funding tracing, bundle scoring.",
    lifespan=lifespan,
)


def _orchestrator() -> ScanOrchestrator:
    orchestrator = _state.get("orchestrator")
    if orchestrator is None:  # pragma: no cover - startup race
        raise HTTPException(status_code=503, detail="Service is still starting")
    return orchestrator  # type: ignore[return-value]


@app.get("/health")
async def health() -> JSONResponse:
    hub: ProviderHub | None = _state.get("hub")  # type: ignore[assignment]
    providers = (
        {name: health.status.value for name, health in hub.quality.providers.items()} if hub else {}
    )
    return JSONResponse({"status": "ok", "providers": providers})


@app.get("/scan/{mint}")
async def scan(mint: str, depth: str = Query("full", pattern="^(quick|full|deep)$")) -> JSONResponse:
    if not is_valid_pubkey(mint):
        raise HTTPException(status_code=400, detail="Not a valid Solana address")
    try:
        report, _ = await _orchestrator().scan(mint, depth=ScanDepth(depth), requested_by="api")
    except NotPumpFunError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "NOT_A_PUMPFUN_TOKEN", "mint": mint, "reason": exc.reason},
        ) from exc
    return JSONResponse(report.model_dump(mode="json"))


@app.get("/report/{mint}", response_class=HTMLResponse)
async def report_html(mint: str, depth: str = Query("full", pattern="^(quick|full|deep)$")) -> HTMLResponse:
    if not is_valid_pubkey(mint):
        raise HTTPException(status_code=400, detail="Not a valid Solana address")
    try:
        report, context = await _orchestrator().scan(mint, depth=ScanDepth(depth), requested_by="api")
    except NotPumpFunError as exc:
        raise HTTPException(status_code=422, detail=exc.reason or "Not a Pump.fun token") from exc
    profiles = {p.address: p for p in report.wallets}
    payload = (
        graph_payload(context.graph, profiles, report.clusters)
        if context.graph
        else {"nodes": [], "edges": [], "clusters": []}
    )
    return HTMLResponse(_render_report_html(report, payload))


@app.get("/validate/{mint}")
async def validate(mint: str) -> JSONResponse:
    """Pump.fun origin check only — the cheap gate, without a full scan."""
    if not is_valid_pubkey(mint):
        raise HTTPException(status_code=400, detail="Not a valid Solana address")
    from app.pumpfun.validator import PumpFunValidator

    hub: ProviderHub = _state["hub"]  # type: ignore[assignment]
    result = await PumpFunValidator(hub).validate(mint)
    return JSONResponse(result.model_dump(mode="json"))
