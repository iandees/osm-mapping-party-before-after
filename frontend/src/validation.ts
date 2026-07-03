// Input parsing and validation for login and job submission.

// Deliberately simple, permissive-but-safe email check (real validation is that a
// login link actually arrives).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ZOOM_MIN = 2;
export const ZOOM_MAX = 18;
export const FRAMES_MIN = 2;
export const FRAMES_MAX = 24;

// Output image size (longest side, px). The user picks the size; the zoom is
// derived from their bbox. Bounding the size bounds both the final GIF and the
// intermediate render, so there is no separate pixel/OOM guard.
export const SIZE_MIN = 256;
export const SIZE_MAX = 2000;
export const SIZE_DEFAULT = 800;

// Optional human label for the map area. Trimmed and truncated, never required.
export const NAME_MAX = 120;

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

/** Approximate rendered pixel dimensions for a bbox at a Web-Mercator zoom. */
export function renderedPixelSize(
  left: number,
  bottom: number,
  right: number,
  top: number,
  zoom: number,
): { width: number; height: number } {
  const worldPx = 256 * 2 ** zoom;
  const latToY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const width = ((right - left) / 360) * worldPx;
  const height = Math.abs(latToY(bottom) - latToY(top)) * worldPx;
  return { width, height };
}

/**
 * Integer Web-Mercator zoom whose rendered image is at least `targetPx` on its
 * longer side (so downscaling to `targetPx` stays crisp), clamped to [ZOOM_MIN,
 * ZOOM_MAX]. This is the authoritative computation; the frontend mirrors it to
 * preview the zoom, but the server always recomputes it.
 */
export function suggestedZoom(
  left: number,
  bottom: number,
  right: number,
  top: number,
  targetPx: number,
): number {
  const { width, height } = renderedPixelSize(left, bottom, right, top, 0);
  const longest0 = Math.max(width, height);
  if (!(longest0 > 0)) return ZOOM_MAX;
  const z = Math.ceil(Math.log2(targetPx / longest0));
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export interface JobInput {
  bbox: string; // normalized "left,bottom,right,top"
  name: string | null; // optional label; null when empty/absent
  time_before: string; // ISO-8601 (Z)
  time_after: string;
  zoom: number; // derived from bbox + output_px
  output_px: number; // longest side of the delivered GIF
  num_frames: number;
}

/** Trim and cap an optional name; empty/whitespace/non-string → null. Never errors. */
export function parseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, NAME_MAX);
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function parseIsoUtc(s: unknown): string | null {
  if (typeof s !== "string" || s.trim() === "") return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(".000Z", "Z");
}

function parseNum(s: unknown): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string" || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate a job submission form. `maxBboxArea` is in square degrees (bounds the
 * data-extraction cost regardless of output size). Fields expected: bbox,
 * time_before, time_after, output_px, num_frames. The zoom is derived server-side.
 */
export function validateJobInput(
  form: Record<string, unknown>,
  maxBboxArea: number,
): ValidationResult<JobInput> {
  const errors: string[] = [];

  // ---- bbox ----
  let coords: [number, number, number, number] | null = null;
  const rawBbox = form.bbox;
  const parts =
    typeof rawBbox === "string" ? rawBbox.split(",").map((p) => Number(p.trim())) : [];
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    errors.push("bbox must be four comma-separated numbers: left,bottom,right,top");
  } else {
    const [left, bottom, right, top] = parts;
    if (left < -180 || right > 180 || left >= right) {
      errors.push("bbox longitude range is invalid (need -180 <= left < right <= 180)");
    }
    if (bottom < -90 || top > 90 || bottom >= top) {
      errors.push("bbox latitude range is invalid (need -90 <= bottom < top <= 90)");
    }
    if (errors.length === 0) {
      const area = (right - left) * (top - bottom);
      if (area > maxBboxArea) {
        errors.push(
          `bbox area ${area.toFixed(3)} exceeds the maximum of ${maxBboxArea} square degrees`,
        );
      }
      coords = [left, bottom, right, top];
    }
  }

  // ---- times ----
  const before = parseIsoUtc(form.time_before);
  const after = parseIsoUtc(form.time_after);
  if (!before) errors.push("time_before is not a valid date/time");
  if (!after) errors.push("time_after is not a valid date/time");
  if (before && after && Date.parse(before) >= Date.parse(after)) {
    errors.push("time_before must be earlier than time_after");
  }

  // ---- output size ----
  const size = parseNum(form.output_px);
  if (size === null || !Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX) {
    errors.push(`output_px must be an integer in [${SIZE_MIN}, ${SIZE_MAX}]`);
  }

  // ---- frames ----
  const frames = parseNum(form.num_frames);
  if (frames === null || !Number.isInteger(frames) || frames < FRAMES_MIN || frames > FRAMES_MAX) {
    errors.push(`num_frames must be an integer in [${FRAMES_MIN}, ${FRAMES_MAX}]`);
  }

  if (errors.length > 0 || !coords) return { ok: false, errors };

  const [l, b, r, t] = coords;
  return {
    ok: true,
    value: {
      bbox: [l, b, r, t].join(","),
      name: parseName(form.name),
      time_before: before!,
      time_after: after!,
      zoom: suggestedZoom(l, b, r, t, size!),
      output_px: size!,
      num_frames: frames!,
    },
  };
}
