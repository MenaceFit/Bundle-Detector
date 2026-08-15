"""Enumerations shared across the domain model."""

from __future__ import annotations

from enum import Enum


class LifecycleState(str, Enum):
    """Where a Pump.fun coin sits in its lifecycle (§9)."""

    CREATED = "CREATED"
    BONDING_CURVE = "BONDING_CURVE"
    NEAR_GRADUATION = "NEAR_GRADUATION"
    GRADUATED = "GRADUATED"
    PUMPSWAP = "PUMPSWAP"

    @property
    def label(self) -> str:
        return {
            "CREATED": "CREATED",
            "BONDING_CURVE": "BONDING CURVE",
            "NEAR_GRADUATION": "NEAR GRADUATION",
            "GRADUATED": "GRADUATED",
            "PUMPSWAP": "GRADUATED → PUMPSWAP",
        }[self.value]


class PairType(str, Enum):
    SOL = "SOL"
    USDC = "USDC"
    UNKNOWN = "UNKNOWN"


class EntityType(str, Enum):
    """Address classification (§42). Infrastructure is never scored as a user."""

    CREATOR = "CREATOR"
    BUYER = "BUYER"
    SELLER = "SELLER"
    FUNDER = "FUNDER"
    INTERMEDIARY = "INTERMEDIARY"
    PUMPFUN = "PUMPFUN"
    PUMPSWAP = "PUMPSWAP"
    DEX = "DEX"
    CEX = "CEX"
    BRIDGE = "BRIDGE"
    PROGRAM = "PROGRAM"
    INFRASTRUCTURE = "INFRASTRUCTURE"
    VAULT = "VAULT"
    BURN = "BURN"
    UNKNOWN = "UNKNOWN"

    @property
    def is_infrastructure(self) -> bool:
        """True for entities that must never be treated as a private wallet."""
        return self in {
            EntityType.PUMPFUN,
            EntityType.PUMPSWAP,
            EntityType.DEX,
            EntityType.CEX,
            EntityType.BRIDGE,
            EntityType.PROGRAM,
            EntityType.INFRASTRUCTURE,
            EntityType.VAULT,
            EntityType.BURN,
        }


class RelationType(str, Enum):
    """Edge kinds in the wallet graph (§26)."""

    FUNDED = "FUNDED"
    TRANSFERRED = "TRANSFERRED"
    BOUGHT = "BOUGHT"
    SOLD = "SOLD"
    COMMON_FUNDER = "COMMON_FUNDER"
    COMMON_INTERMEDIARY = "COMMON_INTERMEDIARY"
    COMMON_LAUNCH = "COMMON_LAUNCH"
    CREATED = "CREATED"


class RiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"

    @property
    def emoji(self) -> str:
        return {"LOW": "🟢", "MEDIUM": "🟡", "HIGH": "🟠", "CRITICAL": "🔴"}[self.value]


class Classification(str, Enum):
    """The mutually exclusive readings the engine must distinguish (§110)."""

    INSUFFICIENT_DATA = "INSUFFICIENT DATA"
    NORMAL_EARLY_BUYERS = "NORMAL EARLY BUYERS"
    CEX_FUNDED_USERS = "CEX-FUNDED USERS"
    PROFESSIONAL_SNIPERS = "PROFESSIONAL SNIPERS"
    AUTOMATED_ACTIVITY = "MEV / AUTOMATED ACTIVITY"
    MAYHEM_ACTIVITY = "MAYHEM ACTIVITY"
    POSSIBLE_COORDINATION = "POSSIBLE COORDINATION"
    BUNDLE = "BUNDLE-LIKE PATTERN"

    @property
    def verdict_text(self) -> str:
        return {
            "INSUFFICIENT DATA": "Insufficient evidence",
            "NORMAL EARLY BUYERS": "Likely independent",
            "CEX-FUNDED USERS": "Likely independent (shared exchange funding)",
            "PROFESSIONAL SNIPERS": "Likely independent professional snipers",
            "MEV / AUTOMATED ACTIVITY": "Automated, not necessarily coordinated wallets",
            "MAYHEM ACTIVITY": "Protocol-automated activity present",
            "POSSIBLE COORDINATION": "Possible coordination",
            "BUNDLE-LIKE PATTERN": "Strong bundle-like pattern",
        }[self.value]


class ScanDepth(str, Enum):
    QUICK = "quick"
    FULL = "full"
    DEEP = "deep"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
