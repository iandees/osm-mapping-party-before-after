import unittest

import problems
import publish


def feat(geom, error, osm_id="0"):
    return {"type": "Feature", "properties": {"osm_id": osm_id, "error": error}, "geometry": geom}


def point(lon, lat):
    return {"type": "Point", "coordinates": [lon, lat]}


class EnrichTests(unittest.TestCase):
    def test_point_with_node_id(self):
        p = problems.enrich(feat(point(8.5, 54.8), "end_point", "123"), "point")["properties"]
        self.assertEqual((p["type"], p["osm_type"], p["osm_id"]), ("end_point", "node", 123))
        self.assertEqual((p["lon"], p["lat"]), (8.5, 54.8))

    def test_line_with_way_id_uses_middle_vertex_and_bbox(self):
        line = {"type": "LineString", "coordinates": [[1, 2], [3, 4], [5, 6]]}
        p = problems.enrich(feat(line, "not_closed", "77"), "line")["properties"]
        self.assertEqual((p["osm_type"], p["osm_id"]), ("way", 77))
        self.assertEqual((p["lon"], p["lat"]), (3, 4))
        self.assertEqual(p["bbox"], [1, 2, 5, 6])

    def test_zero_id_means_no_object(self):
        p = problems.enrich(feat(point(1, 2), "intersection", "0"), "point")["properties"]
        self.assertIsNone(p["osm_type"])
        self.assertIsNone(p["osm_id"])

    def test_links_for_object_and_for_location(self):
        obj = problems.enrich(feat(point(1, 2), "end_point", "5"), "point")["properties"]
        urls = [u for _, u in problems.links(obj)]
        self.assertIn("https://www.openstreetmap.org/node/5", urls)
        self.assertTrue(any("load_object?objects=n5" in u for u in urls))
        loc = problems.enrich(feat(point(1, 2), "intersection"), "point")["properties"]
        urls = [u for _, u in problems.links(loc)]
        self.assertTrue(any("#map=18/2/1" in u for u in urls))
        self.assertTrue(any("load_and_zoom" in u for u in urls))


class PageTests(unittest.TestCase):
    def fc(self, *kinds):
        return {"features": [problems.enrich(feat(point(1, 2), k, "9"), "point") for k in kinds]}

    def test_count_ignores_added_line(self):
        fc = {"features": [problems.enrich(feat(point(1, 2), "fixed_end_point", "9"), "point"),
                           problems.enrich(feat({"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                                                "added_line"), "line")]}
        self.assertEqual(problems.count(fc), 1)

    def test_page_lists_problems_by_title(self):
        page = problems.render_page(self.fc("end_point", "end_point", "tagged_node"), "2026-11-04 00:00 UTC")
        self.assertIn("Unconnected coastline end", page)
        self.assertIn("Node tagged as coastline", page)
        self.assertIn("All problems (3)", page)

    def test_unknown_type_does_not_crash(self):
        self.assertIn("something_new", problems.render_page(self.fc("something_new"), "x"))

    def test_empty_page(self):
        self.assertIn("No problems found", problems.render_page({"features": []}, "x"))

    def test_row_cap(self):
        page = problems.render_page(self.fc(*["end_point"] * (problems.MAX_ROWS + 5)), "x")
        self.assertIn(f"Showing the first {problems.MAX_ROWS}", page)


class IndexLinkTests(unittest.TestCase):
    def test_section(self):
        self.assertEqual(publish.render_problems_section(None), "")
        self.assertIn("<strong>3</strong> places", publish.render_problems_section(3))
        self.assertIn("1</strong> place ", publish.render_problems_section(1))
        self.assertIn("no coastline problems", publish.render_problems_section(0))


if __name__ == "__main__":
    unittest.main()
