"""Statistical primitives shared by the analyzers and the scoring engine.

Every similarity function returns a value in ``[0, 1]`` and is *continuous*:
there are no boolean cliffs like ``if a == b``.  A cliff would make the whole
engine trivially gameable and would produce exactly the kind of brittle verdict
this project is built to avoid.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field


@dataclass(slots=True)
class Distribution:
    """Descriptive statistics for a sample, plus the derived similarity score."""

    count: int
    mean: float
    median: float
    stdev: float
    cv: float
    minimum: float
    maximum: float
    spread: float
    percentiles: dict[int, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, float | int | dict[int, float]]:
        return {
            "count": self.count,
            "mean": self.mean,
            "median": self.median,
            "stdev": self.stdev,
            "cv": self.cv,
            "min": self.minimum,
            "max": self.maximum,
            "spread": self.spread,
            "percentiles": self.percentiles,
        }


def describe(values: Sequence[float], percentiles: Sequence[int] = (25, 50, 75, 90)) -> Distribution:
    """Full descriptive summary; safe on empty and single-element samples."""
    vals = [float(v) for v in values]
    n = len(vals)
    if n == 0:
        return Distribution(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, {})
    mean = statistics.fmean(vals)
    median = statistics.median(vals)
    stdev = statistics.pstdev(vals) if n > 1 else 0.0
    cv = (stdev / abs(mean)) if mean else 0.0
    ordered = sorted(vals)
    pct = {p: _percentile(ordered, p) for p in percentiles}
    return Distribution(
        count=n,
        mean=mean,
        median=median,
        stdev=stdev,
        cv=cv,
        minimum=ordered[0],
        maximum=ordered[-1],
        spread=ordered[-1] - ordered[0],
        percentiles=pct,
    )


def _percentile(ordered: Sequence[float], p: int) -> float:
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return float(ordered[0])
    k = (len(ordered) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return float(ordered[int(k)])
    return float(ordered[lo] * (hi - k) + ordered[hi] * (k - lo))


def similarity_from_cv(cv: float, *, cv_identical: float = 0.02, cv_unrelated: float = 0.60) -> float:
    """Map a coefficient of variation onto a ``[0, 1]`` similarity.

    ``cv <= cv_identical`` -> 1.0, ``cv >= cv_unrelated`` -> 0.0, smooth in
    between (cosine easing, so the derivative is zero at both ends and small
    measurement noise near the boundaries does not swing the score).
    """
    if cv <= cv_identical:
        return 1.0
    if cv >= cv_unrelated:
        return 0.0
    t = (cv - cv_identical) / (cv_unrelated - cv_identical)
    return float(0.5 * (1.0 + math.cos(math.pi * t)))


def amount_similarity(
    values: Sequence[float], *, cv_identical: float = 0.02, cv_unrelated: float = 0.60
) -> tuple[float, Distribution]:
    """Similarity of a set of amounts (funding sizes, buy sizes, ...).

    Fewer than two samples carries no information, so the similarity is 0 —
    never 1.  Claiming perfect similarity from a single observation is the
    classic way a detector manufactures false positives.
    """
    dist = describe(values)
    if dist.count < 2:
        return 0.0, dist
    return similarity_from_cv(dist.cv, cv_identical=cv_identical, cv_unrelated=cv_unrelated), dist


def timing_similarity(timestamps: Sequence[float], *, window_seconds: float) -> tuple[float, Distribution]:
    """How tightly a set of events clusters in time, relative to ``window_seconds``.

    A spread of 0 gives 1.0; a spread of ``window_seconds`` or more gives 0.0.
    """
    if len(timestamps) < 2 or window_seconds <= 0:
        return 0.0, describe([])
    ordered = sorted(float(t) for t in timestamps)
    gaps = [b - a for a, b in zip(ordered, ordered[1:], strict=False)]
    dist = describe(gaps)
    spread = ordered[-1] - ordered[0]
    ratio = min(1.0, spread / window_seconds)
    return float(0.5 * (1.0 + math.cos(math.pi * ratio))), dist


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def overlap_coefficient(a: Iterable[str], b: Iterable[str]) -> float:
    """Szymkiewicz-Simpson: robust when the two sets differ a lot in size."""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / min(len(sa), len(sb))


def gini(values: Sequence[float]) -> float:
    """Inequality of a distribution (0 = perfectly even, 1 = fully concentrated)."""
    vals = sorted(float(v) for v in values if v is not None and v >= 0)
    n = len(vals)
    total = sum(vals)
    if n == 0 or total <= 0:
        return 0.0
    cumulative = 0.0
    for i, v in enumerate(vals, start=1):
        cumulative += i * v
    return float((2.0 * cumulative) / (n * total) - (n + 1.0) / n)


def normalized_entropy(counts: Sequence[float]) -> float:
    """Shannon entropy normalised to ``[0, 1]``; 1 means maximally spread out."""
    vals = [float(c) for c in counts if c and c > 0]
    total = sum(vals)
    if total <= 0 or len(vals) < 2:
        return 0.0
    probs = [v / total for v in vals]
    h = -sum(p * math.log(p) for p in probs)
    return float(h / math.log(len(vals)))


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return float(max(low, min(high, value)))


def scale_to_100(value: float) -> int:
    """Convert a ``[0, 1]`` score to an integer 0-100 for display."""
    return int(round(clamp(value) * 100))


def logistic_confidence(sample_size: int, *, midpoint: float, steepness: float = 0.35) -> float:
    """Smooth 0-1 ramp used for sample-size driven confidence."""
    try:
        return float(1.0 / (1.0 + math.exp(-steepness * (sample_size - midpoint))))
    except OverflowError:  # pragma: no cover - extreme inputs
        return 0.0 if sample_size < midpoint else 1.0
