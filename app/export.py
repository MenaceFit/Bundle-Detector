"""Report export (§91): JSON, CSV, HTML and PNG.

The HTML export is fully self-contained — the report, the evidence, the
clusters and the interactive bubble map are inlined, so the file can be
archived or shared without any network access.
"""

from __future__ import annotations

import csv
import html
import io
import json
from pathlib import Path
from typing import Any

from app.config import EXPORT_DIR
from app.graph.builder import GraphBundle
from app.graph.renderer import graph_payload, render_html, render_png
from app.models.cluster import Cluster
from app.models.scoring import ScanReport
from app.utils.addresses import shorten
from app.utils.logging import get_logger
from app.utils.timefmt import human_duration

log = get_logger("SCAN")

SOLSCAN_TX = "https://solscan.io/tx/"
SOLSCAN_ACCOUNT = "https://solscan.io/account/"


def export_dir(mint: str) -> Path:
    path = EXPORT_DIR / mint
    path.mkdir(parents=True, exist_ok=True)
    return path


def to_json(report: ScanReport, *, path: Path | None = None) -> Path:
    target = path or export_dir(report.mint) / "report.json"
    target.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    return target


def to_csv(report: ScanReport, *, path: Path | None = None) -> Path:
    """One row per analysed wallet — the shape people actually pivot on."""
    target = path or export_dir(report.mint) / "wallets.csv"
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "wallet",
            "cluster",
            "risk",
            "entity_type",
            "sol_balance",
            "wallet_age_seconds",
            "age_is_lower_bound",
            "funding_source",
            "funding_amount",
            "funding_to_buy_seconds",
            "first_buy_signature",
            "first_buy_amount",
            "seconds_after_launch",
            "slot",
            "tokens_received",
            "pumpfun_launches",
            "sold",
        ]
    )
    for profile in report.wallets:
        first = profile.first_buy
        writer.writerow(
            [
                profile.address,
                profile.cluster_id or "",
                profile.risk_score,
                profile.entity_type.value,
                f"{profile.sol_balance:.9f}" if profile.sol_balance is not None else "",
                f"{profile.age_seconds:.0f}" if profile.age_seconds is not None else "",
                int(profile.first_seen_is_bounded),
                profile.direct_funder or "",
                f"{profile.funding_amount:.9f}" if profile.funding_amount is not None else "",
                f"{profile.funding_to_buy_seconds:.2f}" if profile.funding_to_buy_seconds is not None else "",
                first.signature if first else "",
                f"{first.quote_amount:.9f}" if first else "",
                f"{first.seconds_after_launch:.2f}" if first and first.seconds_after_launch is not None else "",
                first.slot if first else "",
                f"{first.token_amount:.6f}" if first else "",
                profile.pumpfun_launches if profile.pumpfun_launches is not None else "",
                int(bool(profile.sells)),
            ]
        )
    target.write_text(buffer.getvalue(), encoding="utf-8")
    return target


def to_png(report: ScanReport, graph: GraphBundle | None, *, path: Path | None = None) -> Path | None:
    if graph is None:
        return None
    target = path or export_dir(report.mint) / "bubble_map.png"
    profiles = {p.address: p for p in report.wallets}
    return render_png(
        graph,
        profiles,
        report.clusters,
        target,
        title=f"{report.token.display_symbol} — Pump.fun wallet graph",
    )


def to_bubble_map_html(report: ScanReport, graph: GraphBundle | None, *, path: Path | None = None) -> Path | None:
    if graph is None:
        return None
    target = path or export_dir(report.mint) / "bubble_map.html"
    profiles = {p.address: p for p in report.wallets}
    payload = graph_payload(graph, profiles, report.clusters)
    target.write_text(
        render_html(payload, title=f"{report.token.display_symbol} bubble map"), encoding="utf-8"
    )
    return target


def to_html(report: ScanReport, graph: GraphBundle | None = None, *, path: Path | None = None) -> Path:
    """Full self-contained HTML report."""
    target = path or export_dir(report.mint) / "report.html"
    profiles = {p.address: p for p in report.wallets}
    payload = graph_payload(graph, profiles, report.clusters) if graph else {"nodes": [], "edges": [], "clusters": []}
    target.write_text(_render_report_html(report, payload), encoding="utf-8")
    return target


