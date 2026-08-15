"""Diagnostic de configuration : `python -m app.main doctor`.

Répond à la question « pourquoi ça ne démarre pas ? » sans lire une traceback.
Chaque vérification affiche un statut, ce qui a été testé, et — en cas
d'échec — l'action exacte à faire.

Les échecs sont classés en deux catégories : ce qui **empêche** le démarrage
(❌) et ce qui **dégrade** l'analyse sans la bloquer (⚠️). C'est la distinction
qui compte quand on débloque une installation : inutile de chercher une clé
Helius si le vrai problème est un token Discord absent.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from typing import Any

from app.config import Settings, get_settings

OK = "✅"
WARN = "⚠️"
FAIL = "❌"
SKIP = "➖"


@dataclass
class Check:
    name: str
    status: str
    detail: str
    fix: str | None = None
    blocking: bool = False


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    @property
    def blocking_failures(self) -> list[Check]:
        return [c for c in self.checks if c.status == FAIL and c.blocking]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.status == WARN]


# ---------------------------------------------------------------------------
def check_python() -> Check:
    version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    # noqa justifié : ruff suppose que la version cible est garantie. C'est
    # exactement l'hypothèse que ce diagnostic doit vérifier — quelqu'un qui
    # lance l'outil avec Python 3.9 mérite un message clair, pas un SyntaxError.
    if sys.version_info < (3, 11):  # noqa: UP036
        return Check(
            "Python",
            FAIL,
            f"Python {version} — trop ancien (3.11 minimum)",
            "Installez Python 3.12 puis recréez l'environnement : python3.12 -m venv .venv",
            blocking=True,
        )
    return Check("Python", OK, f"Python {version}")


#: Marge minimale confortable : le venv pèse ~450 Mo, la base et les exports
#: grossissent, et un disque saturé produit des erreurs déroutantes plutôt
#: qu'un message clair.
MIN_FREE_MB = 500


def check_disk_space() -> Check:
    import shutil

    from app.config import REPO_ROOT

    try:
        free_mb = shutil.disk_usage(REPO_ROOT).free / (1024 * 1024)
    except OSError as exc:  # pragma: no cover - défensif
        return Check("Espace disque", WARN, f"non mesurable : {exc}")

    if free_mb < 100:
        return Check(
            "Espace disque",
            FAIL,
            f"{free_mb:.0f} Mo libres — insuffisant",
            "Un disque saturé fait échouer l'installation, l'écriture de la base et "
            "les exports, souvent avec des erreurs incompréhensibles. Libérez au moins "
            f"{MIN_FREE_MB} Mo puis relancez.",
            blocking=True,
        )
    if free_mb < MIN_FREE_MB:
        return Check(
            "Espace disque",
            WARN,
            f"{free_mb:.0f} Mo libres — peu",
            f"Prévoyez {MIN_FREE_MB} Mo : l'environnement Python en occupe déjà ~450.",
        )
    return Check("Espace disque", OK, f"{free_mb / 1024:.1f} Go libres")


def check_dependencies() -> Check:
    missing: list[str] = []
    for module, package in (
        ("discord", "discord.py"),
        ("httpx", "httpx"),
        ("pydantic", "pydantic"),
        ("sqlalchemy", "SQLAlchemy"),
        ("networkx", "networkx"),
        ("sklearn", "scikit-learn"),
        ("matplotlib", "matplotlib"),
    ):
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    if missing:
        return Check(
            "Dépendances",
            FAIL,
            f"manquantes : {', '.join(missing)}",
            "Installez-les : .venv/bin/pip install -r requirements.txt",
            blocking=True,
        )
    return Check("Dépendances", OK, "toutes les bibliothèques sont installées")


def check_pip() -> Check:
    """pip absent de l'environnement virtuel — panne fréquente sous Windows.

    Le venv paraît valide (l'interpréteur est là) mais toute installation
    échoue sur « No module named pip », et un lanceur qui ne teste que la
    présence du binaire réutilise indéfiniment un environnement mort.
    """
    import importlib.util

    if importlib.util.find_spec("pip") is not None:
        return Check("pip", OK, "disponible")
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    return Check(
        "pip",
        WARN,
        "absent de cet environnement Python",
        "Les dépendances sont installées, donc rien n'est bloqué maintenant, mais toute "
        + (
            "mise à jour échouera. Réparez avec :  python -m ensurepip --default-pip  "
            "ou repartez de zéro :  start.bat reset"
            if in_venv
            else "installation de paquet échouera."
        ),
    )


def check_env_file() -> Check:
    from app.config import REPO_ROOT

    env = REPO_ROOT / ".env"
    if not env.exists():
        return Check(
            "Fichier .env",
            FAIL,
            "absent",
            "Créez-le : cp .env.example .env   (puis renseignez RPC_URL)",
            blocking=True,
        )
    return Check("Fichier .env", OK, str(env))


def check_discord_token(settings: Settings) -> Check:
    token = settings.discord_token
    if not token:
        return Check(
            "Token Discord",
            FAIL,
            "DISCORD_TOKEN est vide",
            "Ajoutez DISCORD_TOKEN=... dans .env "
            "(Discord Developer Portal → votre application → Bot → Reset Token)",
            blocking=True,
        )
    # Un token de bot fait ~59-72 caractères et contient deux points.
    if token.count(".") != 2 or len(token) < 50:
        return Check(
            "Token Discord",
            FAIL,
            f"format invalide ({len(token)} caractères, {token.count('.')} point(s) — attendu : 2)",
            "Vous avez probablement copié l'Application ID, le Public Key ou le Client Secret. "
            "Le token du bot est dans l'onglet « Bot », bouton « Reset Token ».",
            blocking=True,
        )
    return Check("Token Discord", OK, f"format valide ({len(token)} caractères)")


def check_rpc_url(settings: Settings) -> Check:
    url = settings.rpc_url
    if not url:
        return Check(
            "URL RPC",
            FAIL,
            "RPC_URL est vide",
            "Ajoutez RPC_URL=... dans .env",
            blocking=True,
        )
    if not url.startswith(("http://", "https://")):
        return Check(
            "URL RPC", FAIL, f"{url} n'est pas une URL", "L'URL doit commencer par https://", blocking=True
        )
    # `rpc_endpoints` place Helius en tête quand la clé est présente : c'est
    # l'endpoint réellement utilisé, donc c'est celui qu'il faut afficher.
    effective = settings.rpc_endpoints[0] if settings.rpc_endpoints else url
    if "api.mainnet-beta.solana.com" in effective:
        return Check(
            "URL RPC",
            WARN,
            "RPC public Solana — rate limit agressif et historique tronqué",
            "Utilisable pour un premier test. Pour un usage réel, prenez un endpoint payant "
            "(Helius, QuickNode, Triton…) ou définissez HELIUS_API_KEY.",
        )
    label = effective.split("?")[0]
    if len(settings.rpc_endpoints) > 1:
        label += f"  (+{len(settings.rpc_endpoints) - 1} secours)"
    return Check("URL RPC", OK, label)


def check_guilds(settings: Settings) -> Check:
    if not settings.guild_ids:
        return Check(
            "DISCORD_GUILD_IDS",
            WARN,
            "vide — synchronisation globale des commandes",
            "Les commandes slash peuvent mettre jusqu'à 1 heure à apparaître. Pour un affichage "
            "immédiat, mettez l'ID de votre serveur (clic droit sur le serveur → Copier l'identifiant, "
            "mode développeur activé).",
        )
    return Check("DISCORD_GUILD_IDS", OK, f"{len(settings.guild_ids)} serveur(s) — sync immédiate")


def check_optional_providers(settings: Settings) -> list[Check]:
    checks: list[Check] = []
    if settings.helius_api_key:
        checks.append(Check("Helius", OK, "configuré — holders complets + métadonnées"))
    else:
        checks.append(
            Check(
                "Helius",
                SKIP,
                "non configuré",
                "Optionnel. Sans lui, la liste des holders est limitée aux 20 plus gros comptes "
                "et la confiance des rapports est plus basse.",
            )
        )
    if settings.solscan_api_key:
        checks.append(Check("Solscan", OK, "configuré"))
    else:
        checks.append(Check("Solscan", SKIP, "non configuré", "Optionnel (source de secours)."))
    return checks


async def check_rpc_reachable(settings: Settings) -> Check:
    """Appelle réellement le RPC — c'est la vérification qui compte."""
    import httpx

    url = settings.rpc_endpoints[0] if settings.rpc_endpoints else settings.rpc_url
    payload = {"jsonrpc": "2.0", "id": 1, "method": "getHealth", "params": []}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        return Check(
            "Connexion RPC",
            FAIL,
            f"injoignable : {type(exc).__name__}",
            "Vérifiez RPC_URL et votre connexion réseau (pare-feu, proxy, VPN).",
            blocking=True,
        )
    if response.status_code == 401:
        return Check(
            "Connexion RPC", FAIL, "HTTP 401 — clé refusée", "Vérifiez la clé API dans RPC_URL.", blocking=True
        )
    if response.status_code == 429:
        return Check(
            "Connexion RPC",
            WARN,
            "HTTP 429 — rate limit atteint immédiatement",
            "Baissez RPC_REQUESTS_PER_SECOND (essayez 10) ou changez d'endpoint.",
        )
    if response.status_code >= 400:
        return Check(
            "Connexion RPC",
            FAIL,
            f"HTTP {response.status_code}",
            "L'endpoint a refusé la requête. Vérifiez l'URL.",
            blocking=True,
        )
    return Check("Connexion RPC", OK, f"répond en {response.elapsed.total_seconds() * 1000:.0f} ms")


async def check_discord_reachable(settings: Settings) -> Check:
    """Valide le token auprès de Discord — détecte un token révoqué ou faux."""
    if not settings.discord_token:
        return Check("Connexion Discord", SKIP, "pas de token à tester")
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://discord.com/api/v10/users/@me",
                headers={"Authorization": f"Bot {settings.discord_token}"},
            )
    except httpx.HTTPError as exc:
        return Check(
            "Connexion Discord",
            WARN,
            f"injoignable : {type(exc).__name__}",
            "Réseau bloqué vers discord.com (pare-feu, proxy). Le token n'a pas pu être vérifié.",
        )
    if response.status_code == 401:
        return Check(
            "Connexion Discord",
            FAIL,
            "401 — token refusé par Discord",
            "Le token est faux, expiré ou a été réinitialisé. Régénérez-le : "
            "Developer Portal → Bot → Reset Token, puis recopiez-le dans .env.",
            blocking=True,
        )
    if response.status_code >= 400:
        return Check("Connexion Discord", WARN, f"HTTP {response.status_code}", None)
    data: dict[str, Any] = response.json()
    return Check("Connexion Discord", OK, f"connecté en tant que « {data.get('username', '?')} »")


