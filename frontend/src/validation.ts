// Input parsing and validation for login and job submission.

// Deliberately simple, permissive-but-safe email check (real validation is that a
// login link actually arrives).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ZOOM_MIN = 0;
export const ZOOM_MAX = 19;
export const FRAMES_MIN = 2;
export const FRAMES_MAX = 12;

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

export interface JobInput {
  bbox: string; // normalized "left,bottom,right,top"
  time_before: string; // ISO-8601 (Z)
  time_after: string;
  min_zoom: number;
  max_zoom: number;
  num_frames: number;
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
 * Validate a job submission form. `maxBboxArea` is in square degrees.
 * Fields expected: bbox, time_before, time_after, min_zoom, max_zoom, num_frames.
 */
export function validateJobInput(
  form: Record<string, unknown>,
  maxBboxArea: number,
): ValidationResult<JobInput> {
  const errors: string[] = [];

  // ---- bbox ----
  let normalizedBbox = "";
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
      normalizedBbox = [left, bottom, right, top].join(",");
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

  // ---- zoom ----
  const minZoom = parseNum(form.min_zoom);
  const maxZoom = parseNum(form.max_zoom);
  if (minZoom === null || !Number.isInteger(minZoom) || minZoom < ZOOM_MIN || minZoom > ZOOM_MAX) {
    errors.push(`min_zoom must be an integer in [${ZOOM_MIN}, ${ZOOM_MAX}]`);
  }
  if (maxZoom === null || !Number.isInteger(maxZoom) || maxZoom < ZOOM_MIN || maxZoom > ZOOM_MAX) {
    errors.push(`max_zoom must be an integer in [${ZOOM_MIN}, ${ZOOM_MAX}]`);
  }
  if (minZoom !== null && maxZoom !== null && minZoom > maxZoom) {
    errors.push("min_zoom must be <= max_zoom");
  }

  // ---- frames ----
  const frames = parseNum(form.num_frames);
  if (frames === null || !Number.isInteger(frames) || frames < FRAMES_MIN || frames > FRAMES_MAX) {
    errors.push(`num_frames must be an integer in [${FRAMES_MIN}, ${FRAMES_MAX}]`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      bbox: normalizedBbox,
      time_before: before!,
      time_after: after!,
      min_zoom: minZoom!,
      max_zoom: maxZoom!,
      num_frames: frames!,
    },
  };
}
