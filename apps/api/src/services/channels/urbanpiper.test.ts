import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookError } from "./adapter";
import { startFakeHub, type FakeHub } from "./fake-hub";
import { UP_WEBHOOK_SECRET_HEADER, UrbanPiperAdapter, normalizeUrbanPiperEvent, urbanPiperCatalogue } from "./urbanpiper";

/** UrbanPiper-style adapter against a local fake server (no real credentials; shapes to verify at onboarding). */
let up: FakeHub;
let adapter: UrbanPiperAdapter;
const SECRET = "up-secret-123456";

beforeAll(async () => {
  up = await startFakeHub({ authorization: "apikey biz_user:up-key-1" });
  adapter = new UrbanPiperAdapter({ baseUrl: `${up.baseUrl}/`, storeId: "loc-7", apiKey: "biz_user:up-key-1", webhookSecret: SECRET });
});
afterAll(() => up.close());

const orderPlaced = {
  order: {
    details: {
      id: 501234,
      channel: "zomato",
      order_type: "delivery",
      created: 1767225600000,
      instructions: "Ring the bell",
      order_total: 315.5,
      order_subtotal: 280,
      total_taxes: 14,
      discount: 0,
      charges: [{ title: "Packaging charge", value: 20 }, { title: "Delivery charge", value: 1.5 }],
      ext_platforms: [{ name: "zomato", id: "Z-998877", delivery_type: "self", kind: "food_delivery" }],
    },
    items: [
      { merchant_id: "ITEM-1", title: "Paneer Roll", quantity: 2, price: 120, instructions: "No onion", options_to_add: [{ merchant_id: "V-var1", title: "Large", price: 20 }, { merchant_id: "A-add1", title: "Cheese", price: 20 }] },
    ],
    payment: [{ option: "cash", amount: 315.5 }],
    store: { merchant_ref_id: "loc-7" },
  },
  customer: { name: "Ravi Kumar", phone: "+919840012345", address: { line_1: "12 MG Road", line_2: "Flat 3", landmark: "Near park", city: "Chennai", pin: "600001", latitude: "13.08", longitude: 80.27 } },
};

describe("UrbanPiperAdapter webhooks", () => {
  it("maps order_placed to NEW_ORDER (rupees → paise, options → size / add-ons, self-delivery, COD)", () => {
    const e = normalizeUrbanPiperEvent(orderPlaced);
    expect(e).toMatchObject({
      type: "NEW_ORDER",
      channelOrderId: "501234",
      displayId: "Z-998877",
      sourceChannel: "ZOMATO",
      placedAt: new Date(1767225600000).toISOString(),
      customer: { name: "Ravi Kumar", phone: "+919840012345" },
      items: [{ externalId: "ITEM-1", quantity: 2, unitPrice: 12000, variantExternalId: "var1", addonExternalIds: ["add1"], notes: "No onion" }],
      totals: { total: 31550, subtotal: 28000, tax: 1400, discount: 0 },
      charges: { packaging: 2000, delivery: 150 },
      payment: { prepaid: false, mode: "cash" },
      fulfilment: "SELF",
      delivery: { address: "12 MG Road, Flat 3, Chennai, 600001", landmark: "Near park", latitude: 13.08, longitude: 80.27 },
      notes: "Ring the bell",
    });
  });

  it("maps rider and status webhooks; echoes of our own statuses are ignored", () => {
    expect(
      normalizeUrbanPiperEvent({
        order_id: 501234,
        additional_info: { external_channel: { name: "swiggy", order_id: "S-1" } },
        delivery_info: { current_state: "at-store", delivery_person_details: { name: "Arun", phone: "9000000001" }, otp: 4321, eta: 6 },
      }),
    ).toEqual({ type: "RIDER_STATUS", channelOrderId: "501234", sourceChannel: "SWIGGY", status: "AT_STORE", rider: { name: "Arun", phone: "9000000001", pickupCode: "4321", eta: "6 min" } });
    expect(normalizeUrbanPiperEvent({ order_id: "501234", new_state: "Cancelled", message: "Customer cancelled" })).toMatchObject({ type: "ORDER_CANCELLED", channelOrderId: "501234", reason: "Customer cancelled" });
    expect(normalizeUrbanPiperEvent({ order_id: "501234", new_state: "Food Ready" })).toMatchObject({ type: "IGNORED" });
    expect(() => normalizeUrbanPiperEvent({ hello: 1 })).toThrow(WebhookError);
  });

  it("checks the shared secret header", () => {
    const raw = Buffer.from(JSON.stringify(orderPlaced));
    expect(adapter.parseWebhook(raw, { [UP_WEBHOOK_SECRET_HEADER]: SECRET })).toMatchObject({ type: "NEW_ORDER" });
    expect(() => adapter.parseWebhook(raw, { [UP_WEBHOOK_SECRET_HEADER]: "nope" })).toThrow(/secret/);
    expect(() => adapter.parseWebhook(raw, {})).toThrow(WebhookError);
  });
});

