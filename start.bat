@echo off
REM ===========================================================================
REM  Pump.fun Bundle Detector — lanceur Windows
REM
REM    start.bat              demarre le bot Discord
REM    start.bat doctor       verifie la configuration
REM    start.bat api          demarre l'API HTTP
REM    start.bat scan <MINT>  scanne un token depuis le terminal
REM    start.bat demo         affiche un rapport d'exemple (hors ligne)
REM    start.bat test         lance la suite de tests
REM    start.bat reset        supprime l'environnement virtuel et repart de zero
REM
REM  Ecrit sans blocs entre parentheses : dans cmd.exe, %errorlevel% y est
REM  evalue au moment de LIRE le bloc, pas de l'executer, ce qui rend les
REM  tests d'erreur silencieusement faux.
REM ===========================================================================
setlocal
cd /d "%~dp0"

REM Console en UTF-8 : sans cela, les accents et symboles du diagnostic
REM peuvent interrompre l'affichage sur une console en cp850/cp1252.
chcp 65001 >nul 2>&1

set "VENV_PY=.venv\Scripts\python.exe"
set "STAMP=.venv\.requirements-stamp"
set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=bot"

REM --- 1. Python du systeme --------------------------------------------------
REM Ecrit en plusieurs lignes a dessein : dans cmd.exe, `&&` s'applique a la
REM commande `if` entiere, donc `if not defined X cmd && set X=...` execute le
REM `set` meme quand la condition est fausse — et ecraserait le lanceur trouve.
set "LAUNCHER="
where py >nul 2>&1
if not errorlevel 1 set "LAUNCHER=py -3"
if defined LAUNCHER goto :have_python
where python >nul 2>&1
if not errorlevel 1 set "LAUNCHER=python"

:have_python
if not defined LAUNCHER goto :no_python

if /i "%COMMAND%"=="reset" goto :do_reset

REM --- 2. Environnement virtuel, avec reparation -----------------------------
REM Un venv dont pip n'a pas ete amorce est le mode de panne le plus courant
REM sous Windows : python.exe est bien la, donc l'environnement parait valide,
REM mais toute installation echoue sur "No module named pip". Verifier la
REM presence du binaire ne suffit donc pas — on teste pip lui-meme.
if not exist "%VENV_PY%" goto :create_venv
goto :check_pip

:create_venv
echo -^> Creation de l'environnement virtuel...
%LAUNCHER% -m venv .venv
if not exist "%VENV_PY%" goto :venv_failed

:check_pip
"%VENV_PY%" -m pip --version >nul 2>&1
if not errorlevel 1 goto :pip_ok

echo -^> pip est absent de l'environnement virtuel, reparation...
"%VENV_PY%" -m ensurepip --default-pip >nul 2>&1
"%VENV_PY%" -m pip --version >nul 2>&1
if not errorlevel 1 goto :pip_ok

echo -^> Reparation impossible, reconstruction complete de l'environnement...
rmdir /s /q .venv >nul 2>&1
%LAUNCHER% -m venv .venv
if not exist "%VENV_PY%" goto :venv_failed
"%VENV_PY%" -m ensurepip --default-pip >nul 2>&1
"%VENV_PY%" -m pip --version >nul 2>&1
if errorlevel 1 goto :pip_failed

:pip_ok

REM --- 3. Dependances --------------------------------------------------------
REM On ne se fie pas seulement au fichier temoin : une installation interrompue
REM le laisserait absent, mais un environnement a moitie peuple passerait pour
REM valide si l'on ne verifiait pas que les modules s'importent reellement.
if not exist "%STAMP%" goto :install_deps
"%VENV_PY%" -c "import discord, httpx, pydantic, sqlalchemy, networkx, sklearn, matplotlib" >nul 2>&1
if errorlevel 1 goto :install_deps
goto :deps_ok

:install_deps
echo -^> Installation des dependances ^(une a deux minutes la premiere fois^)...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet -r requirements.txt
if errorlevel 1 goto :deps_failed
"%VENV_PY%" -c "import discord, httpx, pydantic, sqlalchemy, networkx, sklearn, matplotlib" >nul 2>&1
if errorlevel 1 goto :deps_broken
echo ok> "%STAMP%"

