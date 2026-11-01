import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookError } from "./adapter";
import { HubAdapter, signHubBody, sourceChannelOf, verifyHubSignature } from "./hub";
import { startFakeHub, type FakeHub } from "./fake-hub";

let hub: FakeHub;
let adapter: HubAdapter;
const SECRET = "whsec_test_123456";

beforeAll(async () => {
  hub = await startFakeHub({ apiKey: "key-1" });
  adapter = new HubAdapter({ baseUrl: `${hub.baseUrl}/`, storeId: "store 9", apiKey: "key-1", webhookSecret: SECRET });
});
afterAll(() => hub.close());

describe("HubAdapter outbound calls", () => {
  it("sends the API key and the documented paths / bodies", async () => {
    hub.reset();
    await adapter.ping();
    await adapter.setStoreOpen(true);
    await adapter.pushMenu([{ externalId: "i1", name: "Chai", description: "", category: "Tea", price: 1500, foodType: "VEG", available: false, variants: [], addons: [] }]);
    await adapter.updateStatus({ channelOrderId: "Z/1", sourceChannel: "ZOMATO" }, "FOOD_READY");
    await adapter.acknowledge({ channelOrderId: "S1", sourceChannel: "SWIGGY" });
    expect(hub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/stores/store%209/ping",
      "PUT /v1/stores/store%209/status",
      "PUT /v1/stores/store%209/menu",
      "POST /v1/orders/Z%2F1/status",
      "POST /v1/orders/S1/status",
    ]);
    expect(hub.calls.every((c) => c.apiKey === "key-1")).toBe(true);
    expect(hub.calls[1].body).toEqual({ open: true });
    expect((hub.calls[2].body as { items: { available: boolean }[] }).items[0].available).toBe(false);
    expect(hub.calls[3].body).toEqual({ storeId: "store 9", channel: "zomato", status: "food_ready" });
    expect(hub.calls[4].body).toMatchObject({ status: "accepted", channel: "swiggy" });
  });

  it("turns hub errors into readable messages", async () => {
    hub.failNext(1, 503);
    await expect(adapter.ping()).rejects.toThrow(/Hub said 503: Hub is having a bad day/);
    const bad = new HubAdapter({ baseUrl: hub.baseUrl, storeId: "s", apiKey: "wrong", webhookSecret: SECRET });
    await expect(bad.ping()).rejects.toThrow(/401: Invalid API key/);
    const down = new HubAdapter({ baseUrl: "http://127.0.0.1:1", storeId: "s", apiKey: "k", webhookSecret: SECRET, timeoutMs: 2000 });
    await expect(down.ping()).rejects.toThrow(/not reachable/);
  });
});

describe("HubAdapter webhooks", () => {
  const body = {
    event: "order.new",
    order: {
      id: "Z-77",
      channel: "Zomato",
      customer: { name: "Asha" },
      items: [{ externalId: "chai", quantity: 2, unitPrice: 1500 }],
      totals: { total: 3150 },
      payment: { prepaid: true },
    },
  };
  const raw = Buffer.from(JSON.stringify(body));

  it("verifies the HMAC signature (timing-safe) and normalizes the order", () => {
    expect(verifyHubSignature(raw, signHubBody(raw, SECRET), SECRET)).toBe(true);
    expect(verifyHubSignature(raw, signHubBody(raw, "other-secret"), SECRET)).toBe(false);
    expect(verifyHubSignature(raw, undefined, SECRET)).toBe(false);
    const e = adapter.parseWebhook(raw, { "x-hub-signature": signHubBody(raw, SECRET) });
    expect(e).toMatchObject({ type: "NEW_ORDER", channelOrderId: "Z-77", sourceChannel: "ZOMATO", fulfilment: "CHANNEL", payment: { prepaid: true }, totals: { total: 3150 } });
    if (e.type === "NEW_ORDER") expect(e.items[0]).toEqual({ externalId: "chai", quantity: 2, unitPrice: 1500, addonExternalIds: [] });
  });

  it("rejects a bad signature (401) and an unreadable body (400)", () => {
    expect(() => adapter.parseWebhook(raw, { "x-hub-signature": "sha256=deadbeef" })).toThrow(WebhookError);
    try {
      adapter.parseWebhook(raw, {});
    } catch (e) {
      expect((e as WebhookError).status).toBe(401);
    }
    const junk = Buffer.from(JSON.stringify({ event: "order.new", order: { id: "x" } }));
    try {
      adapter.parseWebhook(junk, { "x-hub-signature": signHubBody(junk, SECRET) });
      expect.unreachable();
    } catch (e) {
      expect((e as WebhookError).status).toBe(400);
    }
  });

  it("normalizes cancellations and rider updates; unknown channels are OTHER", () => {
    const c = Buffer.from(JSON.stringify({ event: "order.cancelled", order: { id: "S1", channel: "swiggy" }, reason: "Customer cancelled" }));
    expect(adapter.parseWebhook(c, { "x-hub-signature": signHubBody(c, SECRET) })).toEqual({ type: "ORDER_CANCELLED", channelOrderId: "S1", sourceChannel: "SWIGGY", reason: "Customer cancelled" });
    const r = Buffer.from(JSON.stringify({ event: "rider.status", order: { id: "S1", channel: "magicpin" }, status: "picked_up", rider: { name: "Ravi" } }));
    expect(adapter.parseWebhook(r, { "x-hub-signature": signHubBody(r, SECRET) })).toMatchObject({ type: "RIDER_STATUS", sourceChannel: "OTHER", status: "PICKED_UP" });
    expect(sourceChannelOf(" ONDC ")).toBe("ONDC");
  });
});
