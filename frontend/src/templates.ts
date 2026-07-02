import type { Job } from "./db";
import { FRAMES_MAX, FRAMES_MIN, ZOOM_MAX } from "./validation";

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
</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "Sign in — OSM before/after",
    `<h1>OSM before/after map</h1>
<p>Enter your email and we'll send you a one-time sign-in link.</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/login">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <button type="submit">Send sign-in link</button>
</form>`,
  );
}

export function checkEmailPage(email: string): string {
  return layout(
    "Check your email",
    `<h1>Check your email</h1>
<p>If <strong>${esc(email)}</strong> is a valid address, a sign-in link is on its way. It expires shortly and can be used once.</p>`,
  );
}

export function formPage(email: string, error?: string): string {
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
      <label for="min_zoom">Min zoom</label>
      <input id="min_zoom" name="min_zoom" type="number" min="0" max="${ZOOM_MAX}" value="6" required>
    </div>
    <div>
      <label for="max_zoom">Max zoom</label>
      <input id="max_zoom" name="max_zoom" type="number" min="0" max="${ZOOM_MAX}" value="12" required>
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
  function setBbox(layer) {
    drawn.clearLayers();
    drawn.addLayer(layer);
    const b = layer.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(n => n.toFixed(5)).join(',');
    document.getElementById('bbox').value = bbox;
    document.getElementById('bboxlabel').textContent = 'Selected bbox: ' + bbox;
  }
  map.on(L.Draw.Event.CREATED, e => setBbox(e.layer));
  document.getElementById('jobform').addEventListener('submit', e => {
    if (!document.getElementById('bbox').value) {
      e.preventDefault();
      alert('Please draw a rectangle on the map first.');
    }
  });
</script>`,
    head,
  );
}

export function jobPage(job: Job, resultKeys: string[]): string {
  if (job.status === "done") {
    const imgs = resultKeys
      .sort()
      .map((k) => `<img class="result" src="/r/${esc(k)}" alt="animated map">`)
      .join("\n");
    return layout(
      "Your map is ready",
      `<h1>Your before/after map</h1>
<p class="muted">${esc(job.bbox)} · ${esc(job.time_before)} → ${esc(job.time_after)}</p>
${imgs || "<p>No images were produced.</p>"}
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
<p class="muted">Status: <span id="status">${esc(job.status)}</span>. This can take a while for large areas — you'll also get an email when it's ready.</p>
<script>
  async function poll() {
    try {
      const r = await fetch(location.pathname + '.json', { headers: { accept: 'application/json' } });
      const j = await r.json();
      document.getElementById('status').textContent = j.status;
      if (j.status === 'done' || j.status === 'failed') { location.reload(); return; }
    } catch (e) {}
    setTimeout(poll, 5000);
  }
  setTimeout(poll, 5000);
</script>`,
  );
}
