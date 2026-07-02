"""Unit tests for region selection. Run: python3 -m unittest render/test_region.py"""

import unittest

from region import (
    NoCoveringRegion,
    geometry_bbox,
    region_history_url,
    select_region,
)


def rect(id_, west, south, east, north):
    leaf = id_.split("/")[-1]
    return {
        "type": "Feature",
        "id": id_,
        "properties": {
            "id": leaf,
            "urls": {
                "history": f"https://osm-internal.download.geofabrik.de/{id_}-internal.osh.pbf",
            },
        },
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [west, south], [east, south], [east, north], [west, north], [west, south],
            ]],
        },
    }


# A large containing region and a smaller nested one, plus an unrelated region.
INDEX = {
    "type": "FeatureCollection",
    "features": [
        rect("europe", -25, 34, 45, 72),
        rect("europe/great-britain", -9, 49, 2, 61),
        rect("europe/great-britain/england", -6, 49.8, 2, 55.9),
        rect("north-america", -170, 5, -50, 84),
    ],
}


class TestGeometryBbox(unittest.TestCase):
    def test_polygon_bbox(self):
        self.assertEqual(
            geometry_bbox(rect("x", -6, 49.8, 2, 55.9)["geometry"]),
            (-6, 49.8, 2, 55.9),
        )

    def test_multipolygon_bbox(self):
        geom = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                [[[5, 5], [6, 5], [6, 6], [5, 5]]],
            ],
        }
        self.assertEqual(geometry_bbox(geom), (0, 0, 6, 6))


class TestSelectRegion(unittest.TestCase):
    def test_picks_smallest_covering_region(self):
        # A London-ish bbox is covered by england, GB, and europe; england is smallest.
        feature = select_region(INDEX, (-0.2, 51.4, 0.0, 51.6))
        self.assertEqual(feature["id"], "europe/great-britain/england")

    def test_falls_back_to_larger_region_when_needed(self):
        # A bbox spanning England + France is not inside england/GB, but is inside europe.
        feature = select_region(INDEX, (-3.0, 48.0, 3.0, 52.0))
        self.assertEqual(feature["id"], "europe")

    def test_raises_when_uncovered(self):
        with self.assertRaises(NoCoveringRegion):
            select_region(INDEX, (100, -80, 120, -60))

    def test_history_url(self):
        feature = select_region(INDEX, (-0.2, 51.4, 0.0, 51.6))
        self.assertEqual(
            region_history_url(feature),
            "https://osm-internal.download.geofabrik.de/europe/great-britain/england-internal.osh.pbf",
        )

    def test_history_url_missing_raises(self):
        feature = {"properties": {"id": "x", "urls": {}}}
        with self.assertRaises(ValueError):
            region_history_url(feature)


if __name__ == "__main__":
    unittest.main()
