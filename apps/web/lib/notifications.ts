/**
 * Notification centre helpers: kind families, urgency, per-device alert
 * preferences (localStorage), a Web Audio beep and relative time / grouping.
 */

export type KindFamily = "orders" | "kitchen" | "delivery" | "tables" | "attendance" | "inventory" | "reports" | "customers" | "other";

export const FAMILY_LABELS: Record<KindFamily, string> = {
  orders: "Orders & payments",
  kitchen: "Kitchen",
  delivery: "Delivery",
  tables: "Tables & reservations",
  attendance: "Attendance & leave",
  inventory: "Inventory",
  reports: "Reports",
  customers: "Customers",
  other: "Other",
};

export function kindFamily(kind: string | null | undefined): KindFamily {
  const k = kind ?? "";
  if (k.startsWith("kot")) return "kitchen";
  if (k.startsWith("order") || k.startsWith("payment") || k.startsWith("bill")) return "orders";
  if (k.startsWith("delivery")) return "delivery";
  if (k.startsWith("table") || k.startsWith("reservation")) return "tables";
  if (k.startsWith("attendance") || k.startsWith("leave")) return "attendance";
  if (k.startsWith("inventory")) return "inventory";
  if (k.startsWith("report")) return "reports";
  if (k.startsWith("crm") || k.startsWith("customer") || k.startsWith("offer") || k.startsWith("coupon")) return "customers";
  return "other";
}

/** Kinds that need someone to act now: they beep and are highlighted. */
export function isUrgent(n: { kind: string | null | undefined; title?: string }): boolean {
  const k = n.kind ?? "";
  if (["kot.new", "order.ready", "delivery.ready", "delivery.late", "table.attention", "payment.received"].includes(k)) return true;
  // The generic "delivery" kind covers assignments, problems, COD, handovers… only some are urgent.
  if (k === "delivery") return /assigned|problem/i.test(n.title ?? "");
  return false;
}

/** Highlighted in the list (urgent kinds plus things that went wrong). */
export function isImportant(n: { kind: string | null | undefined; title?: string }): boolean {
  if (isUrgent(n)) return true;
  const k = n.kind ?? "";
  return ["kot.cancelled", "order.cancelled", "delivery.unassigned", "reservation.noshow", "inventory.low", "attendance.not_clocked_in"].includes(k) || /cancel/i.test(k);
}

// ---------- Per-device preferences ----------

const SOUND_KEY = "canavo.notif.sound";
const DESKTOP_KEY = "canavo.notif.desktop";
const BANNER_KEY = "canavo.notif.bannerDismissed";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — preference lasts for this page only */
  }
}

export const getSoundPref = () => read(SOUND_KEY) !== "0";
export const setSoundPref = (on: boolean) => write(SOUND_KEY, on ? "1" : "0");
export const getDesktopPref = () => read(DESKTOP_KEY) === "1";
export const setDesktopPref = (on: boolean) => write(DESKTOP_KEY, on ? "1" : "0");
export const getBannerDismissed = () => read(BANNER_KEY) === "1";
export const setBannerDismissed = () => write(BANNER_KEY, "1");

export type DesktopPermission = NotificationPermission | "unsupported";
export const desktopSupported = () => typeof window !== "undefined" && "Notification" in window;
export const desktopPermission = (): DesktopPermission => (desktopSupported() ? window.Notification.permission : "unsupported");

/**
 * Cross-tab "only one of us" claim: the first tab to claim a key wins for a few
 * seconds (so a hidden-tab beep / desktop alert isn't repeated by every tab).
 */
export function claimOnce(slot: "sound" | "desktop", key: string): boolean {
  const k = `canavo.notif.claim.${slot}`;
  const now = Date.now();
  try {
    const raw = localStorage.getItem(k);
    if (raw) {
      const [prev, at] = raw.split("|");
      if (prev === key && now - Number(at) < 10_000) return false;
    }
    localStorage.setItem(k, `${key}|${now}`);
  } catch {
    /* no storage — every tab decides for itself */
  }
  return true;
}

// ---------- Sound ----------

let audioCtx: AudioContext | null = null;

function getAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** Browsers start audio suspended until a user gesture: call from a click / key handler. */
export function unlockAudio() {
  const ctx = getAudio();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

export const audioUnlocked = () => audioCtx?.state === "running";

/** Short two-tone chime (~0.35 s). Silently does nothing if audio is locked. */
export function playBeep() {
  const ctx = getAudio();
  if (!ctx || ctx.state !== "running") return;
  const start = ctx.currentTime + 0.01;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = start + i * 0.16;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
}

// ---------- Time ----------

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export type DayGroup = "Today" | "Yesterday" | "Earlier";

export function dayGroup(iso: string, now = new Date()): DayGroup {
  const d = new Date(iso);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return "Today";
  if (d.getTime() >= startToday - 86_400_000) return "Yesterday";
  return "Earlier";
}

export function groupByDay<T extends { createdAt: string }>(items: T[]): { label: DayGroup; items: T[] }[] {
  const out: { label: DayGroup; items: T[] }[] = [];
  const now = new Date();
  for (const it of items) {
    const label = dayGroup(it.createdAt, now);
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

/** Only follow in-app routes (never an absolute / protocol URL from data). */
export const safeLink = (link: string | null | undefined) => (link && link.startsWith("/") && !link.startsWith("//") ? link : null);
