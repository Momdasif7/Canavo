/**
 * UI sweep: duplicate buttons (same accessible name twice in view) on every page,
 * for every seeded role, at desktop (1440×900) and phone (390×844).
 *
 *   npm run test:e2e:sweep -w @canavo/web      (app must be running, see playwright.config.ts)
 *
 * For each role: log in through the UI, visit every route of the (app) tree (the
 * nav entries in components/layout/nav.ts + components/admin/nav.ts are all part of
 * it, plus sub-pages such as /tables/qr-codes and resolved dynamic pages), and on each
 * page collect the VISIBLE interactive elements grouped by accessible name. A name
 * shown by 2+ visible elements is a duplicate unless the allowlist in sweep-config.ts
 * explains it. Console errors are recorded per page as well. Results land in
 * e2e/.sweep/results/*.json; the global teardown writes docs/qa/ui-duplicate-sweep-results.md.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DYNAMIC_ROUTES, KNOWN_LEFT, NAMED_ALLOWLIST, PAGINATION_NAMES, PER_ITEM_MIN_SIBLINGS, PUBLIC_ROUTES, ROLES, VIEWPORTS, type SweepRole } from "./sweep-config";

const WEB_ROOT = path.resolve(__dirname, "..");
export const RESULTS_DIR = path.join(WEB_ROOT, "e2e/.sweep/results");
const PASSWORD = process.env.SWEEP_PASSWORD ?? "Canavo@123";

// ---------------------------------------------------------------- routes

/** Every page under app/(app) as a route pattern ("/customers/[id]", "/tables/qr-codes", …). */
function appRoutes(): string[] {
  const base = path.join(WEB_ROOT, "app/(app)");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name === "page.tsx") {
        const rel = path.relative(base, dir).split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
        out.push(`/${rel.join("/")}`);
      }
    }
  };
  walk(base);
  return out;
}

/** hrefs of the sidebar / tab nav (nav.ts + admin/nav.ts) — all must be in the route list. */
function navHrefs(): string[] {
  const files = ["components/layout/nav.ts", "components/admin/nav.ts"].map((f) => fs.readFileSync(path.join(WEB_ROOT, f), "utf8"));
  return [...new Set(files.flatMap((src) => [...src.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1])))];
}

const ROUTES = (() => {
  const all = new Set([...navHrefs(), ...appRoutes()]);
  return [...all].sort();
})();

// ---------------------------------------------------------------- page probe

interface Probe {
  name: string;
  tag: string;
  href: string | null;
  region: string;
  context: string;
  items: string[];
  inRow: boolean;
}

/** Runs in the page: visible interactive elements with accessible name and structure info. */
function probePage(minSiblings: number): Probe[] {
  const ids = new WeakMap<Element, number>();
  let next = 1;
  const pid = (el: Element) => {
    if (!ids.has(el)) ids.set(el, next++);
    return ids.get(el)!;
  };
  const text = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const accName = (el: Element): string => {
    const label = el.getAttribute("aria-label");
    if (label?.trim()) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(" ")
        .trim();
      if (t) return t;
    }
    const own = text(el);
    if (own) return own;
    const img = el.querySelector("img[alt], svg[aria-label]");
    const alt = img?.getAttribute("alt") ?? img?.getAttribute("aria-label");
    if (alt) return alt;
    return (el.getAttribute("title") ?? "").trim();
  };
  const visible = (el: Element) => {
    const h = el as HTMLElement;
    if (typeof h.checkVisibility === "function" && !h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true } as never)) return false;
    const r = h.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false; // sr-only / collapsed
    if (r.right <= 0 || r.left >= window.innerWidth) return false; // off-canvas drawer
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    return true;
  };
  const region = (el: Element) => {
    const r = el.closest('[role="dialog"], dialog, nav, aside, header, main, footer');
    if (!r) return "page";
    const lbl = r.getAttribute("aria-label");
    return `${r.tagName.toLowerCase()}${r.getAttribute("role") ? `[${r.getAttribute("role")}]` : ""}${lbl ? `(${lbl})` : ""}`;
  };
  const context = (el: Element) => {
    // nearest heading above the element, for the report
    let a: Element | null = el;
    for (let d = 0; a && d < 8; d++, a = a.parentElement) {
      const h = a.querySelector("h1, h2, h3, h4, [data-card-title]");
      if (h && h !== el && !el.contains(h)) return text(h).slice(0, 60);
    }
    return "";
  };
  /** The element and its ancestors that are items of a repeated structure: "parentId:index". */
  const items = (el: Element) => {
    const keys: string[] = [];
    const sig = (s: Element) => `${s.tagName}.${typeof s.className === "string" ? s.className : ""}`;
    let node: Element = el;
    for (let d = 0; node !== document.body && d < 14; d++) {
      const parent = node.parentElement;
      if (!parent) break;
      const rowish = ["TR", "LI"].includes(node.tagName) || ["row", "listitem", "option", "gridcell"].includes(node.getAttribute("role") ?? "");
      // d > 0: two buttons side by side in one toolbar are not "items"; their containers can be.
      const same = [...parent.children].filter((c) => sig(c) === sig(node)).length;
      if (rowish || (d > 0 && same >= minSiblings)) keys.push(`${pid(parent)}:${[...parent.children].indexOf(node)}`);
      node = parent;
    }
    return keys;
  };
  const isButtonLike = (el: Element) => {
    if (el.tagName === "BUTTON") return true;
    if (["button", "tab", "menuitem", "switch", "link"].includes(el.getAttribute("role") ?? "")) return true;
    if (el.tagName === "A" && el.hasAttribute("href")) return true;
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes((el as HTMLInputElement).type)) return true;
    return false;
  };
  const els = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], input[type="button"], input[type="submit"]')];
  return els
    .filter((el) => isButtonLike(el) && visible(el))
    .map((el) => ({
      name: (el.tagName === "INPUT" ? (el as HTMLInputElement).value : accName(el)).slice(0, 120),
      tag: el.tagName.toLowerCase() + (el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""),
      href: el.getAttribute("href"),
      region: region(el),
      context: context(el),
      items: items(el),
      inRow: !!el.closest('tr, li, [role="row"], [role="listitem"]'),
    }));
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateGroup {
  name: string;
  count: number;
  elements: { tag: string; href: string | null; region: string; context: string }[];
  status: "duplicate" | "allowlisted" | "left";
  reason?: string;
}

