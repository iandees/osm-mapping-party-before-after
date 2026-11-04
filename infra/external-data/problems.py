#!/usr/bin/env python3
"""Turn osmcoastline's error layers into something mappers can act on.

    problems.py export COASTLINE_DB OUT.geojson [DATA_TS]   # build.sh
    problems.py page IN.geojson OUT.html DATA_TS   # tested; publish.py calls render_page()

osmcoastline records everything it had to work around in the error_points and error_lines
layers of coastline.db: gaps it closed, ways that never join up, crossings, reversed
rings. `export` writes both layers as one GeoJSON file in EPSG:4326 and adds what a
mapper needs to go and fix each one (the OSM object when there is one, otherwise a
location, plus editor links). `render_page` turns that into the HTML report.

Each gap osmcoastline closed is reported once, with its length, a place name, the ways
that touch each end and who last edited them. Because the planet file is days old by the
time a mapper reads this, the live OSM API is asked whether the spot has been edited
since; a coastline way that now joins the two ends is flagged as probably already fixed.
Those lookups are best effort: any failure just leaves that detail out.
"""
from __future__ import annotations

import html
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from math import asin, cos, radians, sin, sqrt
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

JOSM_RC = "http://127.0.0.1:8111"
OSM_API = "https://api.openstreetmap.org/api/0.6"
NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "osm-before-after-external-data/1.0 (+https://github.com/iandees/osm-mapping-party-before-after)"
MAX_ITEMS = 500       # problems shown on the page
MAX_LOOKUPS = 30      # problems that get live OSM details (API etiquette: a few calls each)
SHOWN_TAGS = ("natural", "waterway", "highway", "name", "source", "fixme", "note")

# Types shown as part of a gap rather than on their own.
GAP_PARTS = ("fixed_end_point", "added_line")


def export(db: str, out: str, data_ts: str = "") -> None:
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
    fc = {"type": "FeatureCollection", "data_timestamp": data_ts, "features": features}
    fc["items"] = build_items(features)
    try:
        annotate(fc["items"], data_ts)
    except Exception as e:  # live details are a bonus; never lose the report over them
        print(f"could not add live OSM details: {e}", file=sys.stderr)
    with open(out, "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(f"wrote {out}: {len(fc['items'])} problems ({summary(features)})")


def summary(features: list[dict]) -> str:
    counts = Counter(f["properties"]["type"] for f in features)
    return ", ".join(f"{n} {t}" for t, n in counts.most_common()) or "no problems"


def count(fc: dict) -> int:
    """How many problems a mapper has to look at."""
    if "items" in fc:
        return len(fc["items"])
    return len(build_items(fc["features"]))


def coords(geom: dict) -> list[list[float]]:
    return [geom["coordinates"]] if geom["type"] == "Point" else geom["coordinates"]


def enrich(feat: dict, kind: str) -> dict:
    p = feat["properties"]
    pts = coords(feat["geometry"])
    mid = pts[len(pts) // 2] if len(pts) != 2 else [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2]
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


def metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dp, dl = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dl / 2) ** 2
    return 2 * 6371008.8 * asin(sqrt(a))


def build_items(features: list[dict]) -> list[dict]:
    """One entry per thing a mapper should look at, in display order.

    A gap osmcoastline closed shows up as two fixed_end_point nodes plus an added_line
    between them; those become a single "gap" item that records both nodes and the length.
    """
    items, ends = [], {}
    for f in features:
        p = f["properties"]
        if p["type"] == "fixed_end_point":
            ends[(p["lon"], p["lat"])] = p
    for f in features:
        p = f["properties"]
        if p["type"] == "added_line":
            a, b = f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][-1]
            pa = ends.get((round(a[0], 6), round(a[1], 6)))
            pb = ends.get((round(b[0], 6), round(b[1], 6)))
            nodes = [("node", e["osm_id"]) for e in (pa, pb) if e and e["osm_id"]]
            items.append({
                "type": "gap", "lat": p["lat"], "lon": p["lon"], "bbox": p["bbox"],
                "length_m": round(metres(a[1], a[0], b[1], b[0])),
                "ends": [{"osm_type": "node", "osm_id": e["osm_id"], "lat": e["lat"], "lon": e["lon"]}
                         for e in (pa, pb) if e],
                "objects": [{"osm_type": t, "osm_id": i} for t, i in nodes],
            })
        elif p["type"] not in GAP_PARTS:
            items.append({
                "type": p["type"], "lat": p["lat"], "lon": p["lon"], "bbox": p["bbox"],
                "objects": [{"osm_type": p["osm_type"], "osm_id": p["osm_id"]}] if p["osm_type"] else [],
            })
    # Gaps that lost their fixed_end_point nodes (shouldn't happen) still show up via the line above;
    # stray fixed_end_point nodes without a line are reported on their own.
    paired = {(e["lon"], e["lat"]) for it in items if it["type"] == "gap" for e in it["ends"]}
    for (lon, lat), p in ends.items():
        if (lon, lat) not in paired:
            items.append({"type": "fixed_end_point", "lat": lat, "lon": lon, "bbox": p["bbox"],
                          "objects": [{"osm_type": "node", "osm_id": p["osm_id"]}] if p["osm_id"] else []})
    items.sort(key=lambda it: (ORDER_ITEMS.index(it["type"]) if it["type"] in ORDER_ITEMS else 99,
                               it["lat"], it["lon"]))
    return items


