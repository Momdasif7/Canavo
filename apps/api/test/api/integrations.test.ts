/**
 * Per-store integrations (Settings → Integrations) and WhatsApp templates — privacy / data-leak suite.
 *
 *  - role matrix for every new endpoint; Super Admin, platform support views and other stores get nothing;
 *  - secrets are encrypted at rest and NEVER appear: in any GET response of the whole API (route-inventory
 *    sweep), audit rows, notifications, outbox payloads, the owner data export, or the logs;
 *  - each store's Razorpay keys are used for its own QR codes, and store A's webhook can't settle store B's;
 *  - "Test connection" works against fake Razorpay / SMTP / MSG91 / Meta servers and is rate limited.
 * Every third party here is a local fake; all secrets are made up.
 */
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Writable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/env";
import { createLogger } from "../../src/lib/observability";
import { currentStep, totpAt } from "../../src/lib/totp";
import { smtpHostError, storeSmtpOptions } from "../../src/services/mailer";
import { createPlatformAdmin, db, login, startServer, type Client } from "../integration/helpers";
import { rbacMatrix, world, type World } from "./kit";
import { fillParams, listRoutes } from "./routes";

// ---------- distinctive fake secrets (store A) ----------
const A = {
  keyId: "rzp_test_AAAkeyid1234",
  keySecret: "rzpKeySECRET-a1b2c3d4e5",
  webhookSecret: "rzpWebhookSECRET-z9y8x7",
  smtpPass: "smtpPASSWORD-q1w2e3r4",
  msgAuth: "msgAUTHkey77441122xyz",
  metaToken: "EAAmetaTOKEN-0099887766aabbccdd",
  watiToken: "watiTOKEN-55443322ffee",
};
const B = { keyId: "rzp_test_BBBkeyid5678", keySecret: "rzpKeySECRET-bbbbbbbb99", webhookSecret: "rzpWebhookSECRET-bbbbbb" };
const SECRETS = [A.keySecret, A.webhookSecret, A.smtpPass, A.msgAuth, A.metaToken, A.watiToken, B.keySecret, B.webhookSecret];
/** A secret or a long piece of one (catches truncated / partially echoed values). */
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s) || text.includes(s.slice(0, 12)));

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let owner: Client, manager: Client, ownerB: Client;

