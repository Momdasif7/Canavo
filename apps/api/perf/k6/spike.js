// Spike: 50 → 400 cashiers in 10 s (festival rush / everyone reconnecting after an outage), hold 1 min, back to 50.
// Watch error rate and how fast p95 recovers after the spike.
import { sleep } from "k6";
import { cashierBill } from "./lib.js";

export const options = {
  scenarios: {
    cashiers: { executor: "ramping-vus", startVUs: 50,
      stages: [{ target: 50, duration: "1m" }, { target: Number(__ENV.SPIKE || 400), duration: "10s" }, { target: Number(__ENV.SPIKE || 400), duration: "1m" }, { target: 50, duration: "10s" }, { target: 50, duration: "1m30s" }] },
  },
  thresholds: { bill_create: ["p(95)<2000"], http_req_failed: ["rate<0.01"] },
};
export default function () {
  cashierBill();
  sleep(1);
}
