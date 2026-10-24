"""Unit tests for render_job.upload_results — R2 upload of the GIF (and MP4,
if make.sh produced one). Boto3 is mocked; only the local file-discovery and
upload-argument logic is under test."""

import os
import subprocess
import tempfile
import unittest
from unittest import mock

import requests

import render_job


class ValidateHistoryFileTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(delete=False)
        tmp.write(b"x" * 10)
        tmp.close()
        self.path = tmp.name
        self.addCleanup(os.unlink, self.path)

    def test_returns_newest_timestamp_for_a_file_with_data(self):
        with mock.patch.object(render_job, "newest_data_timestamp", return_value=render_job._parse_iso("2026-10-19T00:00:00Z")):
            self.assertEqual(
                render_job.validate_history_file(self.path),
                render_job._parse_iso("2026-10-19T00:00:00Z"),
            )

    def test_rejects_a_header_only_file_with_no_data(self):
        with mock.patch.object(render_job, "newest_data_timestamp", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "no map data"):
                render_job.validate_history_file(self.path)

    def test_rejects_a_file_osmium_cannot_read(self):
        err = subprocess.CalledProcessError(1, ["osmium"])
        with mock.patch.object(render_job, "newest_data_timestamp", side_effect=err):
            with self.assertRaisesRegex(RuntimeError, "not a readable OSM history file"):
                render_job.validate_history_file(self.path)


