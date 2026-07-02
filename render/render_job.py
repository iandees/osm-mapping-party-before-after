#!/usr/bin/env python3
"""Render one before/after job inside an AWS Batch (Fargate) task.

Flow:
  1. Read JOB_ID from env (set by the EventBridge Pipe from the SQS message).
  2. Tell the Worker we're running; fetch the job parameters.
  3. Resolve the bbox to the smallest Geofabrik region; fetch its internal history
     file from the S3 cache, (re)downloading from Geofabrik on a cache miss or when
     the cache lacks data as recent as the requested after-time.
  4. Run make.sh to produce the animated GIF(s).
  5. Upload the GIF(s) to R2 and report completion (or failure) to the Worker.

All heavy state (Postgres, extracts) lives in this ephemeral task, so tasks are
fully isolated and the compute scales to zero when the queue drains.
"""

from __future__ import annotations  # base image is Python 3.9; keep `X | None` lazy

import glob
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime
from urllib.parse import urlparse

import boto3
import requests

ROOT = os.environ.get("APP_ROOT", "/home/postgres")
sys.path.insert(0, os.path.join(ROOT, "render"))
from region import region_history_url, region_id, select_region  # noqa: E402


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise RuntimeError(f"missing required env var {name}")
    return val


class Worker:
    """Thin client for the Worker's /internal callback API."""

    def __init__(self, base_url: str, secret: str, job_id: str):
        self.base = base_url.rstrip("/")
        self.headers = {"x-callback-secret": secret, "content-type": "application/json"}
        self.job_id = job_id
        self._last_progress = None

    def get_params(self) -> dict:
        r = requests.get(f"{self.base}/internal/jobs/{self.job_id}", headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.json()

    def post_status(self, **body) -> None:
        r = requests.post(
            f"{self.base}/internal/jobs/{self.job_id}",
            headers=self.headers,
            data=json.dumps(body),
            timeout=30,
        )
        r.raise_for_status()

    def progress(self, message: str) -> None:
        """Post a progress message (deduped). Never raises — progress is best-effort."""
        if message == self._last_progress:
            return
        self._last_progress = message
        print(f"progress: {message}")
        try:
            self.post_status(status="progress", message=message)
        except Exception as e:  # noqa: BLE001
            print(f"progress post failed: {e}")


def fetch_region_index() -> dict:
    url = env("GEOFABRIK_INDEX_URL", "https://download.geofabrik.de/index-v1.json")
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.load(resp)


def geofabrik_cookie(dest: str) -> None:
    """Obtain a Geofabrik OAuth cookie via the bundled sendfile_osm_oauth_protector."""
    subprocess.run(
        [
            "python3",
            os.path.join(ROOT, "sendfile_osm_oauth_protector", "oauth_cookie_client.py"),
            "--user", env("GEOFABRIK_USER"),
            "--password", env("GEOFABRIK_PASSWORD"),
            "--consumer-url", env("GEOFABRIK_COOKIE_URL", "https://osm-internal.download.geofabrik.de/get_cookie"),
            "-f", "http",
            "-o", dest,
        ],
        check=True,
    )


def download_from_geofabrik(url: str, dest: str) -> None:
    with tempfile.NamedTemporaryFile(prefix="cookie", suffix=".txt") as cookie:
        geofabrik_cookie(cookie.name)
        cookie_value = open(cookie.name).read().strip()
    with requests.get(url, headers={"Cookie": cookie_value}, stream=True, timeout=3600) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))


