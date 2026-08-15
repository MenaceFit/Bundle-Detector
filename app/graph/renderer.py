"""Bubble map rendering (§27, §28, §59).

Two outputs:

* a PNG for Discord, rendered with matplotlib;
* a self-contained interactive HTML page (inline SVG + vanilla JS, no external
  requests) supporting zoom, pan, selection, cluster highlighting and hiding
  infrastructure or low-risk wallets.

Node colour follows the spec's legend; node size is configurable (SOL balance,
token position, or a flat size).  Edge thickness follows relationship strength.
"""

from __future__ import annotations

import html
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import networkx as nx

from app.graph.builder import GraphBundle
from app.models.cluster import Cluster
from app.models.enums import EntityType
from app.models.wallet import WalletProfile
from app.utils.addresses import shorten
from app.utils.logging import get_logger

log = get_logger("CLUSTER")

#: Legend colours (§27).
COLORS: dict[str, str] = {
    "creator": "#c026d3",
    "funder": "#3b82f6",
    "buyer": "#22c55e",
    "suspicious": "#f97316",
    "high_risk": "#ef4444",
    "infrastructure": "#9ca3af",
    "token": "#facc15",
    "holder": "#14b8a6",
}

SUSPICIOUS_RISK = 50
HIGH_RISK = 75


@dataclass
class NodeStyle:
    color: str
    category: str
    size: float


def _is_infrastructure(entity: str | None) -> bool:
    try:
        return EntityType(entity).is_infrastructure
    except ValueError:
        return False


def classify_node(
    node: str, data: dict[str, Any], profile: WalletProfile | None, *, size_by: str
) -> NodeStyle:
    role = data.get("role")
    entity = data.get("entity_type", EntityType.UNKNOWN.value)

    if role == "token":
        return NodeStyle(COLORS["token"], "token", 900.0)
    if entity == EntityType.CREATOR.value:
        category = "creator"
    elif _is_infrastructure(entity):
        category = "infrastructure"
    elif role == "actor":
        category = "funder"
    elif role == "holder":
        category = "holder"
    else:
        risk = int(data.get("risk") or 0)
        category = "high_risk" if risk >= HIGH_RISK else "suspicious" if risk >= SUSPICIOUS_RISK else "buyer"

    if size_by == "sol":
        magnitude = float(data.get("sol_balance") or 0.0)
    elif size_by == "position":
        magnitude = float(data.get("position") or 0.0)
    else:
        magnitude = 1.0
    size = 120.0 + 380.0 * math.log10(1.0 + max(0.0, magnitude))
    return NodeStyle(COLORS[category], category, min(size, 1400.0))


def _layout(graph: nx.Graph, seed: int = 11) -> dict[str, tuple[float, float]]:
    if graph.number_of_nodes() == 0:
        return {}
    if graph.number_of_nodes() <= 2:
        return {node: (float(i), 0.0) for i, node in enumerate(graph.nodes())}
    k = 1.6 / math.sqrt(graph.number_of_nodes())
    return nx.spring_layout(graph, seed=seed, k=k, iterations=120)


def _simple_view(bundle: GraphBundle) -> nx.Graph:
    """Collapse the multigraph into a simple weighted graph for layout/drawing."""
    simple = nx.Graph()
    for node, data in bundle.full.nodes(data=True):
        simple.add_node(node, **data)
    for source, target, data in bundle.full.edges(data=True):
        weight = 1.0 + math.log10(1.0 + float(data.get("amount") or 0.0))
        if simple.has_edge(source, target):
            edge = simple[source][target]
            edge["weight"] = edge.get("weight", 0.0) + weight
            edge["relations"] = sorted({*edge.get("relations", []), data.get("relation", "")})
        else:
            simple.add_edge(source, target, weight=weight, relations=[data.get("relation", "")])
    return simple


