#!/usr/bin/env python3
"""Render one before/after job inside an AWS Batch (Fargate) task.

Flow:
  1. Read JOB_ID from env (set by the EventBridge Pipe from the SQS message).
  2. Tell the Worker we're running; fetch the job parameters.
  3. Resolve the bbox to the smallest Geofabrik region; fetch its internal history
     file from the S3 cache, downloading from Geofabrik on a cache miss.
  4. Run make.sh to produce the animated GIF(s).
  5. Upload the GIF(s) to R2 and report completion (or failure) to the Worker.

All heavy state (Postgres, extracts) lives in this ephemeral task, so tasks are
fully isolated and the compute scales to zero when the queue drains.
"""

import glob
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

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


def fetch_region_index() -> dict:
    url = env("GEOFABRIK_INDEX_URL", "https://osm-internal.download.geofabrik.de/index-v1.json")
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


def ensure_region_file(feature: dict) -> str:
    """Return a local path to the region's history file, using an S3 cache."""
    rid = region_id(feature)
    cache_key = f"regions/{rid}.osh.pbf"
    local = os.path.join(ROOT, f"{rid.replace('/', '_')}.osh.pbf")

    s3 = boto3.client("s3")
    bucket = env("REGION_CACHE_BUCKET")
    try:
        s3.download_file(bucket, cache_key, local)
        print(f"region cache hit: s3://{bucket}/{cache_key}")
        return local
    except Exception:
        print(f"region cache miss for {cache_key}; downloading from Geofabrik")

    url = region_history_url(feature, env("GEOFABRIK_INTERNAL_BASE", "https://osm-internal.download.geofabrik.de"))
    download_from_geofabrik(url, local)
    s3.upload_file(local, bucket, cache_key)
    return local


def run_make(history_file: str, params: dict) -> None:
    subprocess.run(
        [
            os.path.join(ROOT, "make.sh"),
            history_file,
            params["time_before"],
            params["time_after"],
            params["bbox"],
            str(params["min_zoom"]),
            str(params["max_zoom"]),
            str(params["num_frames"]),
        ],
        cwd=ROOT,
        check=True,
    )


def upload_results(job_id: str) -> str:
    """Upload every progress GIF to R2 under jobs/<id>/ and return the key prefix."""
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
    for path in gifs:
        key = prefix + os.path.basename(path)
        r2.upload_file(path, bucket, key, ExtraArgs={"ContentType": "image/gif"})
        print(f"uploaded {key}")
    return prefix


def main() -> int:
    job_id = env("JOB_ID")
    worker = Worker(env("WORKER_BASE_URL"), env("CALLBACK_SECRET"), job_id)
    try:
        worker.post_status(status="running")
        params = worker.get_params()

        bbox = tuple(float(x) for x in params["bbox"].split(","))
        feature = select_region(fetch_region_index(), bbox)
        print(f"selected region {region_id(feature)} for bbox {bbox}")

        history_file = ensure_region_file(feature)
        run_make(history_file, params)
        prefix = upload_results(job_id)

        worker.post_status(status="done", resultKey=prefix)
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
