// Lunch rush: 50 cashiers (one per hotel) creating + paying bills, 50 kitchen screens polling,
// customers opening the online menu. Targets: p95 bill create < 500 ms, errors < 0.1 %.
import { sleep } from "k6";
import { cashierBill, kdsPoll, onlineMenu } from "./lib.js";

const DURATION = __ENV.DURATION || "5m";
export const options = {
  scenarios: {
    cashiers: { executor: "constant-vus", vus: Number(__ENV.CASHIERS || 50), duration: DURATION, exec: "cashier" },
    kitchen: { executor: "constant-vus", vus: 50, duration: DURATION, exec: "kitchen", startTime: "2s" },
    online: { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: DURATION, preAllocatedVUs: 20, exec: "online" },
  },
  thresholds: {
    bill_create: ["p(95)<500"],
    kds_poll: ["p(95)<300"],
    online_menu: ["p(95)<300"],
    http_req_failed: ["rate<0.001"],
  },
};

export function cashier() {
  cashierBill();
  sleep(1 + Math.random() * 2); // a busy counter: a bill every ~2–4 s
}
export function kitchen() {
  kdsPoll();
  sleep(3);
}
export function online() {
  onlineMenu();
}
