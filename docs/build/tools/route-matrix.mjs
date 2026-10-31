// Route × permission × module matrix, generated from the API source.
//   node docs/build/tools/route-matrix.mjs   (after: npm run build -w @canavo/shared)
// Writes docs/build/route-matrix.csv and prints a summary. Static analysis only:
// guards added in handler bodies (e.g. canSee(), role checks) are noted as "in-handler".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const require = createRequire(import.meta.url);
const shared = require(path.join(root, "packages/shared/dist/index.js"));
const { PERMISSION_MODULE, ROLE_PERMISSIONS, ROLES } = shared;

const app = fs.readFileSync(path.join(root, "apps/api/src/app.ts"), "utf8");
const mounts = {};
for (const m of app.matchAll(/app\.use\("([^"]+)",\s*(\w+Router)\)/g)) mounts[m[2]] = m[1];
// Routers mounted without a prefix (public router)
for (const m of app.matchAll(/app\.use\((\w+Router)\)/g)) mounts[m[1]] = "";

const dir = path.join(root, "apps/api/src/routes");
const rows = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const routerName = (src.match(/export const (\w+Router) = Router\(\)/) ?? [])[1];
  if (!routerName) continue;
  const prefix = mounts[routerName] ?? `?(${routerName})`;
  // Router-level middleware applies only to routes declared AFTER the .use() call.
  const uses = [...src.matchAll(new RegExp(`${routerName}\\.use\\(([\\s\\S]*?)\\);\\n`, "g"))].map((m) => ({ at: m.index, text: m[1] }));
  const stateAt = (idx) => {
    const t = uses.filter((u) => u.at < idx).map((u) => u.text).join(" ");
    return {
      auth: /authenticate/.test(t),
      outlet: /requireOutlet/.test(t),
      business: /requireBusiness/.test(t),
      platform: /requirePlatformAdmin/.test(t),
      modules: [...t.matchAll(/require(?:Any)?Module\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1])),
      perms: [...t.matchAll(/requirePermission\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])),
    };
  };
  // Named middleware constants like `const manage = requirePermission("inventory:manage")`
  const named = {};
  for (const m of src.matchAll(/const (\w+) = requirePermission\(([^)]*)\)/g)) named[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  for (const m of src.matchAll(new RegExp(`${routerName}\\.(get|post|put|patch|delete)\\(\\s*([\`"])([^\`"]+)\\2([^\\n]*)`, "g"))) {
    const [, method, , p, rest] = m;
    const st = stateAt(m.index);
    const routerAuth = st.auth, routerOutlet = st.outlet, routerPlatform = st.platform, routerModules = st.modules;
    const head = rest.split(/async\s*\(|\(req|\(_req/)[0];
    const perms = [...st.perms, ...[...head.matchAll(/requirePermission\(([^)]*)\)/g)].flatMap((x) => [...x[1].matchAll(/"([^"]+)"/g)].map((y) => y[1]))];
    for (const [k, v] of Object.entries(named)) if (new RegExp(`[,(\\s]${k}[,\\s)]`).test(head)) perms.push(...v);
    const extra = [];
    if (/requireSettingsAccess/.test(head)) extra.push("settings:outlet|platform(GLOBAL)");
    const modules = [...new Set([...routerModules, ...perms.map((q) => PERMISSION_MODULE[q]).filter(Boolean)])];
    const roles = perms.length ? ROLES.filter((r) => perms.every((q) => ROLE_PERMISSIONS[r].includes(q))) : [];
    rows.push({
      route: `${method.toUpperCase()} ${prefix}${p === "/" ? "" : p}`.replace(/\$\{key\}/, ":reportKey"),
      file,
      auth: routerAuth || /authenticate/.test(head) ? "yes" : "NO",
      outlet: routerOutlet || /requireOutlet/.test(head) ? "yes" : st.business || /requireBusiness/.test(head) ? "business" : "",
      platformOnly: routerPlatform ? "yes" : "",
      permissions: [...perms, ...extra].join(" + ") || (routerPlatform ? "(platform admin)" : routerAuth ? "(any logged-in user / in-handler)" : "(public)"),
      modules: modules.join(" | "),
      roles: routerPlatform ? "SUPER_ADMIN (platform)" : roles.join(" ") || (perms.length ? "none" : "all"),
    });
  }
}
rows.sort((a, b) => a.route.localeCompare(b.route));
const out = path.join(root, "docs/build/route-matrix.csv");
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
fs.writeFileSync(out, ["Route,File,Auth,Outlet scope,Platform only,Permissions,Modules,Roles allowed", ...rows.map((r) => [r.route, r.file, r.auth, r.outlet, r.platformOnly, r.permissions, r.modules, r.roles].map(esc).join(","))].join("\n") + "\n");
const pub = rows.filter((r) => r.auth === "NO");
const noPerm = rows.filter((r) => r.auth === "yes" && r.permissions.startsWith("(any"));
console.log(JSON.stringify({ routes: rows.length, publicRoutes: pub.map((r) => r.route), authNoPermission: noPerm.map((r) => r.route) }, null, 1));