def render_png(
    bundle: GraphBundle,
    profiles: dict[str, WalletProfile],
    clusters: list[Cluster],
    output: Path,
    *,
    title: str = "Pump.fun wallet graph",
    size_by: str = "position",
    hide_infrastructure: bool = False,
) -> Path | None:
    """Render the bubble map to a PNG. Returns ``None`` if rendering fails."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.patches as mpatches
        import matplotlib.pyplot as plt
    except ImportError:  # pragma: no cover - optional dependency
        log.warning("matplotlib unavailable; skipping bubble map")
        return None

    simple = _simple_view(bundle)
    if hide_infrastructure:
        drop = [n for n, d in simple.nodes(data=True) if _is_infrastructure(d.get("entity_type"))]
        simple.remove_nodes_from(drop)
    if simple.number_of_nodes() == 0:
        return None

    positions = _layout(simple)
    cluster_of = {member: c.cluster_id for c in clusters for member in c.members}

    figure, axis = plt.subplots(figsize=(13, 9), dpi=130)
    figure.patch.set_facecolor("#0f1117")
    axis.set_facecolor("#0f1117")

    for source, target, data in simple.edges(data=True):
        if source not in positions or target not in positions:
            continue
        x1, y1 = positions[source]
        x2, y2 = positions[target]
        width = min(3.2, 0.35 + 0.5 * float(data.get("weight") or 1.0))
        axis.plot([x1, x2], [y1, y2], color="#39404f", linewidth=width, zorder=1, alpha=0.75)

    for node, data in simple.nodes(data=True):
        if node not in positions:
            continue
        style = classify_node(node, data, profiles.get(node), size_by=size_by)
        x, y = positions[node]
        edge_color = "#ffffff" if node in cluster_of else "#1f2430"
        axis.scatter(
            [x], [y], s=style.size, c=style.color, zorder=2, edgecolors=edge_color, linewidths=1.2
        )
        label = shorten(node) if data.get("role") != "token" else f"${data.get('label', '')[:8] or 'TOKEN'}"
        axis.annotate(
            label,
            (x, y),
            textcoords="offset points",
            xytext=(0, 11),
            ha="center",
            fontsize=6.5,
            color="#cbd5f5",
        )

    legend = [
        mpatches.Patch(color=COLORS["creator"], label="Creator"),
        mpatches.Patch(color=COLORS["funder"], label="Funder / intermediary"),
        mpatches.Patch(color=COLORS["buyer"], label="Buyer"),
        mpatches.Patch(color=COLORS["suspicious"], label="Suspicious"),
        mpatches.Patch(color=COLORS["high_risk"], label="High risk"),
        mpatches.Patch(color=COLORS["infrastructure"], label="Infrastructure"),
    ]
    axis.legend(
        handles=legend,
        loc="lower left",
        facecolor="#171b24",
        edgecolor="#39404f",
        labelcolor="#cbd5f5",
        fontsize=8,
    )
    axis.set_title(title, color="#e5e7eb", fontsize=13)
    axis.axis("off")
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.tight_layout()
    figure.savefig(output, facecolor=figure.get_facecolor())
    plt.close(figure)
    log.info("bubble map rendered", path=str(output), nodes=simple.number_of_nodes())
    return output


# ---------------------------------------------------------------------------
# Interactive HTML
# ---------------------------------------------------------------------------
def graph_payload(
    bundle: GraphBundle,
    profiles: dict[str, WalletProfile],
    clusters: list[Cluster],
    *,
    size_by: str = "position",
) -> dict[str, Any]:
    """Serialisable graph description shared by the HTML view and JSON export."""
    simple = _simple_view(bundle)
    positions = _layout(simple)
    cluster_of = {member: c.cluster_id for c in clusters for member in c.members}

    nodes = []
    for node, data in simple.nodes(data=True):
        style = classify_node(node, data, profiles.get(node), size_by=size_by)
        x, y = positions.get(node, (0.0, 0.0))
        profile = profiles.get(node)
        nodes.append(
            {
                "id": node,
                "short": shorten(node),
                "x": round(float(x), 4),
                "y": round(float(y), 4),
                "category": style.category,
                "color": style.color,
                "size": round(style.size / 40.0, 2),
                "cluster": cluster_of.get(node),
                "risk": int(data.get("risk") or 0),
                "role": data.get("role"),
                "entity_type": data.get("entity_type"),
                "label": data.get("label"),
                "sol_balance": data.get("sol_balance"),
                "age_seconds": data.get("age_seconds"),
                "funding_amount": profile.funding_amount if profile else None,
                "first_buy_amount": profile.first_buy.quote_amount if profile and profile.first_buy else None,
                "seconds_after_launch": (
                    profile.first_buy.seconds_after_launch if profile and profile.first_buy else None
                ),
            }
        )

    edges = [
        {
            "source": source,
            "target": target,
            "weight": round(float(data.get("weight") or 1.0), 3),
            "relations": [r for r in data.get("relations", []) if r],
        }
        for source, target in simple.edges()
        if (data := simple[source][target])
    ]
    return {
        "nodes": nodes,
        "edges": edges,
        "clusters": [
            {"id": c.cluster_id, "score": c.score, "members": c.members} for c in clusters
        ],
    }


def render_html(payload: dict[str, Any], *, title: str) -> str:
    """Self-contained interactive bubble map (no external requests)."""
    data = json.dumps(payload, separators=(",", ":"))
    safe_title = html.escape(title)
    return _HTML_TEMPLATE.replace("__TITLE__", safe_title).replace("__DATA__", data)


_HTML_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f1117; color:#e5e7eb; font:14px/1.5 system-ui,sans-serif; }
  header { padding:12px 16px; border-bottom:1px solid #262b36; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  label { font-size:12px; color:#9ca3af; display:flex; gap:6px; align-items:center; }
  #wrap { display:flex; height:calc(100vh - 58px); }
  svg { flex:1; cursor:grab; }
  svg.dragging { cursor:grabbing; }
  #side { width:290px; border-left:1px solid #262b36; padding:14px; overflow:auto; font-size:12px; }
  #side h2 { font-size:13px; margin:0 0 8px; }
  .row { display:flex; justify-content:space-between; gap:10px; padding:3px 0; border-bottom:1px solid #1c212b; }
  .k { color:#9ca3af; } .v { font-family:ui-monospace,monospace; word-break:break-all; text-align:right; }
  .legend { display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:#9ca3af; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:4px; }
  .node { cursor:pointer; }
  .node.dim { opacity:.12; }
  .edge.dim { opacity:.04; }
</style></head><body>
<header>
  <h1>__TITLE__</h1>
  <label><input type="checkbox" id="hideInfra"> hide infrastructure</label>
  <label><input type="checkbox" id="hideLow"> hide low-risk wallets</label>
  <label>cluster <select id="clusterSel"><option value="">all</option></select></label>
  <div class="legend" id="legend"></div>
</header>
<div id="wrap"><svg id="svg"></svg><div id="side"><h2>Select a node</h2><div id="detail"></div></div></div>
<script>
const DATA = __DATA__;
const svg = document.getElementById('svg');
const NS = 'http://www.w3.org/2000/svg';
const detail = document.getElementById('detail');
const view = { x:0, y:0, k:1 };
let root;

function bounds() {
  const xs = DATA.nodes.map(n=>n.x), ys = DATA.nodes.map(n=>n.y);
  return { minX: Math.min(...xs,0), maxX: Math.max(...xs,0), minY: Math.min(...ys,0), maxY: Math.max(...ys,0) };
}

function build() {
  svg.innerHTML = '';
  root = document.createElementNS(NS,'g');
  svg.appendChild(root);
  const b = bounds();
  const pad = 60, w = svg.clientWidth || 900, h = svg.clientHeight || 600;
  const sx = (w-2*pad)/Math.max(0.001,(b.maxX-b.minX)), sy = (h-2*pad)/Math.max(0.001,(b.maxY-b.minY));
  const s = Math.min(sx,sy);
  const px = n => pad + (n.x-b.minX)*s, py = n => pad + (n.y-b.minY)*s;
  const byId = Object.fromEntries(DATA.nodes.map(n=>[n.id,n]));

  for (const e of DATA.edges) {
    const a = byId[e.source], c = byId[e.target];
    if (!a || !c) continue;
    const line = document.createElementNS(NS,'line');
    line.setAttribute('x1',px(a)); line.setAttribute('y1',py(a));
    line.setAttribute('x2',px(c)); line.setAttribute('y2',py(c));
    line.setAttribute('stroke','#39404f');
    line.setAttribute('stroke-width', Math.min(3.5, 0.5 + e.weight*0.6));
    line.setAttribute('class','edge');
    line.dataset.source = e.source; line.dataset.target = e.target;
    root.appendChild(line);
  }
  for (const n of DATA.nodes) {
    const circle = document.createElementNS(NS,'circle');
    circle.setAttribute('cx',px(n)); circle.setAttribute('cy',py(n));
    circle.setAttribute('r', Math.max(4, Math.sqrt(n.size)*2.2));
    circle.setAttribute('fill', n.color);
    circle.setAttribute('stroke', n.cluster ? '#ffffff' : '#1f2430');
    circle.setAttribute('class','node');
    circle.dataset.id = n.id;
    circle.addEventListener('click', () => select(n));
    circle.appendChild(Object.assign(document.createElementNS(NS,'title'),{textContent:n.id}));
    root.appendChild(circle);
  }
  apply();
}

function select(n) {
  const rows = [
    ['address', n.id], ['role', n.role], ['type', n.entity_type], ['label', n.label ?? '—'],
    ['cluster', n.cluster ?? '—'], ['risk', n.risk],
    ['SOL balance', n.sol_balance != null ? Number(n.sol_balance).toFixed(4) : '—'],
    ['wallet age (s)', n.age_seconds != null ? Math.round(n.age_seconds) : '—'],
    ['funding', n.funding_amount != null ? Number(n.funding_amount).toFixed(4) : '—'],
    ['first buy', n.first_buy_amount != null ? Number(n.first_buy_amount).toFixed(4) : '—'],
    ['entry (s after launch)', n.seconds_after_launch != null ? Math.round(n.seconds_after_launch) : '—'],
  ];
  detail.innerHTML = rows.map(([k,v]) =>
    `<div class="row"><span class="k">${k}</span><span class="v">${String(v)}</span></div>`).join('');
}

function apply() {
  const hideInfra = document.getElementById('hideInfra').checked;
  const hideLow = document.getElementById('hideLow').checked;
  const sel = document.getElementById('clusterSel').value;
  const hidden = new Set();
  for (const n of DATA.nodes) {
    let off = false;
    if (hideInfra && n.category === 'infrastructure') off = true;
    if (hideLow && n.role === 'wallet' && n.risk < 50 && !n.cluster) off = true;
    if (sel && String(n.cluster) !== sel) off = true;
    if (off) hidden.add(n.id);
  }
  for (const el of root.querySelectorAll('circle.node'))
    el.classList.toggle('dim', hidden.has(el.dataset.id));
  for (const el of root.querySelectorAll('line.edge'))
    el.classList.toggle('dim', hidden.has(el.dataset.source) || hidden.has(el.dataset.target));
}

function transform() { root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }
svg.addEventListener('wheel', ev => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.12 : 1/1.12;
  view.k = Math.min(6, Math.max(0.25, view.k*factor));
  transform();
}, {passive:false});
let drag = null;
svg.addEventListener('mousedown', ev => { drag = {x:ev.clientX-view.x, y:ev.clientY-view.y}; svg.classList.add('dragging'); });
window.addEventListener('mouseup', () => { drag = null; svg.classList.remove('dragging'); });
window.addEventListener('mousemove', ev => { if (!drag) return; view.x = ev.clientX-drag.x; view.y = ev.clientY-drag.y; transform(); });

const legend = {creator:'#c026d3',funder:'#3b82f6',buyer:'#22c55e',suspicious:'#f97316',high_risk:'#ef4444',infrastructure:'#9ca3af'};
document.getElementById('legend').innerHTML = Object.entries(legend)
  .map(([k,v]) => `<span><span class="dot" style="background:${v}"></span>${k.replace('_',' ')}</span>`).join('');
const clusterSel = document.getElementById('clusterSel');
for (const c of DATA.clusters) clusterSel.insertAdjacentHTML('beforeend', `<option value="${c.id}">#${c.id} (${c.members.length} wallets, score ${c.score})</option>`);
for (const id of ['hideInfra','hideLow','clusterSel']) document.getElementById(id).addEventListener('change', apply);
window.addEventListener('resize', build);
build();
</script></body></html>
"""
