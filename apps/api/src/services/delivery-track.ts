/**
 * Gap 3 (P2, approved): delivery-partner location while on a run, incl. the app's background task.
 * Design: docs/qa/known-gaps.md §3.
 *
 * Privacy: points are accepted only from a partner who is clocked in at the outlet; background points only when the
 * outlet switched background tracking on and the partner is on a run (pickup → back at the outlet). No location
 * history is stored: the server keeps the latest point (in memory for the live map + User.lastLat/lastLng for
 * dispatch), and clears both when the partner clocks out.
 */
import { prisma } from "../db";

/** Latest point per partner on an active delivery (live map). In memory only. */
export const liveLocations = new Map<string, { lat: number; lng: number; at: string; deliveryId: string; outletId: string }>();

/** Server-side throttle: at most one accepted point per partner per this many ms (the app sends every 30 s). */
export const MIN_POINT_GAP_MS = 10_000;
/** Offline-batched points older than this are of no use for live tracking and are dropped. */
export const MAX_POINT_AGE_MS = 30 * 60_000;
/** Phone clocks drift a little; anything further in the future is rejected. */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** A fix this vague says nothing about where the partner is. */
export const MAX_POINT_ACCURACY_M = 1_000;
/** ≈ 180 km/h between two fixes: a GPS jump (or a spoofed point), not a scooter. */
export const MAX_SPEED_MPS = 50;

/** Last accepted point per partner (throttle + speed check across batches). */
const lastAccepted = new Map<string, { lat: number; lng: number; t: number }>();

export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy?: number;
  at: string;
}

const R = 6_371_000;
function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Validate and thin a batch: oldest first; drop future / stale / vague points, points closer than MIN_POINT_GAP_MS
 * to the previous accepted one and impossible jumps. Pure apart from the per-partner memory (`prev`).
 */
export function thinPoints(points: TrackPoint[], prev: { lat: number; lng: number; t: number } | undefined, now = Date.now()) {
  const accepted: (TrackPoint & { t: number })[] = [];
  const reasons: Record<string, number> = {};
  const drop = (why: string) => void (reasons[why] = (reasons[why] ?? 0) + 1);
  let last = prev;
  const sorted = points.map((p) => ({ ...p, t: Date.parse(p.at) })).sort((a, b) => a.t - b.t);
  for (const p of sorted) {
    if (!Number.isFinite(p.t) || p.t > now + MAX_CLOCK_SKEW_MS) drop("future");
    else if (p.t < now - MAX_POINT_AGE_MS) drop("stale");
    else if (p.accuracy != null && p.accuracy > MAX_POINT_ACCURACY_M) drop("inaccurate");
    else if (last && p.t - last.t < MIN_POINT_GAP_MS) drop("throttled");
    else if (last && meters(last, p) / Math.max(1, (p.t - last.t) / 1000) > MAX_SPEED_MPS) drop("jump");
    else {
      accepted.push(p);
      last = { lat: p.lat, lng: p.lng, t: p.t };
    }
  }
  return { accepted, dropped: points.length - accepted.length, reasons };
}

export const lastAcceptedPoint = (agentId: string) => lastAccepted.get(agentId);
export function rememberAccepted(agentId: string, p: { lat: number; lng: number; t: number }) {
  lastAccepted.set(agentId, { lat: p.lat, lng: p.lng, t: p.t });
}

/** Off duty: forget where the partner is (memory + database). Called at clock-out. */
export async function forgetPartnerLocation(agentId: string) {
  liveLocations.delete(agentId);
  lastAccepted.delete(agentId);
  await prisma.user.update({ where: { id: agentId }, data: { lastLat: null, lastLng: null, lastLocationAt: null } });
}

/** Test hook. */
export function resetTracking() {
  liveLocations.clear();
  lastAccepted.clear();
}
