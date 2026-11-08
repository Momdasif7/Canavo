// Login storm: every staff member of all 50 hotels (1,000 people) signs in within ~1 minute
// (shift start / app update). bcrypt cost 10 per login. Target: p95 < 1 s, errors < 0.1 %.
import { login, HOTELS } from "./lib.js";

export const options = {
  scenarios: {
    storm: { executor: "ramping-arrival-rate", startRate: 5, timeUnit: "1s", preAllocatedVUs: 100, maxVUs: 400,
      stages: [{ target: Number(__ENV.PEAK || 30), duration: "20s" }, { target: Number(__ENV.PEAK || 30), duration: "40s" }, { target: 0, duration: "10s" }] },
  },
  thresholds: { login: ["p(95)<1000"], http_req_failed: ["rate<0.001"] },
};
export default function () {
  const n = __ITER + __VU * 100000; // unique per iteration
  const staff = (__ITER % 1000);
  login(`u${1 + (staff % HOTELS)}_${1 + Math.floor(staff / HOTELS) % 20}@perf.local`, n);
}
