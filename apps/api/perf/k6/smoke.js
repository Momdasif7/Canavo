// k6 SMOKE profile (QA Phase 16, CI): a few virtual users for 30 s against a freshly seeded API (demo seed,
// prisma/seed.ts) — not a load test. Proves the hot paths answer and stay fast on every PR:
// /health, /ready, login, outlets, menu, bill list.
//   docker run --rm --network host -v "$PWD":/s -w /s -e BASE_URL=http://localhost:4000 grafana/k6 run smoke.js
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:4000";
const EMAIL = __ENV.SMOKE_EMAIL || "cashier@canavo.local";
const PASSWORD = __ENV.SMOKE_PASSWORD || "Canavo@123";

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "30s",
  thresholds: { http_req_failed: ["rate<0.01"], "http_req_duration{kind:api}": ["p(95)<500"], checks: ["rate>0.99"] },
};

export function setup() {
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), { headers: { "content-type": "application/json" } });
  check(r, { "login 200": (x) => x.status === 200 });
  const token = r.json("accessToken");
  const outlets = http.get(`${BASE}/outlets`, { headers: { authorization: `Bearer ${token}` } });
  check(outlets, { "outlets 200": (x) => x.status === 200 });
  const list = outlets.json();
  const outletId = list[0] && list[0].id;
  return { token, outletId };
}

export default function ({ token, outletId }) {
  const h = { headers: { authorization: `Bearer ${token}`, "x-outlet-id": outletId }, tags: { kind: "api" } };
  check(http.get(`${BASE}/health`), { "health 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/ready`), { "ready 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/menu`, h), { "menu 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/orders`, h), { "orders 200": (r) => r.status === 200 });
  sleep(1);
}
