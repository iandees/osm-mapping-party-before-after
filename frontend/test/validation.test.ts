import { describe, it, expect } from "vitest";
import { isValidEmail, validateJobInput } from "../src/validation";

const MAX_AREA = 1.0;

const valid = {
  bbox: "-0.2,51.4,0.0,51.6",
  time_before: "2020-01-01T00:00:00Z",
  time_after: "2024-01-01T00:00:00Z",
  min_zoom: "6",
  max_zoom: "12",
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
  it("accepts and normalizes a valid submission", () => {
    const res = validateJobInput(valid, MAX_AREA);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.bbox).toBe("-0.2,51.4,0,51.6");
      expect(res.value.min_zoom).toBe(6);
      expect(res.value.num_frames).toBe(2);
      expect(res.value.time_before).toBe("2020-01-01T00:00:00Z");
    }
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

  it("rejects bad zoom ranges", () => {
    expect(validateJobInput({ ...valid, min_zoom: "12", max_zoom: "6" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, max_zoom: "99" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, min_zoom: "6.5" }, MAX_AREA).ok).toBe(false);
  });

  it("rejects bad frame counts", () => {
    expect(validateJobInput({ ...valid, num_frames: "1" }, MAX_AREA).ok).toBe(false);
    expect(validateJobInput({ ...valid, num_frames: "999" }, MAX_AREA).ok).toBe(false);
  });
});
