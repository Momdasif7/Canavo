/**
 * QA Phase 10 — real-time and notifications: socket auth, room scoping, ordering,
 * load (200 kitchen screens × 100 bills), notification routing / push payloads / prefs / read sync.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { emitToOutlet, emitToUser, initRealtime, revalidateSockets, socketEmitter } from "../../src/realtime";
import { startOutboxPublisher, stopOutboxPublisher } from "../../src/lib/outbox";
import { runForBusiness } from "../../src/lib/tenant";
import { DEFAULT_LINKS, deliverExternal, outletManagers, outletStaff } from "../../src/services/notify";
import { buildSync } from "esbuild";
import { createHotel, createPlatformAdmin, db, PASSWORD, type Hotel } from "./helpers";

// The mobile app's pure link mapper, bundled on the fly (its tsconfig extends expo, which isn't installed here).
type AccessProfile = { permissions: readonly string[]; modules?: readonly string[] | null };
const mobileLinks = (() => {
  const out = buildSync({ entryPoints: [path.resolve(__dirname, "../../../mobile/src/notifications/links.ts")], bundle: true, write: false, format: "cjs", platform: "node", tsconfigRaw: "{}" });
  const mod = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports as { routeForNotification: (n: { link?: string | null; kind?: string | null }, me: AccessProfile) => string | null; isUrgentKind: (k: string) => boolean };
})();
const { routeForNotification } = mobileLinks;

let base = "";
let io: ReturnType<typeof initRealtime>;
let server: http.Server;
let h: Hotel;
let h2: Hotel;
const open: Socket[] = [];

beforeAll(async () => {
  server = http.createServer(createApp());
  io = initRealtime(server);
  startOutboxPublisher(socketEmitter());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await createHotel("RT Hotel");
  h2 = await createHotel("RT Other");
});
afterAll(async () => {
  open.forEach((s) => s.disconnect());
  stopOutboxPublisher();
  await io.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function signIn(email: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${await r.text()}`);
  return (await r.json()) as { accessToken: string; refreshToken: string };
}
const call = async (token: string, method: string, p: string, body?: unknown, outletId?: string) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(outletId && { "x-outlet-id": outletId }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Connect; resolves with the socket once connected, or the connect_error message. */
function sock(token: string | undefined, outletId?: string): Promise<Socket | string> {
  return new Promise((resolve) => {
    const s = connect(base, { auth: { token, outletId }, transports: ["websocket"], reconnection: false, forceNew: true });
    open.push(s);
    s.once("connect", () => resolve(s));
    s.once("connect_error", (e) => resolve(e.message));
  });
}
async function live(token: string, outletId?: string) {
  const s = await sock(token, outletId);
  if (typeof s === "string") throw new Error(`socket refused: ${s}`);
  return s;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Did the socket receive `event` within ms? */
const receives = (s: Socket, event: string, ms = 400) =>
  new Promise<unknown>((resolve) => {
    const t = setTimeout(() => {
      s.off(event, on);
      resolve(undefined);
    }, ms);
    const on = (p: unknown) => {
      clearTimeout(t);
      resolve(p ?? true);
    };
    s.once(event, on);
  });
const disconnected = (s: Socket, ms = 1500) =>
  new Promise<string | undefined>((resolve) => {
    if (!s.connected) return resolve("already");
    const t = setTimeout(() => resolve(undefined), ms);
    s.once("disconnect", (reason) => {
      clearTimeout(t);
      resolve(reason);
    });
  });

describe("1. socket auth on connect", () => {
  it("no / expired / tampered / foreign-secret tokens are refused", async () => {
    const { accessToken } = await signIn(h.users.kitchen.email);
    const claims = jwt.decode(accessToken) as Record<string, unknown>;
    const secret = process.env.JWT_ACCESS_SECRET!;
    const expired = jwt.sign({ ...claims, iat: 1, exp: 2 }, secret);
    const tampered = accessToken.slice(0, -3) + (accessToken.endsWith("A") ? "BBB" : "AAA");
    const foreign = jwt.sign({ sub: claims.sub, role: claims.role, tv: claims.tv }, "another-secret-0123456789abcdef0123456789");
    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    for (const t of [undefined, "", "garbage", expired, tampered, foreign, noneAlg]) expect(await sock(t, h.outletId)).toBe("unauthorized");
    expect(typeof (await sock(accessToken, h.outletId))).toBe("object");
  });

  it("rt-1: a token whose session was signed out is refused at the handshake", async () => {
    const s = await signIn(h.users.cashier.email);
    const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
    expect(out.status).toBe(204);
    expect(await sock(s.accessToken, h.outletId)).toBe("unauthorized");
  });

  it("rt-2: logout disconnects that device's live sockets (other device stays)", async () => {
    const a = await signIn(h.users.cashier.email);
    const b = await signIn(h.users.cashier.email);
    const sa = await live(a.accessToken, h.outletId);
    const sb = await live(b.accessToken, h.outletId);
    const gone = disconnected(sa);
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: a.refreshToken }) });
    expect(await gone).toBe("io server disconnect");
    await wait(100);
    expect(sb.connected).toBe(true);
  });

  it("rt-2: signing out a device (sessions list) and revoke-others disconnect those sockets", async () => {
    const a = await signIn(h.users.manager.email);
    const b = await signIn(h.users.manager.email);
    const c = await signIn(h.users.manager.email);
    const [sa, sb, sc] = [await live(a.accessToken, h.outletId), await live(b.accessToken, h.outletId), await live(c.accessToken, h.outletId)];
    const sidB = (jwt.decode(b.accessToken) as { sid: string }).sid;
    const goneB = disconnected(sb);
    expect((await call(a.accessToken, "DELETE", `/auth/sessions/${sidB}`)).status).toBe(204);
    expect(await goneB).toBe("io server disconnect");
    const goneC = disconnected(sc);
    expect((await call(a.accessToken, "POST", "/auth/sessions/revoke-others")).status).toBe(200);
    expect(await goneC).toBe("io server disconnect");
    expect(sa.connected).toBe(true);
  });

  it("rt-2: deactivation / token-version bump (forceLogout) disconnects every socket of the user", async () => {
    const owner = await signIn(h.users.owner.email);
    const inv = await signIn(h.users.inventory.email);
    const s1 = await live(inv.accessToken, h.outletId);
    const s2 = await live(inv.accessToken);
    const g1 = disconnected(s1);
    const g2 = disconnected(s2);
    expect((await call(owner.accessToken, "PATCH", `/staff/${h.users.inventory.id}`, { status: "INACTIVE" }, h.outletId)).status).toBe(200);
    expect(await g1).toBe("io server disconnect");
    expect(await g2).toBe("io server disconnect");
    expect(await sock(inv.accessToken, h.outletId)).toBe("unauthorized");
    await db.user.update({ where: { id: h.users.inventory.id }, data: { status: "ACTIVE" } });
  });

  it("rt-2: a change made straight in the database (no hook) is caught by the periodic re-check", async () => {
    const d = await signIn(h.users.delivery.email);
    const s = await live(d.accessToken, h.outletId);
    await db.user.update({ where: { id: h.users.delivery.id }, data: { tokenVersion: { increment: 1 } } });
    const gone = disconnected(s);
    await revalidateSockets(); // what the 60 s sweep runs
    expect(await gone).toBe("io server disconnect");
  });

  it("a suspended business can't open sockets", async () => {
    const h3 = await createHotel("RT Suspended");
    const k = await signIn(h3.users.kitchen.email);
    const s = await live(k.accessToken, h3.outletId);
    await db.business.update({ where: { id: h3.businessId }, data: { status: "SUSPENDED" } });
    expect(await sock(k.accessToken, h3.outletId)).toBe("unauthorized");
    const gone = disconnected(s);
    await revalidateSockets();
    expect(await gone).toBe("io server disconnect");
  });

  it("cookie-session web logins use their in-memory access token on the socket and logout ends it", async () => {
    const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-session-mode": "cookie" }, body: JSON.stringify({ email: h.users.kitchen.email, password: PASSWORD }) });
    const { accessToken } = (await r.json()) as { accessToken: string };
    const cookies = Object.fromEntries(r.headers.getSetCookie().map((c) => c.split(";")[0].split("=") as [string, string]));
    const s = await live(accessToken, h.outletId);
    const gone = disconnected(s);
    const out = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `canavo_rt=${cookies.canavo_rt}; canavo_csrf=${cookies.canavo_csrf}`, "x-csrf-token": decodeURIComponent(cookies.canavo_csrf) },
      body: "{}",
    });
    expect(out.status).toBe(204);
    expect(await gone).toBe("io server disconnect");
  });
});