// ---------- capture every log line written during the suite ----------
const logs: string[] = [];
const originals = {
  log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
  out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr),
};
function captureLogs() {
  for (const k of ["log", "info", "warn", "error", "debug"] as const) {
    console[k] = (...a: unknown[]) => {
      logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      originals[k](...a);
    };
  }
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (originals.out as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    logs.push(String(chunk));
    return (originals.err as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}
function restoreLogs() {
  for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = originals[k];
  process.stdout.write = originals.out as typeof process.stdout.write;
  process.stderr.write = originals.err as typeof process.stderr.write;
}

// ---------- fake Razorpay + MSG91 + Meta (one HTTP server, routed by path) ----------
const seen: { method: string; url: string; auth?: string; authkey?: string; body: string }[] = [];
let fakeBase = "";
let qrSeq = 0;
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, authkey: req.headers.authkey as string | undefined, body: raw });
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    const goodRzp = [basic(A.keyId, A.keySecret), basic(B.keyId, B.keySecret)].includes(req.headers.authorization ?? "");
    if (url.startsWith("/v1/payments?count=1")) {
      res.statusCode = goodRzp ? 200 : 401;
      return res.end(goodRzp ? '{"items":[]}' : '{"error":{"description":"Authentication failed"}}');
    }
    if (url === "/v1/payments/qr_codes") {
      if (!goodRzp) return (res.statusCode = 401), res.end("{}");
      return res.end(JSON.stringify({ id: `qr_IT${++qrSeq}${Date.now()}`, image_url: "https://example.test/qr.png" }));
    }
    if (url === "/api/v5/flow") {
      // Like some gateways, echo the key back on errors — the API must redact it.
      if (req.headers.authkey !== A.msgAuth) return res.end(JSON.stringify({ type: "error", message: `invalid authkey ${String(req.headers.authkey)}` }));
      return res.end('{"type":"success","message":"queued"}');
    }
    if (/^\/v21\.0\/\d+\?fields=/.test(url)) {
      if (req.headers.authorization !== `Bearer ${A.metaToken}`) return (res.statusCode = 401), res.end(JSON.stringify({ error: { message: `Malformed access token ${String(req.headers.authorization).slice(7)}` } }));
      return res.end('{"display_phone_number":"+91 98765 43210","verified_name":"Store A"}');
    }
    if (/^\/v21\.0\/\d+\/messages$/.test(url)) {
      if (req.headers.authorization !== `Bearer ${A.metaToken}`) return (res.statusCode = 401), res.end(JSON.stringify({ error: { message: `Malformed access token ${String(req.headers.authorization).slice(7)}` } }));
      return res.end('{"messages":[{"id":"wamid.IT"}]}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

// ---------- fake SMTP (EHLO, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA) ----------
const mails: { from: string; to: string[]; data: string }[] = [];
let smtpPort = 0;
const smtp = net.createServer((sock) => {
  let buf = "";
  let state: "cmd" | "data" | "authUser" | "authPass" = "cmd";
  let user = "";
  let cur = { from: "", to: [] as string[], data: "" };
  const reply = (s: string) => sock.write(`${s}\r\n`);
  reply("220 fake.smtp ESMTP");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (state === "data") {
        if (line === ".") {
          mails.push(cur);
          cur = { from: "", to: [], data: "" };
          state = "cmd";
          reply("250 OK queued");
        } else cur.data += `${line}\n`;
        continue;
      }
      if (state === "authUser") {
        user = Buffer.from(line, "base64").toString();
        state = "authPass";
        reply("334 UGFzc3dvcmQ6");
        continue;
      }
      if (state === "authPass") {
        state = "cmd";
        reply(user === "mailer@store-a.test" && Buffer.from(line, "base64").toString() === A.smtpPass ? "235 OK" : "535 Authentication failed");
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
      else if (cmd.startsWith("AUTH PLAIN")) {
        const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0");
        reply(u === "mailer@store-a.test" && p === A.smtpPass ? "235 OK" : "535 Authentication failed");
      } else if (cmd.startsWith("AUTH LOGIN")) {
        state = "authUser";
        reply("334 VXNlcm5hbWU6");
      } else if (cmd.startsWith("MAIL FROM")) {
        cur.from = line.slice(10);
        reply("250 OK");
      } else if (cmd.startsWith("RCPT TO")) {
        cur.to.push(line.slice(8));
        reply("250 OK");
      } else if (cmd === "DATA") {
        state = "data";
        reply("354 go ahead");
      } else if (cmd === "QUIT") {
        reply("221 bye");
        sock.end();
      } else reply("250 OK");
    }
  });
  sock.on("error", () => undefined);
});

const savedEnv = { rzp: env.RAZORPAY_BASE_URL, msg: env.MSG91_BASE_URL, meta: env.WHATSAPP_META_BASE_URL, hook: env.RAZORPAY_WEBHOOK_SECRET, shared: env.RAZORPAY_SHARED_ACCOUNT, id: env.RAZORPAY_KEY_ID, secret: env.RAZORPAY_KEY_SECRET };

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  smtpPort = (smtp.address() as AddressInfo).port;
  Object.assign(env, { RAZORPAY_BASE_URL: fakeBase, MSG91_BASE_URL: fakeBase, WHATSAPP_META_BASE_URL: fakeBase, RAZORPAY_SHARED_ACCOUNT: false, RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined });
  captureLogs();
  srv = await startServer();
  w = await world(srv.base, "Integrations");
  owner = w.as.BUSINESS_OWNER;
  manager = w.as.OUTLET_MANAGER;
  ownerB = w.other.owner;
});
afterAll(async () => {
  restoreLogs();
  Object.assign(env, { RAZORPAY_BASE_URL: savedEnv.rzp, MSG91_BASE_URL: savedEnv.msg, WHATSAPP_META_BASE_URL: savedEnv.meta, RAZORPAY_WEBHOOK_SECRET: savedEnv.hook, RAZORPAY_SHARED_ACCOUNT: savedEnv.shared, RAZORPAY_KEY_ID: savedEnv.id, RAZORPAY_KEY_SECRET: savedEnv.secret });
  await srv.close();
  await new Promise<void>((r) => fake.close(() => r()));
  await new Promise<void>((r) => smtp.close(() => r()));
});

const KINDS = ["razorpay", "email", "sms", "whatsapp"] as const;

