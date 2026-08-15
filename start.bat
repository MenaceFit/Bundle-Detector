@echo off
REM Lancement en une commande sous Windows : start.bat
REM
REM   start.bat              demarre le bot Discord
REM   start.bat doctor       verifie la configuration seulement
REM   start.bat api          demarre l'API HTTP
REM   start.bat scan <MINT>  scanne un token depuis le terminal
REM   start.bat demo         affiche un rapport d'exemple (hors ligne)

setlocal
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Python est introuvable.
    echo     Installez Python 3.12 : https://www.python.org/downloads/
    echo     Cochez "Add python.exe to PATH" pendant l'installation.
    exit /b 1
)

REM 1. Environnement virtuel
if not exist .venv (
    echo -^> Creation de l'environnement virtuel...
    py -3.12 -m venv .venv 2>nul || py -3 -m venv .venv
    if %errorlevel% neq 0 (
        echo [X] Echec de la creation de l'environnement virtuel.
        exit /b 1
    )
)
set VENV_PY=.venv\Scripts\python.exe

REM 2. Dependances
if not exist .venv\.requirements-stamp (
    echo -^> Installation des dependances ^(une a deux minutes la premiere fois^)...
    "%VENV_PY%" -m pip install --quiet --upgrade pip
    "%VENV_PY%" -m pip install --quiet -r requirements.txt
    if %errorlevel% neq 0 (
        echo [X] Echec de l'installation des dependances.
        exit /b 1
    )
    echo ok> .venv\.requirements-stamp
)

REM 3. Configuration
if not exist .env (
    copy .env.example .env >nul
    echo.
    echo -^> Fichier .env cree a partir du modele.
    echo.
    echo    Ouvrez-le avec le Bloc-notes et renseignez au minimum :
    echo      RPC_URL=...        votre endpoint RPC Solana
    echo      DISCORD_TOKEN=...  le token du bot ^(pour le mode bot^)
    echo.
    echo    Puis relancez : start.bat
    exit /b 1
)

set COMMAND=%1
if "%COMMAND%"=="" set COMMAND=bot
shift

if "%COMMAND%"=="demo" (
    "%VENV_PY%" -m scripts.demo_report %1 %2 %3
    exit /b %errorlevel%
)
if "%COMMAND%"=="scan" (
    "%VENV_PY%" -m scripts.cli %1 %2 %3 %4
    exit /b %errorlevel%
)
if "%COMMAND%"=="doctor" (
    "%VENV_PY%" -m app.main doctor
    exit /b %errorlevel%
)
if "%COMMAND%"=="api" (
    "%VENV_PY%" -m app.main api
    exit /b %errorlevel%
)
if "%COMMAND%"=="bot" (
    REM Diagnostic d'abord : un message clair vaut mieux qu'une traceback.
    "%VENV_PY%" -m app.main doctor
    if %errorlevel% neq 0 exit /b 1
    echo -^> Demarrage du bot... ^(Ctrl+C pour arreter^)
    "%VENV_PY%" -m app.main bot
    exit /b %errorlevel%
)

echo Commande inconnue : %COMMAND%
echo Usage : start.bat [bot^|doctor^|api^|scan ^<MINT^>^|demo]
exit /b 1
