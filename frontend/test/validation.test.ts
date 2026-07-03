import { describe, it, expect } from "vitest";
import { isValidEmail, NAME_MAX, suggestedZoom, validateJobInput } from "../src/validation";

const MAX_AREA = 1.0;

const valid = {
  bbox: "-0.2,51.4,0.0,51.6",
  time_before: "2020-01-01T00:00:00Z",
  time_after: "2024-01-01T00:00:00Z",
  output_px: "800",
  num_frames: "2",
};

describe("isValidEmail", () => {
  it("accepts sane addresses", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
  });
  it("rejects junk", () => {
    for (const bad of ["", "no-at", "a@b", "a b@c.com", 42, null, undefined]) {
      expect(isValidEmail(bad as unknown)).toBe(false);
    }
  });
});

describe("validateJobInput", () => {
  it("accepts and normalizes a valid submission, deriving zoom", () => {
    const res = validateJobInput(valid, MAX_AREA);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.bbox).toBe("-0.2,51.4,0,51.6");
      expect(res.value.output_px).toBe(800);
      expect(res.value.zoom).toBe(suggestedZoom(-0.2, 51.4, 0.0, 51.6, 800));
      expect(res.value.num_frames).toBe(2);
      expect(res.value.time_before).toBe("2020-01-01T00:00:00Z");
    }
  });

  it("treats name as optional: trims, caps, and nulls empties", () => {
    const absent = validateJobInput(valid, MAX_AREA);
    expect(absent.ok && absent.value.name).toBeNull();

    const blank = validateJobInput({ ...valid, name: "   " }, MAX_AREA);
    expect(blank.ok && blank.value.name).toBeNull();

    const named = validateJobInput({ ...valid, name: "  Downtown Rochester  " }, MAX_AREA);
    expect(named.ok && named.value.name).toBe("Downtown Rochester");

    const long = validateJobInput({ ...valid, name: "x".repeat(NAME_MAX + 50) }, MAX_AREA);
    expect(long.ok && long.value.name?.length).toBe(NAME_MAX);
  });

  it("rejects an oversized bbox", () => {
    const res = validateJobInput({ ...valid, bbox: "-10,0,10,10" }, MAX_AREA);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toMatch(/area/);
  });

  it("rejects malformed bbox", () => {
    expect(validateJobInput({ ...valid, bbox: "1,2,3" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, bbox: "a,b,c,d" }, MAX_AREA).ok).toBe(false);
  });

  it("rejects inverted bbox", () => {
    const res = validateJobInput({ ...valid, bbox: "0,51,-1,52" }, MAX_AREA);
    expect(res.ok).toBe(false);
  });

  it("rejects reversed or missing dates", () => {
    expect(
      validateJobInput({ ...valid, time_before: "2024-01-01T00:00:00Z", time_after: "2020-01-01T00:00:00Z" }, MAX_AREA).ok,
    ).toBe(false);
    expect(validateJobInput({ ...valid, time_after: "" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, time_before: "not-a-date" }, MAX_AREA).ok).toBe(false);
  });

  it("rejects bad output sizes", () => {
    expect(validateJobInput({ ...valid, output_px: "100" }, MAX_AREA).ok).toBe(false); // < SIZE_MIN
    expect(validateJobInput({ ...valid, output_px: "5000" }, MAX_AREA).ok).toBe(false); // > SIZE_MAX
    expect(validateJobInput({ ...valid, output_px: "800.5" }, MAX_AREA).ok).toBe(false);
  });

  it("rejects bad frame counts", () => {
    expect(validateJobInput({ ...valid, num_frames: "1" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, num_frames: "999" }, MAX_AREA).ok).toBe(false);
  });

  it("accepts the maximum frame count and rejects one over", () => {
    expect(validateJobInput({ ...valid, num_frames: "120" }, MAX_AREA).ok).toBe(true);
    expect(validateJobInput({ ...valid, num_frames: "121" }, MAX_AREA).ok).toBe(false);
  });
});

describe("suggestedZoom", () => {
  it("increases with target size and decreases with area", () => {
    const small = suggestedZoom(-0.2, 51.4, 0.0, 51.6, 800);
    const bigger = suggestedZoom(-0.2, 51.4, 0.0, 51.6, 1600);
    expect(bigger).toBeGreaterThanOrEqual(small);
    const wideArea = suggestedZoom(-2, 50, 2, 54, 800);
    expect(wideArea).toBeLessThan(small);
  });

  it("clamps to the allowed zoom range", () => {
    const z = suggestedZoom(-0.0001, 51.5, 0.0001, 51.5001, 2000);
    expect(z).toBeLessThanOrEqual(18);
    expect(z).toBeGreaterThanOrEqual(2);
  });
});