describe("UrbanPiperAdapter outbound calls", () => {
  it("status update, store toggle, catalogue push and item stock toggle hit the mapped endpoints", async () => {
    up.reset();
    await adapter.updateStatus({ channelOrderId: "501234", sourceChannel: "ZOMATO" }, "FOOD_READY");
    await adapter.updateStatus({ channelOrderId: "501234", sourceChannel: "ZOMATO" }, "DISPATCHED", "Handed to Arun");
    await adapter.setStoreOpen(false);
    await adapter.setItemsAvailable(["ITEM-1"], false);
    await adapter.pushMenu([
      {
        externalId: "ITEM-1",
        name: "Paneer Roll",
        description: "",
        category: "Rolls & Wraps",
        price: 12000,
        foodType: "VEG",
        available: true,
        variants: [{ externalId: "var1", name: "Large", price: 14000, available: true }],
        addons: [{ externalId: "add1", name: "Cheese", price: 2000 }],
      },
    ]);
    expect(up.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /external/api/v1/orders/501234/status/",
      "PUT /external/api/v1/orders/501234/status/",
      "POST /hub/api/v1/location/",
      "POST /hub/api/v1/items/",
      "POST /external/api/v1/inventory/locations/loc-7/",
    ]);
    expect(up.calls.every((c) => c.authorization === "apikey biz_user:up-key-1")).toBe(true);
    expect(up.calls[0].body).toEqual({ new_status: "Food Ready", message: "Food Ready" });
    expect(up.calls[1].body).toEqual({ new_status: "Dispatched", message: "Handed to Arun" });
    expect(up.calls[2].body).toEqual({ location_ref_id: "loc-7", platforms: ["zomato", "swiggy"], action: "disable" });
    expect(up.calls[3].body).toMatchObject({ location_ref_id: "loc-7", item_ref_ids: ["ITEM-1"], action: "disable" });
    const cat = up.calls[4].body as ReturnType<typeof urbanPiperCatalogue>;
    expect(cat.categories).toEqual([{ ref_id: "rolls-wraps", name: "Rolls & Wraps", active: true }]);
    expect(cat.items[0]).toMatchObject({ ref_id: "ITEM-1", price: 120, food_type: "1", category_ref_ids: ["rolls-wraps"], available: true });
    expect(cat.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref_id: "V-var1", price: 20 }), expect.objectContaining({ ref_id: "A-add1", price: 20 })]),
    );
  });

  it("reports UrbanPiper errors", async () => {
    up.failNext(1, 400);
    await expect(adapter.ping()).rejects.toThrow(/UrbanPiper said 400/);
    const bad = new UrbanPiperAdapter({ baseUrl: up.baseUrl, storeId: "loc-7", apiKey: "wrong:key", webhookSecret: SECRET });
    await expect(bad.ping()).rejects.toThrow(/401/);
  });
});