ORDER_ITEMS = ["gap"] + [t for t in ORDER if t not in GAP_PARTS]


# --- live OSM details -------------------------------------------------------------------

def api_get(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"lookup failed: {url}: {e}", file=sys.stderr)
        return None
    finally:
        time.sleep(1)  # one request a second is polite to both the API and Nominatim


def short_tags(tags: dict | None) -> dict:
    return {k: tags[k] for k in SHOWN_TAGS if tags and k in tags}


def describe_object(otype: str, oid: int, fetch) -> dict | None:
    """Current state of a node or way and, for a node, every way that uses it."""
    obj = fetch(f"{OSM_API}/{otype}/{oid}.json")
    if not obj or not obj.get("elements"):
        return None
    e = obj["elements"][0]
    out = {"osm_type": otype, "osm_id": oid, "visible": e.get("visible", True),
           "version": e.get("version"), "timestamp": e.get("timestamp"), "user": e.get("user"),
           "changeset": e.get("changeset"), "tags": short_tags(e.get("tags"))}
    if otype == "node":
        ways = fetch(f"{OSM_API}/node/{oid}/ways.json")
        out["ways"] = [
            {"id": w["id"], "tags": short_tags(w.get("tags")), "coastline": (w.get("tags") or {}).get("natural") == "coastline",
             "nodes": w["nodes"], "timestamp": w.get("timestamp"), "user": w.get("user"),
             "changeset": w.get("changeset")}
            for w in (ways or {}).get("elements", [])
        ]
    return out


def place_name(lat: float, lon: float, fetch) -> str | None:
    q = urllib.parse.urlencode({"format": "jsonv2", "zoom": 10, "lat": lat, "lon": lon})
    d = fetch(f"{NOMINATIM}?{q}")
    if not d or "address" not in d:
        return None
    a = d["address"]
    parts = [a.get(k) for k in ("county", "municipality", "city", "state", "country") if a.get(k)]
    return ", ".join(dict.fromkeys(parts)) or d.get("display_name")


def annotate(items: list[dict], data_ts: str, fetch=api_get, lookups: int = MAX_LOOKUPS) -> None:
    """Add a place name, the current state of each object and a possibly-fixed verdict."""
    for it in items[:lookups]:
        it["place"] = place_name(it["lat"], it["lon"], fetch)
        details = [d for o in it["objects"] if (d := describe_object(o["osm_type"], o["osm_id"], fetch))]
        it["details"] = details
        # Edited after the planet snapshot: the report may be out of date for this spot.
        it["edited_since"] = bool(data_ts) and any(
            (d["timestamp"] or "") > data_ts or any((w["timestamp"] or "") > data_ts for w in d.get("ways", []))
            for d in details
        )
        if it["type"] == "gap" and len(details) == 2:
            a, b = details
            for w in a.get("ways", []):
                if w["coastline"] and b["osm_id"] in w["nodes"]:
                    it["probably_fixed_by"] = {"id": w["id"], "user": w["user"], "timestamp": w["timestamp"]}
        elif it["type"] in ("end_point", "fixed_end_point") and details:
            coast = [w for w in details[0].get("ways", []) if w["coastline"]]
            if len(coast) >= 2:
                it["probably_fixed_by"] = {"id": coast[-1]["id"], "user": coast[-1]["user"],
                                           "timestamp": coast[-1]["timestamp"]}


