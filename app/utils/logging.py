"""Structured, tagged logging.

Log lines follow the convention required by the project spec:

    [SCAN] token=<mint> stage=buyers
    [FUNDING] wallet=<addr> sources=2
    [CLUSTER] cluster=4 members=8
    [SCORE] token=<mint> bundle=89
"""

from __future__ import annotations

import logging
import sys
from typing import Any

TAGS = ("SCAN", "WALLET", "FUNDING", "CLUSTER", "SCORE", "API", "DB", "CACHE", "DISCORD", "WATCH")

_CONFIGURED = False


class TaggedLogger:
    """Thin wrapper that prefixes a tag and renders ``key=value`` context."""

    __slots__ = ("_logger", "_tag")

    def __init__(self, tag: str, logger: logging.Logger) -> None:
        self._tag = tag.upper()
        self._logger = logger

    def _render(self, message: str, context: dict[str, Any]) -> str:
        if not context:
            return f"[{self._tag}] {message}"
        rendered = " ".join(f"{k}={_fmt(v)}" for k, v in context.items())
        return f"[{self._tag}] {message} {rendered}".strip()

    def debug(self, message: str = "", **ctx: Any) -> None:
        self._logger.debug(self._render(message, ctx))

    def info(self, message: str = "", **ctx: Any) -> None:
        self._logger.info(self._render(message, ctx))

    def warning(self, message: str = "", **ctx: Any) -> None:
        self._logger.warning(self._render(message, ctx))

    def error(self, message: str = "", **ctx: Any) -> None:
        self._logger.error(self._render(message, ctx))

    def exception(self, message: str = "", **ctx: Any) -> None:
        self._logger.exception(self._render(message, ctx))


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.4g}"
    text = str(value)
    return f'"{text}"' if " " in text else text


def configure_logging(level: str = "INFO") -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S"))
    root = logging.getLogger("pfbd")
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers.clear()
    root.addHandler(handler)
    root.propagate = False
    _CONFIGURED = True


def get_logger(tag: str) -> TaggedLogger:
    configure_logging()
    return TaggedLogger(tag, logging.getLogger(f"pfbd.{tag.lower()}"))
