/**
 * Global teardown for the duplicate-button sweep: turns e2e/.sweep/results/*.json
 * into docs/qa/ui-duplicate-sweep-results.md (generated; the hand-written analysis
 * lives in docs/qa/ui-duplicate-sweep.md).
 */
import fs from "node:fs";
import path from "node:path";
import type { PageResult } from "./duplicate-buttons.spec";

const WEB_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(WEB_ROOT, "e2e/.sweep/results");
const OUT = path.resolve(WEB_ROOT, "../../docs/qa/ui-duplicate-sweep-results.md");

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export default function report() {
  if (!fs.existsSync(RESULTS_DIR)) return;
  const all: PageResult[] = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8")) as PageResult[]);
  if (!all.length) return;

  const roles = [...new Set(all.map((r) => r.role))];
  const vps = [...new Set(all.map((r) => r.viewport))];
  const count = (pred: (r: PageResult) => boolean) => all.filter(pred).length;
  const groups = all.flatMap((r) => r.duplicates.map((d) => ({ r, d })));
  const dup = groups.filter((g) => g.d.status === "duplicate");
  const left = groups.filter((g) => g.d.status === "left");
  const allowed = groups.filter((g) => g.d.status === "allowlisted");
  const withErrors = all.filter((r) => r.consoleErrors.length);

  const L: string[] = [];
  L.push("# UI duplicate-button sweep — results (generated)");
  L.push("");
  L.push(`Generated ${new Date().toISOString()} by \`npm run test:e2e:sweep -w @canavo/web\`. Do not edit by hand; see [ui-duplicate-sweep.md](./ui-duplicate-sweep.md) for the analysis.`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`- Page visits: **${all.length}** (${roles.length} roles × ${vps.length} viewports × routes)`);
  L.push(`- Pages rendered and checked: **${count((r) => r.state === "ok")}**; not available for the role: ${count((r) => r.state === "denied")}; platform-only / needs a business: ${count((r) => r.state === "platform-only")}; module off: ${count((r) => r.state === "module-off")}; dynamic page without data: ${count((r) => r.state === "no-instance")}; navigation errors: ${count((r) => r.state === "error")}`);
  L.push(`- Interactive elements inspected: **${all.reduce((n, r) => n + r.elements, 0)}** (unnamed: ${all.reduce((n, r) => n + r.unnamed, 0)})`);
  L.push(`- Duplicate groups: **${dup.length} unexplained**, ${left.length} left (known, other workstreams), ${allowed.length} allowlisted`);
  L.push(`- Page visits with console errors: **${withErrors.length}**`);
  L.push("");

  L.push("## Coverage (pages checked per role × viewport)");
  L.push("");
  L.push(`| Role | ${vps.map((v) => `${v} ok / visited`).join(" | ")} |`);
  L.push(`|---|${vps.map(() => "---").join("|")}|`);
  for (const role of roles) {
    L.push(`| ${role} | ${vps.map((v) => `${count((r) => r.role === role && r.viewport === v && r.state === "ok")} / ${count((r) => r.role === role && r.viewport === v)}`).join(" | ")} |`);
  }
  L.push("");

  const section = (title: string, list: typeof groups, withReason: boolean) => {
    L.push(`## ${title} (${list.length})`);
    L.push("");
    if (!list.length) {
      L.push("None.");
      L.push("");
      return;
    }
    L.push(`| Role | Viewport | Page | Name | × | Where${withReason ? " | Reason" : ""} |`);
    L.push(`|---|---|---|---|---|---${withReason ? "|---" : ""}|`);
    for (const { r, d } of list) {
      const where = d.elements.map((e) => `${e.tag}${e.href ? ` → ${e.href}` : ""} in ${e.region}${e.context ? ` ("${e.context}")` : ""}`).join("; ");
      L.push(`| ${r.role} | ${r.viewport} | ${r.url} | ${esc(d.name)} | ${d.count} | ${esc(where)}${withReason ? ` | ${esc(d.reason ?? "")}` : ""} |`);
    }
    L.push("");
  };
  section("Unexplained duplicates", dup, false);
  section("Left (known, documented)", left, true);

  L.push(`## Allowlisted repeats (${allowed.length})`);
  L.push("");
  const byKey = new Map<string, { reason: string; pages: Set<string>; n: number }>();
  for (const { r, d } of allowed) {
    const k = `${d.name}\u0000${d.reason}`;
    const e = byKey.get(k) ?? { reason: d.reason ?? "", pages: new Set<string>(), n: 0 };
    e.pages.add(r.route);
    e.n++;
    byKey.set(k, e);
  }
  L.push("| Name | Reason | Pages | Occurrences |");
  L.push("|---|---|---|---|");
  for (const [k, e] of [...byKey].sort((a, b) => b[1].n - a[1].n)) L.push(`| ${esc(k.split("\u0000")[0])} | ${esc(e.reason)} | ${[...e.pages].sort().join(", ")} | ${e.n} |`);
  L.push("");

  L.push(`## Console errors (${withErrors.length} page visits)`);
  L.push("");
  if (!withErrors.length) L.push("None.");
  else {
    const byMsg = new Map<string, Set<string>>();
    for (const r of withErrors) for (const m of r.consoleErrors) byMsg.set(m, (byMsg.get(m) ?? new Set()).add(`${r.role}@${r.viewport} ${r.url}`));
    L.push("| Error | Seen on |");
    L.push("|---|---|");
    for (const [m, where] of byMsg) {
      const w = [...where];
      L.push(`| ${esc(m.slice(0, 200))} | ${esc(w.slice(0, 6).join(", "))}${w.length > 6 ? ` … (+${w.length - 6})` : ""} |`);
    }
  }
  L.push("");

  const errs = all.filter((r) => r.state === "error" || r.state === "no-instance");
  if (errs.length) {
    L.push("## Not checked");
    L.push("");
    for (const r of errs) L.push(`- ${r.role} @ ${r.viewport} ${r.route}: ${r.state}${r.note ? ` — ${esc(r.note)}` : ""}`);
    L.push("");
  }

  L.push("## All page visits");
  L.push("");
  L.push("| Role | Viewport | Route | State | Elements | Duplicates (unexplained / left / allowlisted) |");
  L.push("|---|---|---|---|---|---|");
  for (const r of all) {
    const c = (s: string) => r.duplicates.filter((d) => d.status === s).length;
    L.push(`| ${r.role} | ${r.viewport} | ${r.url} | ${r.state} | ${r.elements} | ${c("duplicate")} / ${c("left")} / ${c("allowlisted")} |`);
  }
  L.push("");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, L.join("\n"));
  console.log(`[sweep] ${all.length} page visits, ${dup.length} unexplained duplicates, ${left.length} left, ${allowed.length} allowlisted → ${path.relative(process.cwd(), OUT)}`);
}
