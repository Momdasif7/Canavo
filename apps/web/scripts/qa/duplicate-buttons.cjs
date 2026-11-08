#!/usr/bin/env node
/* eslint-disable */
/**
 * Duplicate-button sweep (QA).
 *
 * Logs in as each demo role, visits every page that role can reach (sidebar links + known sub-pages),
 * opens a few common dialogs/drawers, and flags the same accessible name (or the same href) appearing
 * twice at once in the same region — e.g. a header action repeated in the page body, mobile and desktop
 * variants both visible, or two Save buttons for one form. Repeats inside structurally identical
 * siblings (table rows, list items, card grids) and pagination are treated as legitimate and skipped.
 *
 * Playwright is NOT a repo dependency. Point PW_PATH at a folder where `playwright` is installed:
 *
 *   PW_PATH=/path/to/scratch/node_modules/playwright \
 *   BASE_URL=http://localhost:3230 OUT_DIR=/tmp/dup-sweep \
 *   node apps/web/scripts/qa/duplicate-buttons.cjs
 *
 * Optional env: ROLES=owner,cashier (default: every demo role), PASSWORD (default Canavo@123),
 * VIEWPORTS=desktop,phone, ROUTES=/pos,/bills (only these), SHOTS=0 (no screenshots), CONCURRENCY=2,
 * CHROME_CHANNEL=chrome (set to "" to use the bundled chromium).
 * Output: OUT_DIR/report.json, OUT_DIR/report.md, OUT_DIR/shots/<role>-<viewport>-<route>.png for flagged pages.
 */
const fs = require("fs");
const path = require("path");

const PW_PATH = process.env.PW_PATH;
if (!PW_PATH) {
  console.error("Set PW_PATH to an installed playwright package (e.g. /tmp/pw/node_modules/playwright).");
  process.exit(2);
}
const { chromium } = require(PW_PATH);

const BASE = (process.env.BASE_URL || "http://localhost:3230").replace(/\/$/, "");
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "dup-sweep-out");
const PASSWORD = process.env.PASSWORD || "Canavo@123";
const SHOTS = process.env.SHOTS !== "0";
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const CHANNEL = process.env.CHROME_CHANNEL ?? "chrome";
const ALL_ROLES = ["owner", "manager", "cashier", "kitchen", "waiter", "delivery", "inventory", "accountant", "auditor", "admin", "support"];
const ROLES = (process.env.ROLES || ALL_ROLES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const VIEWPORTS = {
  desktop: { width: 1366, height: 900 },
  phone: { width: 390, height: 844 },
};
const VP = (process.env.VIEWPORTS || "desktop,phone").split(",").filter((v) => VIEWPORTS[v]);
const ONLY_ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",") : null;