describe("authorization", () => {
  it("role matrix: managers read status, only the owner edits / tests / deletes", async () => {
    await rbacMatrix(w, [
      { method: "GET", path: "/integrations", perms: ["settings:outlet"] },
      ...KINDS.map((k) => ({ method: "GET" as const, path: `/integrations/${k}`, perms: ["settings:outlet" as const] })),
      ...KINDS.map((k) => ({ method: "PUT" as const, path: `/integrations/${k}`, perms: ["outlet:manage" as const] })),
      ...KINDS.map((k) => ({ method: "POST" as const, path: `/integrations/${k}/test`, perms: ["outlet:manage" as const] })),
      { method: "DELETE", path: "/integrations/sms", perms: ["outlet:manage"] },
      { method: "POST", path: "/integrations/razorpay/webhook-key", perms: ["outlet:manage"] },
      { method: "GET", path: "/integrations/whatsapp/templates", perms: ["settings:outlet"] },
      { method: "PUT", path: "/integrations/whatsapp/templates", perms: ["outlet:manage"] },
      { method: "POST", path: "/integrations/whatsapp/templates/receipt/test", perms: ["outlet:manage"] },
    ]);
  });

  it("the Super Admin gets 403 on every integration endpoint (also with a store's outlet header)", async () => {
    for (const [m, p] of [["GET", "/integrations"], ["GET", "/integrations/razorpay"], ["PUT", "/integrations/razorpay"], ["POST", "/integrations/email/test"], ["GET", "/integrations/whatsapp/templates"], ["GET", "/admin/whatsapp"]] as const) {
      const r = await w.admin.call(m, p, m === "GET" ? undefined : {}, { "x-outlet-id": w.h.outletId });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });

  it("unknown integration → 404", async () => {
    expect((await owner.call("GET", "/integrations/stripe")).status).toBe(404);
    expect((await owner.call("PUT", "/integrations/RAZORPAY", {})).status).toBe(404);
  });
});

describe("saving: encrypted at rest, write-only secrets, masked hints, audited by name", () => {
  it("validation: bad keys / hosts / ids → 400 (never echoing the input)", async () => {
    for (const [k, body] of [
      ["razorpay", { keyId: "pk_live_xxx", keySecret: "short" }],
      ["razorpay", { keyId: "rzp_test_ABCDEF12" }], // no secret stored yet
      ["razorpay", { keySecret: "abcdefghijkl" }], // no key id stored yet
      ["email", { host: "http://smtp.example.com", port: 587, fromEmail: "a@b.co" }],
      ["email", { host: "smtp.example.com", port: 587, fromEmail: "not-an-email" }],
      ["email", { host: "smtp.example.com", port: 587, fromEmail: "a@b.co", user: "u@b.co" }], // user without password
      ["sms", { authKey: "bad key!", alertTemplateId: "abcdef12" }],
      ["sms", { authKey: "abcdefghij12" }], // no template
      ["whatsapp", { provider: "META", meta: { phoneNumberId: "12345678" } }], // no token
    ] as const) {
      const r = await owner.call("PUT", `/integrations/${k}`, body);
      expect(r.status, `${k} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it("owner saves all four; the database holds ciphertext only; the API shows configured + last-4 hints", async () => {
    let r = await owner.call("PUT", "/integrations/razorpay", { keyId: A.keyId, keySecret: A.keySecret, webhookSecret: A.webhookSecret });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: true, source: "business", config: { keyId: "rzp_test_••••1234", mode: "test" }, secrets: { keySecret: { set: true, hint: "••••d4e5" }, webhookSecret: { set: true, hint: "••••y8x7" } } });
    expect(r.body.webhookUrl).toMatch(/\/webhooks\/razorpay\/[A-Za-z0-9_-]{32}$/);
    r = await owner.call("PUT", "/integrations/email", { host: "127.0.0.1", port: smtpPort, user: "mailer@store-a.test", password: A.smtpPass, fromEmail: "bills@store-a.test", fromName: "Store A" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: true, config: { host: "127.0.0.1", user: "mailer@store-a.test", fromEmail: "bills@store-a.test" }, secrets: { password: { set: true, hint: "••••e3r4" } } });
    r = await owner.call("PUT", "/integrations/sms", { authKey: A.msgAuth, senderId: "STOREA", alertTemplateId: "alert1234", otpTemplateId: "otp123456" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    r = await owner.call("PUT", "/integrations/whatsapp", { provider: "META", meta: { phoneNumberId: "1234567890", accessToken: A.metaToken, language: "en" }, autoDeliveryUpdates: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.secrets.metaAccessToken).toEqual({ set: true, hint: "••••ccdd" });

    const rows = await db.businessIntegration.findMany({ where: { businessId: w.h.businessId } });
    expect(rows.map((x) => x.kind).sort()).toEqual(["RAZORPAY", "SMS", "SMTP", "WHATSAPP"]);
    expect(leaks(JSON.stringify(rows))).toEqual([]);
    for (const row of rows) for (const v of Object.values(row.secrets as Record<string, string>)) expect(v).toMatch(/^v1:/);
  });

  it("empty secret fields keep the stored values; a new value replaces it; audit has names, never values", async () => {
    const before = await db.businessIntegration.findFirstOrThrow({ where: { businessId: w.h.businessId, kind: "RAZORPAY" } });
    const r = await owner.call("PUT", "/integrations/razorpay", { keyId: A.keyId, keySecret: "", webhookSecret: "" });
    expect(r.status).toBe(200);
    expect(r.body.secrets.keySecret).toEqual({ set: true, hint: "••••d4e5" });
    const after = await db.businessIntegration.findFirstOrThrow({ where: { businessId: w.h.businessId, kind: "RAZORPAY" } });
    expect(after.secrets).toEqual(before.secrets);
    const logsRows = await db.auditLog.findMany({ where: { businessId: w.h.businessId, action: { startsWith: "integration." } } });
    expect(logsRows.length).toBeGreaterThanOrEqual(5);
    const create = logsRows.find((l) => l.action === "integration.create" && (l.meta as { kind?: string }).kind === "RAZORPAY")!;
    expect(create.meta).toMatchObject({ kind: "RAZORPAY", secretsChanged: ["keySecret", "webhookSecret"] });
    expect(create.userId).toBe(w.h.users.owner.id);
    expect(leaks(JSON.stringify(logsRows))).toEqual([]);
  });

  it("managers see status only — no hints, no settings, no webhook URL", async () => {
    const r = await manager.call("GET", "/integrations");
    expect(r.status).toBe(200);
    expect(r.body.editable).toBe(false);
    for (const i of r.body.items) {
      expect(Object.keys(i).sort()).toEqual(["configured", "enabled", "kind", "lastTestOk", "lastTestedAt", "slug", "source", "updatedAt"]);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/••••|webhookUrl|127\.0\.0\.1/);
  });

  it("store B sees only its own (nothing configured), and can't test or delete A's", async () => {
    const r = await ownerB.call("GET", "/integrations");
    expect(r.status).toBe(200);
    expect(r.body.items.every((i: { configured: boolean }) => !i.configured)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/••••/);
    expect((await ownerB.call("POST", "/integrations/razorpay/test", {})).status).toBe(400);
    expect((await ownerB.call("DELETE", "/integrations/sms")).status).toBe(404);
    expect(await db.businessIntegration.count({ where: { businessId: w.h.businessId } })).toBe(4);
  });

  it("a support view (owner-granted, read-only) gets 403 on integrations — secrets aren't for the platform", async () => {
    const adminUser = await createPlatformAdmin();
    const admin = await login(srv.base, adminUser.email);
    const setup = await admin.call("POST", "/auth/2fa/setup");
    expect((await admin.call("POST", "/auth/2fa/enable", { code: totpAt(setup.body.secret, currentStep()) })).status).toBe(200);
    const grant = await owner.call("POST", "/support-access", { hours: 1, reason: "integrations test" });
    expect(grant.status).toBe(201);
    const asSupport = (p: string) => admin.call("GET", p, undefined, { "x-support-business": w.h.businessId, "x-outlet-id": w.h.outletId });
    expect((await asSupport("/orders")).status).toBe(200); // the grant works…
    for (const p of ["/integrations", "/integrations/razorpay", "/integrations/whatsapp/templates", "/admin/whatsapp"]) {
      const r = await asSupport(p);
      expect(r.status, p).toBe(403);
      expect(leaks(JSON.stringify(r.body))).toEqual([]);
    }
    await owner.call("POST", `/support-access/${grant.body.id}/revoke`, {});
  });
});

describe("test connection (fake providers)", () => {
  it("Razorpay: keys checked with the store's own credentials", async () => {
    const r = await owner.call("POST", "/integrations/razorpay/test", {});
    expect(r.body).toMatchObject({ ok: true, message: expect.stringMatching(/accepted/) });
    expect(seen.some((s) => s.url.startsWith("/v1/payments?count=1") && s.auth === basic(A.keyId, A.keySecret))).toBe(true);
    const g = await owner.call("GET", "/integrations/razorpay");
    expect(g.body).toMatchObject({ lastTestOk: true, lastTestMessage: expect.stringMatching(/accepted/) });
  });

  it("Email: logs in to the store's SMTP and sends a test email from the store's address", async () => {
    const r = await owner.call("POST", "/integrations/email/test", { to: "owner@store-a.test" });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true });
    expect(mails.at(-1)).toMatchObject({ from: expect.stringContaining("bills@store-a.test"), to: [expect.stringContaining("owner@store-a.test")] });
  });

  it("Email: a wrong password fails with a message that doesn't contain it", async () => {
    const wrong = "WRONGpassword-123456";
    await owner.call("PUT", "/integrations/email", { host: "127.0.0.1", port: smtpPort, user: "mailer@store-a.test", password: wrong, fromEmail: "bills@store-a.test" });
    const r = await owner.call("POST", "/integrations/email/test", {});
    expect(r.body.ok).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(wrong);
    await owner.call("PUT", "/integrations/email", { host: "127.0.0.1", port: smtpPort, user: "mailer@store-a.test", password: A.smtpPass, fromEmail: "bills@store-a.test", fromName: "Store A" });
  });

  it("SMS: needs a phone; sends through the store's MSG91 key; a wrong key echoed back is redacted", async () => {
    expect((await owner.call("POST", "/integrations/sms/test", {})).status).toBe(400);
    const r = await owner.call("POST", "/integrations/sms/test", { phone: "9876543210" });
    expect(r.body).toMatchObject({ ok: true });
    expect(seen.some((s) => s.url === "/api/v5/flow" && s.authkey === A.msgAuth)).toBe(true);
    // A wrong key: the fake gateway echoes it back in its error — the API answer and the stored result don't.
    const wrongKey = "WRONGauthKEY99887766";
    await owner.call("PUT", "/integrations/sms", { authKey: wrongKey, senderId: "STOREA", alertTemplateId: "alert1234", otpTemplateId: "otp123456" });
    const bad = await owner.call("POST", "/integrations/sms/test", { phone: "9876543210" });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toContain("[redacted]");
    expect(JSON.stringify(bad.body) + JSON.stringify((await owner.call("GET", "/integrations/sms")).body)).not.toContain(wrongKey);
    await owner.call("PUT", "/integrations/sms", { authKey: A.msgAuth, senderId: "STOREA", alertTemplateId: "alert1234", otpTemplateId: "otp123456" });
  });

  it("WhatsApp: a rejected token echoed by Meta is redacted from the answer", async () => {
    const wrong = "EAAwrongTOKEN-1122334455667788";
    await owner.call("PUT", "/integrations/whatsapp", { provider: "META", meta: { phoneNumberId: "1234567890", accessToken: wrong, language: "en" }, autoDeliveryUpdates: true });
    const r = await owner.call("POST", "/integrations/whatsapp/test", {});
    expect(r.body.ok).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(wrong);
    await owner.call("PUT", "/integrations/whatsapp", { provider: "META", meta: { phoneNumberId: "1234567890", accessToken: A.metaToken, language: "en" }, autoDeliveryUpdates: true });
  });

  it("WhatsApp: token check without a phone, test message with one", async () => {
    let r = await owner.call("POST", "/integrations/whatsapp/test", {});
    expect(r.body).toMatchObject({ ok: true, message: expect.stringMatching(/Meta accepted/) });
    r = await owner.call("POST", "/integrations/whatsapp/test", { phone: "9876543210" });
    expect(r.body).toMatchObject({ ok: true });
  });

  it("scheduled report emails go out through the store's own SMTP", async () => {
    const s = await owner.call("POST", "/admin/report-schedules", { email: "acct@store-a.test", frequency: "DAILY", reports: ["sales"] });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const n = mails.length;
    const r = await owner.call("POST", `/admin/report-schedules/${s.body.id}/send-now`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ delivered: true, via: "store" });
    expect(mails.length).toBe(n + 1);
    expect(mails.at(-1)!.from).toContain("bills@store-a.test");
  });

  it("SMTP host rules: no URLs; production refuses internal addresses and odd ports, also after DNS", async () => {
    expect(smtpHostError("smtp.example.com", 587, true)).toBeNull();
    expect(smtpHostError("http://smtp.example.com", 587, false)).toMatch(/server name only/);
    for (const h of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "localhost", "mail.internal", "::1"]) expect(smtpHostError(h, 587, true), h).toMatch(/public mail server/);
    expect(smtpHostError("smtp.example.com", 22, true)).toMatch(/port/);
    expect(smtpHostError("127.0.0.1", 2525, false)).toBeNull();
    const fakeI = { config: { host: "smtp.rebind.example", port: 587 }, secret: () => "" } as never;
    await expect(storeSmtpOptions(fakeI, true, async () => ["10.1.2.3"])).rejects.toThrow(/internal/);
    const ok = await storeSmtpOptions(fakeI, true, async () => ["203.0.113.7"]);
    expect(ok).toMatchObject({ host: "203.0.113.7", tls: { servername: "smtp.rebind.example" } });
    // and through the API in production mode the same rule applies when saving
    expect((await owner.call("PUT", "/integrations/email", { host: "smtp gmail com", port: 587, fromEmail: "a@b.co" })).status).toBe(400);
  });
});

describe("Razorpay per store: QR codes and webhooks", () => {
  const sign = (raw: string, secret: string) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const credited = (qrId: string, amount: number) =>
    JSON.stringify({ event: "qr_code.credited", payload: { qr_code: { entity: { id: qrId } }, payment: { entity: { id: `pay_${crypto.randomBytes(6).toString("hex")}`, amount } } } });
  const hook = (path: string, raw: string, sig: string) =>
    fetch(`${srv.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const bill = async (c: Client, h: { items: { chai: string } }) => {
    const o = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const q = await c.call("POST", `/orders/${o.body.id}/upi-qr`, {});
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    return { orderId: o.body.id as string, qrId: q.body.gatewayRef as string, amount: q.body.amount as number, mock: q.body.mock as boolean };
  };
  let urlA = "", urlB = "";

  it("each store's QR is created with its own keys; without keys (and no shared account) it is a plain UPI QR", async () => {
    const noKeys = await bill(ownerB, w.other.h);
    expect(noKeys.mock).toBe(true);
    const a = await bill(owner, w.h);
    expect(a.mock).toBe(false);
    const qrCall = seen.filter((s) => s.url === "/v1/payments/qr_codes").at(-1)!;
    expect(qrCall.auth).toBe(basic(A.keyId, A.keySecret));
    const rb = await ownerB.call("PUT", "/integrations/razorpay", { keyId: B.keyId, keySecret: B.keySecret, webhookSecret: B.webhookSecret });
    expect(rb.status).toBe(200);
    urlA = new URL((await owner.call("GET", "/integrations/razorpay")).body.webhookUrl).pathname;
    urlB = new URL(rb.body.webhookUrl).pathname;
    expect(urlA).not.toBe(urlB);
    await bill(ownerB, w.other.h);
    expect(seen.filter((s) => s.url === "/v1/payments/qr_codes").at(-1)!.auth).toBe(basic(B.keyId, B.keySecret));
  });

  it("store A's webhook settles A's payment, never B's — whatever the signature", async () => {
    const a = await bill(owner, w.h);
    const b = await bill(ownerB, w.other.h);
    // B's payment through A's URL signed with A's secret: authentic for A, but not A's payment.
    let raw = credited(b.qrId, b.amount);
    expect((await hook(urlA, raw, sign(raw, A.webhookSecret))).body).toEqual({ ignored: "unknown qr" });
    // …signed with B's secret on A's URL: bad signature.
    expect((await hook(urlA, raw, sign(raw, B.webhookSecret))).status).toBe(401);
    expect((await db.payment.findUniqueOrThrow({ where: { gatewayRef: b.qrId } })).status).toBe("PENDING");
    // The platform route can't settle a store with its own account either.
    env.RAZORPAY_WEBHOOK_SECRET = "platform-hook-secret";
    expect((await hook("/webhooks/razorpay", raw, sign(raw, "platform-hook-secret"))).body).toEqual({ ignored: "store uses its own Razorpay account" });
    env.RAZORPAY_WEBHOOK_SECRET = savedEnv.hook;
    expect((await db.payment.findUniqueOrThrow({ where: { gatewayRef: b.qrId } })).status).toBe("PENDING");
    // B's own URL + B's secret works.
    expect((await hook(urlB, raw, sign(raw, B.webhookSecret))).body).toEqual({ ok: true });
    expect((await db.payment.findUniqueOrThrow({ where: { gatewayRef: b.qrId } })).status).toBe("SUCCESS");
    // A's payment on A's URL.
    raw = credited(a.qrId, a.amount);
    expect((await hook(urlA, raw, sign(raw, A.webhookSecret))).body).toEqual({ ok: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe("PAID");
  });

  it("unknown / malformed keys and rotated URLs answer 401 like a bad signature", async () => {
    const raw = credited("qr_x", 100);
    for (const p of ["/webhooks/razorpay/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "/webhooks/razorpay/short", `/webhooks/razorpay/${"%27".repeat(20)}`]) {
      expect((await hook(p, raw, sign(raw, A.webhookSecret))).status, p).toBe(401);
    }
    const r = await owner.call("POST", "/integrations/razorpay/webhook-key");
    expect(r.status).toBe(200);
    const newUrl = new URL(r.body.webhookUrl).pathname;
    expect(newUrl).not.toBe(urlA);
    expect((await hook(urlA, raw, sign(raw, A.webhookSecret))).status).toBe(401);
    expect((await hook(newUrl, raw, sign(raw, A.webhookSecret))).body).toEqual({ ignored: "unknown qr" });
    urlA = newUrl;
  });

  it("a disabled integration stops its webhook and its keys", async () => {
    await ownerB.call("PUT", "/integrations/razorpay", { enabled: false, keyId: B.keyId });
    const raw = credited("qr_y", 100);
    expect((await hook(urlB, raw, sign(raw, B.webhookSecret))).status).toBe(401);
    expect((await bill(ownerB, w.other.h)).mock).toBe(true);
  });
});

describe("WhatsApp templates", () => {
  it("lists every message type with variables in order, samples and a preview; managers read", async () => {
    const r = await manager.call("GET", "/integrations/whatsapp/templates");
    expect(r.status).toBe(200);
    expect(r.body.editable).toBe(false);
    expect(r.body.metaManagerUrl).toMatch(/^https:\/\/business\.facebook\.com\//);
    const receipt = r.body.purposes.find((p: { purpose: string }) => p.purpose === "receipt");
    expect(receipt.variables.map((v: { name: string }) => v.name)).toEqual(["outlet", "invoice", "amount", "link"]);
    expect(receipt.preview).toContain("INV-1042");
    expect(r.body.purposes.find((p: { purpose: string }) => p.purpose === "test").variables).toEqual([]); // hello_world
    expect((await manager.call("PUT", "/integrations/whatsapp/templates", { templates: {} })).status).toBe(403);
  });

  it("owner sets name / language / preview text per type; it is per business and used when sending", async () => {
    const r = await owner.call("PUT", "/integrations/whatsapp/templates", { templates: { receipt: { name: "store_a_receipt", language: "hi", body: "{{1}} bill {{2}}: {{3}} {{4}}" } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const receipt = r.body.purposes.find((p: { purpose: string }) => p.purpose === "receipt");
    expect(receipt).toMatchObject({ name: "store_a_receipt", language: "hi", effectiveName: "store_a_receipt", effectiveLanguage: "hi" });
    expect(receipt.preview).toBe("Spice Garden bill INV-1042: ₹450.00 https://api.example.in/public/receipts/abc123");
    // B unaffected
    const b = (await ownerB.call("GET", "/integrations/whatsapp/templates")).body.purposes.find((p: { purpose: string }) => p.purpose === "receipt");
    expect(b).toMatchObject({ name: null, effectiveName: b.defaultName });
    // Secrets survive a template save
    expect((await owner.call("GET", "/integrations/whatsapp")).body.secrets.metaAccessToken.set).toBe(true);
    // Send test → Meta gets the store's template name, language and the sample values in order
    const t = await owner.call("POST", "/integrations/whatsapp/templates/receipt/test", { phone: "9876543210" });
    expect(t.body, JSON.stringify(t.body)).toMatchObject({ method: "sent", provider: "META" });
    const sent = JSON.parse(seen.filter((s) => /\/messages$/.test(s.url)).at(-1)!.body);
    expect(sent.template).toMatchObject({ name: "store_a_receipt", language: { code: "hi" } });
    expect(sent.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["Spice Garden", "INV-1042", "₹450.00", "https://api.example.in/public/receipts/abc123"]);
  });

  it("400 on bad names / languages / unknown types; 404 on an unknown message type test", async () => {
    for (const body of [{ templates: { receipt: { name: "bad name!" } } }, { templates: { receipt: { language: "english" } } }, { templates: { nope: {} } }, { templates: { receipt: { name: "x", extra: 1 } } }]) {
      expect((await owner.call("PUT", "/integrations/whatsapp/templates", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await owner.call("POST", "/integrations/whatsapp/templates/nope/test", { phone: "9876543210" })).status).toBe(404);
  });

  it("the older /admin/whatsapp keeps working on the same storage (owner only)", async () => {
    const g = await owner.call("GET", "/admin/whatsapp");
    expect(g.body).toMatchObject({ provider: "META", meta: { phoneNumberId: "1234567890", token: "••••ccdd" } });
    expect(g.body.templates.receipt).toBe("store_a_receipt");
    expect((await manager.call("GET", "/admin/whatsapp")).status).toBe(403);
  });
});

describe("data-leak sweep", () => {
  it("no secret in ANY GET response of the API (owner and manager, every route in the inventory)", async () => {
    const gets = listRoutes().filter((r) => r.method === "get");
    expect(gets.length).toBeGreaterThan(150);
    const found: string[] = [];
    for (const c of [owner, manager]) {
      for (const r of gets) {
        const res = await fetch(`${srv.base}${fillParams(r.path)}`, { headers: { authorization: `Bearer ${c.token}`, "x-outlet-id": w.h.outletId } });
        const text = await res.text();
        if (leaks(text).length) found.push(`${r.path} → ${leaks(text).join(",")}`);
      }
      for (const k of KINDS) {
        const text = JSON.stringify((await c.call("GET", `/integrations/${k}`)).body);
        if (leaks(text).length) found.push(`/integrations/${k}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the owner data export has no secret, no ciphertext column and no webhook key", async () => {
    const r = await owner.call("GET", "/admin/export?format=json");
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(leaks(text)).toEqual([]);
    const rows = (r.body as { tables: Record<string, Record<string, unknown>[]> }).tables.BusinessIntegration;
    expect(rows.length).toBe(4);
    for (const row of rows) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["secrets"]));
    for (const row of rows) expect(row).not.toHaveProperty("webhookKey");
  });

  it("audit rows, notifications and outbox payloads hold no secret", async () => {
    const audit = await db.auditLog.findMany({ where: { OR: [{ businessId: { in: [w.h.businessId, w.other.h.businessId] } }, { outletId: { in: [w.h.outletId, w.other.h.outletId] } }] } });
    expect(audit.length).toBeGreaterThan(10);
    expect(leaks(JSON.stringify(audit))).toEqual([]);
    const users = await db.user.findMany({ where: { businessId: { in: [w.h.businessId, w.other.h.businessId] } }, select: { id: true } });
    const notes = await db.notification.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
    expect(leaks(JSON.stringify(notes))).toEqual([]);
    const outbox = await db.outboxEvent.findMany({ where: { OR: [{ businessId: { in: [w.h.businessId, w.other.h.businessId] } }, { businessId: null }] } });
    expect(leaks(JSON.stringify(outbox, (_k, v) => (typeof v === "bigint" ? String(v) : v)))).toEqual([]);
  });

  it("structured logs redact secret-named fields", () => {
    const lines: string[] = [];
    const log = createLogger(new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.info({ body: { keySecret: A.keySecret, webhookSecret: A.webhookSecret, authKey: A.msgAuth, password: A.smtpPass, metaAccessToken: A.metaToken, watiToken: A.watiToken, secrets: { x: A.keySecret } } }, "test");
    expect(leaks(lines.join("\n"))).toEqual([]);
  });

  it("nothing logged during the whole suite contains a secret", () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((l) => leaks(l).length).map((l) => l.slice(0, 200))).toEqual([]);
  });
});

describe("rate limit", () => {
  it("connection tests: at most 10 per 15 minutes per person and integration", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await owner.call("POST", "/integrations/sms/test", {})).status);
    expect(statuses).toContain(429);
    // another integration has its own budget
    expect((await owner.call("POST", "/integrations/razorpay/test", {})).status).not.toBe(429);
  });
});
