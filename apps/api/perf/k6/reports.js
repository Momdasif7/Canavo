// Heavy reports: owners of the 10 busiest hotels (outlet 1 ≈ 75k bills / year) opening 1-year reports
// while the lunch rush runs. Target: p95 < 3 s.
import { sleep } from "k6";
import { cashierBill, yearReport } from "./lib.js";

export const options = {
  scenarios: {
    owners: { executor: "constant-vus", vus: Number(__ENV.OWNERS || 10), duration: __ENV.DURATION || "3m", exec: "owner" },
    cashiers: { executor: "constant-vus", vus: 50, duration: __ENV.DURATION || "3m", exec: "cashier" },
  },
  thresholds: { report_1y: ["p(95)<3000"], bill_create: ["p(95)<500"], http_req_failed: ["rate<0.001"] },
};
export function owner() {
  yearReport();
  sleep(2);
}
export function cashier() {
  cashierBill();
  sleep(1 + Math.random() * 2);
}
