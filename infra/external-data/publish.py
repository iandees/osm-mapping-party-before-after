#!/usr/bin/env python3
"""Publish a build.sh output directory to the public `osm-data` R2 bucket.

    publish.py OUT_DIR [--placeholders DIR] [--check-against URL] [--dry-run]

OUT_DIR holds build.sh's output (the two water zips and manifest.json). The bucket is
served at https://osmdata.mapki.com/, laid out like osmdata.openstreetmap.de:

    download/<name>.zip   the shapefile zips (stable URLs, overwritten each build)
    manifest.json         machine-readable build info, sizes and checksums
    index.html            the human-readable page, generated here from the manifest

Before uploading anything the zips are verified and, with --check-against, their sizes
are compared with the manifest already published, so a bad build can't replace a good
one. Credentials come from the environment (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
R2_ENDPOINT). Files go up first and the page last, so it never links to a missing file.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone

import boto3

BUCKET = "osm-data"
SITE = "https://osmdata.mapki.com"
REPO = "https://github.com/iandees/osm-mapping-party-before-after"

# name -> (what it is, "built" or "placeholder")
FILES = {
    "water-polygons-split-3857.zip": (
        "Coastline water polygons, split into a grid, full resolution (zoom 10 and up).",
        "built",
    ),
    "simplified-water-polygons-split-3857.zip": (
        "The same polygons simplified for low zooms (zoom 9 and below).",
        "built",
    ),
    "antarctica-icesheet-polygons-3857.zip": (
        "Antarctic ice sheet polygons. Empty placeholder, see below.",
        "placeholder",
    ),
    "antarctica-icesheet-outlines-3857.zip": (
        "Antarctic ice sheet outlines. Empty placeholder, see below.",
        "placeholder",
    ),
}

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OSM coastline water polygons</title>
<style>
  :root {{ --bg:#fff; --fg:#1c2530; --muted:#5b6673; --line:#d9dee4; --accent:#0b62c4; --code:#f2f4f7; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#14181d; --fg:#e4e8ec; --muted:#93a0ad; --line:#2a323b; --accent:#6db1ff; --code:#1e242b; }}
  }}
  body {{ margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,sans-serif; }}
  main {{ max-width:60rem; margin:0 auto; padding:2rem 1rem 4rem; }}
  h1 {{ font-size:1.6rem; margin:0 0 .25rem; }}
  h2 {{ font-size:1.15rem; margin:2rem 0 .5rem; }}
  a {{ color:var(--accent); }}
  .muted {{ color:var(--muted); }}
  .table-wrap {{ overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; min-width:36rem; }}
  th, td {{ text-align:left; padding:.55rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }}
  td.num {{ white-space:nowrap; text-align:right; }}
  code {{ background:var(--code); padding:.1em .3em; border-radius:4px; font-size:.9em; }}
  .note {{ border-left:3px solid var(--line); padding:.1rem 0 .1rem .9rem; color:var(--muted); }}
</style>
</head>
<body>
<main>
<h1>OSM coastline water polygons</h1>
<p class="muted">Shapefiles for rendering the sea, built from OpenStreetMap
<code>natural=coastline</code> data. Last updated <strong>{built_at}</strong>
from OpenStreetMap data as of <strong>{data_ts}</strong>.</p>

<p class="note">This is an independent rebuild, not the official
<a href="https://osmdata.openstreetmap.de/">osmdata.openstreetmap.de</a> data. It follows the same
file names and layout, so it can stand in for those downloads when that site is unavailable.</p>

<h2>Downloads</h2>
<div class="table-wrap">
<table>
<thead><tr><th>File</th><th>Description</th><th class="num">Size</th></tr></thead>
<tbody>
{rows}
</tbody>
</table>
</div>
<p class="muted">Checksums and build details are in <a href="manifest.json">manifest.json</a>.
Files are in EPSG:3857 (Web Mercator) and are replaced in place on each update, so check
the date above rather than the URL.</p>

<h2>Using it with openstreetmap-carto</h2>
<p>The URLs match osmdata's <code>/download/</code> paths. Replace
<code>https://osmdata.openstreetmap.de/download/</code> with
<code>{site}/download/</code> in carto's <code>external-data.yml</code>.</p>

<h2>How it is built</h2>
<ol>
<li>Take the latest OpenStreetMap planet file.</li>
<li><code>osmcoastline_filter</code> keeps only the <code>natural=coastline</code> ways.</li>
<li><code>osmcoastline</code> ({osmcoastline}) assembles them into rings, repairs sub-metre gaps and
builds water polygons in EPSG:3857, splitting any with more than 1000 points.</li>
<li><code>ogr2ogr</code> writes them as shapefiles. A second pass simplifies the polygons
(Douglas&ndash;Peucker, {tolerance} m tolerance) for the low-zoom file.</li>
<li>A build is only published if osmcoastline reports no unrepaired errors.</li>
</ol>
<p>The scripts are in <a href="{repo}/tree/HEAD/infra/external-data">{repo_name}</a>.
Rebuilt about once a month.</p>

<h2>Limitations</h2>
<ul>
<li>The simplified file is our own approximation of osmdata's low-zoom data and is not identical to it.</li>
<li>The two Antarctic ice sheet files are <strong>empty placeholders</strong> (no features), published only
so the set is complete. Maps of Antarctica will draw without ice.</li>
</ul>

<h2>License</h2>
<p>&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>. The data is
available under the <a href="https://opendatacommons.org/licenses/odbl/">Open Database License (ODbL) 1.0</a>.
If you use it, credit &ldquo;&copy; OpenStreetMap contributors&rdquo; and share any adapted database under
the same license.</p>
</main>
</body>
</html>
"""


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1000 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1000
    raise AssertionError("unreachable")


