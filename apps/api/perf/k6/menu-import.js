// Bulk menu upload: 20 hotel owners each upload a 500-row menu sheet (CSV, the import template's columns)
// with ?apply=1, twice (second pass = 500 updates). Target: p95 < 10 s, no errors.
import http from "k6/http";
import { check } from "k6";
import { BASE, importT, staffSession } from "./lib.js";

export const options = {
  scenarios: { owners: { executor: "per-vu-iterations", vus: Number(__ENV.OWNERS || 20), iterations: 2, maxDuration: "5m" } },
  thresholds: { menu_import: ["p(95)<10000"], http_req_failed: ["rate<0.001"] },
};
const header = "Category *,Sub-category,Item name *,Price (₹) *,Sizes,GST %,Food type,Kitchen station,Description,Image URL,Available,Ingredients (stock used per item)";
export default function () {
  const s = staffSession(1, 1);
  if (!s) return;
  const rows = [header];
  for (let i = 1; i <= Number(__ENV.ROWS || 500); i++) rows.push(`Bulk ${1 + (i % 15)},,Bulk item ${i},${50 + (i % 300) + __ITER},,5,Veg,MAIN,Imported,,Yes,`);
  const r = http.post(`${BASE}/menu/import?apply=1`, { file: http.file(rows.join("\n"), "menu.csv", "text/csv") }, {
    headers: { authorization: `Bearer ${s.token}`, "x-outlet-id": `out${s.outlet}` },
    tags: { name: "POST /menu/import" },
    timeout: "120s",
  });
  importT.add(r.timings.duration);
  check(r, { "import 200": (x) => x.status === 200 });
}
