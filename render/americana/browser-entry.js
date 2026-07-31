// render/americana/browser-entry.js
//
// Constructs one Americana map frame in the browser page and waits for it to
// fully settle (all tiles + shield/POI sprites loaded and painted) before
// returning. capture.mjs screenshots the page once this resolves.
//
// The routeParser below is vendored from openstreetmap-americana's own
// source (NOT part of the published @americana/maplibre-shield-generator npm
// package — confirmed in the feasibility spike):
//   https://github.com/osm-americana/openstreetmap-americana/blob/main/src/js/shield_format.ts
//   https://github.com/osm-americana/openstreetmap-americana/blob/main/src/layer/highway_shield.js
import maplibregl from "maplibre-gl";
import { URLShieldRenderer } from "@americana/maplibre-shield-generator";
import { getGlobalStateForLocalization, getLocales } from "@americana/diplomat";

const STYLE_URL = "https://americanamap.org/style.json";
const SHIELDS_URL = "https://americanamap.org/shields.json";

const orderedRouteAttributes = ["network", "ref", "name", "color"];

function parseImageName(imageName) {
  const lines = imageName.split("\n");
  lines.shift(); // "shield"
  const parsed = Object.fromEntries(
    orderedRouteAttributes.map((a, i) => [a, lines[i]])
  );
  parsed.imageName = imageName;
  return parsed;
}

const routeParser = {
  parse: (id) => parseImageName(id),
  format: (network, ref, name) => `shield\n${network}\n${ref}\n${name}\n`,
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.json();
}

window.renderAmericanaFrame = async function (center, zoom, tileSourceUrl) {
  const style = await fetchJson(STYLE_URL);

  // Point the "openmaptiles" vector source at this frame's tile source
  // instead of the style's default public one — every production render is a
  // specific historic snapshot, never "current" public data.
  style.sources.openmaptiles = { type: "vector", url: tileSourceUrl };

  const map = new maplibregl.Map({
    container: "map",
    style,
    center,
    zoom,
    interactive: false,
    attributionControl: false,
  });

  new URLShieldRenderer(SHIELDS_URL, routeParser).renderOnMaplibreGL(map);

  map.once("styledata", () => {
    const localizationState = getGlobalStateForLocalization(getLocales(), {
      uppercaseCountryNames: true,
    });
    for (const [key, value] of Object.entries(localizationState)) {
      map.setGlobalStateProperty(key, value);
    }
  });

  await new Promise((resolve) => map.once("idle", resolve));
  return true;
};
