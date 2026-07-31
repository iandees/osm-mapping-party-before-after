#!/usr/bin/env node
// render/americana/capture.mjs
//
// Renders one Americana frame (bbox + zoom) to a PNG via Puppeteer + headless
// Chromium, against the given OpenMapTiles-schema tile source.
//
// Usage: node capture.mjs <left,bottom,right,top> <zoom> <tileSourceUrl> <outfile>
import puppeteer from "puppeteer";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AMERICANA_CAPTURE_PORT || 8842);
const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const [, , bboxArg, zoomArg, tileSourceUrl, outfile] = process.argv;
if (!bboxArg || !zoomArg || !tileSourceUrl || !outfile) {
  console.error("usage: node capture.mjs <left,bottom,right,top> <zoom> <tileSourceUrl> <outfile>");
  process.exit(2);
}
const [left, bottom, right, top] = bboxArg.split(",").map(Number);
const zoom = Number(zoomArg);

// Standard Web Mercator (EPSG:3857) pixel projection at a given zoom, tile
// size 256 — the same math the OSM slippy-map tile grid uses
// (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames). Used to size
// the render frame so the bbox fills it exactly, matching how nik4/Mapnik
// renders a bbox at a given zoom to its natural pixel size elsewhere in this
// pipeline.
function project(lon, lat, zoom) {
  const scale = 256 * 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}
function unproject(x, y, zoom) {
  const scale = 256 * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

const topLeft = project(left, top, zoom);
const bottomRight = project(right, bottom, zoom);
const width = Math.max(1, Math.round(bottomRight.x - topLeft.x));
const height = Math.max(1, Math.round(bottomRight.y - topLeft.y));
const centerPx = { x: (topLeft.x + bottomRight.x) / 2, y: (topLeft.y + bottomRight.y) / 2 };
const center = unproject(centerPx.x, centerPx.y, zoom);

const server = http.createServer(async (req, res) => {
  const filePath = path.join(HERE, req.url === "/" ? "/page.html" : req.url);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await puppeteer.launch({
  // Required running as a non-root container user with no seccomp/userns
  // namespace setup — Fargate tasks run in a locked-down container runtime.
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width, height });
page.on("console", (msg) => console.log("[page]", msg.text()));
page.on("pageerror", (err) => console.error("[pageerror]", err));

await page.goto(`http://localhost:${PORT}/page.html`, { waitUntil: "load" });
await page.evaluate(
  (c, z, url) => window.renderAmericanaFrame(c, z, url),
  [center.lon, center.lat],
  zoom,
  tileSourceUrl,
);

const mapEl = await page.$("#map");
await mapEl.screenshot({ path: outfile });
console.log(`wrote ${outfile}`);

await browser.close();
server.close();
