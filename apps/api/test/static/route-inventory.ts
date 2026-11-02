/**
 * Route inventory: walks the real Express app (not a regex over the source) and
 * records, for every endpoint, the middleware chain that runs before its
 * handler — router-level `use` layers whose path matches, plus route-level
 * middleware. Used by route-guards.test.ts and scripts/route-inventory.
 */
import fs from "node:fs";
import path from "node:path";
import type { GuardInfo } from "../../src/middleware/auth";

type Fn = ((...a: unknown[]) => unknown) & { guard?: GuardInfo; stack?: Layer[] };
interface Layer {
  name: string;
  handle: Fn;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
  match(path: string): boolean;
}

export interface RouteEntry {
  method: string;
  path: string;
  router: string;
  authenticate: boolean;
  outlet: "required" | "if-given" | "none";
  platformAdmin: boolean;
  business: boolean;
  permissions: string[];
  modules: string[];
  /** Other named guard-like middleware (requireX / *Whitelist / etc.) */
  custom: string[];
  /** Middleware we can't classify (anonymous closures) — review by hand */
  anonymous: number;
  /** How the route is protected beyond authentication */
  authz: "permission" | "platform-admin" | "custom" | "none";
}

const KNOWN_NAMED: Record<string, (e: RouteEntry) => void> = {
  authenticate: (e) => (e.authenticate = true),
  requireOutlet: (e) => (e.outlet = "required"),
  outletIfGiven: (e) => (e.outlet = e.outlet === "required" ? "required" : "if-given"),
  requirePlatformAdmin: (e) => (e.platformAdmin = true),
  requireBusiness: (e) => (e.business = true),
};
/** Not guards: body parsers, upload handlers, rate limiters. */
const NON_GUARD = /^(jsonParser|rawParser|multerMiddleware|rateLimit|bound dispatch|router|handle)$/;

function sample(p: string) {
  return p.replace(/:(\w+)/g, "x").replace(/\*\w*/g, "x");
}

function classify(e: RouteEntry, fn: Fn) {
  if (fn.guard?.kind === "permission") e.permissions.push(...fn.guard.permissions);
  else if (fn.guard?.kind === "module") e.modules.push(...fn.guard.modules);
  else if (KNOWN_NAMED[fn.name]) KNOWN_NAMED[fn.name](e);
  else if (!fn.name || fn.name === "<anonymous>") e.anonymous++;
  else if (!NON_GUARD.test(fn.name)) e.custom.push(fn.name);
}

function walk(router: Fn, prefix: string, routerName: string, inherited: Fn[], out: RouteEntry[]) {
  const stack = router.stack ?? [];
  stack.forEach((layer, i) => {
    if (!layer.route) return;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const p of paths) {
      // router-level `use` layers BEFORE this route whose path matches it
      const uses = stack.slice(0, i).filter((l) => !l.route && l.match(sample(p))).map((l) => l.handle);
      const chain = [...inherited, ...uses, ...layer.route.stack.slice(0, -1).map((l) => l.handle)];
      for (const method of Object.keys(layer.route.methods)) {
        const e: RouteEntry = {
          method: method.toUpperCase(),
          path: (prefix + p).replace(/\/$/, "") || "/",
          router: routerName,
          authenticate: false,
          outlet: "none",
          platformAdmin: false,
          business: false,
          permissions: [],
          modules: [],
          custom: [],
          anonymous: 0,
          authz: "none",
        };
        chain.forEach((fn) => classify(e, fn));
        // Route-level stack: every layer except the last is middleware; the
        // last is the handler. Count only guards appearing before it.
        e.authz = e.platformAdmin ? "platform-admin" : e.permissions.length ? "permission" : e.custom.length || e.anonymous ? "custom" : "none";
        out.push(e);
      }
    }
  });
}

/** Mount prefixes are read from app.ts (`app.use("/x", xRouter)`), routers from their modules. */
export async function routeInventory(): Promise<RouteEntry[]> {
  const appSrc = fs.readFileSync(path.join(__dirname, "../../src/app.ts"), "utf8");
  const mounts = [...appSrc.matchAll(/app\.use\(\s*(?:"([^"]+)"\s*,\s*)?(\w+Router)\s*\)/g)].map((m) => ({
    prefix: m[1] ?? "",
    name: m[2],
  }));
  const imports = [...appSrc.matchAll(/import \{ (\w+Router) \} from "\.\/routes\/([\w-]+)"/g)];
  const out: RouteEntry[] = [];
  for (const { prefix, name } of mounts) {
    const file = imports.find((m) => m[1] === name)?.[2];
    if (!file) throw new Error(`Cannot find module for ${name}`);
    const mod = await import(`../../src/routes/${file}`);
    walk(mod[name], prefix, file, [], out);
  }
  // app-level routes registered directly on the app
  for (const m of appSrc.matchAll(/app\.get\("([^"]+)"/g)) {
    out.push({ method: "GET", path: m[1], router: "app", authenticate: false, outlet: "none", platformAdmin: false, business: false, permissions: [], modules: [], custom: [], anonymous: 0, authz: "none" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
