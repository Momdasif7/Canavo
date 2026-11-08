// Shared helpers for the CANAVO k6 scenarios (see README.md). Dataset: perf/seed.sql (50 hotels, out1..out50).
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend } from "k6/metrics";

export const BASE = __ENV.BASE_URL || "http://host.docker.internal:4200";
export const PASSWORD = __ENV.PERF_PASSWORD || "Perf@12345";
export const HOTELS = Number(__ENV.HOTELS || 50);

export const billCreate = new Trend("bill_create", true);
export const billPay = new Trend("bill_pay", true);
export const menuLoadT = new Trend("menu_load", true);
export const kdsPollT = new Trend("kds_poll", true);
export const reportT = new Trend("report_1y", true);
export const loginT = new Trend("login", true);
export const importT = new Trend("menu_import", true);
export const onlineMenuT = new Trend("online_menu", true);

/**
 * Many hotels sit behind one load generator, so each virtual device sends its own client address in
 * X-Forwarded-For (the API trusts loopback / private proxies, as behind a real load balancer) —
 * otherwise the per-IP login limit (50 / 15 min) would be measured instead of the API.
 */
export const fakeIp = (n) => `100.${64 + ((n >> 16) & 63)}.${(n >> 8) & 255}.${n & 255}`;

export function login(email, ipSeed) {
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { "content-type": "application/json", "x-forwarded-for": fakeIp(ipSeed) },
    tags: { name: "POST /auth/login" },
  });
  loginT.add(r.timings.duration);
  if (!check(r, { "login 200": (x) => x.status === 200 })) return null;
  return r.json("accessToken");
}

export const authHeaders = (token, outlet) => ({
  authorization: `Bearer ${token}`,
  "x-outlet-id": `out${outlet}`,
  "content-type": "application/json",
});

/** Per-VU session (module scope = one per VU). */
const session = { token: null, outlet: 0, items: null, at: 0 };

/** VU n → outlet 1..HOTELS and one of its staff (role offset: 1 owner, 2..8 cashier, 9..14 kitchen). */
export function staffSession(roleFrom, roleCount) {
  const vu = __VU;
  const outlet = ((vu - 1) % HOTELS) + 1;
  const staff = roleFrom + (Math.floor((vu - 1) / HOTELS) % roleCount);
  // Access tokens live 15 min: log in again after 12 (long soak runs).
  if (!session.token || Date.now() - session.at > 12 * 60_000) {
    session.token = login(`u${outlet}_${staff}@perf.local`, vu * 7 + staff);
    session.outlet = outlet;
    session.at = Date.now();
    if (!session.token) {
      sleep(1);
      return null;
    }
  }
  return session;
}

export function loadMenu(s) {
  const r = http.get(`${BASE}/menu`, { headers: authHeaders(s.token, s.outlet), tags: { name: "GET /menu" } });
  menuLoadT.add(r.timings.duration);
  check(r, { "menu 200": (x) => x.status === 200 });
  if (r.status === 200) s.items = r.json("items").filter((i) => i.status === "AVAILABLE").map((i) => i.id);
  return r;
}

/** One counter bill: create (takeaway, 1–5 lines) then pay it in full by UPI/card. */
export function cashierBill() {
  const s = staffSession(2, 7);
  if (!s) return;
  if (!s.items || !s.items.length) loadMenu(s);
  if (!s.items || !s.items.length) return void sleep(1);
  const lines = [];
  const n = 1 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) lines.push({ menuItemId: s.items[Math.floor(Math.random() * s.items.length)], quantity: 1 + Math.floor(Math.random() * 3) });
  const uniq = Object.values(Object.fromEntries(lines.map((l) => [l.menuItemId, l])));
  const c = http.post(`${BASE}/orders`, JSON.stringify({ orderType: "TAKEAWAY", items: uniq }), {
    headers: authHeaders(s.token, s.outlet),
    tags: { name: "POST /orders" },
  });
  billCreate.add(c.timings.duration);
  if (!check(c, { "bill created": (x) => x.status === 201 })) return;
  const order = c.json();
  const p = http.post(
    `${BASE}/orders/${order.id}/payments`,
    JSON.stringify({ payments: [{ mode: Math.random() < 0.6 ? "UPI" : "CARD", amount: order.grandTotal }] }),
    { headers: authHeaders(s.token, s.outlet), tags: { name: "POST /orders/:id/payments" } },
  );
  billPay.add(p.timings.duration);
  check(p, { "bill paid": (x) => x.status === 200 || x.status === 201 });
}

/** Kitchen display without sockets: poll the open tickets. */
export function kdsPoll() {
  const s = staffSession(9, 6);
  if (!s) return;
  const r = http.get(`${BASE}/kot`, { headers: authHeaders(s.token, s.outlet), tags: { name: "GET /kot" } });
  kdsPollT.add(r.timings.duration);
  check(r, { "kot 200": (x) => x.status === 200 });
}

/** POS start-up / refresh: the full menu for the outlet. */
export function menuOnly() {
  const s = staffSession(2, 7);
  if (s) loadMenu(s);
}

const ymd = (d) => d.toISOString().slice(0, 10);
export const REPORTS = ["sales", "items", "categories", "gst", "profit", "staff", "customers", "peak-hours"];

/** Owner opens a 1-year report. */
export function yearReport() {
  const s = staffSession(1, 1);
  if (!s) return;
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 365 * 86_400_000));
  const kind = REPORTS[Math.floor(Math.random() * REPORTS.length)];
  const r = http.get(`${BASE}/reports/${kind}?from=${from}&to=${to}&groupBy=month`, {
    headers: authHeaders(s.token, s.outlet),
    tags: { name: `GET /reports/${kind} 1y` },
    timeout: "60s",
  });
  reportT.add(r.timings.duration, { report: kind });
  check(r, { "report 200": (x) => x.status === 200 });
}

/** Customer opens the online ordering page (public, no login). */
export function onlineMenu() {
  const outlet = 1 + Math.floor(Math.random() * HOTELS);
  const r = http.get(`${BASE}/public/o/hotel-${outlet}`, {
    headers: { "x-forwarded-for": fakeIp(10_000 + __VU * 31 + (__ITER % 31)) },
    tags: { name: "GET /public/o/:slug" },
  });
  onlineMenuT.add(r.timings.duration);
  check(r, { "online menu 200": (x) => x.status === 200 });
}

export const need = (cond, msg) => cond || fail(msg);