def fmt_ts(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M UTC")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(out_dir: str, placeholders: str | None) -> dict[str, str]:
    """Map each published file name to its local path, failing if any is missing."""
    paths = {}
    for name, (_, kind) in FILES.items():
        base = out_dir if kind == "built" else placeholders
        path = os.path.join(base or "", name)
        if not os.path.isfile(path):
            sys.exit(f"missing {path}" + ("" if base else " (pass --placeholders)"))
        paths[name] = path
    return paths


# A new build whose size differs from the published one by more than this is rejected.
SIZE_RATIO_LIMITS = (0.8, 1.25)
REQUIRED_EXTENSIONS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


def verify_zip(name: str, path: str) -> None:
    """Exit unless the zip is intact and holds a complete shapefile."""
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            sys.exit(f"{name}: corrupt member {bad}")
        members = z.namelist()
    for ext in REQUIRED_EXTENSIONS:
        if not any(m.endswith(ext) for m in members):
            sys.exit(f"{name}: no {ext} file inside")


def check_sizes(previous: dict, paths: dict[str, str]) -> None:
    """Exit if a built file's size changed implausibly since the published build."""
    lo, hi = SIZE_RATIO_LIMITS
    for name, old in previous.get("files", {}).items():
        if old.get("placeholder") or name not in paths or not old.get("size"):
            continue
        ratio = os.path.getsize(paths[name]) / old["size"]
        if not lo <= ratio <= hi:
            sys.exit(f"{name}: size is {ratio:.2f}x the published file (allowed {lo}-{hi}); not publishing")


def check_against(url: str, paths: dict[str, str]) -> None:
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            previous = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        print(f"nothing published at {url} yet; skipping the size comparison")
        return
    check_sizes(previous, paths)


def build_manifest(build: dict, paths: dict[str, str]) -> dict:
    files = {}
    for name, path in paths.items():
        files[name] = {
            "description": FILES[name][0],
            "placeholder": FILES[name][1] == "placeholder",
            "size": os.path.getsize(path),
            "sha256": sha256_file(path),
            "url": f"{SITE}/download/{name}",
        }
    return {
        "built_at": build["built_at"],
        "planet_data_timestamp": build["planet_data_timestamp"],
        "osmcoastline_version": build["osmcoastline_version"],
        "simplify_tolerance_m": build["simplify_tolerance_m"],
        "files": files,
    }


def render_index(m: dict) -> str:
    rows = "\n".join(
        f'<tr><td><a href="download/{html.escape(name)}">{html.escape(name)}</a></td>'
        f"<td>{html.escape(f['description'])}</td>"
        f'<td class="num">{human_size(f["size"])}</td></tr>'
        for name, f in m["files"].items()
    )
    return PAGE.format(
        rows=rows,
        built_at=fmt_ts(m["built_at"]),
        data_ts=fmt_ts(m["planet_data_timestamp"]),
        osmcoastline=html.escape(m["osmcoastline_version"].replace("osmcoastline version", "").strip() or "2.x"),
        tolerance=m["simplify_tolerance_m"],
        site=SITE,
        repo=REPO,
        repo_name=REPO.split("github.com/")[1],
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--placeholders", help="dir holding the empty icesheet zips")
    ap.add_argument("--check-against", metavar="URL", help="published manifest.json to compare sizes with")
    ap.add_argument("--dry-run", action="store_true", help="write the page to OUT_DIR/index.html and upload nothing")
    args = ap.parse_args()

    with open(os.path.join(args.out_dir, "manifest.json")) as f:
        build = json.load(f)
    paths = collect(args.out_dir, args.placeholders)
    for name, path in paths.items():
        verify_zip(name, path)
    if args.check_against:
        check_against(args.check_against, paths)
    manifest = build_manifest(build, paths)
    page = render_index(manifest)

    if args.dry_run:
        with open(os.path.join(args.out_dir, "index.html"), "w") as f:
            f.write(page)
        print(f"wrote {args.out_dir}/index.html")
        return 0

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    for name, path in paths.items():
        print(f"uploading download/{name} ({human_size(os.path.getsize(path))})")
        s3.upload_file(path, BUCKET, f"download/{name}", ExtraArgs={
            "ContentType": "application/zip", "CacheControl": "public, max-age=3600"})
    s3.put_object(Bucket=BUCKET, Key="manifest.json", Body=json.dumps(manifest, indent=2).encode(),
                  ContentType="application/json", CacheControl="public, max-age=300")
    s3.put_object(Bucket=BUCKET, Key="index.html", Body=page.encode(),
                  ContentType="text/html; charset=utf-8", CacheControl="public, max-age=300")
    print(f"published {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}; page: {SITE}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
