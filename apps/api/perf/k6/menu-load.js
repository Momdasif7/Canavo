// Menu load: POS devices opening / refreshing the menu (120 items per hotel) + the public online menu.
// Target: p95 < 300 ms.
import { sleep } from "k6";
import { menuOnly, onlineMenu } from "./lib.js";

export const options = {
  scenarios: {
    pos: { executor: "constant-vus", vus: 100, duration: __ENV.DURATION || "2m", exec: "pos" },
    online: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: __ENV.DURATION || "2m", preAllocatedVUs: 30, exec: "online" },
  },
  thresholds: { menu_load: ["p(95)<300"], online_menu: ["p(95)<300"], http_req_failed: ["rate<0.001"] },
};
export function pos() {
  menuOnly();
  sleep(0.5);
}
export function online() {
  onlineMenu();
}
