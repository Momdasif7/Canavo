import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, metaTemplateBody, sendWhatsApp, waLink, waNumber, type WaConfig } from "./whatsapp";

// A local stand-in for Meta's Graph API and WATI: records requests, answers by path.
const seen: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
let base = "";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/slow/")) return; // never answers → timeout path
    if (req.url?.includes("/v21.0/111111/messages")) return res.end(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }));
    if (req.url?.includes("/v21.0/777777/messages")) {
      // Real Meta behaviour: some errors echo the token back
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: `Malformed access token ${String(req.headers.authorization).slice(7)}`, code: 190 } }));
    }
    if (req.url?.includes("/v21.0/999999/messages")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Template name does not exist in the translation", code: 132001 } }));
    }
    if (req.url?.startsWith("/wati-ok/api/v1/sendTemplateMessage")) return res.end(JSON.stringify({ result: true }));
    if (req.url?.startsWith("/wati-bad/api/v1/sendTemplateMessage")) return res.end(JSON.stringify({ result: false, info: "Invalid template" }));
    res.statusCode = 404;
    res.end("{}");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = (over: Partial<WaConfig>): WaConfig => ({
  provider: "NONE",
  templates: { ...DEFAULT_TEMPLATES },
  autoDeliveryUpdates: false,
  staffAlerts: false,
  fromEnv: false,
  ...over,
});

const msg = { to: "9876543210", text: "Bill INV-1 — ₹60", purpose: "receipt" as const, params: [{ name: "outlet", value: "Chai Corner" }, { name: "invoice", value: "INV-1" }] };

describe("whatsapp helpers", () => {
  it("waNumber adds 91 to a 10-digit Indian mobile and strips symbols", () => {
    expect(waNumber("9876543210")).toBe("919876543210");
    expect(waNumber("+91 98765-43210")).toBe("919876543210");
    expect(waNumber("0091 9876543210")).toBe("919876543210");
  });

  it("waLink is a click-to-chat link with the text encoded", () => {
    expect(waLink("9876543210", "Hi & bye")).toBe("https://wa.me/919876543210?text=Hi%20%26%20bye");
  });

  it("metaTemplateBody puts parameters in template order; none → no components", () => {
    const b = metaTemplateBody("919876543210", "receipt_share", "en", [{ value: "A" }, { value: "" }]);
    expect(b).toEqual({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "template",
      template: { name: "receipt_share", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "A" }, { type: "text", text: "-" }] }] },
    });
    expect(metaTemplateBody("1", "hello_world", "en_US", []).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });
});

describe("sendWhatsApp", () => {
  it("NONE → click-to-chat link, no network call", async () => {
    const before = seen.length;
    const r = await sendWhatsApp(msg, cfg({}));
    expect(r).toMatchObject({ method: "link", provider: "NONE" });
    expect(r.waLink).toContain("wa.me/919876543210");
    expect(seen.length).toBe(before);
  });

  it("META missing token → link with a reason, no call", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "META", meta: { phoneNumberId: "111111", accessToken: "", language: "en" } }));
    expect(r.method).toBe("link");
    expect(r.error).toMatch(/token missing/);
  });

  it("META success posts a template message to /<version>/<phone id>/messages and returns the message id", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "META", meta: { phoneNumberId: "111111", accessToken: "meta-token-abcdefghijklmnop", language: "en", baseUrl: base } }));
    expect(r).toMatchObject({ method: "sent", provider: "META", messageId: "wamid.TEST" });
    const req = seen.at(-1)!;
    expect(req.url).toBe("/v21.0/111111/messages");
    expect(req.auth).toBe("Bearer meta-token-abcdefghijklmnop");
    expect(req.body).toEqual(metaTemplateBody("919876543210", "receipt_share", "en", msg.params));
  });

  it("META API error → link with Meta's message", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "META", meta: { phoneNumberId: "999999", accessToken: "meta-token-abcdefghijklmnop", language: "en", baseUrl: base } }));
    expect(r.method).toBe("link");
    expect(r.error).toContain("Template name does not exist");
  });

  it("META test purpose with hello_world sends no parameters", async () => {
    await sendWhatsApp({ ...msg, purpose: "test" }, cfg({ provider: "META", meta: { phoneNumberId: "111111", accessToken: "meta-token-abcdefghijklmnop", language: "en_US", baseUrl: base } }));
    expect((seen.at(-1)!.body.template as Record<string, unknown>).components).toBeUndefined();
  });

  it("provider that never answers → falls back after the timeout", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "META", meta: { phoneNumberId: "1", accessToken: "meta-token-abcdefghijklmnop", language: "en", baseUrl: `${base}/slow` } }));
    expect(r.method).toBe("link");
    expect(r.error).toMatch(/10 s/);
  }, 15_000);

  it("WATI success sends the template with named parameters and bearer token", async () => {
    const r = await sendWhatsApp({ ...msg, tag: "receipt_INV-1" }, cfg({ provider: "WATI", wati: { apiUrl: `${base}/wati-ok`, token: "wati-secret-token" } }));
    expect(r).toMatchObject({ method: "sent", provider: "WATI" });
    const req = seen.at(-1)!;
    expect(req.url).toBe("/wati-ok/api/v1/sendTemplateMessage?whatsappNumber=919876543210");
    expect(req.auth).toBe("Bearer wati-secret-token");
    expect(req.body).toEqual({ template_name: "receipt_share", broadcast_name: "receipt_INV-1", parameters: msg.params });
  });

  it("WATI 200 with result:false is treated as a failure → link + reason", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "WATI", wati: { apiUrl: `${base}/wati-bad`, token: "t" } }));
    expect(r.method).toBe("link");
    expect(r.error).toContain("Invalid template");
  });

  it("BUG-005: a provider error that echoes the token is redacted", async () => {
    const token = "EAAG-real-looking-token-1234567890";
    const r = await sendWhatsApp(msg, cfg({ provider: "META", meta: { phoneNumberId: "777777", accessToken: token, language: "en", baseUrl: base } }));
    expect(r.method).toBe("link");
    expect(r.error).toContain("Malformed access token");
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it("errors never leak the token", async () => {
    const r = await sendWhatsApp(msg, cfg({ provider: "WATI", wati: { apiUrl: `${base}/wati-bad`, token: "super-secret-123" } }));
    expect(JSON.stringify(r)).not.toContain("super-secret-123");
  });
});
