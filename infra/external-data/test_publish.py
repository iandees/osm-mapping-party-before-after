import io
import os
import tempfile
import unittest
import zipfile

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


class HumanSizeTests(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(publish.human_size(1537), "1.5 KB")
        self.assertEqual(publish.human_size(942007804), "942.0 MB")
        self.assertEqual(publish.human_size(12), "12 B")


if __name__ == "__main__":
    unittest.main()
