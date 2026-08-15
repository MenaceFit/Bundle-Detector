"""Human-readable time formatting used throughout the reports."""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def from_unix(ts: int | float | None) -> datetime | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=UTC)
    except (OverflowError, OSError, ValueError):  # pragma: no cover - defensive
        return None


def human_duration(seconds: float | None, *, precise: bool = False) -> str:
    """`154` -> `2m 34s`; sub-second values keep millisecond resolution."""
    if seconds is None:
        return "unknown"
    seconds = float(seconds)
    sign = "-" if seconds < 0 else ""
    seconds = abs(seconds)
    if seconds < 1:
        return f"{sign}{seconds * 1000:.0f}ms"
    if seconds < 60:
        return f"{sign}{seconds:.2f}s" if precise else f"{sign}{seconds:.0f}s"
    minutes, secs = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{sign}{minutes}m {secs}s"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{sign}{hours}h {minutes}m"
    days, hours = divmod(hours, 24)
    return f"{sign}{days}d {hours}h"


def human_age(ts: int | float | None, *, now: float | None = None) -> str:
    if ts is None:
        return "unknown"
    reference = now if now is not None else utc_now().timestamp()
    return human_duration(reference - float(ts))
