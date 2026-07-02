"""Select the smallest Geofabrik region whose extent covers a bounding box.

Geofabrik publishes an ``index-v1.json`` GeoJSON FeatureCollection; each feature's
``id`` is the region path (e.g. ``europe/great-britain/england``) used to build the
download URL. We pick the region with the smallest geometry bounding box that fully
contains the requested bbox. Using the geometry's bbox (rather than exact
point-in-polygon) is a deliberate, simple heuristic: it can over-select a slightly
larger region, which is safe — the subsequent ``osmium extract`` clips to the exact
bbox anyway.
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


def select_region(index: dict, bbox: tuple[float, float, float, float]) -> dict:
    """Return the GeoJSON feature of the smallest region covering ``bbox``.

    ``bbox`` is (left, bottom, right, top). Raises NoCoveringRegion if none cover it.
    """
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
            continue
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
