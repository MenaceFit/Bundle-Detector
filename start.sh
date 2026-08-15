#!/usr/bin/env bash
# Lancement en une commande : ./start.sh
#
# Crée l'environnement virtuel s'il manque, installe les dépendances,
# vérifie la configuration, puis démarre le bot. Relancer le script est sans
# risque : chaque étape est ignorée si elle est déjà faite.
#
#   ./start.sh              démarre le bot Discord
#   ./start.sh doctor       vérifie la configuration seulement
#   ./start.sh api          démarre l'API HTTP
#   ./start.sh scan <MINT>  scanne un token depuis le terminal
#   ./start.sh demo         affiche un rapport d'exemple (hors ligne)

set -euo pipefail
cd "$(dirname "$0")"

PY=""
for candidate in python3.12 python3.13 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
            PY="$candidate"
            break
        fi
    fi
done

if [ -z "$PY" ]; then
    echo "❌ Python 3.11 ou plus récent est introuvable."
    echo "   Installez Python 3.12 : https://www.python.org/downloads/"
    exit 1
fi

# 1. Environnement virtuel
if [ ! -d .venv ]; then
    echo "→ Création de l'environnement virtuel ($PY)…"
    "$PY" -m venv .venv
fi
VENV_PY=".venv/bin/python"

# 2. Dépendances — réinstallées seulement si requirements.txt a changé
STAMP=".venv/.requirements-stamp"
if [ ! -f "$STAMP" ] || [ requirements.txt -nt "$STAMP" ]; then
    echo "→ Installation des dépendances (une à deux minutes la première fois)…"
    "$VENV_PY" -m pip install --quiet --upgrade pip
    "$VENV_PY" -m pip install --quiet -r requirements.txt
    touch "$STAMP"
fi

# 3. Configuration
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

COMMAND="${1:-bot}"
shift || true

case "$COMMAND" in
    demo)
        exec "$VENV_PY" -m scripts.demo_report "${@:-private_bundle}"
        ;;
    scan)
        exec "$VENV_PY" -m scripts.cli "$@"
        ;;
    doctor)
        exec "$VENV_PY" -m app.main doctor "$@"
        ;;
    api)
        exec "$VENV_PY" -m app.main api "$@"
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
        echo "Usage : ./start.sh [bot|doctor|api|scan <MINT>|demo]"
        exit 1
        ;;
esac