def export_all(report: ScanReport, graph: GraphBundle | None = None) -> dict[str, Path]:
    out: dict[str, Path] = {"json": to_json(report), "csv": to_csv(report), "html": to_html(report, graph)}
    png = to_png(report, graph)
    if png:
        out["png"] = png
    bubble = to_bubble_map_html(report, graph)
    if bubble:
        out["bubble_map"] = bubble
    log.info("export complete", token=report.mint, files=len(out))
    return out


# ---------------------------------------------------------------------------
def _render_report_html(report: ScanReport, payload: dict[str, Any]) -> str:
    risk = report.risk
    token = report.token
    esc = html.escape

    def rows(pairs: list[tuple[str, Any]]) -> str:
        return "".join(
            f'<div class="row"><span class="k">{esc(str(k))}</span>'
            f'<span class="v">{esc(str(v))}</span></div>'
            for k, v in pairs
        )

    evidence_html = "".join(
        f"""<article class="ev">
          <h3>Evidence #{i} — {esc(e.title)}</h3>
          <p>{esc(e.detail)}</p>
          <p class="wallets">{" ".join(f'<a href="{SOLSCAN_ACCOUNT}{esc(w)}">{esc(shorten(w))}</a>' for w in e.wallets[:12])}</p>
          <p class="sigs">{" ".join(f'<a href="{SOLSCAN_TX}{esc(s)}">{esc(shorten(s, 6, 6))}</a>' for s in e.signatures[:8]) or "<em>no direct transaction reference</em>"}</p>
          <p class="caveat">⚖️ {esc(e.caveat or "")}</p>
        </article>"""
        for i, e in enumerate(report.evidence, start=1)
    )

    cluster_html = "".join(_cluster_html(c, esc) for c in report.clusters)

    wallet_rows = "".join(
        _wallet_row_html(p, esc)
        for p in sorted(report.wallets, key=lambda w: w.risk_score, reverse=True)
    )

    breakdown_html = "".join(
        f'<div class="row"><span class="k">{esc(c.label)}</span>'
        f'<span class="v">+{c.points:.1f} / {c.max_points:.0f}'
        + (f' <em>({esc(c.damping_reason)})</em>' if c.damping_reason else "")
        + "</span></div>"
        for c in risk.bundle.top_contributions(12)
    )

    return _REPORT_TEMPLATE.format(
        title=esc(f"{token.display_symbol} — Pump.fun forensics report"),
        mint=esc(token.mint),
        symbol=esc(token.display_symbol),
        name=esc(token.name or "Unknown"),
        level=esc(risk.risk_level.value),
        level_emoji=risk.risk_level.emoji,
        classification=esc(risk.classification.value),
        verdict=esc(risk.classification.verdict_text),
        bundle=risk.bundle.score,
        confidence=risk.confidence.score,
        confidence_level=esc(risk.confidence.level),
        overall=risk.overall_risk,
        overview=rows(
            [
                ("Mint", token.mint),
                ("Creator", token.creator or "unknown"),
                ("Launch age", human_duration(token.age_seconds)),
                ("Lifecycle", token.lifecycle.label),
                ("Pair", token.pair.value),
                ("Graduated", "yes" if token.graduation.graduated else "no"),
                ("PumpSwap pool", token.graduation.pumpswap_pool or "—"),
                ("Mayhem mode", "yes" if token.mayhem.enabled else "no"),
                ("Wallets analysed", len(report.wallets)),
                ("Clusters", len(report.clusters)),
                ("Scan duration", f"{report.duration_seconds:.1f}s"),
                ("Data quality", f"{report.data_quality.get('score', 0) * 100:.0f}%"),
            ]
        ),
        scores=rows(
            [
                ("Bundle", risk.bundle.score),
                ("Funding coordination", risk.funding_coordination),
                ("Buy coordination", risk.buy_coordination),
                ("Wallet cluster", risk.wallet_cluster),
                ("Creator link", risk.creator_link),
                ("Historical pattern", risk.historical_pattern),
                ("Sell coordination", risk.sell_coordination),
                ("Mayhem activity", risk.mayhem_activity),
                ("Early buyer risk", risk.early_buyer_risk),
                ("Dev risk", risk.dev_risk),
                ("Overall", risk.overall_risk),
                ("Confidence", f"{risk.confidence.score}% ({risk.confidence.level})"),
                ("Independent signal families", risk.bundle.independent_signals),
            ]
        ),
        breakdown=breakdown_html or "<p>No contributing signals.</p>",
        evidence=evidence_html or "<p>No coordination evidence was found.</p>",
        clusters=cluster_html or "<p>No clusters met the minimum size.</p>",
        wallet_rows=wallet_rows,
        limitations="".join(f"<li>{esc(x)}</li>" for x in risk.confidence.limitations)
        or "<li>None recorded.</li>",
        warnings="".join(f"<li>{esc(w)}</li>" for w in report.warnings) or "<li>None.</li>",
        disclaimer_en=esc(report.disclaimer_en),
        disclaimer_fr=esc(report.disclaimer_fr),
        graph_json=json.dumps(payload, separators=(",", ":")),
    )


