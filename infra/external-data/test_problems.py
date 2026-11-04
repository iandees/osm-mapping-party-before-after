import unittest

import problems
import publish

NODE_A, NODE_B, WAY = 111, 222, 333
DATA_TS = "2026-10-26T01:00:03Z"


def feat(geom, error, osm_id="0"):
    return {"type": "Feature", "properties": {"osm_id": osm_id, "error": error}, "geometry": geom}


def point(lon, lat):
    return {"type": "Point", "coordinates": [lon, lat]}


def line(*pts):
    return {"type": "LineString", "coordinates": [list(p) for p in pts]}


def features(*specs):
    return [problems.enrich(f, "point" if f["geometry"]["type"] == "Point" else "line") for f in specs]


def gap_features():
    return features(
        feat(point(-80.296224, 7.416456), "fixed_end_point", str(NODE_A)),
        feat(point(-80.29182, 7.417937), "fixed_end_point", str(NODE_B)),
        feat(line((-80.296224, 7.416456), (-80.29182, 7.417937)), "added_line"),
    )


class EnrichTests(unittest.TestCase):
    def test_point_with_node_id(self):
        p = problems.enrich(feat(point(8.5, 54.8), "end_point", "123"), "point")["properties"]
        self.assertEqual((p["type"], p["osm_type"], p["osm_id"]), ("end_point", "node", 123))

    def test_line_with_way_id_uses_middle_vertex_and_bbox(self):
        p = problems.enrich(feat(line((1, 2), (3, 4), (5, 6)), "not_closed", "77"), "line")["properties"]
        self.assertEqual((p["osm_type"], p["osm_id"]), ("way", 77))
        self.assertEqual((p["lon"], p["lat"]), (3, 4))
        self.assertEqual(p["bbox"], [1, 2, 5, 6])

    def test_two_point_line_uses_its_midpoint(self):
        p = problems.enrich(feat(line((0, 0), (2, 4)), "added_line"), "line")["properties"]
        self.assertEqual((p["lon"], p["lat"]), (1, 2))

    def test_zero_id_means_no_object(self):
        p = problems.enrich(feat(point(1, 2), "intersection", "0"), "point")["properties"]
        self.assertIsNone(p["osm_type"])


class ItemTests(unittest.TestCase):
    def test_a_closed_gap_is_one_item_with_length_and_both_nodes(self):
        items = problems.build_items(gap_features())
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["type"], "gap")
        self.assertAlmostEqual(items[0]["length_m"], 513, delta=2)
        self.assertEqual([o["osm_id"] for o in items[0]["objects"]], [NODE_A, NODE_B])

    def test_other_problems_stay_separate_and_gaps_come_first(self):
        items = problems.build_items(features(feat(point(1, 2), "tagged_node", "9")) + gap_features())
        self.assertEqual([i["type"] for i in items], ["gap", "tagged_node"])

    def test_count_uses_items(self):
        fc = {"features": gap_features()}
        fc["items"] = problems.build_items(fc["features"])
        self.assertEqual(problems.count(fc), 1)
        self.assertEqual(problems.count({"features": gap_features()}), 1)

    def test_links(self):
        gap = problems.build_items(gap_features())[0]
        urls = [u for _, u in problems.links(gap)]
        self.assertIn(f"https://www.openstreetmap.org/node/{NODE_A}", urls)
        self.assertTrue(any(f"select=node{NODE_A},node{NODE_B}" in u for u in urls))
        bare = problems.build_items(features(feat(point(1, 2), "intersection")))[0]
        urls = [u for _, u in problems.links(bare)]
        self.assertTrue(any("#map=18/2/1" in u for u in urls))


class FakeOsm:
    """Stands in for the OSM API and Nominatim."""

    def __init__(self, fixed=False):
        join = {"id": WAY, "nodes": [NODE_A, NODE_B], "tags": {"natural": "coastline"},
                "timestamp": "2026-10-26T03:06:00Z", "user": "fixer", "changeset": 5}
        self.ways = [join] if fixed else []

    def __call__(self, url):
        if "nominatim" in url:
            return {"address": {"county": "Tonosi", "state": "Los Santos", "country": "Panama"}}
        for n in (NODE_A, NODE_B):
            if url.endswith(f"/node/{n}.json"):
                return {"elements": [{"id": n, "version": 2, "timestamp": "2026-10-25T23:32:00Z",
                                      "user": "mapper", "changeset": 4}]}
            if url.endswith(f"/node/{n}/ways.json"):
                return {"elements": self.ways}
        return None


