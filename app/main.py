"""Process entry point.

    python -m app.main bot   # Discord bot (default)
    python -m app.main api   # FastAPI service
    python -m app.main scan <mint> [--depth quick|full|deep]
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.config import get_settings
from app.utils.logging import configure_logging


def _run_bot() -> None:
    from app.discord.bot import run

    run()


def _run_api(host: str, port: int) -> None:
    import uvicorn

    uvicorn.run("app.api:app", host=host, port=port, log_config=None)


def _run_scan(mint: str, depth: str) -> int:
    from scripts.cli import scan_once

    return asyncio.run(scan_once(mint, depth))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pfbd", description="Pump.fun bundle detector")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("bot", help="run the Discord bot")

    api = sub.add_parser("api", help="run the HTTP API")
    api.add_argument("--host", default="0.0.0.0")  # noqa: S104 - containerised service
    api.add_argument("--port", type=int, default=8000)

    scan = sub.add_parser("scan", help="scan a mint from the terminal")
    scan.add_argument("mint")
    scan.add_argument("--depth", default="full", choices=["quick", "full", "deep"])

    args = parser.parse_args(argv)
    configure_logging(get_settings().log_level)

    command = args.command or "bot"
    if command == "bot":
        _run_bot()
        return 0
    if command == "api":
        _run_api(args.host, args.port)
        return 0
    if command == "scan":
        return _run_scan(args.mint, args.depth)
    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
