// Stress: ramp counter traffic (cashier VUs with 1 s think time) + kitchen polling until it breaks.
// Breaking point = first stage where p95 bill create > 2 s or errors > 1 % (abortOnFail stops the run).
import { sleep } from "k6";
import { cashierBill, kdsPoll } from "./lib.js";

const MAX = Number(__ENV.MAX_VUS || 700);
export const options = {
  scenarios: {
    cashiers: { executor: "ramping-vus", exec: "cashier", startVUs: 50,
      stages: [50, 100, 200, 300, 400, 500, MAX].map((t) => ({ target: t, duration: "90s" })) },
    kitchen: { executor: "constant-vus", exec: "kitchen", vus: 50, duration: "10m30s" },
  },
  thresholds: {
    bill_create: [{ threshold: "p(95)<2000", abortOnFail: true, delayAbortEval: "60s" }],
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "60s" }],
  },
};
export function cashier() {
  cashierBill();
  sleep(1);
}
export function kitchen() {
  kdsPoll();
  sleep(3);
}
