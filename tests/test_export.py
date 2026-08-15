"""Export, rendering and report-presentation tests (§91, §113, §109)."""

from __future__ import annotations

import json

import pytest

from app.export import export_all, to_csv, to_html, to_json, to_png
from app.graph.renderer import graph_payload, render_html
from app.models.enums import ScanDepth
from tests.support import scenarios
from tests.test_pipeline import run_scenario


@pytest.fixture
async def scanned(settings):
    return await run_scenario(scenarios.private_bundle(), settings, ScanDepth.FULL)


class TestExports:
    async def test_json_export_roundtrips(self, scanned, tmp_path):
        report, _ = scanned
        path = to_json(report, path=tmp_path / "report.json")
        payload = json.loads(path.read_text())
        assert payload["mint"] == report.mint
        assert payload["risk"]["bundle"]["score"] == report.risk.bundle.score
        assert payload["evidence"]
        assert payload["disclaimer_en"]

    async def test_csv_has_one_row_per_wallet_with_provenance(self, scanned, tmp_path):
        report, _ = scanned
        path = to_csv(report, path=tmp_path / "wallets.csv")
        lines = path.read_text().strip().splitlines()
        assert len(lines) == len(report.wallets) + 1
        header = lines[0].split(",")
        assert "first_buy_signature" in header
        assert "funding_source" in header
        assert "age_is_lower_bound" in header

    async def test_html_report_is_self_contained(self, scanned, tmp_path):
        report, context = scanned
        path = to_html(report, context.graph, path=tmp_path / "report.html")
        html = path.read_text()
        assert "<!doctype html>" in html.lower()
        assert report.mint in html
        assert "EVIDENCE" in html.upper()
        # No external resources — the page must open offline.
        assert "http://" not in html.replace("http://www.w3.org", "")
        assert "<script src=" not in html
        assert "<link" not in html

    async def test_html_places_evidence_before_the_verdict_sections(self, scanned, tmp_path):
        """§113: evidence first, conclusions after."""
        report, context = scanned
        html = to_html(report, context.graph, path=tmp_path / "r.html").read_text()
        assert html.index("<h2>Evidence</h2>") < html.index("<h2>Score breakdown</h2>")

    async def test_html_contains_the_disclaimers(self, scanned, tmp_path):
        report, context = scanned
        html = to_html(report, context.graph, path=tmp_path / "r.html").read_text()
        assert "does not prove wallet ownership" in html
        assert "probabiliste" in html

    async def test_png_bubble_map_is_produced(self, scanned, tmp_path):
        report, context = scanned
        path = to_png(report, context.graph, path=tmp_path / "map.png")
        assert path is not None
        assert path.exists()
        assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    async def test_export_all_produces_every_format(self, scanned, tmp_path, monkeypatch):
        report, context = scanned
        monkeypatch.setattr("app.export.EXPORT_DIR", tmp_path)
        paths = export_all(report, context.graph)
        assert {"json", "csv", "html", "png", "bubble_map"} <= set(paths)
        assert all(p.exists() for p in paths.values())


class TestBubbleMap:
    async def test_payload_describes_nodes_edges_and_clusters(self, scanned):
        report, context = scanned
        profiles = {p.address: p for p in report.wallets}
        payload = graph_payload(context.graph, profiles, report.clusters)
        assert payload["nodes"] and payload["edges"]
        categories = {n["category"] for n in payload["nodes"]}
        assert "token" in categories
        assert categories & {"buyer", "suspicious", "high_risk"}
        clustered = [n for n in payload["nodes"] if n["cluster"]]
        assert clustered, "cluster membership must be visible on the map"

    async def test_interactive_html_has_no_external_requests(self, scanned):
        report, context = scanned
        profiles = {p.address: p for p in report.wallets}
        html = render_html(graph_payload(context.graph, profiles, report.clusters), title="map")
        assert "<script src=" not in html
        assert "hideInfra" in html  # infrastructure filter (§59)
        assert "clusterSel" in html  # cluster highlighting


class TestTerminalRendering:
    async def test_cli_render_is_ordered_evidence_then_verdict(self, scanned):
        from scripts.cli import render

        report, _ = scanned
        text = render(report)
        assert text.index("EVIDENCE") < text.index("VERDICT")
        assert "BUNDLE" in text.upper() or "Bundle" in text
        assert "DATA QUALITY" in text
        assert "probabilistic analysis" in text

    async def test_cli_render_shows_score_contributors(self, scanned):
        from scripts.cli import render

        report, _ = scanned
        text = render(report)
        assert "Contributors:" in text
        assert "Confidence" in text


class TestDiscordEmbeds:
    async def test_full_report_embed_order(self, scanned):
        from app.discord.embeds import build_all

        report, _ = scanned
        embeds = build_all(report)
        titles = [e.title for e in embeds]
        assert any("RISK ANALYSIS" in t for t in titles)
        assert titles.index("🔍 EVIDENCE") < titles.index("FINAL VERDICT")

    async def test_verdict_embed_carries_both_disclaimers(self, scanned):
        from app.discord.embeds import verdict_embed

        report, _ = scanned
        embed = verdict_embed(report)
        text = " ".join(field.value for field in embed.fields)
        assert "does not prove wallet ownership" in text
        assert "probabiliste" in text

    async def test_not_pumpfun_embed_states_the_rule(self):
        from app.discord.embeds import not_pumpfun_embed

        embed = not_pumpfun_embed("SomeMint", "no bonding curve")
        assert "NOT A PUMP.FUN TOKEN" in embed.title
        assert "only analyzes Pump.fun launches" in embed.description