export interface PageResult {
  role: string;
  viewport: string;
  route: string;
  url: string;
  state: "ok" | "denied" | "module-off" | "platform-only" | "no-instance" | "error";
  elements: number;
  unnamed: number;
  duplicates: DuplicateGroup[];
  consoleErrors: string[];
  note?: string;
}

/**
 * What the control does, as far as the DOM tells: a link's destination (pathname),
 * or "action" for buttons. Same name + different action (e.g. the sidebar "Customers"
 * link and the "Customers" report tab, or the sidebar "Delivery" link and the POS
 * "Delivery" order-type tab) is not a duplicate.
 */
function actionKey(p: Probe): string {
  if (p.href && !p.href.startsWith("#") && !p.href.startsWith("javascript:")) return `link:${p.href.split(/[?#]/)[0].replace(/\/$/, "") || "/"}`;
  return "action";
}

const SIDEBAR = /^nav\(Main\)$/;
const SECTION_TABS = /^nav\(.+ sections\)$/;

function classify(route: string, probes: Probe[]): { groups: DuplicateGroup[]; unnamed: number } {
  const byName = new Map<string, Probe[]>();
  let unnamed = 0;
  for (const p of probes) {
    const name = p.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!name) {
      unnamed++;
      continue;
    }
    const key = `${name}\u0000${actionKey(p)}`;
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [, list] of byName) {
    if (list.length < 2) continue;
    const name = list[0].name;
    const elements = list.map(({ tag, href, region, context }) => ({ tag, href, region, context }));
    const base = { name, count: list.length, elements };
    const match = (a: { route: RegExp; name: string | RegExp }) => a.route.test(route) && (typeof a.name === "string" ? a.name.toLowerCase() === name.toLowerCase() : a.name.test(name));
    const named = NAMED_ALLOWLIST.find(match);
    const left = KNOWN_LEFT.find(match);
    const regions = list.map((p) => p.region);
    if (PAGINATION_NAMES.some((re) => re.test(name))) groups.push({ ...base, status: "allowlisted", reason: "pagination / stepping control" });
    else if (perItem(list)) groups.push({ ...base, status: "allowlisted", reason: "per-item action (rows / list items / repeated cards)" });
    else if (list.length === 2 && regions.some((r) => SIDEBAR.test(r)) && regions.some((r) => SECTION_TABS.test(r)))
      groups.push({ ...base, status: "allowlisted", reason: "sidebar category + its first section tab (two-level nav by design, nav.ts NAV_GROUPS)" });
    else if (named) groups.push({ ...base, status: "allowlisted", reason: named.reason });
    else if (left) groups.push({ ...base, status: "left", reason: left.reason });
    else groups.push({ ...base, status: "duplicate" });
  }
  return { groups, unnamed };
}

/** True when every pair sits in different items of the same repeated structure. */
function perItem(list: Probe[]): boolean {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].items.map((k) => k.split(":"));
      const b = list[j].items.map((k) => k.split(":"));
      const ok = a.some(([pa, ia]) => b.some(([pb, ib]) => pa === pb && ia !== ib));
      if (!ok) return false;
    }
  return true;
}