DASH = "—"


def _account_link(address: str | None, esc) -> str:
    if not address:
        return DASH
    return f'<a href="{SOLSCAN_ACCOUNT}{esc(address)}">{esc(shorten(address))}</a>'


def _wallet_row_html(profile, esc) -> str:
    first = profile.first_buy
    balance = DASH if profile.sol_balance is None else f"{profile.sol_balance:.3f}"
    buy = DASH if first is None else f"{first.quote_amount:.4f}"
    entry = (
        DASH
        if first is None or first.seconds_after_launch is None
        else esc(human_duration(first.seconds_after_launch))
    )
    funding = DASH if profile.funding_amount is None else f"{profile.funding_amount:.4f}"
    return (
        "<tr>"
        f'<td><a href="{SOLSCAN_ACCOUNT}{esc(profile.address)}">{esc(shorten(profile.address, 6, 6))}</a></td>'
        f"<td>{profile.cluster_id or DASH}</td>"
        f"<td>{profile.risk_score}</td>"
        f"<td>{balance}</td>"
        f"<td>{esc(human_duration(profile.age_seconds))}</td>"
        f"<td>{buy}</td>"
        f"<td>{entry}</td>"
        f"<td>{_account_link(profile.direct_funder, esc)}</td>"
        f"<td>{funding}</td>"
        "</tr>"
    )


def _cluster_html(cluster: Cluster, esc) -> str:
    signals = "".join(
        f'<div class="row"><span class="k">{esc(k.replace("_", " "))}</span>'
        f'<span class="v">{v * 100:.0f}%</span></div>'
        for k, v in cluster.signals.as_dict().items()
        if v > 0
    )
    members = " ".join(
        f'<a href="{SOLSCAN_ACCOUNT}{esc(m)}">{esc(shorten(m))}</a>' for m in cluster.members
    )
    recurring = (
        f"<p>Matches a cluster seen on {len(cluster.recurring_launches)} previous launch(es) "
        f"({cluster.recurring_similarity * 100:.0f}% similar).</p>"
        if cluster.recurring_launches
        else ""
    )
    return f"""<article class="cluster">
      <h3>Cluster #{cluster.cluster_id} — {cluster.size} wallets · score {cluster.score}/100</h3>
      <p class="meta">detected by {esc(cluster.method)}</p>
      {signals}
      {recurring}
      <p class="wallets">{members}</p>
    </article>"""


