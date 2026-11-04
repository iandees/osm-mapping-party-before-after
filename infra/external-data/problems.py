#!/usr/bin/env python3
"""Turn osmcoastline's error layers into something mappers can act on.

    problems.py export COASTLINE_DB OUT.geojson    # build.sh
    problems.py page IN.geojson OUT.html DATA_TS   # tested; publish.py calls render_page()

osmcoastline records everything it had to work around in the error_points and error_lines
layers of coastline.db: gaps it closed, ways that never join up, crossings, reversed
rings. `export` writes both layers as one GeoJSON file in EPSG:4326 and adds what a
mapper needs to go and fix each one (the OSM object when there is one, otherwise a
location, plus editor links). `render_page` turns that into the HTML report.
"""
from __future__ import annotations

import html
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

# Display order is the order of this table: breaks in the coastline first, since those
# are what actually leave a hole in the water polygons.
# type -> (title, what it means and how to fix it)
TYPES = {
    "end_point": (
        "Unconnected coastline end",
        "A chain of coastline ways stops here without joining back up. Look for a missing "
        "connection or a gap between two ways and join them, or extend the coastline until it closes.",
    ),
    "not_closed": (
        "Coastline that never closes",
        "The ways making up this chain of coastline never form a closed ring. Follow the line to both "
        "marked ends and close the gap.",
    ),
    "fixed_end_point": (
        "Gap closed automatically",
        "Two coastline ends here are not connected in OpenStreetMap. osmcoastline joined them with a "
        "straight line to get a usable result. Connect the ways (or mend the coastline between the "
        "two ends) so the data is right at the source.",
    ),
    "added_line": (
        "Line added to close a gap",
        "The straight line osmcoastline added between two unconnected coastline ends. "
        "The real coastline between them is missing or broken.",
    ),
    "intersection": (
        "Coastline crosses itself",
        "Two coastline segments cross here. Look for a missing shared node or a way that has been "
        "drawn over another one.",
    ),
    "overlap": (
        "Overlapping coastline",
        "Two coastline segments run on top of each other. Remove or merge the duplicate.",
    ),
    "direction": (
        "Coastline drawn the wrong way round",
        "A ring runs the wrong direction. Coastline ways must have land on the left and water on the right. "
        "Reverse the way, or check that the island or lake is nested correctly.",
    ),
    "invalid": (
        "Invalid coastline shape",
        "The coastline forms an invalid polygon here, usually because it touches or crosses itself.",
    ),
    "questionable": (
        "Small water-side ring",
        "A small closed coastline ring has water on its inside. It may be an island drawn backwards "
        "(reverse it) or a pond that should not be tagged natural=coastline.",
    ),
    "tagged_node": (
        "Node tagged as coastline",
        "A single node has natural=coastline. The tag belongs on ways only, so remove it from the node.",
    ),
    "double_node": (
        "Duplicated node",
        "Two nodes sit at the same spot where coastline ways meet. Merge them.",
    ),
    "single_point_in_ring": (
        "Coastline ring with one node",
        "A coastline way consists of a single node repeated. Delete it or draw the coastline properly.",
    ),
    "not_a_ring": (
        "Coastline ring with too few nodes",
        "A closed coastline way has only two or three nodes, so it cannot enclose anything. "
        "Delete it or draw the coastline properly.",
    ),
}
ORDER = list(TYPES)

# Points whose osm_id is a node; lines' osm_id (when present) is the smallest way id in the ring.
JOSM_RC = "http://127.0.0.1:8111"
MAX_ROWS = 1500


def export(db: str, out: str) -> None:
    """Write both error layers of an osmcoastline database as one enriched GeoJSON file."""
    features = []
    with tempfile.TemporaryDirectory() as tmp:
        for layer, kind in (("error_points", "point"), ("error_lines", "line")):
            part = Path(tmp) / f"{layer}.geojson"
            subprocess.run(
                ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "COORDINATE_PRECISION=6",
                 str(part), db, layer],
                check=True,
            )
            for feat in json.loads(part.read_text())["features"]:
                features.append(enrich(feat, kind))
    features.sort(key=lambda f: (ORDER.index(f["properties"]["type"]) if f["properties"]["type"] in ORDER else 99,
                                 f["properties"]["lat"], f["properties"]["lon"]))
    with open(out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"wrote {out}: {summary(features)}")


