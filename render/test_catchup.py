"""Unit tests for catchup.py — command construction and orchestration branches.

These do not shell out to osmium/osmupdate; the subprocess runner and the
timestamp probe are injected. An opt-in end-to-end test (real osmium/osmupdate on
a fixture .osc) belongs alongside render/test_incremental.sh.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

import catchup

UTC = timezone.utc


def _osmium(*args):
    return subprocess.run(["osmium", *args], check=True, capture_output=True, text=True)


def _to_opl(path):
    """Return the OPL text of an osm/osc file (for asserting on contents)."""
    return _osmium("cat", "-f", "opl", path, "-o", "-").stdout


class CommandBuilderTests(unittest.TestCase):
    def test_extract_bbox_cmd_sets_replication_headers(self):
        ts = datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC)
        cmd = catchup.extract_bbox_cmd(
            "region.osh.pbf", "-1,50,0,51", "out.osh.pbf", ts, "https://x/replication"
        )
        self.assertIn("--with-history", cmd)
        self.assertIn("--bbox", cmd)
        self.assertIn("-1,50,0,51", cmd)
        self.assertIn("osmosis_replication_timestamp=2024-01-02T03:04:05Z", cmd)
        self.assertIn("osmosis_replication_base_url=https://x/replication", cmd)
        self.assertEqual(cmd[-1], "region.osh.pbf")  # input is the last positional

    def test_extract_bbox_cmd_utc_normalizes_offset(self):
        # A non-UTC tz must be converted to Z (UTC) for the header.
        ts = datetime.fromisoformat("2024-01-02T03:04:05+02:00")
        cmd = catchup.extract_bbox_cmd("r", "-1,50,0,51", "o", ts, "https://x")
        self.assertIn("osmosis_replication_timestamp=2024-01-02T01:04:05Z", cmd)

    def test_osmupdate_cmd_normalizes_base_url_and_orders_files(self):
        cmd = catchup.osmupdate_cmd("in.osh.pbf", "ch.osc.gz", "/tmp/x", "https://planet/replication")
        self.assertEqual(cmd[0], "osmupdate")
        self.assertIn("--base-url=https://planet/replication/", cmd)  # trailing slash added once
        self.assertIn("-t=/tmp/x", cmd)
        self.assertEqual(cmd[-2:], ["in.osh.pbf", "ch.osc.gz"])

    def test_clip_changes_cmd_uses_simple_strategy(self):
        cmd = catchup.clip_changes_cmd("-1,50,0,51", "ch.osc.gz", "loc.osc.gz")
        self.assertIn("--strategy", cmd)
        self.assertIn("simple", cmd)
        self.assertEqual(cmd[-1], "ch.osc.gz")  # change file is the input

    def test_apply_changes_cmd_keeps_history(self):
        cmd = catchup.apply_changes_cmd("h.osh.pbf", "loc.osc.gz", "out.osh.pbf")
        self.assertIn("-H", cmd)  # keep full history
        self.assertEqual(cmd[-2:], ["h.osh.pbf", "loc.osc.gz"])


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.region = os.path.join(self.tmp, "region.osh.pbf")
        open(self.region, "w").close()
        self.calls = []

    def _run(self, cmd, **kw):
        """Fake runner: records the argv, creates -o outputs, and makes osmupdate
        emit a nonempty change file."""
        self.calls.append(cmd)
        if cmd and cmd[0] == "osmupdate":
            with open(cmd[-1], "wb") as f:
                f.write(b"changedata")
        if "-o" in cmd:
            open(cmd[cmd.index("-o") + 1], "a").close()
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    def test_noop_when_base_already_covers_after(self):
        result = catchup.bring_bbox_up_to_date(
            self.region,
            "-1,50,0,51",
            "2024-01-01T00:00:00Z",
            self.tmp,
            run=self._run,
            newest=lambda p, run: datetime(2025, 1, 1, tzinfo=UTC),  # newer than after
        )
        self.assertEqual(result, self.region)  # base returned untouched
        self.assertEqual(self.calls, [])  # never shelled out

    def test_full_catchup_pipeline_runs_in_order(self):
        ts = iter([datetime(2020, 1, 1, tzinfo=UTC), datetime(2024, 6, 1, tzinfo=UTC)])
        result = catchup.bring_bbox_up_to_date(
            self.region,
            "-1,50,0,51",
            "2024-01-01T00:00:00Z",
            self.tmp,
            run=self._run,
            newest=lambda p, run: next(ts),
        )
        progs = [c[0] for c in self.calls]
        self.assertEqual(progs, ["osmium", "osmupdate", "osmium", "osmium"])
        self.assertIn("extract", self.calls[0])  # bbox extract
        self.assertIn("extract", self.calls[2])  # clip changes
        self.assertIn("apply-changes", self.calls[3])
        self.assertTrue(result.endswith("catchup_updated.osh.pbf"))

    def test_osmupdate_no_new_data_returns_bbox_extract(self):
        def run(cmd, **kw):
            self.calls.append(cmd)
            if "-o" in cmd and cmd[0] == "osmium":
                open(cmd[cmd.index("-o") + 1], "a").close()
            if cmd[0] == "osmupdate":
                # Simulate "already up-to-date": no change file, nonzero rc.
                return subprocess.CompletedProcess(cmd, 21, stdout="", stderr="up to date")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        result = catchup.bring_bbox_up_to_date(
            self.region,
            "-1,50,0,51",
            "2024-01-01T00:00:00Z",
            self.tmp,
            run=run,
            newest=lambda p, run: datetime(2020, 1, 1, tzinfo=UTC),
        )
        self.assertTrue(result.endswith("catchup_bbox.osh.pbf"))
        # extract happened, apply-changes did not.
        self.assertFalse(any("apply-changes" in c for c in self.calls))


@unittest.skipUnless(shutil.which("osmium"), "osmium-tool not installed")
class OsmiumIntegrationTests(unittest.TestCase):
    """Runs the real osmium binary against the exact argv catchup.py builds, proving
    the 'clip the changes to the bbox, then apply with history' pipeline works —
    the core of 'trimmed to the area of the history extract'. Skipped without osmium.

    bbox is lon/lat 0..1. n1 (inside) exists in the base; the change modifies n1 and
    n2 (n2 outside) and creates n3 (inside) and n4 (outside). After clipping to the
    bbox, only the in-area edits (n1, n3) may survive.
    """

    BBOX = "0,0,1,1"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # Base history: n1 inside the bbox, n2 outside — both at v1.
        base_opl = (
            "n1 v1 dV c1 t2024-01-01T00:00:00Z i1 uu T x0.5 y0.5\n"
            "n2 v1 dV c1 t2024-01-01T00:00:00Z i1 uu T x50.0 y50.0\n"
        )
        # A later snapshot: n1/n2 modified (v2), n3 (inside) and n4 (outside) created.
        snap2_opl = (
            "n1 v2 dV c2 t2024-06-01T00:00:00Z i1 uu Tamenity=cafe x0.5 y0.5\n"
            "n2 v2 dV c2 t2024-06-01T00:00:00Z i1 uu Tamenity=cafe x50.0 y50.0\n"
            "n3 v1 dV c2 t2024-06-01T00:00:00Z i1 uu T x0.6 y0.6\n"
            "n4 v1 dV c2 t2024-06-01T00:00:00Z i1 uu T x60.0 y60.0\n"
        )
        self.base = self._pbf("base.osh.pbf", base_opl)  # history file
        snap1 = self._pbf("snap1.osm.pbf", base_opl)
        snap2 = self._pbf("snap2.osm.pbf", snap2_opl)
        self.change = os.path.join(self.tmp, "change.osc.gz")
        _osmium("derive-changes", snap1, snap2, "-o", self.change)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _p(self, name):
        return os.path.join(self.tmp, name)

    def _pbf(self, name, opl):
        opl_path = self._p(name.rsplit(".", 2)[0] + ".osm.opl")
        with open(opl_path, "w") as f:
            f.write(opl)
        out = self._p(name)
        _osmium("cat", opl_path, "-o", out)
        return out

    def test_clip_drops_out_of_bbox_changes(self):
        clipped = self._p("clipped.osc.gz")
        subprocess.run(catchup.clip_changes_cmd(self.BBOX, self.change, clipped), check=True)
        opl = _to_opl(clipped)
        # Only in-bbox objects survive the clip.
        self.assertRegex(opl, r"(?m)^n1 ")  # modified, inside
        self.assertRegex(opl, r"(?m)^n3 ")  # created, inside
        self.assertNotRegex(opl, r"(?m)^n2 ")  # modified, outside → dropped
        self.assertNotRegex(opl, r"(?m)^n4 ")  # created, outside → dropped

    def test_apply_clipped_changes_with_history(self):
        clipped = self._p("clipped.osc.gz")
        subprocess.run(catchup.clip_changes_cmd(self.BBOX, self.change, clipped), check=True)
        merged = self._p("merged.osh.pbf")
        subprocess.run(catchup.apply_changes_cmd(self.base, clipped, merged), check=True)
        opl = _to_opl(merged)
        self.assertRegex(opl, r"(?m)^n1 v2 ")  # in-bbox modify applied
        self.assertRegex(opl, r"(?m)^n3 v1 ")  # in-bbox create applied
        self.assertNotRegex(opl, r"(?m)^n4 ")  # out-of-bbox create never applied
        # n2's out-of-bbox modify was clipped, so the base's n2 v1 is untouched.
        self.assertRegex(opl, r"(?m)^n2 v1 ")
        self.assertNotRegex(opl, r"(?m)^n2 v2 ")

    def test_extract_bbox_sets_replication_timestamp_header(self):
        out = self._p("bbox_base.osh.pbf")
        ts = datetime(2024, 6, 1, tzinfo=UTC)
        subprocess.run(
            catchup.extract_bbox_cmd(self.base, self.BBOX, out, ts, "https://planet/replication"),
            check=True,
        )
        info = _osmium("fileinfo", out).stdout
        self.assertIn("2024-06-01T00:00:00Z", info)  # header timestamp round-trips
        # And the extract kept the in-bbox node while dropping the out-of-bbox one.
        opl = _to_opl(out)
        self.assertRegex(opl, r"(?m)^n1 ")
        self.assertNotRegex(opl, r"(?m)^n2 ")


if __name__ == "__main__":
    unittest.main()
