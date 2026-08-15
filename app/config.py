"""Central configuration.

Everything tunable lives here: provider credentials, engine depth, analysis
time windows and — critically — the scoring weights.  No secret is ever
hardcoded; every credential comes from the environment.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "app" / "data"
EXPORT_DIR = REPO_ROOT / "exports"


class AnalysisWindows(BaseModel):
    """Time windows (seconds after launch) used to bucket early activity."""

    ultra_early: int = 10
    early: int = 60
    launch: int = 300
    extended: int = 1800
    full: int = 3600

    def as_ordered(self) -> list[tuple[str, int]]:
        return [
            ("ultra_early", self.ultra_early),
            ("early", self.early),
            ("launch", self.launch),
            ("extended", self.extended),
            ("full", self.full),
        ]


#: Checkpoints (seconds) reported in the launch timeline section of a report.
TIMELINE_CHECKPOINTS: tuple[int, ...] = (0, 1, 5, 10, 30, 60, 300, 600, 1800, 3600)

#: Fresh-wallet age buckets, ordered from freshest to oldest (seconds).
FRESH_WALLET_BUCKETS: tuple[tuple[str, int], ...] = (
    ("<30s", 30),
    ("<1m", 60),
    ("<5m", 300),
    ("<10m", 600),
    ("<1h", 3600),
    ("<6h", 21600),
    ("<24h", 86400),
)


class BundleWeights(BaseModel):
    """Maximum point contribution of each independent signal to the bundle score.

    The weights sum to 100.  A signal can never contribute more than its weight,
    and the engine additionally requires *signal independence* (see
    ``app.scoring.bundle``) before a high score can be produced — a single
    strong signal is deliberately incapable of pushing the score into the
    "critical" band on its own.
    """

    common_direct_funder: float = 20.0
    common_intermediary: float = 10.0
    funding_amount_similarity: float = 8.0
    funding_timing_similarity: float = 8.0
    buy_amount_similarity: float = 8.0
    buy_timing_similarity: float = 10.0
    wallet_age_similarity: float = 6.0
    historical_overlap: float = 10.0
    repeated_cluster: float = 8.0
    creator_linkage: float = 7.0
    other_anomalies: float = 5.0

    def total(self) -> float:
        return float(sum(self.model_dump().values()))


class ScoringConfig(BaseModel):
    weights: BundleWeights = Field(default_factory=BundleWeights)

    #: Minimum number of *independent* signal families that must fire before the
    #: bundle score is allowed above `single_signal_ceiling`.
    min_independent_signals: int = 3
    #: Hard ceiling applied when fewer than `min_independent_signals` fire.
    single_signal_ceiling: float = 35.0
    #: Ceiling applied when exactly `min_independent_signals - 1` fire.
    two_signal_ceiling: float = 55.0

    #: A cluster smaller than this is never reported as a bundle candidate.
    min_cluster_size: int = 3
    #: Below this many analysed wallets, confidence is capped.
    low_data_wallet_threshold: int = 5
    high_data_wallet_threshold: int = 20

    #: Coefficient-of-variation thresholds for "similar amounts".
    #: cv <= cv_identical  -> ~1.0 similarity, cv >= cv_unrelated -> ~0.0
    cv_identical: float = 0.02
    cv_unrelated: float = 0.60

    #: A funder that has fanned out to more than this many distinct wallets, or
    #: whose signature count exceeds `infra_signature_threshold`, is treated as
    #: probable shared infrastructure (CEX / bot service) rather than a private
    #: bundler, and its "common funder" weight is damped by `infra_damping`.
    infra_fanout_threshold: int = 60
    infra_signature_threshold: int = 5000
    infra_damping: float = 0.20


class AlertThresholds(BaseModel):
    low_max: int = 24
    medium_max: int = 49
    high_max: int = 74


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- Discord ---
    discord_token: str | None = None
    discord_guild_ids: str = ""
    discord_autoscan_channel_id: int | None = None
    discord_alert_channel_id: int | None = None

    # --- Solana ---
    rpc_url: str = "https://api.mainnet-beta.solana.com"
    rpc_ws_url: str = "wss://api.mainnet-beta.solana.com"
    rpc_url_secondary: str | None = None

    # --- Optional providers ---
    helius_api_key: str | None = None
    solscan_api_key: str | None = None

    # --- Storage ---
    database_url: str = "sqlite+aiosqlite:///./pfbd.db"
    redis_url: str | None = "redis://localhost:6379/0"

    # --- Engine ---
    max_funding_hops: int = 3
    first_buyers_limit: int = 100
    max_concurrent_rpc: int = 16
    rpc_requests_per_second: float = 25.0
    history_max_signatures: int = 1000
    scan_timeout_seconds: int = 180
    log_level: str = "INFO"

    # --- Thresholds ---
    alert_low_max: int = 24
    alert_medium_max: int = 49
    alert_high_max: int = 74

    # --- Nested (not env-driven; edit here or override programmatically) ---
    windows: AnalysisWindows = Field(default_factory=AnalysisWindows)
    scoring: ScoringConfig = Field(default_factory=ScoringConfig)

    @field_validator("discord_guild_ids", mode="before")
    @classmethod
    def _coerce_guilds(cls, v: object) -> str:
        return "" if v is None else str(v)

    @field_validator(
        "discord_autoscan_channel_id",
        "discord_alert_channel_id",
        "helius_api_key",
        "solscan_api_key",
        "discord_token",
        "rpc_url_secondary",
        "redis_url",
        mode="before",
    )
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        """Traite une variable d'environnement vide comme absente.

        `.env.example` liste les réglages optionnels avec une valeur vide
        (`DISCORD_ALERT_CHANNEL_ID=`), ce qui est la façon habituelle de
        documenter une option. Sans ce validateur, copier le modèle tel quel
        fait échouer le chargement de la configuration sur « impossible de
        convertir '' en entier » — avant même que le programme démarre.
        """
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @property
    def guild_ids(self) -> list[int]:
        out: list[int] = []
        for chunk in self.discord_guild_ids.split(","):
            chunk = chunk.strip()
            if chunk.isdigit():
                out.append(int(chunk))
        return out

    @property
    def alerts(self) -> AlertThresholds:
        return AlertThresholds(
            low_max=self.alert_low_max,
            medium_max=self.alert_medium_max,
            high_max=self.alert_high_max,
        )

    @property
    def rpc_endpoints(self) -> list[str]:
        """Ordered RPC endpoints: Helius (if keyed) first, then configured ones."""
        endpoints: list[str] = []
        if self.helius_api_key:
            endpoints.append(f"https://mainnet.helius-rpc.com/?api-key={self.helius_api_key}")
        if self.rpc_url:
            endpoints.append(self.rpc_url)
        if self.rpc_url_secondary:
            endpoints.append(self.rpc_url_secondary)
        # de-duplicate, preserve order
        seen: set[str] = set()
        return [e for e in endpoints if not (e in seen or seen.add(e))]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Used by tests that patch the environment."""
    get_settings.cache_clear()
