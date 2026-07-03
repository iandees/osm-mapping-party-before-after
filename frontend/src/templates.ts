import type { Job } from "./db";
import {
  FRAMES_MAX,
  FRAMES_MIN,
  NAME_MAX,
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
  input[type=email], input[type=datetime-local], input[type=number], input[type=text] { width: 100%; max-width: 22rem; box-sizing: border-box; }
  button { cursor: pointer; margin-top: 1rem; }
  .userbar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin: 0 0 0.5rem; }
  .userbar form { margin: 0; }
  .linkbtn { margin: 0; padding: 0; border: none; background: none; text-decoration: underline; color: inherit; cursor: pointer; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .row > div { flex: 1 1 10rem; }
  .error { color: #b00020; }
  .muted { color: #666; }
  .presets { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0.5rem 0 0; }
  .presets a { display: inline-block; padding: 0.2rem 0.6rem; border: 1px solid #ccc; border-radius: 999px; font-size: 0.85rem; text-decoration: none; color: inherit; }
  .presets a:hover { border-color: #e6007e; color: #e6007e; }
  #map { height: 380px; margin-top: 0.5rem; border: 1px solid #ccc; }
  img.result { max-width: 100%; border: 1px solid #ccc; margin: 0.5rem 0; display: block; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .gallery .card { position: relative; }
  .gallery a { display: block; border: 1px solid #ccc; border-radius: 6px; overflow: hidden; text-decoration: none; color: inherit; }
  .gallery img { width: 100%; height: 140px; object-fit: cover; display: block; }
  .gallery .placeholder { height: 140px; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 0.4rem; padding: 0.5rem; text-align: center; font-size: 0.85rem;
    background: rgba(127,127,127,0.12); box-sizing: border-box; }
  .gallery .placeholder.failed { background: rgba(176,0,32,0.12); color: #b00020; }
  .gallery .placeholder .spinner { width: 1.4rem; height: 1.4rem; border: 3px solid rgba(127,127,127,0.4);
    border-top-color: #e6007e; border-radius: 50%; animation: spin 0.9s linear infinite; }
  .gallery .caption { display: block; padding: 0.35rem 0.5rem; font-size: 0.8rem; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gallery .del { position: absolute; top: 4px; right: 4px; margin: 0; }
  .gallery .del button { padding: 0; width: 1.6rem; height: 1.6rem; line-height: 1; border: none; border-radius: 50%;
    background: rgba(0,0,0,0.6); color: #fff; font-size: 1.1rem; cursor: pointer; }
  .gallery .del button:hover { background: #b00020; }
  .delete-form { display: inline; margin: 0; }
  section.maps { margin-top: 2rem; border-top: 1px solid #ddd; padding-top: 1rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  ol.checklist { list-style: none; padding: 0; margin: 1rem 0; max-width: 26rem; }
  ol.checklist li { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0; color: #999; }
  ol.checklist li .mark { flex: 0 0 1.4rem; height: 1.4rem; display: flex; align-items: center; justify-content: center; }
  ol.checklist li.done { color: inherit; }
  ol.checklist li.done .mark { color: #2e7d32; font-weight: 700; }
  ol.checklist li.active { color: inherit; font-weight: 600; }
  ol.checklist li.active .mark .spinner { width: 1.1rem; height: 1.1rem; border: 3px solid rgba(127,127,127,0.4);
    border-top-color: #e6007e; border-radius: 50%; animation: spin 0.9s linear infinite; }
  ol.checklist li .detail { color: #666; font-weight: 400; font-size: 0.9rem; }
</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/** A small confirm-on-submit form that hard-deletes a job the owner controls. */
function deleteForm(id: string, cssClass: string, label: string): string {
  return (
    `<form class="${cssClass}" method="post" action="/jobs/${esc(id)}/delete" ` +
    `onsubmit="return confirm('Delete this map? This can\\'t be undone.')">` +
    `<button type="submit" title="Delete this map" aria-label="Delete this map">${label}</button></form>`
  );
}

/** The label shown under a card and in its link title: the name, else the bbox. */
function cardLabel(j: Job): string {
  return j.name && j.name.trim() !== "" ? j.name : j.bbox;
}

/** The inner media of a card, chosen by job status. */
function cardInner(j: Job): string {
  if (j.status === "done" && j.result_key) {
    return `<img loading="lazy" src="/r/${esc(j.result_key)}" alt="before/after map">`;
  }
  if (j.status === "failed") {
    return `<div class="placeholder failed"><span>Failed</span></div>`;
  }
  // queued | running
  const msg = j.progress ?? (j.status === "running" ? "Working…" : "Queued…");
  return `<div class="placeholder"><span class="spinner"></span><span>${esc(msg)}</span></div>`;
}

/**
 * A responsive grid of maps, each linking to its job page. When `owned`, cards of any
 * status are shown (finished, in-progress, failed) each with a delete control; otherwise
 * only finished maps with a result are shown (the public / "others" galleries).
 */
function galleryGrid(jobs: Job[], heading: string, owned = false): string {
  const shown = owned ? jobs : jobs.filter((j) => j.status === "done" && j.result_key);
  const cards = shown
    .map((j) => {
      const label = cardLabel(j);
      return (
        `<div class="card">` +
        `<a href="/jobs/${esc(j.id)}" title="${esc(label)} · ${esc(j.time_before)} → ${esc(j.time_after)}">` +
        cardInner(j) +
        `<span class="caption">${esc(label)}</span></a>` +
        (owned ? deleteForm(j.id, "del", "×") : "") +
        `</div>`
      );
    })
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

export function formPage(
  email: string,
  jobs: Job[] = [],
  others: Job[] = [],
  error?: string,
): string {
  const head = `
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js"></script>`;
  return layout(
    "Create a before/after map",
    `<h1>Create a before/after map</h1>
<div class="userbar"><span class="muted">Signed in as ${esc(email)}</span><form method="post" action="/logout"><button class="linkbtn">Sign out</button></form></div>
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
  <p class="presets" id="presets">
    <span class="muted">Quick range (ending now):</span>
    <a href="#" data-preset="10y">10 years</a>
    <a href="#" data-preset="1y">1 year</a>
    <a href="#" data-preset="1mo">1 month</a>
    <a href="#" data-preset="6h">6 hours</a>
  </p>

  <label for="name">Name (optional)</label>
  <input id="name" name="name" type="text" maxlength="${NAME_MAX}"
         placeholder="e.g. Downtown Rochester" autocomplete="off">
  <p class="muted" id="namehint">We'll suggest a name for the area you draw; edit it however you like.</p>

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
    suggestName(current);
  }
  map.on(L.Draw.Event.CREATED, e => setBbox(e.layer));
  document.getElementById('output_px').addEventListener('input', updateZoomHint);

  // Reverse-geocode the bbox centroid to suggest a name — but never clobber a name
  // the user has typed themselves. Best-effort, debounced, single in-flight request.
  const nameInput = document.getElementById('name');
  let nameDirty = nameInput.value.trim() !== '';
  nameInput.addEventListener('input', () => { nameDirty = true; });
  let geocodeTimer = null, geocodeAbort = null;
  function suggestName(bbox) {
    if (nameDirty) return;
    const [left, bottom, right, top] = bbox;
    const lat = (bottom + top) / 2, lon = (left + right) / 2;
    if (geocodeTimer) clearTimeout(geocodeTimer);
    geocodeTimer = setTimeout(async () => {
      if (geocodeAbort) geocodeAbort.abort();
      geocodeAbort = new AbortController();
      const url = 'https://nominatim.openstreetmap.org/reverse?lat=' + lat +
        '&lon=' + lon + '&zoom=10&format=jsonv2';
      try {
        const r = await fetch(url, { signal: geocodeAbort.signal, headers: { accept: 'application/json' } });
        if (!r.ok) return;
        const j = await r.json();
        if (nameDirty) return; // user typed while we were fetching
        const name = j && (j.name || j.display_name);
        if (name) nameInput.value = String(name).slice(0, ${NAME_MAX});
      } catch (e) { /* best-effort: leave the field as-is */ }
    }, 500);
  }

  // Format a Date as the local value a datetime-local input expects (YYYY-MM-DDTHH:MM).
  function toLocalInput(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // Set Before/After to [now - amount·unit, now]. Exposed as window.applyRange so any
  // range can be applied from the console, e.g. applyRange(3, 'mo') or applyRange(90, 'd').
  function applyRange(amount, unit) {
    const after = new Date();
    const before = new Date(after);
    const setters = {
      y:  () => before.setFullYear(before.getFullYear() - amount),
      mo: () => before.setMonth(before.getMonth() - amount),
      w:  () => before.setDate(before.getDate() - amount * 7),
      d:  () => before.setDate(before.getDate() - amount),
      h:  () => before.setHours(before.getHours() - amount),
      m:  () => before.setMinutes(before.getMinutes() - amount),
    };
    const apply = setters[unit];
    if (!apply) throw new Error('Unknown unit: ' + unit + ' (use y, mo, w, d, h, m)');
    apply();
    document.getElementById('time_before').value = toLocalInput(before);
    document.getElementById('time_after').value = toLocalInput(after);
  }
  window.applyRange = applyRange;

  // Preset links carry a "<amount><unit>" token, e.g. "10y" or "6h".
  function applyPreset(preset) {
    const m = /^(\\d+)(y|mo|w|d|h|m)$/.exec(preset);
    if (!m) throw new Error('Bad preset: ' + preset);
    applyRange(Number(m[1]), m[2]);
  }
  document.getElementById('presets').addEventListener('click', e => {
    const a = e.target.closest('a[data-preset]');
    if (!a) return;
    e.preventDefault();
    applyPreset(a.dataset.preset);
  });
  document.getElementById('jobform').addEventListener('submit', e => {
    if (!document.getElementById('bbox').value) {
      e.preventDefault();
      alert('Please draw a rectangle on the map first.');
    }
  });
</script>
${galleryGrid(jobs, "Your maps", true)}
${galleryGrid(others, "Maps from others")}`,
    head,
  );
}

export function jobPage(job: Job, isOwner = false): string {
  const hasName = !!(job.name && job.name.trim() !== "");
  if (job.status === "done" && job.result_key) {
    return layout(
      hasName ? job.name! : "Your map is ready",
      `<h1>${hasName ? esc(job.name!) : "Your before/after map"}</h1>
<p class="muted">${esc(job.bbox)} · ${esc(job.time_before)} → ${esc(job.time_after)}</p>
<img class="result" src="/r/${esc(job.result_key)}" alt="animated before/after map">
<p><a href="/">Make another</a>${isOwner ? ` · ${deleteForm(job.id, "delete-form", "Delete this map")}` : ""}</p>`,
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

  // queued | running: poll for updates and drive an ordered checklist.
  const steps = [
    "Finding the map region",
    "Preparing map data",
    "Extracting frames",
    "Importing frames",
    "Rendering images",
    "Assembling the animation",
    "Uploading your map",
  ];
  const items = steps
    .map(
      (label, i) =>
        `<li data-step="${i}"><span class="mark"></span><span class="label">${esc(label)}</span> <span class="detail"></span></li>`,
    )
    .join("\n");
  return layout(
    hasName ? `${job.name!} — building…` : "Working on your map",
    `<h1>Building ${hasName ? esc(job.name!) : "your map"}…</h1>
<ol class="checklist" id="checklist">${items}</ol>
<p class="muted">Status: <span id="status">${esc(job.status)}</span>. This can take a while for large areas — you'll also get an email when it's ready.</p>
<script>
  // Map a free-text progress message to the furthest matching step index (-1 = none yet).
  // Keywords mirror the messages emitted by render_job.py.
  const STEP_KEYWORDS = [
    ["Finding the right map region"],
    ["Preparing map data", "Downloading map history"],
    ["Extracting frame"],
    ["Importing frame"],
    ["Rendering images"],
    ["Assembling the animation"],
    ["Uploading your map"],
  ];
  function stepIndexFor(message) {
    if (!message) return -1;
    let idx = -1;
    for (let i = 0; i < STEP_KEYWORDS.length; i++) {
      if (STEP_KEYWORDS[i].some(k => message.indexOf(k) !== -1)) idx = i;
    }
    return idx;
  }
  let lastIdx = -1;
  function renderChecklist(idx, message) {
    if (idx < lastIdx) idx = lastIdx;      // never regress
    else lastIdx = idx;
    const lis = document.querySelectorAll('#checklist li');
    lis.forEach((li, i) => {
      li.classList.remove('done', 'active', 'pending');
      const mark = li.querySelector('.mark');
      const detail = li.querySelector('.detail');
      detail.textContent = '';
      if (i < idx) { li.classList.add('done'); mark.textContent = '\\u2713'; }
      else if (i === idx) {
        li.classList.add('active');
        mark.innerHTML = '<span class="spinner"></span>';
        if (message) detail.textContent = message;
      } else { li.classList.add('pending'); mark.textContent = ''; }
    });
  }
  renderChecklist(stepIndexFor(${JSON.stringify(job.progress ?? "")}), ${JSON.stringify(job.progress ?? "")});
  async function poll() {
    try {
      const r = await fetch(location.pathname + '/status', { headers: { accept: 'application/json' } });
      const j = await r.json();
      document.getElementById('status').textContent = j.status;
      renderChecklist(stepIndexFor(j.progress), j.progress);
      if (j.status === 'done' || j.status === 'failed') { location.reload(); return; }
    } catch (e) {}
    setTimeout(poll, 3000);
  }
  setTimeout(poll, 3000);
</script>`,
  );
}
