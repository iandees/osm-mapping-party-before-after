import type { Job } from "./db";
import {
  FRAMES_MAX,
  FRAMES_MIN,
  SIZE_DEFAULT,
  SIZE_MAX,
  SIZE_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./validation";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input, button { font: inherit; padding: 0.5rem; }
  input[type=email], input[type=datetime-local], input[type=number] { width: 100%; max-width: 22rem; box-sizing: border-box; }
  button { cursor: pointer; margin-top: 1rem; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .row > div { flex: 1 1 10rem; }
  .error { color: #b00020; }
  .muted { color: #666; }
  #map { height: 380px; margin-top: 0.5rem; border: 1px solid #ccc; }
  img.result { max-width: 100%; border: 1px solid #ccc; margin: 0.5rem 0; display: block; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .gallery a { display: block; border: 1px solid #ccc; border-radius: 6px; overflow: hidden; }
  .gallery img { width: 100%; height: 140px; object-fit: cover; display: block; }
  section.maps { margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/** A responsive grid of finished maps, each linking to its job page. */
function galleryGrid(jobs: Job[], heading: string): string {
  const cards = jobs
    .filter((j) => j.result_key)
    .map(
      (j) =>
        `<a href="/jobs/${esc(j.id)}" title="${esc(j.bbox)} · ${esc(j.time_before)} → ${esc(j.time_after)}">` +
        `<img loading="lazy" src="/r/${esc(j.result_key!)}" alt="before/after map"></a>`,
    )
    .join("\n");
  if (!cards) return "";
  return `<section class="maps"><h2 style="font-size:1.1rem">${esc(heading)}</h2>
<div class="gallery">${cards}</div></section>`;
}

export function loginPage(error?: string, recent: Job[] = []): string {
  return layout(
    "Sign in — OSM before/after",
    `<h1>OSM before/after map</h1>
<p>See how an area of OpenStreetMap changed over time. Sign in with your email to make your own.</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/login">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <button type="submit">Send sign-in link</button>
</form>
${galleryGrid(recent, "Recently created maps")}`,
  );
}

export function checkEmailPage(email: string): string {
  return layout(
    "Check your email",
    `<h1>Check your email</h1>
<p>If <strong>${esc(email)}</strong> is a valid address, a sign-in link is on its way. It expires shortly and can be used once.</p>`,
  );
}

export function formPage(email: string, jobs: Job[] = [], error?: string): string {
  const head = `
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js"></script>`;
  return layout(
    "Create a before/after map",
    `<h1>Create a before/after map</h1>
<p class="muted">Signed in as ${esc(email)} · <form method="post" action="/logout" style="display:inline"><button style="margin:0;padding:0;border:none;background:none;text-decoration:underline;color:inherit;cursor:pointer">sign out</button></form></p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/submit" id="jobform">
  <label>Area — draw a rectangle on the map</label>
  <div id="map"></div>
  <input type="hidden" name="bbox" id="bbox" required>
  <p class="muted" id="bboxlabel">No area selected yet.</p>

  <div class="row">
    <div>
      <label for="time_before">Before</label>
      <input id="time_before" name="time_before" type="datetime-local" required>
    </div>
    <div>
      <label for="time_after">After</label>
      <input id="time_after" name="time_after" type="datetime-local" required>
    </div>
  </div>

  <div class="row">
    <div>
      <label for="output_px">Image size (longest side, px)</label>
      <input id="output_px" name="output_px" type="number" min="${SIZE_MIN}" max="${SIZE_MAX}" value="${SIZE_DEFAULT}" required>
      <p class="muted" id="zoomhint">Draw an area to see the map zoom that will be used.</p>
    </div>
    <div>
      <label for="num_frames">Frames</label>
      <input id="num_frames" name="num_frames" type="number" min="${FRAMES_MIN}" max="${FRAMES_MAX}" value="2" required>
    </div>
  </div>

  <button type="submit">Build my map</button>
</form>
<script>
  const map = L.map('map').setView([51.505, -0.09], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  const drawn = new L.FeatureGroup().addTo(map);
  const drawControl = new L.Control.Draw({
    draw: { polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
            rectangle: { shapeOptions: { color: '#e6007e' } } },
    edit: { featureGroup: drawn, edit: false }
  });
  map.addControl(drawControl);
  const ZOOM_MIN = ${ZOOM_MIN}, ZOOM_MAX = ${ZOOM_MAX};
  let current = null; // [left, bottom, right, top]

  // Mirror of validation.ts suggestedZoom(): the server recomputes authoritatively.
  function suggestedZoom(left, bottom, right, top, targetPx) {
    const latToY = lat => {
      const s = Math.sin(lat * Math.PI / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const width = (right - left) / 360 * 256;
    const height = Math.abs(latToY(bottom) - latToY(top)) * 256;
    const longest0 = Math.max(width, height);
    if (!(longest0 > 0)) return ZOOM_MAX;
    const z = Math.ceil(Math.log2(targetPx / longest0));
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }
  function updateZoomHint() {
    const hint = document.getElementById('zoomhint');
    if (!current) { hint.textContent = 'Draw an area to see the map zoom that will be used.'; return; }
    const px = Number(document.getElementById('output_px').value) || ${SIZE_DEFAULT};
    const z = suggestedZoom(current[0], current[1], current[2], current[3], px);
    hint.textContent = 'At ' + px + 'px this area will render at map zoom ' + z + '.';
  }
  function setBbox(layer) {
    drawn.clearLayers();
    drawn.addLayer(layer);
    const b = layer.getBounds();
    current = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const bbox = current.map(n => n.toFixed(5)).join(',');
    document.getElementById('bbox').value = bbox;
    document.getElementById('bboxlabel').textContent = 'Selected bbox: ' + bbox;
    updateZoomHint();
  }
  map.on(L.Draw.Event.CREATED, e => setBbox(e.layer));
  document.getElementById('output_px').addEventListener('input', updateZoomHint);
  document.getElementById('jobform').addEventListener('submit', e => {
    if (!document.getElementById('bbox').value) {
      e.preventDefault();
      alert('Please draw a rectangle on the map first.');
    }
  });
</script>
${galleryGrid(jobs, "Your maps")}`,
    head,
  );
}

export function jobPage(job: Job): string {
  if (job.status === "done" && job.result_key) {
    return layout(
      "Your map is ready",
      `<h1>Your before/after map</h1>
<p class="muted">${esc(job.bbox)} · ${esc(job.time_before)} → ${esc(job.time_after)}</p>
<img class="result" src="/r/${esc(job.result_key)}" alt="animated before/after map">
<p><a href="/">Make another</a></p>`,
    );
  }

  if (job.status === "failed") {
    return layout(
      "Job failed",
      `<h1>Something went wrong</h1>
<p class="error">${esc(job.error ?? "The render failed.")}</p>
<p><a href="/">Try again</a></p>`,
    );
  }

  // queued | running: poll for updates.
  return layout(
    "Working on your map",
    `<h1>Building your map…</h1>
<p><strong id="progress">${esc(job.progress ?? "Waiting to start…")}</strong></p>
<p class="muted">Status: <span id="status">${esc(job.status)}</span>. This can take a while for large areas — you'll also get an email when it's ready.</p>
<script>
  async function poll() {
    try {
      const r = await fetch(location.pathname + '/status', { headers: { accept: 'application/json' } });
      const j = await r.json();
      document.getElementById('status').textContent = j.status;
      if (j.progress) document.getElementById('progress').textContent = j.progress;
      if (j.status === 'done' || j.status === 'failed') { location.reload(); return; }
    } catch (e) {}
    setTimeout(poll, 3000);
  }
  setTimeout(poll, 3000);
</script>`,
  );
}
