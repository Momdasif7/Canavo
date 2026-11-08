// Soak: normal busy-day load for a long time (DURATION, default 40m; production check: DURATION=8h).
// Run perf/soak-watch.sh alongside to sample API RSS / heap, DB connections and socket counts.
import { sleep } from "k6";
import { cashierBill, kdsPoll, onlineMenu, yearReport } from "./lib.js";

const D = __ENV.DURATION || "40m";
export const options = {
  scenarios: {
    cashiers: { executor: "constant-vus", vus: 50, duration: D, exec: "cashier" },
    kitchen: { executor: "constant-vus", vus: 50, duration: D, exec: "kitchen" },
    online: { executor: "constant-arrival-rate", rate: 2, timeUnit: "1s", duration: D, preAllocatedVUs: 10, exec: "online" },
    owners: { executor: "constant-vus", vus: 2, duration: D, exec: "owner" },
  },
  thresholds: { bill_create: ["p(95)<500"], kds_poll: ["p(95)<300"], report_1y: ["p(95)<3000"], http_req_failed: ["rate<0.001"] },
};
export function cashier() {
  cashierBill();
  sleep(2 + Math.random() * 3);
}
export function kitchen() {
  kdsPoll();
  sleep(5);
}
export function online() {
  onlineMenu();
}
export function owner() {
  yearReport();
  sleep(30);
}
