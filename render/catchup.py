#!/usr/bin/env python3
"""Bring a region history extract up to date with recent OSM edits.

The cached Geofabrik ``-internal.osh.pbf`` extract lags ~1 day. When a job's
``time_after`` is close to (or past) "now" — e.g. a scheduled job that runs right
after a mapping party ends — that lag would drop the very edits the user wants to
see. This module closes the gap by pulling OSM replication diffs and applying them
to a bbox-clipped history file.

It follows the community-standard "clip the changes first, then apply" recipe
(https://pavie.info/blog/complete-full-history-osm/):

  1. Extract the job bbox from the region history (small working file), stamping the
     replication timestamp so ``osmupdate`` knows where to resume.
  2. ``osmupdate`` fetches the merged changes from that timestamp up to the newest
     available replication (day+hour+minute granularity → minutely freshness).
  3. ``osmium extract -s simple --bbox`` clips the (global) change file to the bbox,
     so we apply only in-area changes and the file never bloats.
  4. ``osmium apply-changes -H`` merges the clipped changes into the history file.

Fetching past ``time_after`` is harmless: make.sh's ``osmium time-filter`` cuts each
frame to its timestamp, so the temporal trim happens downstream.

Degrades gracefully: if the base already covers ``time_after`` we return it
untouched (make.sh does its own bbox extract); if replication hasn't reached
``time_after`` yet, we apply the best available and log it; if ``osmupdate`` finds
nothing new, we return the extract as-is.
"""

from __future__ import annotations  # base image is Python 3.9; keep `X | None` lazy

import os
import subprocess
from datetime import datetime, timezone
from typing import Callable, List, Optional

DEFAULT_REPLICATION_URL = "https://planet.openstreetmap.org/replication"

# subprocess.run-compatible callable; injected in tests.
Runner = Callable[..., "subprocess.CompletedProcess"]


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))


def _iso_z(ts: datetime) -> str:
    """Render a datetime as an OSM-style UTC ...Z timestamp for a PBF header."""
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def newest_timestamp(path: str, run: Runner = subprocess.run) -> Optional[datetime]:
    """The newest object timestamp in a(n osm/osh) file, via ``osmium fileinfo``."""
    out = run(
        ["osmium", "fileinfo", "-e", "-g", "data.timestamp.last", path],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return _parse_iso(out) if out else None


# ---- pure command builders (unit-tested without shelling out) -------------


def extract_bbox_cmd(
    region_file: str, bbox: str, out_file: str, replication_ts: Optional[datetime], replication_url: str
) -> List[str]:
    """Clip the region history to ``bbox`` (with history), stamping replication headers
    so ``osmupdate`` can resume from ``replication_ts``.

    Uses osmium's default extract strategy (complete ways), not ``simple`` — osmium
    rejects ``simple`` for history files, and the default keeps way/relation
    geometries complete, matching make.sh's own bbox extract."""
    cmd = [
        "osmium",
        "extract",
        "--with-history",
        "--bbox",
        bbox,
        "--overwrite",
        "-o",
        out_file,
    ]
    if replication_ts is not None:
        cmd += ["--output-header", f"osmosis_replication_timestamp={_iso_z(replication_ts)}"]
    cmd += ["--output-header", f"osmosis_replication_base_url={replication_url}"]
    cmd += [region_file]
    return cmd


def osmupdate_cmd(in_file: str, changes_file: str, tmp_dir: str, replication_url: str) -> List[str]:
    """Fetch merged replication changes since ``in_file``'s timestamp into ``changes_file``.
    No granularity flag → osmupdate combines day/hour/minute to reach minutely freshness."""
    return [
        "osmupdate",
        "-v",
        "--base-url=" + replication_url.rstrip("/") + "/",
        "-t=" + tmp_dir,
        in_file,
        changes_file,
    ]


def clip_changes_cmd(bbox: str, changes_file: str, out_file: str) -> List[str]:
    """Clip a change file to ``bbox`` (simple strategy: keep in-box objects)."""
    return [
        "osmium",
        "extract",
        "--bbox",
        bbox,
        "--strategy",
        "simple",
        "--overwrite",
        "-o",
        out_file,
        changes_file,
    ]


def apply_changes_cmd(history_file: str, changes_file: str, out_file: str) -> List[str]:
    """Apply a change file to a history file (``-H``: keep full history)."""
    return [
        "osmium",
        "apply-changes",
        "-H",
        "--overwrite",
        "-o",
        out_file,
        history_file,
        changes_file,
    ]


# ---- orchestration --------------------------------------------------------


def bring_bbox_up_to_date(
    region_file: str,
    bbox: str,
    time_after: str,
    workdir: str,
    progress: Optional[Callable[[str], None]] = None,
    replication_url: Optional[str] = None,
    run: Runner = subprocess.run,
    newest: Callable[..., Optional[datetime]] = newest_timestamp,
) -> str:
    """Return a history file covering ``bbox`` through ``time_after``.

    If the base extract already covers ``time_after``, return it unchanged (make.sh
    does its own bbox extract). Otherwise produce a bbox-clipped history file updated
    with OSM replication diffs and return that.
    """
    replication_url = replication_url or os.environ.get("OSM_REPLICATION_URL", DEFAULT_REPLICATION_URL)

    def say(msg: str) -> None:
        if progress:
            progress(msg)
        print(msg)

    want = _parse_iso(time_after)
    t0 = newest(region_file, run=run)
    if t0 is not None and t0 >= want:
        print(f"base extract already covers {time_after} (data through {t0.isoformat()}); no catch-up needed")
        return region_file

    say("Fetching the latest map edits…")
    bbox_file = os.path.join(workdir, "catchup_bbox.osh.pbf")
    run(extract_bbox_cmd(region_file, bbox, bbox_file, t0, replication_url), check=True)

    tmp_dir = os.path.join(workdir, "osmupdate_tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    changes_file = os.path.join(workdir, "catchup_changes.osc.gz")
    _remove(changes_file)
    proc = run(osmupdate_cmd(bbox_file, changes_file, tmp_dir, replication_url), capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(changes_file) or os.path.getsize(changes_file) == 0:
        # osmupdate reports "already up-to-date" (or fails to reach the server) →
        # nothing to apply. Proceed with the best available data.
        stderr = (getattr(proc, "stderr", "") or "").strip()
        print(f"osmupdate produced no changes (rc={proc.returncode}); using best available data. {stderr}")
        return bbox_file

    local_changes = os.path.join(workdir, "catchup_changes.local.osc.gz")
    run(clip_changes_cmd(bbox, changes_file, local_changes), check=True)

    updated = os.path.join(workdir, "catchup_updated.osh.pbf")
    run(apply_changes_cmd(bbox_file, local_changes, updated), check=True)

    new_newest = newest(updated, run=run)
    if new_newest is not None and new_newest < want:
        print(
            f"warning: newest available data ({new_newest.isoformat()}) still predates "
            f"requested after-time ({time_after}); rendering with best available data"
        )
    else:
        print(f"caught up bbox history through {new_newest.isoformat() if new_newest else 'unknown'}")
    return updated


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