def summary(features: list[dict]) -> str:
    counts = Counter(f["properties"]["type"] for f in features)
    return ", ".join(f"{n} {t}" for t, n in counts.most_common()) or "no problems"


def count(fc: dict) -> int:
    """How many problems a mapper has to look at (added_line only illustrates a fixed gap)."""
    return sum(1 for f in fc["features"] if f["properties"]["type"] != "added_line")


def coords(geom: dict) -> list[list[float]]:
    return [geom["coordinates"]] if geom["type"] == "Point" else geom["coordinates"]


def enrich(feat: dict, kind: str) -> dict:
    p = feat["properties"]
    pts = coords(feat["geometry"])
    mid = pts[len(pts) // 2]
    lons, lats = [c[0] for c in pts], [c[1] for c in pts]
    try:
        osm_id = int(p.get("osm_id") or 0)
    except ValueError:
        osm_id = 0
    otype = ("node" if kind == "point" else "way") if osm_id > 0 else None
    feat["properties"] = {
        "type": p["error"],
        "geometry": kind,
        "osm_type": otype,
        "osm_id": osm_id if otype else None,
        "lon": round(mid[0], 6),
        "lat": round(mid[1], 6),
        "bbox": [round(min(lons), 6), round(min(lats), 6), round(max(lons), 6), round(max(lats), 6)],
    }
    return feat


def links(p: dict) -> list[tuple[str, str]]:
    """(label, url) pairs for opening a problem in the OSM site, iD and JOSM."""
    lat, lon = p["lat"], p["lon"]
    if p["osm_type"]:
        t, i = p["osm_type"], p["osm_id"]
        return [
            (f"{t} {i}", f"https://www.openstreetmap.org/{t}/{i}"),
            ("iD", f"https://www.openstreetmap.org/edit?editor=id&{t}={i}"),
            ("JOSM", f"{JOSM_RC}/load_object?objects={t[0]}{i}&relation_members=false"),
        ]
    w, s, e, n = p["bbox"]
    pad = 0.0015
    return [
        (f"{lat:.5f}, {lon:.5f}", f"https://www.openstreetmap.org/#map=18/{lat}/{lon}"),
        ("iD", f"https://www.openstreetmap.org/edit?editor=id#map=18/{lat}/{lon}"),
        ("JOSM", f"{JOSM_RC}/load_and_zoom?left={w - pad}&right={e + pad}&bottom={s - pad}&top={n + pad}"),
    ]


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OSM coastline problems</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"
  integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous">
<style>
  :root {{ --bg:#fff; --fg:#1c2530; --muted:#5b6673; --line:#d9dee4; --accent:#0b62c4; --code:#f2f4f7; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#14181d; --fg:#e4e8ec; --muted:#93a0ad; --line:#2a323b; --accent:#6db1ff; --code:#1e242b; }}
  }}
  body {{ margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,sans-serif; }}
  main {{ max-width:70rem; margin:0 auto; padding:2rem 1rem 4rem; }}
  h1 {{ font-size:1.6rem; margin:0 0 .25rem; }}
  h2 {{ font-size:1.15rem; margin:2rem 0 .5rem; }}
  a {{ color:var(--accent); }}
  .muted {{ color:var(--muted); }}
  .table-wrap {{ overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; min-width:36rem; }}
  th, td {{ text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }}
  td.num {{ white-space:nowrap; text-align:right; }}
  td.links a {{ margin-right:.6rem; white-space:nowrap; }}
  code {{ background:var(--code); padding:.1em .3em; border-radius:4px; font-size:.9em; }}
  #map {{ height:28rem; border:1px solid var(--line); border-radius:6px; }}
  .note {{ border-left:3px solid var(--line); padding:.1rem 0 .1rem .9rem; color:var(--muted); }}
</style>
</head>
<body>
<main>
<h1>OSM coastline problems</h1>
<p class="muted">Places where the OpenStreetMap coastline is broken or inconsistent, as reported by
<a href="https://osmcode.org/osmcoastline/">osmcoastline</a> when it built the
<a href="index.html">water polygons</a>. Data as of <strong>{data_ts}</strong>; updated about once a month.</p>

{body}

<h2>Fixing these</h2>
<ul>
<li>Fix problems in OpenStreetMap itself, not in the shapefiles. The next monthly build picks the fix up.</li>
<li>The <strong>iD</strong> and <strong>JOSM</strong> links open the spot in your editor. JOSM needs to be
running with remote control enabled.</li>
<li>Coastline is <code>natural=coastline</code> on ways with land on the left and water on the right.
See the <a href="https://wiki.openstreetmap.org/wiki/Tag:natural%3Dcoastline">wiki page</a> before changing it,
and ask on the <a href="https://community.openstreetmap.org/">community forum</a> if a spot is unclear.</li>
<li>The raw data is <a href="coastline-problems.geojson">coastline-problems.geojson</a> (EPSG:4326).</li>
</ul>

<p class="muted">&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>,
<a href="https://opendatacommons.org/licenses/odbl/">ODbL</a>.</p>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"
  integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous"></script>
<script>
(function () {{
  var el = document.getElementById("map");
  if (!el || !window.L) return;
  var map = L.map(el).setView([20, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png", {{
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }}).addTo(map);
  fetch("coastline-problems.geojson").then(function (r) {{ return r.json(); }}).then(function (fc) {{
    var layer = L.geoJSON(fc, {{
      style: function () {{ return {{ color: "#e6007e", weight: 3 }}; }},
      pointToLayer: function (f, ll) {{ return L.circleMarker(ll, {{ radius: 6, color: "#e6007e", fillOpacity: 0.6 }}); }},
      onEachFeature: function (f, l) {{
        var p = f.properties;
        l.bindPopup("<b>" + p.type + "</b><br>" +
          (p.osm_type ? '<a href="https://www.openstreetmap.org/' + p.osm_type + "/" + p.osm_id + '">' +
            p.osm_type + " " + p.osm_id + "</a><br>" : "") +
          '<a href="https://www.openstreetmap.org/edit?editor=id' +
          (p.osm_type ? "&" + p.osm_type + "=" + p.osm_id : "#map=18/" + p.lat + "/" + p.lon) + '">Edit in iD</a>');
      }}
    }}).addTo(map);
    if (fc.features.length) map.fitBounds(layer.getBounds(), {{ maxZoom: 12 }});
  }});
}})();
</script>
</body>
</html>
"""


def render_page(fc: dict, data_ts: str) -> str:
    feats = fc["features"]
    if not feats:
        body = "<p><strong>No problems found.</strong> The coastline in this build is clean.</p>"
    else:
        # added_line just draws the join between two fixed_end_point markers.
        feats = [f for f in feats if f["properties"]["type"] != "added_line"]
        counts = Counter(f["properties"]["type"] for f in feats)
        kinds = sorted(counts, key=lambda t: ORDER.index(t) if t in ORDER else 99)
        summary_rows = "\n".join(
            f"<tr><td>{html.escape(TYPES.get(t, (t,))[0])}</td><td class=\"num\">{counts[t]}</td>"
            f"<td>{html.escape(TYPES.get(t, ('', 'Reported by osmcoastline as ' + t + '.'))[1])}</td></tr>"
            for t in kinds
        )
        shown = feats[:MAX_ROWS]
        rows = []
        for f in shown:
            p = f["properties"]
            anchors = " ".join(
                f'<a href="{html.escape(url)}" target="_blank" rel="noopener">{html.escape(label)}</a>'
                for label, url in links(p)
            )
            rows.append(
                f"<tr><td>{html.escape(TYPES.get(p['type'], (p['type'],))[0])}</td>"
                f'<td class="links">{anchors}</td></tr>'
            )
        more = (f'<p class="muted">Showing the first {MAX_ROWS} of {len(feats)}. '
                f'The rest are in the GeoJSON file.</p>' if len(feats) > MAX_ROWS else "")
        body = f"""<h2>Summary</h2>
<div class="table-wrap"><table>
<thead><tr><th>Problem</th><th class="num">Count</th><th>What it means</th></tr></thead>
<tbody>
{summary_rows}
</tbody></table></div>

<h2>Map</h2>
<div id="map" role="img" aria-label="Map of coastline problems"></div>

<h2>All problems ({len(feats)})</h2>
<div class="table-wrap"><table>
<thead><tr><th>Problem</th><th>Where</th></tr></thead>
<tbody>
{chr(10).join(rows)}
</tbody></table></div>
{more}"""
    return PAGE.format(body=body, data_ts=html.escape(data_ts))


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "export":
        export(argv[2], argv[3])
        return 0
    if len(argv) == 5 and argv[1] == "page":
        Path(argv[3]).write_text(render_page(json.loads(Path(argv[2]).read_text()), argv[4]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
