@echo off
REM ===========================================================================
REM  Pump.fun Bundle Detector — lanceur Windows
REM
REM    start.bat              demarre le bot Discord
REM    start.bat doctor       verifie la configuration
REM    start.bat api          demarre l'API HTTP
REM    start.bat scan <MINT>  scanne un token depuis le terminal
REM    start.bat demo         affiche un rapport d'exemple (hors ligne)
REM
REM  Ecrit sans blocs entre parentheses : dans cmd.exe, %errorlevel% y est
REM  evalue au moment de LIRE le bloc, pas de l'executer, ce qui rend les
REM  tests d'erreur silencieusement faux.
REM ===========================================================================
setlocal
cd /d "%~dp0"

REM Console en UTF-8 : sans cela, les accents et les symboles du diagnostic
REM peuvent interrompre l'affichage sur une console en cp850/cp1252.
chcp 65001 >nul 2>&1

set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=bot"

REM --- 1. Python -------------------------------------------------------------
set "LAUNCHER="
where py >nul 2>&1 && set "LAUNCHER=py -3"
if not defined LAUNCHER where python >nul 2>&1 && set "LAUNCHER=python"
if not defined LAUNCHER goto :no_python

REM --- 2. Environnement virtuel ---------------------------------------------
set "VENV_PY=.venv\Scripts\python.exe"
if exist "%VENV_PY%" goto :have_venv

echo -^> Creation de l'environnement virtuel...
%LAUNCHER% -m venv .venv
if not exist "%VENV_PY%" goto :venv_failed

:have_venv

REM --- 3. Dependances -------------------------------------------------------
if exist ".venv\.requirements-stamp" goto :have_deps

echo -^> Installation des dependances ^(une a deux minutes la premiere fois^)...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet -r requirements.txt
if errorlevel 1 goto :deps_failed
echo ok> .venv\.requirements-stamp

:have_deps

REM --- 4. Configuration -----------------------------------------------------
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

REM --- 5. Dispatch ----------------------------------------------------------
if /i "%COMMAND%"=="demo"   goto :run_demo
if /i "%COMMAND%"=="scan"   goto :run_scan
if /i "%COMMAND%"=="doctor" goto :run_doctor
if /i "%COMMAND%"=="api"    goto :run_api
if /i "%COMMAND%"=="bot"    goto :run_bot
echo Commande inconnue : %COMMAND%
echo Usage : start.bat [bot^|doctor^|api^|scan ^<MINT^>^|demo]
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

:run_bot
REM Diagnostic d'abord : un message clair vaut mieux qu'une traceback.
"%VENV_PY%" -m app.main doctor
if errorlevel 1 goto :halt
echo.
echo -^> Demarrage du bot... ^(Ctrl+C pour arreter^)
echo.
"%VENV_PY%" -m app.main bot
goto :halt

REM --- Erreurs --------------------------------------------------------------
:no_python
echo.
echo [X] Python est introuvable.
echo     Installez Python 3.12 : https://www.python.org/downloads/
echo     IMPORTANT : cochez "Add python.exe to PATH" pendant l'installation.
goto :halt

:venv_failed
echo.
echo [X] Impossible de creer l'environnement virtuel.
echo     Causes habituelles : disque plein, ou Python installe sans le
echo     module venv. Verifiez l'espace disque disponible.
goto :halt

:deps_failed
echo.
echo [X] L'installation des dependances a echoue.
echo     Cause la plus frequente : espace disque insuffisant
echo     ^(il faut environ 500 Mo^). Liberez de la place et relancez.
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
