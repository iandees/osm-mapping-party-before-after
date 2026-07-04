#!/usr/bin/env python3
"""Bring a region history extract up to date with recent OSM edits.

The cached Geofabrik ``-internal.osh.pbf`` extract lags ~1 day, and Geofabrik
itself sometimes rebuilds a region days late. When a job's ``time_after`` is close
to (or past) the base's newest data — e.g. a scheduled job that runs right after a
mapping party ends, or a stale region base — that gap would drop the very edits the
user wants to see. This module closes the gap by pulling OSM replication diffs and
applying them to a bbox-clipped history file.

**Regional-first, global-tail.** Naively catching up from the global planet stream
downloads *whole-planet* diffs (~114 MB/day even at daily granularity) just to clip
a tiny bbox — for a 19-day-stale base that is ~2 GB. Geofabrik instead publishes a
per-region daily update stream (``<region>-updates/``) whose diffs are already
region-scoped (~tens of KB/day), so we catch up from *that* as far as it reaches
(~1-day lag), and only fall back to the global planet stream for the sub-day tail.
This bounds the expensive global download to at most ~1 day regardless of how stale
the base is. Both streams are consumed with the same ``osmupdate`` (osmium-tool
itself has no replication downloader): the global stream via its day/hour/minute
layout, the Geofabrik regional stream as "sporadic" changefiles.

Each catch-up pass follows the community-standard "clip the changes first, then
apply" recipe (https://pavie.info/blog/complete-full-history-osm/):

  1. Extract the job bbox from the region history (small working file), stamping the
     replication timestamp so ``osmupdate`` knows where to resume.
  2. ``osmupdate`` fetches the merged changes from that timestamp up to the newest
     available replication on the given stream.
  3. ``osmium extract -s simple --bbox`` clips the change file to the bbox, so we
     apply only in-area changes and the file never bloats.
  4. ``osmium apply-changes -H`` merges the clipped changes into the history file.

Fetching past ``time_after`` is harmless: make.sh's ``osmium time-filter`` cuts each
frame to its timestamp, so the temporal trim happens downstream.

Degrades gracefully: if the base already covers ``time_after`` we return it
untouched (make.sh does its own bbox extract); if a region has no ``updates_url`` we
skip straight to the global stream (the old behaviour); if replication hasn't
reached ``time_after`` yet, we apply the best available and log it; if ``osmupdate``
finds nothing new on a stream, that pass is a no-op.
"""

from __future__ import annotations  # base image is Python 3.9; keep `X | None` lazy

import os
import subprocess
import urllib.request
from datetime import datetime, timezone
from typing import Callable, List, Optional

DEFAULT_REPLICATION_URL = "https://planet.openstreetmap.org/replication"

# subprocess.run-compatible callable; injected in tests.
Runner = Callable[..., "subprocess.CompletedProcess"]
# base_url -> newest available replication timestamp; injected in tests.
HeadFn = Callable[[str], Optional[datetime]]


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


def stream_head_timestamp(base_url: str) -> Optional[datetime]:
    """The newest timestamp a replication stream can currently serve, from its state.txt.

    This is the *replication* position, not a file's newest object timestamp — the two
    diverge for a sparse bbox whose last in-area edit predates the stream head, and we
    must use the stream head so the global-tail pass resumes from where the regional
    pass actually left off (not from the last in-bbox edit). Handles both a single
    Geofabrik regional stream (``state.txt`` at the base) and the planet parent
    (``minute/state.txt``). state.txt escapes the ``:`` in timestamps, so unescape."""
    base = base_url.rstrip("/")
    for suffix in ("/state.txt", "/minute/state.txt"):
        try:
            with urllib.request.urlopen(base + suffix, timeout=30) as resp:
                text = resp.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 — try the next layout / degrade gracefully
            continue
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("timestamp="):
                return _parse_iso(line.split("=", 1)[1].replace("\\", ""))
    return None


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

    No granularity flag → for the planet stream osmupdate combines day/hour/minute to
    reach minutely freshness; for a Geofabrik regional stream (a single daily stream,
    no day/hour/minute layout) it walks the "sporadic" changefiles. The resume point
    is read from ``in_file``'s ``osmosis_replication_timestamp`` header."""
    return [
        "osmupdate",
        "-v",
        "--base-url=" + replication_url.rstrip("/") + "/",
        "-t=" + tmp_dir,
        in_file,
        changes_file,
    ]


