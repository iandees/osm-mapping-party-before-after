"""Select the smallest Geofabrik region whose extent covers a bounding box.

Geofabrik publishes an ``index-v1.json`` GeoJSON FeatureCollection. We pick the
smallest region whose *actual polygon* contains the requested bbox, then download
its ``urls.history`` file.

We test true polygon containment (not just the geometry's bounding box) because
region shapes are irregular: e.g. West Virginia's bounding box reaches east into
Virginia, so a bbox-only test would pick WV for a Virginia point and the extract
would come back empty. The geometry bbox is still used as a cheap pre-filter.
"""

from __future__ import annotations

from typing import Any, Iterable


class NoCoveringRegion(Exception):
    """Raised when no region in the index covers the requested bbox."""


def _iter_coords(coords: Any) -> Iterable[list[float]]:
    """Yield [lon, lat] pairs from arbitrarily nested GeoJSON coordinate arrays."""
    if (
        isinstance(coords, list)
        and len(coords) >= 2
        and isinstance(coords[0], (int, float))
        and isinstance(coords[1], (int, float))
    ):
        yield coords  # a single position
        return
    if isinstance(coords, list):
        for item in coords:
            yield from _iter_coords(item)


def geometry_bbox(geometry: dict) -> tuple[float, float, float, float]:
    """Return (min_lon, min_lat, max_lon, max_lat) for a GeoJSON geometry."""
    lons: list[float] = []
    lats: list[float] = []
    for lon, lat in (p[:2] for p in _iter_coords(geometry.get("coordinates", []))):
        lons.append(lon)
        lats.append(lat)
    if not lons:
        raise ValueError("geometry has no coordinates")
    return (min(lons), min(lats), max(lons), max(lats))


def _covers(region_bbox, request_bbox) -> bool:
    rl, rb, rr, rt = region_bbox
    l, b, r, t = request_bbox
    return rl <= l and rb <= b and rr >= r and rt >= t


def _point_in_ring(x: float, y: float, ring) -> bool:
    """Ray-casting point-in-ring test for a linear ring of [lon, lat] positions."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _point_in_polygon(x: float, y: float, polygon) -> bool:
    """A GeoJSON Polygon: first ring is the outer boundary, the rest are holes."""
    if not polygon or not _point_in_ring(x, y, polygon[0]):
        return False
    return not any(_point_in_ring(x, y, hole) for hole in polygon[1:])


def _point_in_geometry(x: float, y: float, geometry: dict) -> bool:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        return _point_in_polygon(x, y, coords)
    if gtype == "MultiPolygon":
        return any(_point_in_polygon(x, y, poly) for poly in coords)
    return False


def select_region(index: dict, bbox: tuple[float, float, float, float]) -> dict:
    """Return the GeoJSON feature of the smallest region whose polygon covers ``bbox``.

    ``bbox`` is (left, bottom, right, top). The bbox's four corners (and centre)
    must all lie within the region's actual polygon. Raises NoCoveringRegion if
    none qualify.
    """
    l, b, r, t = bbox
    probes = [(l, b), (r, b), (r, t), (l, t), ((l + r) / 2, (b + t) / 2)]
    best: dict | None = None
    best_area = float("inf")
    for feature in index.get("features", []):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        try:
            rb = geometry_bbox(geometry)
        except ValueError:
            continue
        if not _covers(rb, bbox):
            continue  # cheap bbox pre-filter
        if not all(_point_in_geometry(x, y, geometry) for x, y in probes):
            continue  # exact polygon containment
        area = (rb[2] - rb[0]) * (rb[3] - rb[1])
        if area < best_area:
            best_area = area
            best = feature
    if best is None:
        raise NoCoveringRegion(f"no Geofabrik region covers bbox {bbox}")
    return best


def region_id(feature: dict) -> str:
    """The region's leaf id, e.g. 'bremen' (used only for logging)."""
    props = feature.get("properties") or {}
    return feature.get("id") or props.get("id")


def region_history_url(feature: dict) -> str:
    """The internal full-history (.osh.pbf) URL, taken from the index's urls.history."""
    urls = (feature.get("properties") or {}).get("urls") or {}
    history = urls.get("history")
    if not history:
        raise ValueError(f"region {region_id(feature)} has no history URL in the index")
    return history
