"""Tests de configuration et de démarrage.

Ces tests portent sur le premier contact avec l'outil : si le chargement de la
configuration échoue, rien d'autre n'a la moindre chance de fonctionner, et
l'utilisateur ne voit qu'une traceback.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.config import REPO_ROOT, BundleWeights, Settings


class TestEnvExample:
    """`.env.example` est le premier fichier que tout le monde copie."""

    def test_example_file_exists(self):
        assert (REPO_ROOT / ".env.example").exists()

    def test_copying_the_example_verbatim_loads(self, tmp_path: Path, monkeypatch):
        """Régression : les options vides faisaient planter le chargement.

        `.env.example` documente les réglages optionnels avec une valeur vide
        (`DISCORD_ALERT_CHANNEL_ID=`). Pydantic refusait de convertir `''` en
        entier, donc copier le modèle tel quel — le tout premier geste de
        l'installation — cassait *toutes* les commandes avant leur démarrage.
        """
        target = tmp_path / ".env"
        target.write_text((REPO_ROOT / ".env.example").read_text(encoding="utf-8"), encoding="utf-8")
        monkeypatch.chdir(tmp_path)

        settings = Settings(_env_file=str(target))

        assert settings.discord_autoscan_channel_id is None
        assert settings.discord_alert_channel_id is None
        assert settings.helius_api_key is None
        assert settings.solscan_api_key is None
        assert settings.rpc_url  # la seule valeur réellement pré-remplie

    @pytest.mark.parametrize(
        "field",
        [
            "discord_token",
            "helius_api_key",
            "solscan_api_key",
            "rpc_url_secondary",
            "discord_autoscan_channel_id",
            "discord_alert_channel_id",
        ],
    )
    def test_blank_optional_values_are_treated_as_absent(self, field: str):
        settings = Settings(**{field: ""})
        assert getattr(settings, field) is None

    def test_whitespace_only_is_also_treated_as_absent(self):
        assert Settings(discord_token="   ").discord_token is None


class TestSettings:
    def test_guild_ids_parsing_tolerates_junk(self):
        assert Settings(discord_guild_ids="123, 456 ,,abc, 789").guild_ids == [123, 456, 789]

    def test_guild_ids_empty(self):
        assert Settings(discord_guild_ids="").guild_ids == []

    def test_helius_key_becomes_the_priority_rpc_endpoint(self):
        settings = Settings(helius_api_key="test-key", rpc_url="https://example.invalid")
        endpoints = settings.rpc_endpoints
        assert "helius-rpc.com" in endpoints[0]
        assert endpoints[1] == "https://example.invalid"

    def test_rpc_endpoints_are_deduplicated(self):
        settings = Settings(rpc_url="https://a.invalid", rpc_url_secondary="https://a.invalid")
        assert settings.rpc_endpoints == ["https://a.invalid"]

    def test_alert_thresholds_are_ordered(self):
        alerts = Settings().alerts
        assert alerts.low_max < alerts.medium_max < alerts.high_max

    def test_weights_sum_to_one_hundred(self):
        assert BundleWeights().total() == pytest.approx(100.0)


class TestDoctor:
    """Le diagnostic doit produire une action, pas seulement un constat."""

    def test_missing_token_is_blocking_and_actionable(self):
        from app.doctor import FAIL, check_discord_token

        check = check_discord_token(Settings(discord_token=None))
        assert check.status == FAIL
        assert check.blocking
        assert check.fix and "DISCORD_TOKEN" in check.fix

    def test_application_id_pasted_instead_of_token_is_caught(self):
        """L'erreur la plus fréquente : copier l'Application ID."""
        from app.doctor import FAIL, check_discord_token

        check = check_discord_token(Settings(discord_token="1234567890123456789"))
        assert check.status == FAIL
        assert "Application ID" in (check.fix or "")

    def test_well_formed_token_passes_format_check(self):
        from app.doctor import OK, check_discord_token

        token = "M" * 26 + "." + "G" * 6 + "." + "H" * 38
        assert check_discord_token(Settings(discord_token=token)).status == OK

    def test_public_rpc_warns_but_does_not_block(self):
        from app.doctor import WARN, check_rpc_url

        check = check_rpc_url(Settings(rpc_url="https://api.mainnet-beta.solana.com"))
        assert check.status == WARN
        assert not check.blocking

    def test_missing_rpc_blocks(self):
        from app.doctor import FAIL, check_rpc_url

        check = check_rpc_url(Settings(rpc_url=""))
        assert check.status == FAIL
        assert check.blocking

    def test_disk_space_check_reports_free_space(self):
        from app.doctor import FAIL, check_disk_space

        check = check_disk_space()
        assert check.status != FAIL or "insuffisant" in check.detail

    def test_missing_pip_is_reported_with_the_repair_command(self):
        """Panne réelle sous Windows : venv sans pip, réutilisé indéfiniment."""
        from app.doctor import WARN, check_pip

        with patch("importlib.util.find_spec", return_value=None):
            check = check_pip()
        assert check.status == WARN
        assert check.fix and ("ensurepip" in check.fix or "installation" in check.fix)

    def test_pip_present_passes(self):
        from app.doctor import OK, check_pip

        assert check_pip().status == OK

    def test_report_renders_every_check_with_a_verdict(self):
        from app.doctor import Check, Report, render

        report = Report()
        report.add(Check("Token Discord", "❌", "vide", "Ajoutez DISCORD_TOKEN", blocking=True))
        report.add(Check("Python", "✅", "3.12"))
        text = render(report)
        assert "Token Discord" in text
        assert "Ajoutez DISCORD_TOKEN" in text
        assert "LE BOT NE PEUT PAS DÉMARRER" in text

    def test_report_gives_the_launch_command_when_healthy(self):
        from app.doctor import Check, Report, render

        report = Report()
        report.add(Check("Python", "✅", "3.12"))
        text = render(report)
        assert "python -m app.main bot" in text


class TestLaunchers:
    def test_launcher_scripts_are_shipped(self):
        assert (REPO_ROOT / "start.sh").exists()
        assert (REPO_ROOT / "start.bat").exists()

    def test_shell_launcher_is_executable(self):
        import os
        import stat

        mode = os.stat(REPO_ROOT / "start.sh").st_mode
        assert mode & stat.S_IXUSR, "start.sh doit être exécutable"

    def test_batch_launcher_uses_windows_line_endings(self):
        """Régression : un .bat en LF fait dérailler cmd.exe.

        cmd.exe suit un décalage d'octets dans le fichier pendant l'exécution.
        Avec des LF seuls, ce décalage dérive d'un octet par ligne, et la
        console finit par exécuter des fragments : « REM » devient « EM » puis
        « M », « if » devient « f ». Le fichier paraît normal à la lecture,
        donc la panne est très difficile à relier à sa cause.
        """
        raw = (REPO_ROOT / "start.bat").read_bytes()
        assert raw.count(b"\r\n") > 50, "start.bat doit utiliser des fins de ligne CRLF"
        assert raw.count(b"\n") == raw.count(b"\r\n"), "aucun LF orphelin ne doit subsister"

    def test_batch_launcher_is_pure_ascii(self):
        """Un caractère accentué s'affiche différemment selon la page de codes.

        Rester en ASCII supprime toute dépendance à cp850/cp1252/UTF-8.
        """
        raw = (REPO_ROOT / "start.bat").read_bytes()
        raw.decode("ascii")  # lève UnicodeDecodeError si un octet dépasse 127

    def test_gitattributes_pins_batch_line_endings(self):
        """Sans cela, git reconvertirait le fichier en LF au prochain checkout."""
        attributes = (REPO_ROOT / ".gitattributes").read_text(encoding="utf-8")
        assert "*.bat" in attributes and "eol=crlf" in attributes

    def test_gitattributes_catch_all_comes_before_the_specific_rules(self):
        """Dans .gitattributes, la DERNIÈRE règle correspondante l'emporte.

        Une règle générale placée après `*.bat text eol=crlf` l'annule en
        silence : le fichier reste correct dans l'arbre de travail, mais un
        clone neuf ressort un batch en LF — précisément la panne que
        l'attribut devait empêcher.
        """
        lines = [
            line.strip()
            for line in (REPO_ROOT / ".gitattributes").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        catch_all = next(i for i, line in enumerate(lines) if line.startswith("* "))
        specific = [i for i, line in enumerate(lines) if line.startswith(("*.bat", "*.sh"))]
        assert all(i > catch_all for i in specific), (
            "les règles spécifiques doivent suivre la règle générale, sinon elles sont annulées"
        )

    def test_shell_launcher_uses_unix_line_endings(self):
        """Inversement, un .sh en CRLF échoue sur « bad interpreter »."""
        raw = (REPO_ROOT / "start.sh").read_bytes()
        assert b"\r\n" not in raw, "start.sh doit rester en LF"

    def test_batch_launcher_has_no_dangling_gotos(self):
        import re

        source = (REPO_ROOT / "start.bat").read_text(encoding="utf-8")
        labels = {
            line.strip()[1:].split()[0].lower()
            for line in source.splitlines()
            if line.strip().startswith(":") and not line.strip().startswith("::")
        }
        targets = {m.group(1).lower() for m in re.finditer(r"goto\s+:?(\w+)", source, re.I)}
        assert not (targets - labels), f"labels manquants : {sorted(targets - labels)}"

    def test_batch_launcher_avoids_the_cmd_errorlevel_trap(self):
        """`%errorlevel%` dans un bloc parenthésé est évalué à la lecture.

        C'est ce qui rendait les tests d'erreur silencieusement faux et faisait
        partir le script n'importe où sans rien afficher.
        """
        import re

        for line in (REPO_ROOT / "start.bat").read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.upper().startswith("REM"):
                continue
            assert not (
                "(" in stripped and re.search(r"%errorlevel%", stripped, re.I)
            ), f"piège %errorlevel% : {stripped}"
            assert not re.match(
                r"if\s+(not\s+)?defined\s+\w+\s+\S+.*&&", stripped, re.I
            ), f"`&&` après un `if` s'applique au `if` entier : {stripped}"

    def test_batch_launcher_always_pauses_before_closing(self):
        """En double-clic, une sortie directe referme la fenêtre sur l'erreur."""
        import re

        source = (REPO_ROOT / "start.bat").read_text(encoding="utf-8")
        assert "pause" in source.lower()
        direct_exits = [
            line for line in source.splitlines() if re.match(r"^\s*exit /b", line, re.I)
        ]
        assert not direct_exits, f"sortie sans pause : {direct_exits}"

    def test_launchers_repair_a_venv_without_pip(self):
        """Panne vécue : venv sans pip, réutilisé à chaque lancement.

        Les deux lanceurs doivent tester pip lui-même — pas seulement la
        présence de l'interpréteur — et savoir le réamorcer.
        """
        for name in ("start.sh", "start.bat"):
            source = (REPO_ROOT / name).read_text(encoding="utf-8")
            assert "ensurepip" in source, f"{name} ne sait pas réparer pip"
            assert "-m pip --version" in source, f"{name} ne vérifie pas que pip fonctionne"

    def test_no_pythonpath_prefix_left_in_the_docs(self):
        """`python -m` ajoute déjà le dossier courant au chemin d'import.

        Le préfixe `PYTHONPATH=.` que la documentation portait était inutile et
        faisait paraître l'installation plus fragile qu'elle ne l'est.
        """
        for name in ("README.md", "docs/GUIDE_FR.md", "docs/DEMARRAGE_RAPIDE.md"):
            path = REPO_ROOT / name
            if not path.exists():
                continue
            assert "PYTHONPATH=." not in path.read_text(encoding="utf-8"), (
                f"{name} contient encore un préfixe PYTHONPATH inutile"
            )