/** Static sub-pages not in the sidebar; visited when the role can open their parent section. */
const EXTRA_ROUTES = [
  "/account/appearance",
  "/account/security",
  "/notifications",
  "/tables/qr-codes",
  "/customers/loyalty",
  "/inventory/reports",
  "/platform/businesses/new",
  "/settings/notifications",
  "/reports/canteen",
  "/reports/customers",
  "/reports/delivery",
  "/reports/exceptions",
  "/reports/gst",
  "/reports/gstr1",
  "/reports/inventory",
  "/reports/items",
  "/reports/peak-hours",
  "/reports/profit",
  "/reports/sales",
  "/reports/settlements",
  "/reports/staff",
];
/** Dynamic detail pages: open the first matching link found on the list page. */
const DETAIL_ROUTES = [
  { list: "/customers", pattern: /^\/customers\/(?!khata|loyalty)[^/?#]+$/ },
  { list: "/inventory/audits", pattern: /^\/inventory\/audits\/[^/?#]+$/ },
  { list: "/platform/businesses", pattern: /^\/platform\/businesses\/(?!new)[^/?#]+$/ },
];
/** Common dialogs / drawers: on `route`, click the first visible element matching one of `click` (in order), then scan. */
const INTERACTIONS = [
  { route: "/bills", name: "bill drawer", click: ["tbody tr >> nth=0", "[data-bill-row] >> nth=0"] },
  { route: "/pos", name: "POS payment dialog", click: ["main button:has-text('₹') >> nth=0", "role=button[name=/^(Pay|Charge|Checkout)/i]"] },
  { route: "/online-orders", name: "online order detail", click: ["tbody tr >> nth=0"] },
  { route: "/customers", name: "add customer dialog", click: ["role=button[name=/Add customer|New customer/i]"] },
  { route: "/menu", name: "add item dialog", click: ["role=button[name=/Add item|New item/i]"] },
  { route: "/staff", name: "add staff dialog", click: ["role=button[name=/Add staff|Invite|New staff/i]"] },
];

const slug = (s) => s.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";

/** Runs in the page: returns duplicate groups among visible interactive elements. */
function scanInPage() {
  const SEL = "button, a[href], [role=button], [role=tab], [role=menuitem], [role=link], input[type=submit], input[type=button]";
  const isVisible = (el) => {
    if (el.closest("nextjs-portal, [data-nextjs-toast], #__next-build-watcher")) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right < 0 || r.bottom < -2000 || r.left > window.innerWidth) return false; // parked off-canvas (closed drawers)
    if (el.closest("[aria-hidden=true], [inert]")) return false;
    return true;
  };
  const nameOf = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    let n = el.getAttribute("aria-label") || (lb && lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ")) || el.innerText || el.value || el.getAttribute("title") || "";
    return n.replace(/\s+/g, " ").trim();
  };
  const regionOf = (el) => {
    const d = el.closest("[role=dialog], dialog, [role=alertdialog]");
    if (d) return "dialog:" + (d.getAttribute("aria-label") || d.querySelector("h1,h2,h3")?.innerText || "").slice(0, 40);
    const r = el.closest("main, aside, nav, header, footer, [role=navigation], [role=banner]");
    return r ? r.tagName.toLowerCase() + (r.getAttribute("aria-label") ? ":" + r.getAttribute("aria-label") : "") : "body";
  };
  // An open modal makes everything behind it irrelevant.
  const modal = [...document.querySelectorAll("[role=dialog], dialog[open], [role=alertdialog]")].filter(isVisible).pop();
  const root = modal || document;
  const els = [...root.querySelectorAll(SEL)].filter(isVisible);
  const items = els.map((el, i) => {
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    const r = el.getBoundingClientRect();
    return { i, el, name: nameOf(el), href, region: regionOf(el), box: [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)] };
  });
  /** Nearest card / section title above the control, to tell "two Saves for one form" from "one Save per card". */
  const contextOf = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (/^(MAIN|ASIDE|NAV)$/.test(n.tagName)) break;
      const h = n.querySelector("h2, h3, [data-card-title]");
      if (h && n.tagName !== "MAIN") return h.innerText.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    return "";
  };
  const sig = (n) => n.tagName + "|" + (typeof n.className === "string" ? n.className : "");
  /** Two elements are "repeated items" when, below their lowest common ancestor, they sit in structurally identical siblings. */
  const repeated = (a, b) => {
    const pa = [];
    for (let n = a; n; n = n.parentElement) pa.push(n);
    let lca = b, cb = b;
    while (lca && !pa.includes(lca)) { cb = lca; lca = lca.parentElement; }
    if (!lca) return false;
    const ca = pa[pa.indexOf(lca) - 1];
    if (!ca || !cb || ca === cb) return false;
    if (/^(TR|LI)$/.test(ca.tagName) || ca.getAttribute("role") === "row") return true;
    // Cards in a grid often differ only by a status colour class: same tag path down to the control and
    // a parent with 3+ children of that tag counts as a repeated item too.
    const tagPath = (top, el) => { const t = []; for (let n = el; n && n !== top; n = n.parentElement) t.push(n.tagName); return t.join(">"); };
    if (sig(ca) !== sig(cb)) {
      if (ca === a || cb === b || ca.tagName !== cb.tagName || tagPath(ca, a) !== tagPath(cb, b)) return false;
      return [...lca.children].filter((c) => c.tagName === ca.tagName).length >= 3;
    }
    const same = [...lca.children].filter((c) => sig(c) === sig(ca)).length;
    // the controls themselves are adjacent identical siblings: a duplicate unless it is a run of 3+ (a button group)
    if (ca === a && cb === b) return same >= 3;
    return same >= 2;
  };
  const LEGIT = /^(\d+|‹|›|«|»|previous|next|prev|more|…|\.\.\.|−|\+|-)$/i;
  const groups = [];
  const by = (keyFn, kind) => {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (!k) continue;
      const key = it.region + "␟" + k;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(it);
    }
    for (const [key, list] of m) {
      if (list.length < 2) continue;
      // keep the members that are NOT explained by a repeated-item structure
      const flagged = list.filter((x) => list.some((y) => y !== x && !repeated(x.el, y.el)));
      if (flagged.length < 2) continue;
      // nested duplicates (a link wrapping a button with the same label) are one control
      const uniq = flagged.filter((x) => !flagged.some((y) => y !== x && y.el.contains(x.el)));
      if (uniq.length < 2) continue;
      const gi = groups.length;
      uniq.forEach((x, mi) => {
        x.el.setAttribute("data-dup", `g${gi}-${mi}`);
        x.el.style.outline = "3px solid #e11d48";
        x.el.style.outlineOffset = "2px";
      });
      groups.push({ id: gi, kind, region: key.split("␟")[0], key: key.split("␟")[1], count: uniq.length, sameCard: new Set(uniq.map((x) => contextOf(x.el))).size === 1, members: uniq.map((x) => ({ name: x.name, context: contextOf(x.el), href: x.href, tag: x.el.tagName.toLowerCase(), box: x.box, cls: (x.el.className || "").toString().slice(0, 120) })) });
    }
  };
  by((it) => (it.name && !LEGIT.test(it.name) ? it.name.toLowerCase() : null), "same-name");
  by((it) => (it.href && it.href !== "#" && !it.href.startsWith("javascript") ? it.href.replace(/\/$/, "") : null), "same-href");
  // Look-alikes in one card: a bare verb next to the same verb with an object ("Copy" + "Copy message") reads as
  // two identical buttons, especially with the same icon. Reported for review, not necessarily a bug.
  for (const a of items) {
    const an = a.name.toLowerCase();
    if (!an || LEGIT.test(an) || an.split(" ").length > 1) continue;
    const ctx = contextOf(a.el);
    const twins = items.filter((b) => b !== a && b.region === a.region && b.name.toLowerCase().startsWith(an + " ") && contextOf(b.el) === ctx && !repeated(a.el, b.el));
    if (!twins.length || !ctx) continue;
    const gid = groups.length;
    groups.push({ id: gid, kind: "look-alike", region: a.region, key: [a.name, ...twins.map((t) => t.name)].join(" / "), count: twins.length + 1, sameCard: true, members: [a, ...twins].map((x) => ({ name: x.name, context: ctx, href: x.href, tag: x.el.tagName.toLowerCase(), box: x.box, cls: (x.el.className || "").toString().slice(0, 120) })) });
    [a, ...twins].forEach((x, mi) => { x.el.setAttribute("data-dup", `g${gid}-${mi}`); x.el.style.outline = "3px dashed #d97706"; });
  }
  // drop same-href groups that are already reported as same-name
  const names = new Set(groups.filter((g) => g.kind === "same-name").map((g) => g.region + "|" + g.members.map((m) => m.href).sort().join(",")));
  return groups.filter((g) => g.kind !== "same-href" || !names.has(g.region + "|" + g.members.map((m) => m.href).sort().join(",")));
}

async function settle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  await page.waitForTimeout(700);
}

async function login(context, role) {
  const page = await context.newPage();
  await page.goto(BASE + "/login", { waitUntil: "load", timeout: 120000 });
  await settle(page); // wait for hydration, or the form submits natively
  await page.getByLabel("Email").fill(`${role}@canavo.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /^(sign in|log in|login)$/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
  await settle(page);
  return page;
}

async function sidebarRoutes(page) {
  const hrefs = await page.$$eval("a[href^='/']", (as) => as.map((a) => a.getAttribute("href")));
  return [...new Set(hrefs.map((h) => h.split(/[?#]/)[0].replace(/\/$/, "")))].filter((h) => h && !h.startsWith("/login") && !/^\/(o|t)\//.test(h));
}

async function scan(page, ctx, results) {
  const groups = await page.evaluate(scanInPage);
  const entry = { ...ctx, url: new URL(page.url()).pathname, groups };
  results.push(entry);
  if (groups.length && SHOTS) {
    // The app scrolls inside its own container, so a full-page shot is just the viewport: take one shot per
    // flagged control that is not already on screen (flagged controls are outlined in red).
    const base = `${ctx.role}-${ctx.viewport}-${slug(ctx.route)}${ctx.interaction ? "-" + slug(ctx.interaction) : ""}`;
    entry.shots = [];
    for (let gi = 0; gi < groups.length; gi++) {
      for (let mi = 0; mi < Math.min(groups[gi].count, 2); mi++) {
        const loc = page.locator(`[data-dup="g${groups[gi].id}-${mi}"]`);
        const inView = await loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).catch(() => false);
        if (mi > 0 && inView) continue;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const file = path.join(OUT, "shots", `${base}-g${gi}${mi ? "-" + mi : ""}.png`);
        await page.screenshot({ path: file }).catch(() => {});
        entry.shots.push(path.relative(OUT, file));
      }
      groups[gi].shots = entry.shots.filter((f) => new RegExp(`-g${gi}(-\\d+)?\\.png$`).test(f));
    }
    entry.shot = entry.shots[0];
  }
  if (groups.length) console.log(`  ! ${ctx.role} ${ctx.viewport} ${ctx.route}${ctx.interaction ? " [" + ctx.interaction + "]" : ""}: ${groups.map((g) => `${g.kind} "${g.key}" ×${g.count} (${g.region}${g.sameCard ? "" : ", different cards"})`).join("; ")}`);
}

async function runRole(browser, role, results) {
  for (const vp of VP) {
    const context = await browser.newContext({ viewport: VIEWPORTS[vp] });
    let page;
    try {
      page = await login(context, role);
    } catch (e) {
      console.log(`  x ${role}: login failed (${e.message.split("\n")[0]})`);
      await context.close();
      return;
    }
    // On phones the sidebar is in a drawer; take the route list from a desktop-width read of the same session.
    await page.setViewportSize(VIEWPORTS.desktop);
    await settle(page);
    let routes = await sidebarRoutes(page);
    await page.setViewportSize(VIEWPORTS[vp]);
    const sections = new Set(routes.map((r) => "/" + r.split("/")[1]));
    routes = [...new Set([...routes, ...EXTRA_ROUTES.filter((r) => sections.has("/" + r.split("/")[1]) || r.startsWith("/account") || r === "/notifications")])];
    // Sidebar entries are sections; their sub-pages are tabs inside them. Crawl links within the role's sections.
    const inScope = (r) => (sections.has("/" + r.split("/")[1]) || r.startsWith("/account") || r === "/notifications") && !r.split("/").some((seg) => seg.length >= 15 && /\d/.test(seg)) && (!ONLY_ROUTES || ONLY_ROUTES.includes(r));
    const queue = routes.filter(inScope);
    const queued = new Set(queue);
    const seen = new Set();
    let visited = 0;
    while (queue.length) {
      const route = queue.shift();
      try {
        await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 60000 });
        await settle(page);
        const landed = new URL(page.url()).pathname;
        for (const h of await sidebarRoutes(page)) if (!queued.has(h) && inScope(h)) { queued.add(h); queue.push(h); }
        if (seen.has(landed)) continue;
        seen.add(landed);
        visited++;
        await scan(page, { role, viewport: vp, route: landed }, results);
        const detail = DETAIL_ROUTES.find((d) => d.list === landed);
        if (detail) {
          const hrefs = await page.$$eval("a[href^='/']", (as) => as.map((a) => a.getAttribute("href")));
          const h = hrefs.find((x) => detail.pattern.test(x));
          if (h && !seen.has(h)) {
            seen.add(h);
            await page.goto(BASE + h, { waitUntil: "domcontentloaded" });
            await settle(page);
            await scan(page, { role, viewport: vp, route: h.replace(/\/[^/]+$/, "/[id]") }, results);
          }
        }
        for (const it of INTERACTIONS.filter((x) => x.route === landed)) {
          await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
          await settle(page);
          let opened = false;
          for (const sel of it.click) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) {
              await loc.click({ timeout: 5000 }).catch(() => {});
              await settle(page);
              opened = true;
              // POS: after adding an item, open payment
              if (it.route === "/pos") continue;
              break;
            }
          }
          if (opened) await scan(page, { role, viewport: vp, route: landed, interaction: it.name }, results);
        }
      } catch (e) {
        console.log(`  x ${role} ${vp} ${route}: ${e.message.split("\n")[0]}`);
      }
    }
    console.log(`${role} ${vp}: ${visited} pages`);
    await context.close();
  }
}

(async () => {
  fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
  const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
  const results = [];
  const queue = [...ROLES];
  await Promise.all(
    Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
      while (queue.length) await runRole(browser, queue.shift(), results);
    }),
  );
  await browser.close();
  results.sort((a, b) => (a.route + a.role + a.viewport).localeCompare(b.route + b.role + b.viewport));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
  const flagged = results.filter((r) => r.groups.length);
  const lines = [`# Duplicate-button sweep — ${new Date().toISOString()}`, "", `Pages scanned: ${results.length}; pages with flags: ${flagged.length}`, "", "| Route | Role | Viewport | Region | Kind | Label / href | × | Same card? | Cards | Screenshot |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of flagged)
    for (const g of r.groups) lines.push(`| ${r.route}${r.interaction ? " (" + r.interaction + ")" : ""} | ${r.role} | ${r.viewport} | ${g.region} | ${g.kind} | ${g.key.replace(/\|/g, "\\|")} | ${g.count} | ${g.sameCard ? "yes" : "no"} | ${[...new Set(g.members.map((m) => m.context || "—"))].join(" / ").replace(/\|/g, "\\|")} | ${(g.shots || []).join(" ")} |`);
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
  console.log(`\nScanned ${results.length} pages, ${flagged.length} with flags. Report: ${path.join(OUT, "report.md")}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
