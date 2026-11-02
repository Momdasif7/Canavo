import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { distanceMeters } from "./geo";

/** Independent oracle: spherical law of cosines (different formula from haversine). */
function lawOfCosines(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const c = Math.sin(r(a.latitude)) * Math.sin(r(b.latitude)) + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.cos(r(b.longitude - a.longitude));
  return 6371000 * Math.acos(Math.min(1, Math.max(-1, c)));
}

describe("geofence distance (UT-GEO)", () => {
  it("UT-GEO-001 Chennai Central → Bengaluru City ≈ 290 km; same point = 0", () => {
    const chennai = { latitude: 13.0827, longitude: 80.2707 };
    const blr = { latitude: 12.9716, longitude: 77.5946 };
    expect(distanceMeters(chennai, blr) / 1000).toBeCloseTo(290.2, 0);
    expect(distanceMeters(chennai, chennai)).toBe(0);
  });

  it("UT-GEO-002 geofence-scale distances: 150 m north and 150 m east of an outlet", () => {
    const o = { latitude: 13.0, longitude: 80.25 };
    const north = { latitude: 13.0 + 150 / 111_195, longitude: 80.25 };
    const east = { latitude: 13.0, longitude: 80.25 + 150 / (111_195 * Math.cos((13 * Math.PI) / 180)) };
    expect(distanceMeters(o, north)).toBeCloseTo(150, 0);
    expect(distanceMeters(o, east)).toBeCloseTo(150, 0);
  });

  it("PBT-GEO-001 matches an independent formula, is symmetric and non-negative", () => {
    const pt = fc.record({ latitude: fc.double({ min: 6, max: 37, noNaN: true }), longitude: fc.double({ min: 68, max: 97, noNaN: true }) });
    fc.assert(
      fc.property(pt, pt, (a, b) => {
        const d = distanceMeters(a, b);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(Math.abs(d - distanceMeters(b, a))).toBeLessThan(1e-6);
        expect(Math.abs(d - lawOfCosines(a, b))).toBeLessThan(Math.max(1, d * 1e-6));
      }),
    );
  });
});
