/**
 * Notification links → app screens. The API stores WEB routes ("/delivery",
 * "/kitchen", "/attendance?tab=leaves"…); each maps to the mobile screen the
 * signed-in user can actually open (by /auth/me permissions), or null when
 * there's no sensible screen (the caller falls back to the inbox / home).
 * Pure: no React Native imports, testable from node.
 */
import { hasPermission, isDeliveryPartner, visibleTabs, type AccessProfile } from "../auth/access";

/** Expo-router hrefs the mapping can return. */
export type AppRoute =
  | "/(tabs)"
  | "/(tabs)/bill"
  | "/(tabs)/tables"
  | "/(tabs)/deliveries"
  | "/(tabs)/kot"
  | "/(tabs)/online"
  | "/(tabs)/stock"
  | "/(tabs)/reports"
  | "/delivery-board"
  | "/delivery-partners"
  | "/inventory"
  | "/customers"
  | "/attendance"
  | "/staff-attendance"
  | "/outlet-info"
  | "/notifications";

export const HOME_ROUTE: AppRoute = "/(tabs)";

/** Default web link per kind (mirrors the API's DEFAULT_LINKS) for rows without one. */
const KIND_LINKS: [prefix: string, link: string][] = [
  ["delivery", "/delivery"],
  ["order.ready", "/pos"],
  ["order.cancelled", "/bills"],
  ["payment", "/bills"],
  ["kot", "/kitchen"],
  ["table", "/tables"],
  ["reservation", "/reservations"],
  ["leave.request", "/attendance?tab=leaves"],
  ["leave", "/attendance"],
  ["attendance", "/attendance"],
  ["inventory", "/inventory"],
  ["report", "/dashboard"],
  ["crm", "/customers"],
  ["customer", "/customers"],
  ["platform", "/settings"],
  ["channel", "/pos"],
];

export const linkForKind = (kind: string | null | undefined): string | null =>
  kind ? KIND_LINKS.find(([p]) => kind === p || kind.startsWith(`${p}.`))?.[1] ?? null : null;

/** "/attendance?tab=leaves#x" → { section: "attendance", rest: [], query: { tab: "leaves" } } */
export function parseLink(link: string): { section: string; rest: string[]; query: Record<string, string> } {
  let path = link.trim();
  // Absolute web URLs (https://host/delivery) → path only.
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  const [beforeHash] = path.split("#");
  const [p, q = ""] = beforeHash.split("?");
  const parts = p.split("/").filter(Boolean);
  const query: Record<string, string> = {};
  q.split("&")
    .filter(Boolean)
    .forEach((kv) => {
      const [k, v = ""] = kv.split("=");
      try {
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        query[k] = v;
      }
    });
  // Web routes may carry an app prefix like "/app/delivery".
  if (parts[0] === "app") parts.shift();
  return { section: (parts[0] ?? "").toLowerCase(), rest: parts.slice(1), query };
}

/**
 * Mobile route for a notification, or null when the user has no matching
 * screen. `link` wins; otherwise the kind's default link is used.
 */
export function routeForNotification(n: { link?: string | null; kind?: string | null }, me: AccessProfile): AppRoute | null {
  const link = n.link || linkForKind(n.kind);
  if (!link) return null;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(me, p);
  const tabs = visibleTabs(me);
  const { section, query } = parseLink(link);
  // QR / online orders to accept (kind "channel.*"): the Online tab has the queue and the board.
  if (n.kind?.startsWith("channel") && tabs.includes("online")) return "/(tabs)/online";

  switch (section) {
    case "delivery":
    case "deliveries":
      if (isDeliveryPartner(me) || (can("delivery:own") && tabs.includes("deliveries"))) return "/(tabs)/deliveries";
      if (can("delivery:manage")) return "/delivery-board";
      return null;
    case "delivery-partners":
    case "partners":
      return can("delivery:manage") ? "/delivery-partners" : null;
    case "kitchen":
    case "kot":
    case "kds":
      return can("kot:view") ? "/(tabs)/kot" : null;
    case "tables":
    case "floor":
    case "reservations":
      // No separate reservations screen on mobile: bookings show on the floor.
      return can("table:serve") && tabs.includes("tables") ? "/(tabs)/tables" : null;
    case "pos":
    case "billing":
    case "bill":
      return can("order:create") ? "/(tabs)/bill" : null;
    case "attendance":
    case "leaves":
      if ((query.tab === "leaves" || section === "leaves" || query.tab === "register") && can("attendance:manage")) return "/staff-attendance";
      if (can("attendance:self") || can("attendance:manage")) return "/attendance";
      return null;
    case "staff-attendance":
      return can("attendance:manage") ? "/staff-attendance" : can("attendance:self") ? "/attendance" : null;
    case "inventory":
    case "stock":
    case "purchases":
      if (tabs.includes("stock")) return "/(tabs)/stock";
      return can("inventory:view") ? "/inventory" : null;
    case "bills":
    case "orders":
    case "dashboard":
    case "reports":
      // The app has no bill list: reports for managers, the POS for cashiers.
      if (can("report:view")) return "/(tabs)/reports";
      if (section !== "dashboard" && can("order:create")) return "/(tabs)/bill";
      return section === "dashboard" ? HOME_ROUTE : null;
    case "customers":
    case "crm":
      return can("customer:view") ? "/customers" : null;
    case "settings":
    case "outlet":
      return can("settings:view") ? "/outlet-info" : null;
    case "notifications":
      return "/notifications";
    case "":
      return HOME_ROUTE;
    default:
      return null;
  }
}

// ---------- Urgency (sound + Android channel) ----------
export const ANDROID_CHANNEL_URGENT = "urgent";
/** Normal channel keeps the id "default", which pushes without a channelId land in. */
export const ANDROID_CHANNEL_NORMAL = "default";

const URGENT_PREFIXES = ["kot.new", "order.ready", "delivery", "table.attention", "payment.received", "channel.order"];

/** Kitchen tickets, ready orders, deliveries, tables needing attention and payments ring; the rest stay quiet. */
export const isUrgentKind = (kind: string | null | undefined): boolean =>
  !!kind && URGENT_PREFIXES.some((p) => kind === p || kind.startsWith(`${p}.`) || (p === "delivery" && kind.startsWith("delivery")));

export const channelForKind = (kind: string | null | undefined) => (isUrgentKind(kind) ? ANDROID_CHANNEL_URGENT : ANDROID_CHANNEL_NORMAL);
