import { z } from "zod";

/**
 * Product request (rqb): an outlet takes delivery addresses either with a map pin (zones and
 * distance fees — the original behaviour) or as a typed address only (address lines, landmark and
 * PIN code; a flat fee, an optional minimum order and an optional list of allowed areas).
 */
export const DELIVERY_ADDRESS_MODES = ["MAP", "ADDRESS"] as const;
export type DeliveryAddressMode = (typeof DELIVERY_ADDRESS_MODES)[number];

/** Indian PIN code: 6 digits, not starting with 0. */
export const PINCODE_RE = /^[1-9]\d{5}$/;
export const pincodeSchema = z.string().trim().regex(PINCODE_RE, "Enter a 6-digit PIN code");

const areaEntry = z
  .string()
  .trim()
  .min(2, "Area names need at least 2 letters")
  .max(60)
  .refine((s) => !/^\d+$/.test(s) || PINCODE_RE.test(s), "PIN codes are 6 digits");

/** Outlet delivery settings (Settings → Delivery). Money in paise. */
export const deliverySettingsSchema = z.object({
  addressMode: z.enum(DELIVERY_ADDRESS_MODES),
  /** ADDRESS mode: flat fee per delivery order */
  flatFee: z.number().int().min(0).max(1_000_000, "Delivery fee can be at most ₹10,000"),
  /** ADDRESS mode: minimum item total (0 = none) */
  minOrder: z.number().int().min(0).max(10_000_000),
  /** ADDRESS mode: PIN codes and / or area names we deliver to (empty = anywhere) */
  areas: z
    .array(areaEntry)
    .max(200, "At most 200 areas")
    .transform((a) => [...new Map(a.map((x) => [x.toLowerCase(), x])).values()]),
  /** ADDRESS mode: promised delivery time */
  etaMinutes: z.number().int().min(5).max(300),
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export const deliverySettingsUpdateSchema = deliverySettingsSchema.partial();
export type DeliverySettingsUpdate = z.infer<typeof deliverySettingsUpdateSchema>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Is a typed address inside the outlet's allowed areas? Empty list = anywhere. A PIN code entry
 * matches the PIN code exactly; an area name matches the chosen area or appears (as whole words) in
 * the typed address.
 */
export function deliveryAreaAllowed(areas: readonly string[], to: { pincode?: string | null; area?: string | null; address?: string | null }): boolean {
  if (!areas.length) return true;
  const pin = to.pincode?.trim() ?? "";
  const area = norm(to.area ?? "");
  const address = ` ${norm(to.address ?? "")} `;
  return areas.some((entry) => {
    if (PINCODE_RE.test(entry)) return entry === pin;
    const n = norm(entry);
    return n.length > 0 && (n === area || address.includes(` ${n} `));
  });
}

/** Customer-facing refusal for an address outside the allowed areas. */
export function deliveryAreaRefusal(areas: readonly string[], pincode?: string | null): string {
  const list = areas.slice(0, 8).join(", ") + (areas.length > 8 ? ` and ${areas.length - 8} more` : "");
  return `Sorry, we don't deliver to ${pincode ? `PIN code ${pincode}` : "this address"} — we deliver to ${list}`;
}

/** Google Maps search for a typed address (delivery staff: "Open in Google Maps"). */
export function mapsSearchUrl(parts: { address: string; landmark?: string | null; pincode?: string | null }): string {
  const q = [parts.address, parts.landmark, parts.pincode].filter((x) => x && x.trim()).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