_REPORT_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
 :root {{ color-scheme: dark; }}
 body {{ margin:0; background:#0f1117; color:#e5e7eb; font:14px/1.6 system-ui,sans-serif; }}
 main {{ max-width:1080px; margin:0 auto; padding:28px 20px 80px; }}
 h1 {{ font-size:22px; margin:0 0 4px; }}
 h2 {{ font-size:16px; margin:34px 0 10px; padding-bottom:6px; border-bottom:1px solid #262b36; }}
 h3 {{ font-size:14px; margin:0 0 6px; }}
 .sub {{ color:#9ca3af; font-family:ui-monospace,monospace; font-size:12px; word-break:break-all; }}
 .verdict {{ margin:18px 0; padding:16px; border-radius:10px; background:#171b24; border:1px solid #262b36; }}
 .verdict .big {{ font-size:20px; font-weight:700; }}
 .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:18px; }}
 .card {{ background:#141821; border:1px solid #262b36; border-radius:10px; padding:14px; }}
 .row {{ display:flex; justify-content:space-between; gap:14px; padding:4px 0; border-bottom:1px solid #1c212b; }}
 .k {{ color:#9ca3af; }} .v {{ text-align:right; font-family:ui-monospace,monospace; word-break:break-all; }}
 .ev, .cluster {{ background:#141821; border:1px solid #262b36; border-left:3px solid #38bdf8; border-radius:8px; padding:12px 14px; margin:10px 0; }}
 .cluster {{ border-left-color:#f97316; }}
 .caveat {{ color:#facc15; font-size:12px; }}
 .wallets a, .sigs a {{ color:#7dd3fc; margin-right:8px; font-family:ui-monospace,monospace; font-size:12px; }}
 table {{ width:100%; border-collapse:collapse; font-size:12px; }}
 th, td {{ text-align:left; padding:6px 8px; border-bottom:1px solid #1c212b; }}
 th {{ color:#9ca3af; font-weight:600; }}
 .scroll {{ overflow-x:auto; }}
 footer {{ margin-top:36px; padding-top:14px; border-top:1px solid #262b36; color:#9ca3af; font-size:12px; }}
 a {{ color:#7dd3fc; }}
</style></head><body><main>
 <h1>{level_emoji} {symbol} — {name}</h1>
 <div class="sub">{mint}</div>

 <section class="verdict">
   <div class="big">{level_emoji} {level} · {classification}</div>
   <div>{verdict}</div>
   <div class="sub">Bundle {bundle}/100 · overall {overall}/100 · confidence {confidence}% ({confidence_level})</div>
 </section>

 <h2>Evidence</h2>
 {evidence}

 <h2>Overview</h2>
 <div class="grid"><div class="card">{overview}</div><div class="card">{scores}</div></div>

 <h2>Score breakdown</h2>
 <div class="card">{breakdown}</div>

 <h2>Clusters</h2>
 {clusters}

 <h2>Wallets</h2>
 <div class="card scroll"><table>
  <thead><tr><th>wallet</th><th>cluster</th><th>risk</th><th>SOL</th><th>age</th><th>buy</th><th>entry</th><th>funder</th><th>funding</th></tr></thead>
  <tbody>{wallet_rows}</tbody>
 </table></div>

 <h2>Bubble map</h2>
 <div class="card"><svg id="map" width="100%" height="520"></svg></div>

 <h2>Limitations</h2>
 <div class="card"><ul>{limitations}</ul></div>

 <h2>Caveats</h2>
 <div class="card"><ul>{warnings}</ul></div>

 <footer><p>{disclaimer_en}</p><p>{disclaimer_fr}</p></footer>
</main>
<script>
const G = {graph_json};
(function(){{
  const svg = document.getElementById('map');
  if (!G.nodes.length) {{ svg.outerHTML = '<p>No graph data.</p>'; return; }}
  const NS='http://www.w3.org/2000/svg';
  const xs=G.nodes.map(n=>n.x), ys=G.nodes.map(n=>n.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const W=svg.clientWidth||900, H=520, pad=40;
  const sx=v=>pad+(v-minX)/Math.max(1e-6,(maxX-minX))*(W-2*pad);
  const sy=v=>pad+(v-minY)/Math.max(1e-6,(maxY-minY))*(H-2*pad);
  const byId=Object.fromEntries(G.nodes.map(n=>[n.id,n]));
  for (const e of G.edges) {{
    const a=byId[e.source], b=byId[e.target]; if(!a||!b) continue;
    const l=document.createElementNS(NS,'line');
    l.setAttribute('x1',sx(a.x)); l.setAttribute('y1',sy(a.y));
    l.setAttribute('x2',sx(b.x)); l.setAttribute('y2',sy(b.y));
    l.setAttribute('stroke','#39404f'); l.setAttribute('stroke-width',Math.min(3,0.5+e.weight*0.5));
    svg.appendChild(l);
  }}
  for (const n of G.nodes) {{
    const c=document.createElementNS(NS,'circle');
    c.setAttribute('cx',sx(n.x)); c.setAttribute('cy',sy(n.y));
    c.setAttribute('r',Math.max(4,Math.sqrt(n.size)*2));
    c.setAttribute('fill',n.color); c.setAttribute('stroke',n.cluster?'#fff':'#1f2430');
    const t=document.createElementNS(NS,'title'); t.textContent=n.id+' · risk '+n.risk;
    c.appendChild(t); svg.appendChild(c);
  }}
}})();
</script></body></html>
"""