# --- links and page ---------------------------------------------------------------------

def links(it: dict) -> list[tuple[str, str]]:
    """(label, url) pairs for opening a problem in the OSM site, iD and JOSM."""
    lat, lon = it["lat"], it["lon"]
    objs = it["objects"]
    w, s, e, n = it["bbox"]
    pad = 0.0015
    box = f"left={w - pad}&right={e + pad}&bottom={s - pad}&top={n + pad}"
    if not objs:
        return [
            ("OpenStreetMap", f"https://www.openstreetmap.org/#map=18/{lat}/{lon}"),
            ("iD", f"https://www.openstreetmap.org/edit?editor=id#map=18/{lat}/{lon}"),
            ("JOSM", f"{JOSM_RC}/load_and_zoom?{box}"),
        ]
    first = objs[0]
    select = ",".join(f"{o['osm_type']}{o['osm_id']}" for o in objs)
    return [
        ("OpenStreetMap", f"https://www.openstreetmap.org/{first['osm_type']}/{first['osm_id']}"),
        ("iD", f"https://www.openstreetmap.org/edit?editor=id&{first['osm_type']}={first['osm_id']}#map=19/{lat}/{lon}"),
        ("JOSM", f"{JOSM_RC}/load_and_zoom?{box}&select={select}"),
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
  .item {{ border:1px solid var(--line); border-radius:6px; padding:.2rem 1rem .6rem; margin:.8rem 0; }}
  .item h3 {{ font-size:1.02rem; margin:.7rem 0 .2rem; }}
  .item p {{ margin:.3rem 0; }}
  .item ul {{ margin:.3rem 0; padding-left:1.2rem; }}
  .pill {{ font-size:.78rem; font-weight:600; padding:.05rem .5rem; border-radius:999px; border:1px solid var(--line); vertical-align:middle; }}
  .pill.ok {{ border-color:#2e7d32; color:#2e7d32; }}
  .pill.warn {{ border-color:#b26a00; color:#b26a00; }}
  .links a {{ margin-right:.8rem; white-space:nowrap; }}
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




GAP_TEXT = (
    "The coastline is broken here. These two nodes are the ends of coastline ways that don't connect "
    "to each other, so osmcoastline drew a straight line between them to get a usable result. "
    "Repair the coastline between them: connect the ways, or tag the missing stretch natural=coastline."
)


def day(ts: str | None) -> str:
    return (ts or "")[:10] or "unknown date"


def esc(s) -> str:
    return html.escape(str(s))


def tag_text(tags: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in tags.items()) or "no useful tags"


def render_details(d: dict) -> str:
    who = (f"last edited by {esc(d['user'])} on {day(d['timestamp'])}"
           f" (<a href=\"https://www.openstreetmap.org/changeset/{d['changeset']}\">changeset</a>)")
    head = (f"<a href=\"https://www.openstreetmap.org/{d['osm_type']}/{d['osm_id']}\">"
            f"{d['osm_type']} {d['osm_id']}</a>, {who}")
    ways = ""
    if d.get("ways"):
        lis = "".join(
            f"<li><a href=\"https://www.openstreetmap.org/way/{w['id']}\">way {w['id']}</a>: "
            + ("<strong>natural=coastline</strong>" if w["coastline"] else "<strong>not tagged as coastline</strong>")
            + f" ({esc(tag_text({k: v for k, v in w['tags'].items() if k != 'natural'}))}), "
            f"edited by {esc(w['user'])} on {day(w['timestamp'])}</li>"
            for w in d["ways"]
        )
        ways = f"<ul>{lis}</ul>"
    return f"<li>{head}{ways}</li>"


def render_item(i: int, it: dict) -> str:
    title, text = TYPES.get(it["type"], (it["type"], f"Reported by osmcoastline as {it['type']}."))
    pills = ""
    if it["type"] == "gap":
        title, text = "Gap in the coastline", GAP_TEXT
        pills += f' <span class="pill">{it["length_m"]:,} m</span>'
    fixed = it.get("probably_fixed_by")
    if fixed:
        pills += ' <span class="pill ok">probably already fixed</span>'
    elif it.get("edited_since"):
        pills += ' <span class="pill warn">edited since this data</span>'
    place = f'{esc(it["place"])} &middot; ' if it.get("place") else ""
    out = [f'<section class="item" id="p{i}"><h3>{esc(title)}{pills}</h3>',
           f'<p class="muted">{place}{it["lat"]:.5f}, {it["lon"]:.5f}</p>']
    if fixed:
        out.append(
            f'<p><strong>Probably already fixed:</strong> <a href="https://www.openstreetmap.org/way/{fixed["id"]}">'
            f'way {fixed["id"]}</a>, a coastline way edited by {esc(fixed["user"])} on {day(fixed["timestamp"])}, '
            "now joins the ends. Check it's a sensible coastline; the next build will drop this entry.</p>")
    out.append(f"<p>{esc(text)}</p>")
    if it.get("details"):
        out.append("<ul>" + "".join(render_details(d) for d in it["details"]) + "</ul>")
    anchors = " ".join(f'<a href="{esc(url)}" target="_blank" rel="noopener">{esc(label)}</a>'
                       for label, url in links(it))
    out.append(f'<p class="links">Open in: {anchors}</p></section>')
    return "\n".join(out)


def render_page(fc: dict, data_ts: str) -> str:
    items = fc.get("items")
    if items is None:  # a file from before items existed
        items = build_items(fc["features"])
    if not items:
        body = "<p><strong>No problems found.</strong> The coastline in this build is clean.</p>"
    else:
        items = sorted(items, key=lambda it: bool(it.get("probably_fixed_by")))  # stable: open problems first
        counts = Counter(it["type"] for it in items)
        kinds = sorted(counts, key=lambda t: ORDER_ITEMS.index(t) if t in ORDER_ITEMS else 99)
        open_n = sum(1 for it in items if not it.get("probably_fixed_by"))
        summary_rows = "\n".join(
            f"<tr><td>{esc('Gap in the coastline' if t == 'gap' else TYPES.get(t, (t,))[0])}</td>"
            f'<td class="num">{counts[t]}</td></tr>'
            for t in kinds
        )
        cards = "\n".join(render_item(n, it) for n, it in enumerate(items[:MAX_ITEMS], 1))
        more = (f'<p class="muted">Showing the first {MAX_ITEMS} of {len(items)}. '
                f'The rest are in the GeoJSON file.</p>' if len(items) > MAX_ITEMS else "")
        body = f"""<p><strong>{open_n}</strong> of {len(items)} still look open.
This data is built from a planet file dated {esc(data_ts)}, so some spots may have been fixed since.
Entries marked <em>probably already fixed</em> or <em>edited since this data</em> were checked against
the live OpenStreetMap database when the report was built.</p>

<div class="table-wrap"><table>
<thead><tr><th>Problem</th><th class="num">Count</th></tr></thead>
<tbody>
{summary_rows}
</tbody></table></div>

<h2>Map</h2>
<div id="map" role="img" aria-label="Map of coastline problems"></div>

<h2>Problems</h2>
{cards}
{more}"""
    return PAGE.format(body=body, data_ts=html.escape(data_ts))


def main(argv: list[str]) -> int:
    if len(argv) in (4, 5) and argv[1] == "export":
        export(argv[2], argv[3], argv[4] if len(argv) == 5 else "")
        return 0
    if len(argv) == 5 and argv[1] == "page":
        Path(argv[3]).write_text(render_page(json.loads(Path(argv[2]).read_text()), argv[4]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