class EnsureRegionFileTests(unittest.TestCase):
    FEATURE = {"properties": {"id": "sud", "urls": {"history": "https://h/europe/italy/sud-internal.osh.pbf"}}}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for p in (
            mock.patch.object(render_job, "ROOT", self.tmp.name),
            mock.patch.dict(os.environ, {"REGION_CACHE_BUCKET": "cache"}),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.worker = mock.Mock()

    def _download(self, url, dest):
        with open(dest, "wb") as f:
            f.write(b"downloaded")

    def test_bad_download_is_not_cached(self):
        with mock.patch("boto3.client") as client, \
             mock.patch.object(render_job, "download_from_geofabrik", side_effect=self._download), \
             mock.patch.object(render_job, "newest_data_timestamp", return_value=None), \
             mock.patch("time.sleep"):
            client.return_value.download_file.side_effect = Exception("miss")
            with self.assertRaisesRegex(RuntimeError, "no map data"):
                render_job.ensure_region_file(self.FEATURE, "2026-10-19T00:00:00Z", self.worker)
            client.return_value.upload_file.assert_not_called()

    def test_download_is_retried_until_it_validates(self):
        good = render_job._parse_iso("2026-10-19T00:00:00Z")
        responses = [requests.HTTPError("404 Not Found"), None, None]
        newest = [None, good]  # 2nd attempt downloads header-only, 3rd is good

        def download(url, dest):
            r = responses.pop(0)
            if r:
                raise r
            self._download(url, dest)

        with mock.patch.object(render_job, "download_from_geofabrik", side_effect=download) as dl, \
             mock.patch.object(render_job, "newest_data_timestamp", side_effect=newest), \
             mock.patch("time.sleep") as sleep:
            render_job.download_valid_region_file("https://h/x.osh.pbf", os.path.join(self.tmp.name, "x"), self.worker)
        self.assertEqual(dl.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_download_gives_up_after_max_attempts(self):
        with mock.patch.object(render_job, "download_from_geofabrik", side_effect=requests.HTTPError("404")) as dl, \
             mock.patch("time.sleep"):
            with self.assertRaises(requests.HTTPError):
                render_job.download_valid_region_file("https://h/x.osh.pbf", os.path.join(self.tmp.name, "x"), self.worker)
        self.assertEqual(dl.call_count, 3)

    def test_unreadable_cache_entry_is_redownloaded_and_replaced(self):
        good = render_job._parse_iso("2026-10-19T00:00:00Z")
        err = subprocess.CalledProcessError(1, ["osmium"])
        with mock.patch("boto3.client") as client, \
             mock.patch.object(render_job, "download_from_geofabrik", side_effect=self._download) as dl, \
             mock.patch.object(render_job, "newest_data_timestamp", side_effect=[err, good]):
            render_job.ensure_region_file(self.FEATURE, "2026-10-19T00:00:00Z", self.worker)
            dl.assert_called_once()
            client.return_value.upload_file.assert_called_once()


class RunMakeEmptyAreaTests(unittest.TestCase):
    PARAMS = {"zoom": 12, "num_frames": 2, "time_before": "a", "time_after": "b", "bbox": "0,0,1,1"}

    def _run(self, lines, rc=0):
        proc = mock.Mock()
        proc.stdout = iter(lines)
        proc.wait.return_value = rc
        with mock.patch("subprocess.Popen", return_value=proc):
            render_job.run_make("h.osh.pbf", self.PARAMS, mock.Mock())

    def test_fails_when_every_frame_imports_zero_objects(self):
        lines = [f"2026-10-19 13:10:46    Processed 0 {k} in 0s - 0/s\n" for k in ("nodes", "ways", "relations")] * 2
        with self.assertRaisesRegex(RuntimeError, "no OpenStreetMap data"):
            self._run(lines)

    def test_passes_when_any_frame_has_data(self):
        lines = [
            "  Processed 0 nodes in 0s - 0/s\n",
            "  Processed 1234 nodes in 1s - 1234/s\n",
        ]
        self._run(lines)

    def test_passes_when_no_osm2pgsql_summary_was_seen(self):
        self._run(["Generating zoom 12\n"])


class UploadResultsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root_patcher = mock.patch.object(render_job, "ROOT", self.tmp.name)
        root_patcher.start()
        self.addCleanup(root_patcher.stop)
        env_patcher = mock.patch.dict(
            os.environ,
            {
                "R2_ENDPOINT": "https://example.r2",
                "R2_ACCESS_KEY_ID": "key",
                "R2_SECRET_ACCESS_KEY": "secret",
                "R2_BUCKET": "bucket",
            },
        )
        env_patcher.start()
        self.addCleanup(env_patcher.stop)

    def _touch(self, name):
        path = os.path.join(self.tmp.name, name)
        with open(path, "wb") as f:
            f.write(b"data")
        return path

    def test_uploads_gif_only_when_no_mp4_was_produced(self):
        self._touch("progress.region.2020.2024.bbox.z12.gif")
        with mock.patch("boto3.client") as client:
            r2 = client.return_value
            keys = render_job.upload_results("job-1")

        self.assertEqual(keys, {"gif": "jobs/job-1/progress.region.2020.2024.bbox.z12.gif"})
        r2.upload_file.assert_called_once_with(
            os.path.join(self.tmp.name, "progress.region.2020.2024.bbox.z12.gif"),
            "bucket",
            "jobs/job-1/progress.region.2020.2024.bbox.z12.gif",
            ExtraArgs={"ContentType": "image/gif"},
        )

    def test_uploads_gif_and_mp4_when_both_were_produced(self):
        self._touch("progress.region.2020.2024.bbox.z12.gif")
        self._touch("progress.region.2020.2024.bbox.z12.mp4")
        with mock.patch("boto3.client") as client:
            r2 = client.return_value
            keys = render_job.upload_results("job-1")

        self.assertEqual(
            keys,
            {
                "gif": "jobs/job-1/progress.region.2020.2024.bbox.z12.gif",
                "mp4": "jobs/job-1/progress.region.2020.2024.bbox.z12.mp4",
            },
        )
        self.assertEqual(r2.upload_file.call_count, 2)
        r2.upload_file.assert_any_call(
            os.path.join(self.tmp.name, "progress.region.2020.2024.bbox.z12.mp4"),
            "bucket",
            "jobs/job-1/progress.region.2020.2024.bbox.z12.mp4",
            ExtraArgs={"ContentType": "video/mp4"},
        )

    def test_raises_when_no_gif_was_produced(self):
        with mock.patch("boto3.client"):
            with self.assertRaises(RuntimeError):
                render_job.upload_results("job-1")

    def test_skips_upload_of_a_zero_byte_mp4(self):
        self._touch("progress.region.2020.2024.bbox.z12.gif")
        # A truncated/empty MP4 (e.g. ffmpeg exiting 0 but writing nothing) should
        # be treated the same as "no MP4 was produced" rather than uploaded.
        open(os.path.join(self.tmp.name, "progress.region.2020.2024.bbox.z12.mp4"), "wb").close()
        with mock.patch("boto3.client") as client:
            r2 = client.return_value
            keys = render_job.upload_results("job-1")

        self.assertEqual(keys, {"gif": "jobs/job-1/progress.region.2020.2024.bbox.z12.gif"})
        r2.upload_file.assert_called_once_with(
            os.path.join(self.tmp.name, "progress.region.2020.2024.bbox.z12.gif"),
            "bucket",
            "jobs/job-1/progress.region.2020.2024.bbox.z12.gif",
            ExtraArgs={"ContentType": "image/gif"},
        )


if __name__ == "__main__":
    unittest.main()