class AnnotateTests(unittest.TestCase):
    def annotated(self, fixed):
        items = problems.build_items(gap_features())
        problems.annotate(items, DATA_TS, fetch=FakeOsm(fixed))
        return items[0]

    def test_adds_place_and_details(self):
        it = self.annotated(fixed=False)
        self.assertEqual(it["place"], "Tonosi, Los Santos, Panama")
        self.assertEqual([d["osm_id"] for d in it["details"]], [NODE_A, NODE_B])
        self.assertNotIn("probably_fixed_by", it)
        self.assertFalse(it["edited_since"])

    def test_a_coastline_way_joining_both_ends_means_probably_fixed(self):
        it = self.annotated(fixed=True)
        self.assertEqual(it["probably_fixed_by"]["id"], WAY)
        self.assertTrue(it["edited_since"])  # the joining way is newer than the planet

    def test_lookups_failing_leaves_the_item_usable(self):
        items = problems.build_items(gap_features())
        problems.annotate(items, DATA_TS, fetch=lambda url: None)
        self.assertEqual(items[0]["details"], [])
        self.assertIn("Gap in the coastline", problems.render_page({"features": [], "items": items}, "x"))

    def test_only_the_first_few_items_are_looked_up(self):
        items = problems.build_items(features(*[feat(point(i, i), "tagged_node", str(i + 1)) for i in range(5)]))
        problems.annotate(items, DATA_TS, fetch=FakeOsm(), lookups=2)
        self.assertEqual(["details" in i for i in items], [True, True, False, False, False])


class PageTests(unittest.TestCase):
    def fc(self, fixed=None, kinds=()):
        feats = gap_features() if fixed is not None else []
        feats += features(*[feat(point(1, 2), k, "9") for k in kinds])
        fc = {"features": feats, "items": problems.build_items(feats)}
        if fixed is not None:
            problems.annotate(fc["items"], DATA_TS, fetch=FakeOsm(fixed))
        return fc

    def test_page_shows_gap_length_place_ways_and_links(self):
        page = problems.render_page(self.fc(fixed=False), DATA_TS)
        self.assertIn("513 m", page)
        self.assertIn("Tonosi, Los Santos, Panama", page)
        self.assertIn(f"node {NODE_A}", page)
        self.assertIn("<strong>1</strong> of 1 still look open", page)

    def test_fixed_gap_is_flagged_and_not_counted_as_open(self):
        page = problems.render_page(self.fc(fixed=True), DATA_TS)
        self.assertIn("probably already fixed", page)
        self.assertIn("<strong>0</strong> of 1 still look open", page)

    def test_open_problems_sort_before_fixed_ones(self):
        page = problems.render_page(self.fc(fixed=True, kinds=("tagged_node",)), DATA_TS)
        self.assertLess(page.index("<h3>Node tagged as coastline"), page.index("<h3>Gap in the coastline"))

    def test_unknown_type_does_not_crash(self):
        self.assertIn("something_new", problems.render_page(self.fc(kinds=("something_new",)), "x"))

    def test_empty_page(self):
        self.assertIn("No problems found", problems.render_page({"features": [], "items": []}, "x"))

    def test_item_cap(self):
        page = problems.render_page(self.fc(kinds=["tagged_node"] * (problems.MAX_ITEMS + 5)), "x")
        self.assertIn(f"Showing the first {problems.MAX_ITEMS}", page)


class IndexLinkTests(unittest.TestCase):
    def test_section(self):
        self.assertEqual(publish.render_problems_section(None), "")
        self.assertIn("<strong>3</strong> places", publish.render_problems_section(3))
        self.assertIn("no coastline problems", publish.render_problems_section(0))


if __name__ == "__main__":
    unittest.main()