async def check_database(settings: Settings) -> Check:
    from app.db import dispose, init_db

    ok = await init_db(settings.database_url)
    await dispose()
    kind = settings.database_url.split("://", 1)[0]
    if not ok:
        return Check(
            "Base de données",
            WARN,
            f"{kind} injoignable",
            "Non bloquant : les scans fonctionnent, mais la mémoire inter-launches "
            "(clusters récurrents) est perdue. Pour un test local, mettez "
            "DATABASE_URL=sqlite+aiosqlite:///./pfbd.db",
        )
    return Check("Base de données", OK, kind)


async def check_cache(settings: Settings) -> Check:
    from app.cache import RedisCache, build_cache

    cache = await build_cache(settings.redis_url)
    await cache.aclose()
    if isinstance(cache, RedisCache):
        return Check("Cache", OK, "Redis connecté")
    return Check(
        "Cache",
        SKIP,
        "cache mémoire (Redis absent ou non configuré)",
        "Non bloquant. Redis accélère les scans répétés.",
    )


# ---------------------------------------------------------------------------
async def run_checks(*, need_discord: bool = True) -> Report:
    report = Report()
    report.add(check_python())
    report.add(check_disk_space())
    deps = report.add(check_dependencies())
    report.add(check_pip())
    if deps.status == FAIL:
        return report  # inutile d'aller plus loin

    report.add(check_env_file())
    settings = get_settings()

    report.add(check_rpc_url(settings))
    report.add(await check_rpc_reachable(settings))

    if need_discord:
        token = report.add(check_discord_token(settings))
        if token.status == OK:
            report.add(await check_discord_reachable(settings))
        report.add(check_guilds(settings))

    report.add(await check_database(settings))
    report.add(await check_cache(settings))
    for check in check_optional_providers(settings):
        report.add(check)
    return report