def cat_stamp_cmd(in_file: str, out_file: str, replication_ts: datetime, replication_url: str) -> List[str]:
    """Rewrite ``in_file`` to ``out_file`` resetting the replication resume headers.

    ``osmium apply-changes`` does not advance the replication headers, so before
    switching ``osmupdate`` from the regional stream to the global stream we must
    stamp the file with the timestamp it has actually reached and the new stream's
    base URL, or osmupdate would resume from the stale original timestamp."""
    return [
        "osmium",
        "cat",
        "--overwrite",
        "-o",
        out_file,
        "--output-header",
        f"osmosis_replication_timestamp={_iso_z(replication_ts)}",
        "--output-header",
        f"osmosis_replication_base_url={replication_url}",
        in_file,
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


def _replication_pass(
    in_file: str,
    bbox: str,
    base_url: str,
    workdir: str,
    tag: str,
    run: Runner,
    newest: Callable[..., Optional[datetime]],
) -> str:
    """Run one osmupdate→clip→apply pass against ``base_url``; return the updated file.

    ``in_file`` must already carry the ``osmosis_replication_timestamp`` header that
    tells osmupdate where to resume. If osmupdate finds nothing new (or can't reach
    the server), the pass is a no-op and ``in_file`` is returned unchanged.
    """
    tmp_dir = os.path.join(workdir, f"osmupdate_tmp_{tag}")
    os.makedirs(tmp_dir, exist_ok=True)
    changes_file = os.path.join(workdir, f"catchup_changes_{tag}.osc.gz")
    _remove(changes_file)
    proc = run(osmupdate_cmd(in_file, changes_file, tmp_dir, base_url), capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(changes_file) or os.path.getsize(changes_file) == 0:
        # osmupdate reports "already up-to-date" (or fails to reach the server) →
        # nothing to apply on this stream. Proceed with what we have.
        stderr = (getattr(proc, "stderr", "") or "").strip()
        print(f"osmupdate ({tag}) produced no changes (rc={proc.returncode}); using data as-is. {stderr}")
        return in_file

    local_changes = os.path.join(workdir, f"catchup_changes_{tag}.local.osc.gz")
    run(clip_changes_cmd(bbox, changes_file, local_changes), check=True)

    updated = os.path.join(workdir, f"catchup_updated_{tag}.osh.pbf")
    run(apply_changes_cmd(in_file, local_changes, updated), check=True)
    reached = newest(updated, run=run)
    print(f"applied {tag} diffs; bbox history now through {reached.isoformat() if reached else 'unknown'}")
    return updated


def bring_bbox_up_to_date(
    region_file: str,
    bbox: str,
    time_after: str,
    workdir: str,
    updates_url: Optional[str] = None,
    progress: Optional[Callable[[str], None]] = None,
    replication_url: Optional[str] = None,
    run: Runner = subprocess.run,
    newest: Callable[..., Optional[datetime]] = newest_timestamp,
    head: HeadFn = stream_head_timestamp,
) -> str:
    """Return a history file covering ``bbox`` through ``time_after``.

    If the base extract already covers ``time_after``, return it unchanged (make.sh
    does its own bbox extract). Otherwise produce a bbox-clipped history file updated
    with OSM replication diffs and return that.

    ``updates_url`` is the region's Geofabrik per-region daily update stream (from the
    index's ``urls.updates``). When present we catch up from it first — its diffs are
    region-scoped and tiny — then only use the global ``replication_url`` planet stream
    for whatever sub-day tail remains. When absent (region has no update stream) we go
    straight to the global stream.

    The replication position we've reached is read from each stream's ``state.txt``
    head, **not** the bbox file's newest object timestamp: a sparse bbox whose last
    edit predates the stream head would otherwise make the global-tail pass re-bridge
    days of whole-planet diffs it doesn't need.
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
    # Stamp the bbox extract's resume header with whichever stream we'll pull first.
    first_url = updates_url or replication_url
    current = os.path.join(workdir, "catchup_bbox.osh.pbf")
    run(extract_bbox_cmd(region_file, bbox, current, t0, first_url), check=True)

    # Pass 1: Geofabrik regional daily diffs (cheap, already region-scoped). The bbox
    # extract carries the base's data, so absent a regional pass we've reached t0.
    reached = t0
    if updates_url:
        before = current
        current = _replication_pass(current, bbox, updates_url, workdir, "regional", run, newest)
        if current is not before:  # diffs applied → we're current to the regional head
            regional_head = head(updates_url)
            if regional_head is not None:
                reached = regional_head if reached is None else max(reached, regional_head)

    # Pass 2: global planet stream for the remaining tail (bounded to the regional
    # stream's ~1-day lag). Skipped if the regional pass already reached want.
    if reached is None or reached < want:
        if updates_url and reached is not None:
            # apply-changes didn't advance the replication header; restamp to the
            # regional head + the global base URL before resuming from planet.
            stamped = os.path.join(workdir, "catchup_global_base.osh.pbf")
            run(cat_stamp_cmd(current, stamped, reached, replication_url), check=True)
            current = stamped
        before = current
        current = _replication_pass(current, bbox, replication_url, workdir, "global", run, newest)
        if current is not before:  # diffs applied → we're current to the planet head
            planet_head = head(replication_url)
            if planet_head is not None:
                reached = planet_head if reached is None else max(reached, planet_head)

    if reached is not None and reached < want:
        print(
            f"warning: replication only reaches {reached.isoformat()}, which still predates "
            f"requested after-time ({time_after}); rendering with best available data"
        )
    else:
        print(f"caught up bbox history through {reached.isoformat() if reached else 'unknown'}")
    return current


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
