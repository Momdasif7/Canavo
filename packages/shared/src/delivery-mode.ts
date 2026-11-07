import { z } from "zod";

/**
 * How an outlet finds a delivery address (per outlet, stored in Setting `delivery.location`).
 * - MAP: the customer / cashier puts a pin on the map; zones by distance set the fee.
 * - ADDRESS: no map. The customer types an address + landmark (+ PIN code); one flat fee,
 *   optionally only for a list of areas / PIN codes.
 */
export const DELIVERY_LOCATION_MODES = ["MAP", "ADDRESS"] as const;
export type DeliveryLocationMode = (typeof DELIVERY_LOCATION_MODES)[number];

/** Setting key (scope = outlet id). */
export const DELIVERY_LOCATION_SETTING = "delivery.location";

/** Indian PIN code: 6 digits, never starting with 0. */
export const PINCODE_RE = /^[1-9]\d{5}$/;
export const pincodeSchema = z.string().trim().regex(PINCODE_RE, "Enter a 6-digit PIN code");

const areaName = z.string().trim().min(2, "Area names need at least 2 letters").max(60);

/** Stored value; anything missing or invalid falls back to these defaults (MAP = today's behaviour). */
export const deliveryLocationSettingsSchema = z.object({
  mode: z.enum(DELIVERY_LOCATION_MODES).default("MAP"),
  /** ADDRESS mode: flat delivery fee, paise */
  flatFee: z.number().int().nonnegative().max(10_000_000).default(0),
  /** ADDRESS mode: minimum order (item total) for delivery, paise; 0 = none */
  minOrder: z.number().int().nonnegative().max(10_000_000).default(0),
  /** ADDRESS mode: promised delivery time */
  etaMinutes: z.number().int().min(5).max(300).default(30),
  /** ADDRESS mode: only these PIN codes (empty = any) */
  pincodes: z.array(pincodeSchema).max(200).default([]),
  /** ADDRESS mode: only these areas (empty = any) */
  areas: z.array(areaName).max(100).default([]),
});
export type DeliveryLocationSettings = z.infer<typeof deliveryLocationSettingsSchema>;

/** PUT /delivery/settings: any subset; lists are de-duplicated. */
export const deliveryLocationUpdateSchema = deliveryLocationSettingsSchema
  .partial()
  .strict()
  .transform((s) => ({
    ...s,
    ...(s.pincodes && { pincodes: [...new Set(s.pincodes)] }),
    ...(s.areas && { areas: dedupeAreas(s.areas) }),
  }));
export type DeliveryLocationUpdate = z.infer<typeof deliveryLocationUpdateSchema>;

function dedupeAreas(areas: string[]) {
  const seen = new Set<string>();
  return areas.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Stored JSON → valid settings (defaults for anything missing / invalid). */
export function normalizeDeliveryLocation(raw: unknown): DeliveryLocationSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const parsed = deliveryLocationSettingsSchema.safeParse(obj);
  return parsed.success ? parsed.data : deliveryLocationSettingsSchema.parse({});
}

/** A typed delivery address (ADDRESS mode). */
export interface TypedAddress {
  address: string;
  landmark?: string | null;
  area?: string | null;
  pincode?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** First PIN code written in a text (e.g. "… Anna Nagar, Chennai 600040"). */
export function findPincode(text: string): string | null {
  return text.match(/(?<!\d)[1-9]\d{5}(?!\d)/)?.[0] ?? null;
}

export type AreaCheck = { ok: true; pincode: string | null; area: string | null } | { ok: false; message: string };

/**
 * Is a typed address inside the outlet's allowed areas / PIN codes?
 * No lists = anywhere. Otherwise the PIN code (given, or found in the address) must be on the
 * PIN list, or the chosen area / an area name written in the address must be on the area list.
 */
export function checkDeliveryArea(s: Pick<DeliveryLocationSettings, "pincodes" | "areas">, a: TypedAddress): AreaCheck {
  const pincode = a.pincode?.trim() || findPincode(`${a.address} ${a.landmark ?? ""}`);
  const chosen = a.area?.trim() ? (s.areas.find((x) => x.toLowerCase() === a.area!.trim().toLowerCase()) ?? null) : null;
  if (!s.pincodes.length && !s.areas.length) return { ok: true, pincode: pincode || null, area: a.area?.trim() || null };
  if (pincode && s.pincodes.includes(pincode)) return { ok: true, pincode, area: chosen };
  if (chosen) return { ok: true, pincode: pincode || null, area: chosen };
  const text = ` ${norm(`${a.address} ${a.landmark ?? ""}`)} `;
  const written = s.areas.find((x) => norm(x) && text.includes(` ${norm(x)} `));
  if (written) return { ok: true, pincode: pincode || null, area: written };
  if (!pincode && s.pincodes.length && !s.areas.length) return { ok: false, message: "Enter your PIN code" };
  return { ok: false, message: `Sorry, we don't deliver ${pincode ? `to ${pincode}` : "there"}. We deliver to ${deliveryAreaList(s)}` };
}

/** "Anna Nagar, T Nagar, 600040 and 600017" (shortened when long). */
export function deliveryAreaList(s: Pick<DeliveryLocationSettings, "pincodes" | "areas">, max = 8): string {
  const all = [...s.areas, ...s.pincodes];
  if (!all.length) return "anywhere";
  const shown = all.slice(0, max);
  const rest = all.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** The address as stored on the delivery: typed address, then the area and PIN code when not already in it. */
export function composeDeliveryAddress(a: TypedAddress): string {
  let out = a.address.trim();
  const area = a.area?.trim();
  if (area && !norm(out).includes(norm(area))) out += `, ${area}`;
  const pin = a.pincode?.trim();
  if (pin && !out.includes(pin)) out += ` - ${pin}`;
  return out.slice(0, 500);
}

/** Google Maps search link for a typed address (what delivery staff open without a map pin). */
export function mapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
}