def render(report: Report) -> str:
    width = max(len(c.name) for c in report.checks) + 2
    lines = ["", "DIAGNOSTIC — Pump.fun Bundle Detector", "─" * 68]
    for check in report.checks:
        lines.append(f"{check.status} {check.name:<{width}} {check.detail}")
        if check.fix and check.status in {FAIL, WARN}:
            for i, chunk in enumerate(_wrap(check.fix, 62)):
                lines.append(f"   {'→' if i == 0 else ' '} {chunk}")
    lines.append("─" * 68)

    blocking = report.blocking_failures
    if blocking:
        lines.append("")
        lines.append(f"{FAIL} LE BOT NE PEUT PAS DÉMARRER — {len(blocking)} problème(s) bloquant(s) :")
        for check in blocking:
            lines.append(f"   • {check.name} : {check.detail}")
        lines.append("")
        lines.append("Corrigez-les dans l'ordre ci-dessus, puis relancez ce diagnostic.")
    else:
        lines.append("")
        lines.append(f"{OK} Tout est prêt. Lancez le bot :")
        lines.append("")
        lines.append("      python -m app.main bot")
        if report.warnings:
            lines.append("")
            lines.append(f"{WARN} {len(report.warnings)} avertissement(s) — non bloquants, voir ci-dessus.")
    lines.append("")
    return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def main(*, need_discord: bool = True) -> int:
    # Le diagnostic doit être lisible : les logs internes (connexion base,
    # repli du cache…) sont déjà traduits en lignes de rapport ci-dessous.
    import logging

    from app.utils.logging import configure_logging

    configure_logging()
    logging.getLogger("pfbd").setLevel(logging.CRITICAL)

    report = asyncio.run(run_checks(need_discord=need_discord))
    print(render(report))
    return 1 if report.blocking_failures else 0
