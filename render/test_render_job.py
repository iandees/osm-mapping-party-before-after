"""Unit tests for render_job.upload_results — R2 upload of the GIF (and MP4,
if make.sh produced one). Boto3 is mocked; only the local file-discovery and
upload-argument logic is under test."""

import os
import tempfile
import unittest
from unittest import mock

import render_job


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


if __name__ == "__main__":
    unittest.main()