:deps_ok

REM --- 4. Configuration ------------------------------------------------------
if exist ".env" goto :have_env
copy .env.example .env >nul
echo.
echo -^> Fichier .env cree a partir du modele.
echo.
echo    Ouvrez-le et renseignez au minimum :
echo      RPC_URL=...        votre endpoint RPC Solana
echo      DISCORD_TOKEN=...  le token du bot ^(pour le mode bot^)
echo.
echo    Puis relancez : start.bat
goto :halt

:have_env

REM --- 5. Lancement ----------------------------------------------------------
if /i "%COMMAND%"=="demo"   goto :run_demo
if /i "%COMMAND%"=="scan"   goto :run_scan
if /i "%COMMAND%"=="doctor" goto :run_doctor
if /i "%COMMAND%"=="api"    goto :run_api
if /i "%COMMAND%"=="test"   goto :run_test
if /i "%COMMAND%"=="bot"    goto :run_bot
echo Commande inconnue : %COMMAND%
echo Usage : start.bat [bot^|doctor^|api^|scan ^<MINT^>^|demo^|test^|reset]
goto :halt

:run_demo
"%VENV_PY%" -m scripts.demo_report %2 %3
goto :halt

:run_scan
"%VENV_PY%" -m scripts.cli %2 %3 %4 %5
goto :halt

:run_doctor
"%VENV_PY%" -m app.main doctor
goto :halt

:run_api
"%VENV_PY%" -m app.main api
goto :halt

:run_test
REM pytest n'est pas dans requirements.txt (dependance de developpement).
"%VENV_PY%" -c "import pytest" >nul 2>&1
if errorlevel 1 "%VENV_PY%" -m pip install --quiet pytest pytest-asyncio
"%VENV_PY%" -m pytest -q
goto :halt

:run_bot
REM Diagnostic d'abord : un message clair vaut mieux qu'une traceback.
"%VENV_PY%" -m app.main doctor
if errorlevel 1 goto :halt
echo.
echo -^> Demarrage du bot... ^(Ctrl+C pour arreter^)
echo.
"%VENV_PY%" -m app.main bot
goto :halt

:do_reset
echo -^> Suppression de l'environnement virtuel...
rmdir /s /q .venv >nul 2>&1
echo    Fait. Relancez start.bat
goto :halt

REM --- Erreurs ---------------------------------------------------------------
:no_python
echo.
echo [X] Python est introuvable.
echo     Installez Python 3.12 : https://www.python.org/downloads/
echo     IMPORTANT : cochez "Add python.exe to PATH" pendant l'installation.
goto :halt

:venv_failed
echo.
echo [X] Impossible de creer l'environnement virtuel.
echo     Causes possibles : droits d'ecriture sur le dossier, antivirus, ou
echo     Python installe sans le module venv.
goto :halt

:pip_failed
echo.
echo [X] Impossible d'obtenir un pip fonctionnel dans l'environnement virtuel.
echo.
echo     Votre installation de Python n'inclut probablement pas 'ensurepip'.
echo     C'est frequent avec la version du Microsoft Store.
echo.
echo     Solution : desinstallez-la, puis installez Python 3.12 depuis
echo     https://www.python.org/downloads/ en cochant :
echo       - "Add python.exe to PATH"
echo       - "pip" dans les composants optionnels
goto :halt

:deps_failed
echo.
echo [X] L'installation des dependances a echoue.
echo     Regardez le message ci-dessus : reseau, droits d'ecriture, antivirus
echo     bloquant .venv, ou espace disque sur le lecteur du projet.
goto :halt

:deps_broken
echo.
echo [X] Les dependances se sont installees mais ne s'importent pas.
echo     Repartez de zero :  start.bat reset
goto :halt

REM Lance en double-clic, la fenetre se refermerait instantanement et le
REM message serait illisible. On garde la console ouverte.
:halt
echo.
echo ----------------------------------------------------------------
echo Le programme s'est arrete. Lisez le message ci-dessus.
echo Diagnostic :  start.bat doctor
echo.
pause
endlocal