// ---------------------------------------------------------------- navigation helpers

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  // Wait for first-load spinners to go (LoadingState renders role=status with "Loading…").
  await page
    .waitForFunction(() => !/Loading…|Switching…/.test(document.querySelector("main")?.textContent ?? document.body.textContent ?? ""), undefined, { timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

async function pageState(page: Page): Promise<PageResult["state"]> {
  if (await page.locator('[data-testid="not-available"]').count()) return "denied";
  const body = (await page.locator("body").textContent()) ?? "";
  if (body.includes("Not available in the platform console")) return "platform-only";
  if (/isn't enabled for your business|Not enabled for your business/.test(body)) return "module-off";
  if (/This page isn.t available for your role|You don.t have access/i.test(body)) return "denied";
  return "ok";
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await settle(page);
}

/** A concrete URL for a dynamic route, or the parent page's state when the role can't open it. */
async function resolveDynamic(page: Page, pattern: string): Promise<{ url: string | null; parentState: PageResult["state"] }> {
  const spec = DYNAMIC_ROUTES[pattern];
  if (!spec) return { url: null, parentState: "no-instance" };
  await page.goto(spec.from);
  await settle(page);
  const parentState = await pageState(page);
  if (parentState !== "ok") return { url: null, parentState };
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
  return { url: hrefs.find((h) => spec.link.test(h)) ?? null, parentState };
}

async function sweep(page: Page, role: string, routes: string[], opts: { skipDeniedOnPhone: boolean }): Promise<PageResult[]> {
  const results: PageResult[] = [];
  let errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  const deniedOnDesktop = new Map<string, PageResult["state"]>();
  const resolved = new Map<string, Awaited<ReturnType<typeof resolveDynamic>>>();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const route of routes) {
      const base: Omit<PageResult, "state" | "elements" | "unnamed" | "duplicates" | "consoleErrors"> = { role, viewport: vp.key, route, url: route };
      if (opts.skipDeniedOnPhone && vp.key !== "desktop" && deniedOnDesktop.has(route)) {
        results.push({ ...base, state: deniedOnDesktop.get(route)!, elements: 0, unnamed: 0, duplicates: [], consoleErrors: [], note: "same state as desktop (not re-checked)" });
        continue;
      }
      let url = route;
      if (route.includes("[")) {
        if (!resolved.has(route)) resolved.set(route, await resolveDynamic(page, route));
        const r = resolved.get(route)!;
        if (!r.url) {
          const parent = DYNAMIC_ROUTES[route]?.from;
          const note = r.parentState === "ok" ? `no link to an instance on ${parent} (no data)` : `parent page ${parent} is ${r.parentState} for this role`;
          results.push({ ...base, state: r.parentState === "ok" ? "no-instance" : r.parentState, elements: 0, unnamed: 0, duplicates: [], consoleErrors: [], note });
          continue;
        }
        url = r.url;
      }
      errors = [];
      try {
        await page.goto(url);
        await settle(page);
        const state = await pageState(page);
        if (state !== "ok") {
          if (vp.key === "desktop") deniedOnDesktop.set(route, state);
          results.push({ ...base, url, state, elements: 0, unnamed: 0, duplicates: [], consoleErrors: [...new Set(errors)] });
          continue;
        }
        const probes = await page.evaluate(probePage, PER_ITEM_MIN_SIBLINGS);
        const { groups, unnamed } = classify(route, probes);
        results.push({ ...base, url: new URL(page.url()).pathname, state, elements: probes.length, unnamed, duplicates: groups, consoleErrors: [...new Set(errors)] });
      } catch (e) {
        results.push({ ...base, url, state: "error", elements: 0, unnamed: 0, duplicates: [], consoleErrors: [...new Set(errors)], note: String(e).slice(0, 300) });
      }
    }
  }
  return results;
}

function save(key: string, results: PageResult[]) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${key}.json`), JSON.stringify(results, null, 2));
}

function unexplained(results: PageResult[]) {
  return results.flatMap((r) => r.duplicates.filter((d) => d.status === "duplicate").map((d) => `${r.viewport} ${r.url}: "${d.name}" ×${d.count} (${d.elements.map((e) => e.region).join(", ")})`));
}

// ---------------------------------------------------------------- tests

const wanted = (process.env.SWEEP_ROLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const roles: SweepRole[] = wanted.length ? ROLES.filter((r) => wanted.includes(r.key)) : ROLES;

test.describe("duplicate buttons", () => {
  for (const role of roles) {
    test(`${role.label} (${role.email})`, async ({ page }) => {
      await login(page, role.email);
      const results = await sweep(page, role.key, ROUTES, { skipDeniedOnPhone: true });
      save(role.key, results);
      expect(results.filter((r) => r.state === "ok").length, "at least one page available").toBeGreaterThan(0);
      expect(unexplained(results), "duplicate buttons not explained by the allowlist").toEqual([]);
    });
  }

  if (!wanted.length || wanted.includes("public")) {
    test("Public pages (signed out)", async ({ page }) => {
      const routes = [...PUBLIC_ROUTES, ...(process.env.SWEEP_STORE_SLUG ? [`/o/${process.env.SWEEP_STORE_SLUG}`] : [])];
      const results = await sweep(page, "public", routes, { skipDeniedOnPhone: false });
      save("public", results);
      expect(unexplained(results), "duplicate buttons not explained by the allowlist").toEqual([]);
    });
  }
});
