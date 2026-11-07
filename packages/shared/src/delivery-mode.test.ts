import { describe, expect, it } from "vitest";
import {
  checkDeliveryArea,
  composeDeliveryAddress,
  deliveryAreaList,
  deliveryLocationUpdateSchema,
  findPincode,
  mapsSearchUrl,
  normalizeDeliveryLocation,
} from "./delivery-mode";

describe("delivery location settings", () => {
  it("defaults to MAP (today's behaviour); junk falls back to defaults", () => {
    expect(normalizeDeliveryLocation(undefined)).toEqual({ mode: "MAP", flatFee: 0, minOrder: 0, etaMinutes: 30, pincodes: [], areas: [] });
    expect(normalizeDeliveryLocation({ mode: "SATELLITE" }).mode).toBe("MAP");
    expect(normalizeDeliveryLocation([1, 2]).mode).toBe("MAP");
    expect(normalizeDeliveryLocation({ mode: "ADDRESS", flatFee: 4000 })).toMatchObject({ mode: "ADDRESS", flatFee: 4000, etaMinutes: 30 });
  });

  it("update: validates PIN codes, money and ETA; de-duplicates lists; unknown keys refused", () => {
    expect(deliveryLocationUpdateSchema.parse({ pincodes: ["600040", "600040", " 600017 "], areas: ["Anna Nagar", "anna nagar", "T Nagar"] })).toEqual({
      pincodes: ["600040", "600017"],
      areas: ["Anna Nagar", "T Nagar"],
    });
    for (const bad of [
      { pincodes: ["60004"] },
      { pincodes: ["060040"] },
      { pincodes: ["6000401"] },
      { pincodes: ["abcdef"] },
      { flatFee: -1 },
      { flatFee: 10.5 },
      { minOrder: "100" },
      { etaMinutes: 4 },
      { etaMinutes: 301 },
      { mode: "GPS" },
      { areas: ["A"] },
      { zones: [] },
    ]) {
      expect(deliveryLocationUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("checkDeliveryArea", () => {
  const open = { pincodes: [], areas: [] };
  const pins = { pincodes: ["600040", "600017"], areas: [] };
  const areas = { pincodes: [], areas: ["Anna Nagar", "T. Nagar"] };
  const both = { pincodes: ["600040"], areas: ["Velachery"] };

  it("no list: anywhere is fine; the PIN in the address is picked up", () => {
    expect(checkDeliveryArea(open, { address: "12 Main Road, Madurai 625001" })).toEqual({ ok: true, pincode: "625001", area: null });
  });

  it("PIN list: allowed PIN passes, other PIN refused with the list, missing PIN asked for", () => {
    expect(checkDeliveryArea(pins, { address: "5 Second Ave", pincode: "600040" })).toMatchObject({ ok: true, pincode: "600040" });
    expect(checkDeliveryArea(pins, { address: "5 Second Ave, Chennai 600017" })).toMatchObject({ ok: true, pincode: "600017" });
    const far = checkDeliveryArea(pins, { address: "5 Second Ave", pincode: "560001" });
    expect(far).toEqual({ ok: false, message: "Sorry, we don't deliver to 560001. We deliver to 600040 and 600017" });
    expect(checkDeliveryArea(pins, { address: "5 Second Ave" })).toEqual({ ok: false, message: "Enter your PIN code" });
  });

  it("area list: chosen area or an area written in the address (case / punctuation-insensitive, whole words)", () => {
    expect(checkDeliveryArea(areas, { address: "5 Second Ave", area: "anna nagar" })).toMatchObject({ ok: true, area: "Anna Nagar" });
    expect(checkDeliveryArea(areas, { address: "Flat 3, 4th St, T Nagar, Chennai" })).toMatchObject({ ok: true, area: "T. Nagar" });
    expect(checkDeliveryArea(areas, { address: "Flat 3", landmark: "Opp. Anna Nagar tower" })).toMatchObject({ ok: true, area: "Anna Nagar" });
    // "Nagar" alone or a longer word isn't a match
    expect(checkDeliveryArea(areas, { address: "Flat 3, Annanagar West" }).ok).toBe(false);
    expect(checkDeliveryArea(areas, { address: "Flat 3, Adyar", area: "Adyar" })).toEqual({ ok: false, message: "Sorry, we don't deliver there. We deliver to Anna Nagar and T. Nagar" });
  });

  it("areas and PINs together: either one lets the order through", () => {
    expect(checkDeliveryArea(both, { address: "x street", pincode: "600040" }).ok).toBe(true);
    expect(checkDeliveryArea(both, { address: "x street, Velachery" }).ok).toBe(true);
    expect(checkDeliveryArea(both, { address: "x street", pincode: "600001" }).ok).toBe(false);
    expect(checkDeliveryArea(both, { address: "x street" }).ok).toBe(false);
  });
});

describe("address helpers", () => {
  it("findPincode: 6 digits not part of a longer number (phone numbers are ignored)", () => {
    expect(findPincode("Door 4, Chennai - 600040")).toBe("600040");
    expect(findPincode("call 9876543210")).toBeNull();
    expect(findPincode("No 012345")).toBeNull();
  });

  it("composeDeliveryAddress adds area / PIN only when missing", () => {
    expect(composeDeliveryAddress({ address: "12 Main Rd", area: "Anna Nagar", pincode: "600040" })).toBe("12 Main Rd, Anna Nagar - 600040");
    expect(composeDeliveryAddress({ address: "12 Main Rd, Anna Nagar 600040", area: "anna nagar", pincode: "600040" })).toBe("12 Main Rd, Anna Nagar 600040");
    expect(composeDeliveryAddress({ address: " 12 Main Rd " })).toBe("12 Main Rd");
  });

  it("mapsSearchUrl encodes the typed address", () => {
    expect(mapsSearchUrl("12 Main Rd, Anna Nagar - 600040")).toBe("https://www.google.com/maps/search/?api=1&query=12%20Main%20Rd%2C%20Anna%20Nagar%20-%20600040");
  });

  it("deliveryAreaList shortens long lists", () => {
    expect(deliveryAreaList({ areas: [], pincodes: [] })).toBe("anywhere");
    expect(deliveryAreaList({ areas: ["A1", "B1", "C1"], pincodes: ["600001"] }, 2)).toBe("A1, B1 and 2 more");
  });
});
