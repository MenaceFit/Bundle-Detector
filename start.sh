#!/usr/bin/env bash
# Lancement en une commande : ./start.sh
#
# Crée l'environnement virtuel s'il manque, le RÉPARE s'il est cassé, installe
# les dépendances, vérifie la configuration, puis démarre le bot. Relancer le
# script est sans risque : chaque étape est ignorée si elle est déjà faite.
#
#   ./start.sh              démarre le bot Discord
#   ./start.sh doctor       vérifie la configuration seulement
#   ./start.sh api          démarre l'API HTTP
#   ./start.sh scan <MINT>  scanne un token depuis le terminal
#   ./start.sh demo         affiche un rapport d'exemple (hors ligne)
#   ./start.sh reset        supprime l'environnement virtuel et repart de zéro

set -uo pipefail
cd "$(dirname "$0")"

VENV_PY=".venv/bin/python"
STAMP=".venv/.requirements-stamp"

# --- 1. Trouver un Python utilisable ---------------------------------------
PY=""
for candidate in python3.12 python3.13 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "❌ Python 3.11 ou plus récent est introuvable."
    echo "   Installez Python 3.12 : https://www.python.org/downloads/"
    exit 1
fi

COMMAND="${1:-bot}"
if [ "$COMMAND" = "reset" ]; then
    echo "→ Suppression de l'environnement virtuel…"
    rm -rf .venv
    echo "   Fait. Relancez ./start.sh"
    exit 0
fi
shift || true

# --- 2. Environnement virtuel, avec réparation ------------------------------
# Un venv dont pip n'a pas été amorcé est le mode de panne le plus courant :
# il paraît valide (python.exe est là) mais toute installation échoue sur
# « No module named pip ». Vérifier l'existence du binaire ne suffit donc pas.
pip_works() {
    [ -x "$VENV_PY" ] && "$VENV_PY" -m pip --version >/dev/null 2>&1
}

if [ ! -x "$VENV_PY" ]; then
    echo "→ Création de l'environnement virtuel ($PY)…"
    "$PY" -m venv .venv || true
fi

if ! pip_works; then
    echo "→ pip est absent de l'environnement virtuel, réparation…"
    "$VENV_PY" -m ensurepip --default-pip >/dev/null 2>&1 || true
fi

if ! pip_works; then
    echo "→ Réparation impossible, reconstruction complète de l'environnement…"
    rm -rf .venv
    "$PY" -m venv .venv || true
    "$VENV_PY" -m ensurepip --default-pip >/dev/null 2>&1 || true
fi

if ! pip_works; then
    echo ""
    echo "❌ Impossible d'obtenir un pip fonctionnel dans l'environnement virtuel."
    echo ""
    echo "   Votre installation de Python n'inclut probablement pas le module"
    echo "   'ensurepip'. C'est le cas des Python fournis par certaines"
    echo "   distributions minimales."
    echo ""
    echo "   Solution : installez le paquet complet, par exemple"
    echo "     Debian/Ubuntu :  sudo apt install python3-venv python3-pip"
    echo "     ou réinstallez Python depuis python.org"
    exit 1
fi

# --- 3. Dépendances ---------------------------------------------------------
# On ne se fie pas seulement au fichier témoin : une installation interrompue
# le laisserait absent, mais un environnement à moitié peuplé passerait pour
# valide si l'on ne vérifiait pas que les modules s'importent réellement.
deps_ok() {
    "$VENV_PY" -c "import discord, httpx, pydantic, sqlalchemy, networkx, sklearn, matplotlib" >/dev/null 2>&1
}

if [ ! -f "$STAMP" ] || [ requirements.txt -nt "$STAMP" ] || ! deps_ok; then
    echo "→ Installation des dépendances (une à deux minutes la première fois)…"
    "$VENV_PY" -m pip install --quiet --upgrade pip
    if ! "$VENV_PY" -m pip install --quiet -r requirements.txt; then
        echo ""
        echo "❌ L'installation des dépendances a échoué."
        echo "   Regardez le message ci-dessus : espace disque, réseau, ou"
        echo "   antivirus bloquant l'écriture dans .venv."
        exit 1
    fi
    if ! deps_ok; then
        echo ""
        echo "❌ Les dépendances se sont installées mais ne s'importent pas."
        echo "   Essayez de repartir de zéro :  ./start.sh reset"
        exit 1
    fi
    touch "$STAMP"
fi

# --- 4. Configuration -------------------------------------------------------
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "→ Fichier .env créé à partir du modèle."
    echo ""
    echo "  Ouvrez-le et renseignez au minimum :"
    echo "    RPC_URL=...        votre endpoint RPC Solana"
    echo "    DISCORD_TOKEN=...  le token du bot (pour le mode bot)"
    echo ""
    echo "  Puis relancez :  ./start.sh"
    exit 1
fi

# --- 5. Lancement -----------------------------------------------------------
case "$COMMAND" in
    demo)   exec "$VENV_PY" -m scripts.demo_report "${@:-private_bundle}" ;;
    scan)   exec "$VENV_PY" -m scripts.cli "$@" ;;
    doctor) exec "$VENV_PY" -m app.main doctor "$@" ;;
    api)    exec "$VENV_PY" -m app.main api "$@" ;;
    test)
        # pytest n'est pas dans requirements.txt (dépendance de développement).
        "$VENV_PY" -c "import pytest" 2>/dev/null ||
            "$VENV_PY" -m pip install --quiet pytest pytest-asyncio
        exec "$VENV_PY" -m pytest -q
        ;;
    bot)
        # Diagnostic d'abord : un message clair vaut mieux qu'une traceback.
        if ! "$VENV_PY" -m app.main doctor; then
            exit 1
        fi
        echo "→ Démarrage du bot… (Ctrl+C pour arrêter)"
        exec "$VENV_PY" -m app.main bot
        ;;
    *)
        echo "Commande inconnue : $COMMAND"
        echo "Usage : ./start.sh [bot|doctor|api|scan <MINT>|demo|test|reset]"
        exit 1
        ;;
esac
