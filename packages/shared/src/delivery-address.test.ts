import { describe, expect, it } from "vitest";
import { deliveryAreaAllowed, deliveryAreaRefusal, deliverySettingsSchema, mapsSearchUrl } from "./delivery-address";

describe("address-only delivery areas", () => {
  const areas = ["600017", "T Nagar", "Besant Nagar"];
  it("empty list = anywhere", () => {
    expect(deliveryAreaAllowed([], { pincode: "110001" })).toBe(true);
  });
  it("PIN codes match exactly; area names match the chosen area or whole words in the address", () => {
    expect(deliveryAreaAllowed(areas, { pincode: "600017" })).toBe(true);
    expect(deliveryAreaAllowed(areas, { pincode: "600018" })).toBe(false);
    expect(deliveryAreaAllowed(areas, { pincode: "600099", area: "t nagar" })).toBe(true);
    expect(deliveryAreaAllowed(areas, { pincode: "600099", address: "12 Usman Road, T. Nagar, Chennai" })).toBe(true);
    expect(deliveryAreaAllowed(areas, { pincode: "600099", address: "4 Elliot's Beach Road, Besant Nagar" })).toBe(true);
    // "Nagar" alone is not "T Nagar"; substrings inside words don't count.
    expect(deliveryAreaAllowed(areas, { pincode: "600099", address: "Anna Nagar" })).toBe(false);
    expect(deliveryAreaAllowed(["Adyar"], { address: "Kadyar Street" })).toBe(false);
  });
  it("refusal names the PIN code and the areas", () => {
    expect(deliveryAreaRefusal(areas, "600040")).toBe("Sorry, we don't deliver to PIN code 600040 — we deliver to 600017, T Nagar, Besant Nagar");
  });
  it("settings: PIN-looking entries must be 6 digits; duplicates collapse case-insensitively", () => {
    expect(deliverySettingsSchema.shape.areas.safeParse(["60001"]).success).toBe(false);
    expect(deliverySettingsSchema.shape.areas.parse(["Adyar", "adyar", "600020"])).toEqual(["adyar", "600020"]);
  });
  it("maps search link carries address, landmark and PIN", () => {
    expect(mapsSearchUrl({ address: "21 Ranganathan St", landmark: "Opp. Pothys", pincode: "600017" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=21%20Ranganathan%20St%2C%20Opp.%20Pothys%2C%20600017",
    );
  });
});