def newest_data_timestamp(path: str) -> datetime | None:
    """The newest object timestamp contained in a history file, via osmium."""
    out = subprocess.run(
        ["osmium", "fileinfo", "-e", "-g", "data.timestamp.last", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return _parse_iso(out) if out else None


def ensure_region_file(feature: dict, time_after: str, worker: "Worker") -> str:
    """Return a local path to the region's history file, using an S3 cache.

    The cache is refreshed from Geofabrik when it does not contain data as recent
    as ``time_after`` — otherwise the render would silently miss recent edits. If
    even a freshly downloaded file predates ``time_after`` (Geofabrik's daily lag),
    we proceed with the best available data.
    """
    history_url = region_history_url(feature)
    # e.g. "europe/germany/bremen-internal.osh.pbf" — unique per region.
    rel_path = urlparse(history_url).path.lstrip("/")
    cache_key = f"regions/{rel_path}"
    local = os.path.join(ROOT, rel_path.replace("/", "_"))
    want = _parse_iso(time_after)

    s3 = boto3.client("s3")
    bucket = env("REGION_CACHE_BUCKET")

    cached = False
    try:
        s3.download_file(bucket, cache_key, local)
        cached = True
    except Exception:
        print(f"region cache miss for {cache_key}")

    if cached:
        newest = newest_data_timestamp(local)
        if newest is not None and newest >= want:
            print(f"region cache hit (data through {newest.isoformat()}): {cache_key}")
            return local
        print(f"region cache stale (data through {newest}); refreshing from Geofabrik")

    worker.progress("Downloading map history for the region…")
    download_from_geofabrik(history_url, local)
    s3.upload_file(local, bucket, cache_key)

    fresh = newest_data_timestamp(local)
    if fresh is not None and fresh < want:
        print(f"warning: newest available data ({fresh.isoformat()}) predates requested "
              f"after-time ({time_after}); rendering with best available data")
    return local


def run_make(history_file: str, params: dict, worker: "Worker") -> None:
    # A single zoom is rendered (min == max), chosen by the frontend from the bbox
    # and requested output size. We stream make.sh output to report progress by
    # parsing its per-frame log lines.
    zoom = str(params["zoom"])
    n = int(params["num_frames"])
    proc = subprocess.Popen(
        [
            os.path.join(ROOT, "make.sh"),
            history_file,
            params["time_before"],
            params["time_after"],
            params["bbox"],
            zoom,
            zoom,
            str(n),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    extracted = 0
    imported = 0
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line.rstrip())  # keep full output in CloudWatch
        if line.startswith("Extracting data for"):
            extracted += 1
            worker.progress(f"Extracting frame {extracted}/{n}…")
        elif line.startswith("Importing data for"):
            imported += 1
            worker.progress(f"Importing frame {imported}/{n}…")
        elif line.startswith("Generating zoom"):
            worker.progress("Rendering images…")
        elif "comparison image" in line or line.startswith("Generating comparison"):
            worker.progress("Assembling the animation…")
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"make.sh exited with code {rc}")


def upload_results(job_id: str) -> str:
    """Upload the produced GIF to R2 at its native resolution; return its full object key.

    The GIF is delivered exactly as rendered — no post-render scaling, since
    resampling blurs the map labels. The frontend's suggested zoom keeps the
    native render close to the requested output size.

    A job renders a single zoom, so there is exactly one GIF; if make.sh somehow
    produced more, we deliver the first.
    """
    r2 = boto3.client(
        "s3",
        endpoint_url=env("R2_ENDPOINT"),
        aws_access_key_id=env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )
    bucket = env("R2_BUCKET")
    prefix = f"jobs/{job_id}/"
    gifs = sorted(glob.glob(os.path.join(ROOT, "progress.*.z*.gif")))
    if not gifs:
        raise RuntimeError("make.sh produced no GIFs")
    path = gifs[0]
    key = prefix + os.path.basename(path)
    r2.upload_file(path, bucket, key, ExtraArgs={"ContentType": "image/gif"})
    print(f"uploaded {key}")
    return key


def main() -> int:
    job_id = env("JOB_ID")
    worker = Worker(env("WORKER_BASE_URL"), env("CALLBACK_SECRET"), job_id)
    try:
        worker.post_status(status="running", message="Starting up…")
        params = worker.get_params()

        worker.progress("Finding the right map region…")
        bbox = tuple(float(x) for x in params["bbox"].split(","))
        feature = select_region(fetch_region_index(), bbox)
        print(f"selected region {region_id(feature)} for bbox {bbox}")

        worker.progress("Preparing map data…")
        history_file = ensure_region_file(feature, params["time_after"], worker)
        run_make(history_file, params, worker)

        worker.progress("Uploading your map…")
        key = upload_results(job_id)

        worker.post_status(status="done", resultKey=key)
        return 0
    except Exception as e:  # noqa: BLE001 — report any failure back to the Worker
        print(f"render failed: {e}", file=sys.stderr)
        try:
            worker.post_status(status="failed", error=str(e)[:500])
        except Exception as e2:  # noqa: BLE001
            print(f"failed to report failure: {e2}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
