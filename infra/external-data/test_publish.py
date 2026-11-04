import io
import os
import tempfile
import unittest
import zipfile
from unittest import mock

import publish


def make_zip(path, members=("a.shp", "a.shx", "a.dbf", "a.prj", "a.cpg")):
    with zipfile.ZipFile(path, "w") as z:
        for m in members:
            z.writestr(m, "x")


class VerifyZipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "z.zip")

    def test_accepts_a_complete_shapefile(self):
        make_zip(self.path)
        publish.verify_zip("z.zip", self.path)

    def test_rejects_a_zip_missing_a_component(self):
        make_zip(self.path, members=("a.shp", "a.shx", "a.dbf", "a.prj"))
        with self.assertRaises(SystemExit):
            publish.verify_zip("z.zip", self.path)

    def test_rejects_a_non_zip(self):
        with open(self.path, "wb") as f:
            f.write(b"not a zip")
        with self.assertRaises(zipfile.BadZipFile):
            publish.verify_zip("z.zip", self.path)


class CheckSizesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "w.zip")
        with open(self.path, "wb") as f:
            f.write(b"x" * 1000)
        self.paths = {"w.zip": self.path}

    def previous(self, size, placeholder=False):
        return {"files": {"w.zip": {"size": size, "placeholder": placeholder}}}

    def test_accepts_a_similar_size(self):
        publish.check_sizes(self.previous(1100), self.paths)

    def test_rejects_a_much_smaller_build(self):
        with self.assertRaises(SystemExit):
            publish.check_sizes(self.previous(2000), self.paths)

    def test_rejects_a_much_larger_build(self):
        with self.assertRaises(SystemExit):
            publish.check_sizes(self.previous(500), self.paths)

    def test_ignores_placeholders_and_unbuilt_files(self):
        publish.check_sizes(self.previous(5, placeholder=True), self.paths)
        publish.check_sizes({"files": {"other.zip": {"size": 5}}}, self.paths)


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = os.path.join(self.tmp.name, "out")
        self.ph = os.path.join(self.tmp.name, "placeholders")
        os.makedirs(self.out)
        os.makedirs(self.ph)
        for name in ("water-polygons-split-3857.zip", "simplified-water-polygons-split-3857.zip"):
            make_zip(os.path.join(self.out, name))
        for name in ("antarctica-icesheet-polygons-3857.zip", "antarctica-icesheet-outlines-3857.zip"):
            make_zip(os.path.join(self.ph, name))

    def test_icesheet_falls_back_to_placeholders(self):
        paths, fallback = publish.collect(self.out, self.ph)
        self.assertEqual(fallback, {"antarctica-icesheet-polygons-3857.zip", "antarctica-icesheet-outlines-3857.zip"})
        self.assertTrue(paths["antarctica-icesheet-polygons-3857.zip"].startswith(self.ph))

    def test_built_icesheet_files_win_over_placeholders(self):
        for name in ("antarctica-icesheet-polygons-3857.zip", "antarctica-icesheet-outlines-3857.zip"):
            make_zip(os.path.join(self.out, name))
        paths, fallback = publish.collect(self.out, self.ph)
        self.assertEqual(fallback, set())
        self.assertTrue(paths["antarctica-icesheet-outlines-3857.zip"].startswith(self.out))

    def test_missing_water_zip_is_fatal(self):
        os.remove(os.path.join(self.out, "water-polygons-split-3857.zip"))
        with self.assertRaises(SystemExit):
            publish.collect(self.out, self.ph)

    def test_manifest_and_page_reflect_built_vs_placeholder(self):
        build = {"built_at": "2026-11-03T20:54:17Z", "planet_data_timestamp": "2026-10-26T01:00:03Z",
                 "osmcoastline_version": "osmcoastline version 2.4.1", "simplify_tolerance_m": 300}
        info = {"antarctica_data_timestamp": "2026-11-02T21:21:26Z", "icesheet_proc_commit": "abc"}
        paths, fallback = publish.collect(self.out, self.ph)
        m = publish.build_manifest(build, paths, fallback, info)
        self.assertNotIn("icesheet", m)
        self.assertIn("empty placeholders", publish.render_index(m))
        for name in ("antarctica-icesheet-polygons-3857.zip", "antarctica-icesheet-outlines-3857.zip"):
            make_zip(os.path.join(self.out, name))
        paths, fallback = publish.collect(self.out, self.ph)
        m = publish.build_manifest(build, paths, fallback, info)
        self.assertEqual(m["icesheet"]["icesheet_proc_commit"], "abc")
        page = publish.render_index(m)
        self.assertIn("icesheet_proc", page)
        self.assertNotIn("empty placeholders", page)


class CheckAgainstTests(unittest.TestCase):
    def test_sends_a_user_agent_cloudflare_accepts(self):
        seen = {}

        def fake_urlopen(req, timeout):
            seen["ua"] = req.get_header("User-agent")
            return io.StringIO('{"files": {}}')

        with mock.patch("publish.urllib.request.urlopen", fake_urlopen):
            publish.check_against("https://example.test/manifest.json", {})
        self.assertEqual(seen["ua"], publish.USER_AGENT)
        self.assertNotIn("urllib", seen["ua"])


class HumanSizeTests(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(publish.human_size(1537), "1.5 KB")
        self.assertEqual(publish.human_size(942007804), "942.0 MB")
        self.assertEqual(publish.human_size(12), "12 B")


if __name__ == "__main__":
    unittest.main()