describe("2. room scoping", () => {
  it("outlet id spoofing: another outlet / another business's outlet never joins its room", async () => {
    const m = await signIn(h.users.manager.email); // outlet 1 only
    const k2 = await signIn(h2.users.kitchen.email);
    const own = await live(m.accessToken, h.outletId);
    const spoofOutlet2 = await live(m.accessToken, h.outlet2Id);
    const spoofOtherBiz = await live(m.accessToken, h2.outletId);
    const other = await live(k2.accessToken, h.outletId);
    const ev = [receives(own, "x:test"), receives(spoofOutlet2, "x:test"), receives(spoofOtherBiz, "x:test"), receives(other, "x:test")];
    emitToOutlet(h.outletId, "x:test", { n: 1 });
    emitToOutlet(h.outlet2Id, "x:test", { n: 2 });
    emitToOutlet(h2.outletId, "x:test", { n: 3 });
    expect(await Promise.all(ev)).toEqual([{ n: 1 }, undefined, undefined, undefined]);
  });

  it("client-sent join / subscribe events are ignored", async () => {
    const k2 = await signIn(h2.users.kitchen.email);
    const s = await live(k2.accessToken, h2.outletId);
    for (const e of ["join", "subscribe", "room:join", "joinRoom"]) {
      s.emit(e, `outlet:${h.outletId}`);
      s.emit(e, { room: `outlet:${h.outletId}`, outletId: h.outletId });
    }
    await wait(100);
    const got = receives(s, "x:join");
    emitToOutlet(h.outletId, "x:join", {});
    emitToUser(h.users.manager.id, "x:join", {});
    expect(await got).toBeUndefined();
  });

  it("owners get every outlet of their business only; platform admins get no outlet room", async () => {
    const o = await signIn(h.users.owner.email);
    const admin = await createPlatformAdmin();
    const a = await signIn(admin.email);
    const own2 = await live(o.accessToken, h.outlet2Id);
    const foreign = await live(o.accessToken, h2.outletId);
    const sa = await live(a.accessToken, h.outletId);
    const ev = [receives(own2, "x:own"), receives(foreign, "x:own"), receives(sa, "x:own")];
    emitToOutlet(h.outlet2Id, "x:own", { ok: 1 });
    emitToOutlet(h2.outletId, "x:own", { ok: 2 });
    emitToOutlet(h.outletId, "x:own", { ok: 3 });
    expect(await Promise.all(ev)).toEqual([{ ok: 1 }, undefined, undefined]);
  });

  it("rt-3: a cashier moved to another outlet stops getting the old outlet's events at once", async () => {
    const owner = await signIn(h.users.owner.email);
    const c = await signIn(h.users.cashier.email);
    const s = await live(c.accessToken, h.outletId);
    expect((await call(owner.accessToken, "PATCH", `/staff/${h.users.cashier.id}`, { outletIds: [h.outlet2Id] }, h.outletId)).status).toBe(200);
    expect(s.connected).toBe(true);
    const got = receives(s, "x:moved");
    emitToOutlet(h.outletId, "x:moved", {});
    expect(await got).toBeUndefined();
    await call(owner.accessToken, "PATCH", `/staff/${h.users.cashier.id}`, { outletIds: [h.outletId] }, h.outletId);
  });

  it("a real bill's events reach only the outlet's sockets and carry no secrets or other tenant data", async () => {
    const k = await signIn(h.users.kitchen.email);
    const k2 = await signIn(h2.users.kitchen.email);
    const mine = await live(k.accessToken, h.outletId);
    const other = await live(k2.accessToken, h2.outletId);
    const seen: { e: string; p: unknown }[] = [];
    const leaked: string[] = [];
    mine.onAny((e, p) => seen.push({ e, p }));
    other.onAny((e) => leaked.push(e));
    const cashier = await signIn(h.users.cashier.email);
    const r = await call(cashier.accessToken, "POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }], customerPhone: "9876543210", customerName: "Ravi" }, h.outletId);
    expect(r.status).toBe(201);
    await wait(600);
    expect(seen.map((s) => s.e)).toEqual(expect.arrayContaining(["kot:new", "order:created"]));
    expect(leaked).toEqual([]);
    const blob = JSON.stringify(seen);
    for (const bad of ["passwordHash", "pinHash", "tokenHash", "totpSecret", "refreshToken", "accessToken", h2.businessId, h2.outletId, "9876543210"]) expect(blob).not.toContain(bad);
  });
});

describe("3. ordering", () => {
  it("1000 events for one outlet arrive in emit order", async () => {
    const k = await signIn(h.users.kitchen.email);
    const s = await live(k.accessToken, h.outletId);
    const got: number[] = [];
    s.on("x:seq", (p: { i: number }) => got.push(p.i));
    for (let i = 0; i < 1000; i++) emitToOutlet(h.outletId, "x:seq", { i });
    for (let t = 0; t < 50 && got.length < 1000; t++) await wait(50);
    expect(got).toEqual([...Array(1000).keys()]);
  });

  it("KOTs of sequential bills arrive in bill order", async () => {
    const k = await signIn(h.users.kitchen.email);
    const s = await live(k.accessToken, h.outletId);
    const got: string[] = [];
    s.on("kot:new", (kots: { orderId: string }[]) => got.push(kots[0].orderId));
    const cashier = await signIn(h.users.cashier.email);
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) ids.push((await call(cashier.accessToken, "POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] }, h.outletId)).body.id);
    for (let t = 0; t < 40 && got.length < 15; t++) await wait(50);
    expect(got).toEqual(ids);
  });
});

describe("4. load: 200 kitchen screens on one outlet, burst of 100 bills", () => {
  it("every socket gets every kot:new; latency, memory and listener cleanup are sane", { timeout: 120_000 }, async () => {
    const SOCKETS = 200;
    const BILLS = 100;
    const k = await signIn(h.users.kitchen.email);
    const sockets: Socket[] = [];
    for (let i = 0; i < SOCKETS; i += 50) sockets.push(...(await Promise.all(Array.from({ length: 50 }, () => live(k.accessToken, h.outletId)))));
    const room = io.of("/").adapter.rooms.get(`outlet:${h.outletId}`);
    expect(room?.size).toBeGreaterThanOrEqual(SOCKETS);
    const counts = new Map<Socket, Set<string>>();
    const latencies: number[] = [];
    for (const s of sockets) {
      counts.set(s, new Set());
      s.on("kot:new", (kots: { id: string; createdAt: string }[]) => {
        for (const kot of kots) {
          counts.get(s)!.add(kot.id);
          latencies.push(Date.now() - new Date(kot.createdAt).getTime());
        }
      });
    }
    global.gc?.();
    const mem0 = process.memoryUsage().rss;
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    const cashier = await signIn(h.users.cashier.email);
    const statuses: number[] = [];
    // 100 bills, 20 in flight at a time (a busy counter + online orders).
    for (let i = 0; i < BILLS; i += 20) {
      const batch = await Promise.all(
        Array.from({ length: 20 }, () => call(cashier.accessToken, "POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] }, h.outletId)),
      );
      statuses.push(...batch.map((b) => b.status));
    }
    expect(statuses.filter((s) => s !== 201)).toEqual([]);
    for (let t = 0; t < 200 && [...counts.values()].some((c) => c.size < BILLS); t++) await wait(50);
    const elapsed = Date.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const mem1 = process.memoryUsage().rss;
    const short = [...counts.values()].filter((c) => c.size < BILLS).length;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
    const report = {
      sockets: SOCKETS,
      bills: BILLS,
      deliveries: latencies.length,
      expected: SOCKETS * BILLS,
      socketsMissingEvents: short,
      p50ms: pct(50),
      p95ms: pct(95),
      p99ms: pct(99),
      maxMs: latencies[latencies.length - 1],
      elapsedMs: elapsed,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      rssDeltaMb: Math.round((mem1 - mem0) / 1048576),
    };
    console.info("[rt-load]", JSON.stringify(report));
    expect(short).toBe(0);
    expect(latencies.length).toBe(SOCKETS * BILLS);
    expect(report.p95ms).toBeLessThan(2000);
    expect(report.rssDeltaMb).toBeLessThan(300);

    // Disconnect everything: no sockets, rooms or engine clients left behind.
    const before = io.of("/").sockets.size;
    sockets.forEach((s) => s.disconnect());
    for (let t = 0; t < 40 && io.of("/").sockets.size > before - SOCKETS; t++) await wait(50);
    expect(io.of("/").sockets.size).toBe(before - SOCKETS);
    const left = io.of("/").adapter.rooms.get(`outlet:${h.outletId}`)?.size ?? 0;
    expect(left).toBe(before - SOCKETS - [...io.of("/").sockets.values()].filter((s) => !s.rooms.has(`outlet:${h.outletId}`)).length);
    expect(io.engine.clientsCount).toBe(io.of("/").sockets.size);
  });
});

describe("5. notifications", () => {
  it("manager / staff resolution stays inside the business and outlet; super admins excluded", async () => {
    await createPlatformAdmin();
    const managers = await runForBusiness(h.businessId, () => outletManagers(h.outletId));
    expect(managers.sort()).toEqual([h.users.owner.id, h.users.manager.id].sort());
    expect(await runForBusiness(h.businessId, () => outletManagers(h.outlet2Id))).toEqual([h.users.owner.id]);
    expect(await runForBusiness(h.businessId, () => outletStaff(h.outletId, ["KITCHEN"]))).toEqual([h.users.kitchen.id]);
    expect(await runForBusiness(h.businessId, () => outletStaff(h.outletId, ["DELIVERY"]))).toEqual([h.users.delivery.id]);
    // A foreign business context can't resolve this outlet's staff (RLS).
    expect(await runForBusiness(h2.businessId, () => outletManagers(h.outletId))).toEqual([]);
  });

  it("a leave request notifies only this business's managers (live), not the requester or another hotel", async () => {
    const c = await signIn(h.users.cashier.email);
    const m = await signIn(h.users.manager.email);
    const o = await signIn(h.users.owner.email);
    const m2 = await signIn(h2.users.manager.email);
    const k = await signIn(h.users.kitchen.email);
    const [sm, so, sm2, sk, sc] = await Promise.all([live(m.accessToken, h.outletId), live(o.accessToken), live(m2.accessToken, h2.outletId), live(k.accessToken, h.outletId), live(c.accessToken, h.outletId)]);
    const ev = [sm, so, sm2, sk, sc].map((s) => receives(s, "notification", 800));
    expect((await call(c.accessToken, "POST", "/attendance/leaves", { fromDate: "2026-12-01", toDate: "2026-12-02", type: "CASUAL" }, h.outletId)).status).toBe(201);
    const [gm, go, gm2, gk, gc] = (await Promise.all(ev)) as ({ kind: string; link: string; id: string } | undefined)[];
    expect(gm).toMatchObject({ kind: "leave.request", link: "/attendance?tab=leaves", id: expect.any(String) });
    expect(go).toMatchObject({ kind: "leave.request" });
    expect([gm2, gk, gc]).toEqual([undefined, undefined, undefined]);
  });

  it("push payloads: urgent channel for urgent kinds, deep link + ids only, no secrets; prefs respected", async () => {
    const realFetch = globalThis.fetch;
    const pushes: { channelId: string; data: Record<string, unknown>; to: string; title: string; body: string }[] = [];
    const headers: Record<string, string>[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://exp.host/")) {
        headers.push(init?.headers as Record<string, string>);
        const msgs = JSON.parse(String(init?.body));
        pushes.push(...msgs);
        return new Response(JSON.stringify({ data: msgs.map(() => ({ status: "ok", id: "t" })) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url as string, init);
    });
    try {
      const k = await signIn(h.users.kitchen.email);
      const token = `ExponentPushToken[rt-${Date.now()}]`;
      expect((await call(k.accessToken, "POST", "/notifications/devices", { token, platform: "android" })).status).toBe(201);
      const send = (kind: string, link: string | null = null) =>
        runForBusiness(h.businessId, () => deliverExternal([h.users.kitchen.id], "T", "B", kind, link, h.outletId, { [h.users.kitchen.id]: { id: "n1" } }));
      for (const kind of ["kot.new", "channel.order", "order.ready", "delivery", "table.attention", "payment.received", "leave.request", "inventory.low", "report.daily"]) await send(kind);
      expect(pushes.map((p) => [p.data.kind, p.channelId])).toEqual([
        ["kot.new", "urgent"],
        ["channel.order", "urgent"], // rt-4: was "default" (mobile rings for it, the API didn't)
        ["order.ready", "urgent"],
        ["delivery", "urgent"],
        ["table.attention", "urgent"],
        ["payment.received", "urgent"],
        ["leave.request", "default"],
        ["inventory.low", "default"],
        ["report.daily", "default"],
      ]);
      for (const p of pushes) {
        expect(p.to).toBe(token);
        expect(Object.keys(p.data).sort()).toEqual(["id", "kind", "link", "outletId"]);
      }
      expect(JSON.stringify(headers)).not.toMatch(/JWT|secret/i);

      // Business preferences: kitchen tickets off for push → nothing sent; other kinds unaffected.
      pushes.length = 0;
      await db.setting.upsert({
        where: { scope_key: { scope: h.businessId, key: "notifications.prefs" } },
        create: { scope: h.businessId, key: "notifications.prefs", value: { kot: { push: false } } },
        update: { value: { kot: { push: false } } },
      });
      await send("kot.new");
      await send("leave.request");
      expect(pushes.map((p) => p.data.kind)).toEqual(["leave.request"]);
      await db.setting.delete({ where: { scope_key: { scope: h.businessId, key: "notifications.prefs" } } });
    } finally {
      spy.mockRestore();
    }
  });

  it("every default deep link is a web route and opens a mobile screen for the owner", async () => {
    const webApp = path.resolve(__dirname, "../../../web/app/(app)");
    const o = await signIn(h.users.owner.email);
    const me = (await call(o.accessToken, "GET", "/auth/me")).body as { permissions: string[]; business?: { modules: string[] } };
    const profile = { permissions: me.permissions, modules: me.business?.modules ?? null };
    const unrouted: string[] = [];
    for (const [kind, link] of DEFAULT_LINKS) {
      expect(fs.existsSync(path.join(webApp, link.split("?")[0].split("/")[1])), `${kind} → ${link}`).toBe(true);
      if (!routeForNotification({ link, kind }, profile)) unrouted.push(kind);
    }
    expect(unrouted).toEqual([]);
  });

  it("read state syncs to the user's other tabs only; unread and clear are forwarded as such", async () => {
    const m = await signIn(h.users.manager.email);
    const other = await signIn(h.users.cashier.email);
    const tab1 = await live(m.accessToken, h.outletId);
    const tab2 = await live(m.accessToken, h.outletId);
    const stranger = await live(other.accessToken, h.outletId);
    const n = await db.notification.create({ data: { userId: h.users.manager.id, title: "x", body: "y", kind: "report.daily" } });
    const r1 = [receives(tab2, "notification:read"), receives(stranger, "notification:read")];
    expect((await call(m.accessToken, "POST", `/notifications/${n.id}/read`)).body).toMatchObject({ unread: expect.any(Number) });
    expect(await Promise.all(r1)).toEqual([{ id: n.id }, undefined]);
    const r2 = receives(tab2, "notification:read");
    await call(m.accessToken, "POST", `/notifications/${n.id}/unread`);
    expect(await r2).toEqual({ id: n.id, read: false });
    await call(m.accessToken, "POST", `/notifications/${n.id}/read`);
    const r3 = receives(tab1, "notification:read");
    await call(m.accessToken, "DELETE", "/notifications/read");
    expect(await r3).toEqual({ cleared: true });
    // Another user can't mark this user's notification.
    const n2 = await db.notification.create({ data: { userId: h.users.manager.id, title: "x", body: "y", kind: "report.daily" } });
    expect((await call(other.accessToken, "POST", `/notifications/${n2.id}/read`)).status).toBe(404);
  });
});
