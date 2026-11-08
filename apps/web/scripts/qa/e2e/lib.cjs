/* eslint-disable */
/**
 * Shared helpers for the web UI journeys (QA Phase 11). Playwright and axe-core are NOT repo
 * dependencies (product-owner decision): PW_PATH points at an installed `playwright` package and
 * AXE_PATH (default: next to PW_PATH) at `axe-core`. See README.md.
 */
const fs = require("fs");
const path = require("path");

const PW_PATH = process.env.PW_PATH;
if (!PW_PATH) {
  console.error("Set PW_PATH to an installed playwright package (e.g. /tmp/pw/node_modules/playwright).");
  process.exit(2);
}
const pw = require(PW_PATH);
const NM = path.dirname(PW_PATH);
const req = (name, env) => require(process.env[env] || path.join(NM, name));

const BASE = (process.env.BASE_URL || "http://localhost:3280").replace(/\/$/, "");
const API = (process.env.API_URL || "http://localhost:4180").replace(/\/$/, "");
const PASSWORD = process.env.PASSWORD || "Canavo@123";
const SLUG = process.env.SLUG || "demo";
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "e2e-out");
const CHANNEL = process.env.CHROME_CHANNEL ?? "chrome";
const HEADED = process.env.HEADED === "1";
fs.mkdirSync(OUT, { recursive: true });

const email = (role) => (role.includes("@") ? role : `${role}@canavo.local`);

// ---------- results ----------
const results = [];
const state = { lastPage: null };
let current = "";
function suite(name) {
  current = name;
  console.log(`\n== ${name}`);
}
function check(name, ok, detail = "") {
  const r = { suite: current, name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 400) };
  results.push(r);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${name}${r.detail && !r.ok ? " — " + r.detail : ""}`);
  return r.ok;
}
async function step(name, fn, page) {
  try {
    return await fn();
  } catch (e) {
    check(name, false, (e && e.message ? e.message : String(e)).split("\n")[0]);
    page ??= state.lastPage;
    if (page) await page.screenshot({ path: path.join(OUT, `fail-${name.replace(/[^\w]+/g, "-")}.png`) }).catch(() => {});
    return undefined;
  }
}
function finish(file) {
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, `${file}.json`), JSON.stringify(results, null, 2));
  console.log(`\n${file}: ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
  return failed.length;
}

// ---------- browsers ----------
async function launch(kind = "chromium") {
  const type = pw[kind];
  const opts = { headless: !HEADED };
  if (kind === "chromium" && CHANNEL) opts.channel = CHANNEL;
  return type.launch(opts);
}

// Every context gets its own X-Forwarded-For on auth calls so the per-IP login limiter (50 / 15 min)
// does not trip during a full run. The API trusts loopback proxies, so this only works locally.
let ipSeq = Math.floor(Math.random() * 200);
async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...opts });
  const ip = `10.77.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  await ctx.route(`${API}/auth/**`, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
  return ctx;
}

/** Collects console errors, page errors and failed API calls (5xx) for the zero-console-errors rule. */
function watch(page, label, opts = {}) {
  const errors = [];
  state.lastPage = page;
  // The browser's own "Failed to load resource … 4xx" line is not an app error: expected 4xx (validation,
  // geofence) are shown to the user. 403s are tracked below (a screen calling an API its role can't use).
  const ignore = [/Download the React DevTools/, /\[Fast Refresh\]/, /favicon/, /Failed to load resource: the server responded with a status of 4\d\d/,
    // Firefox logs this for any socket that was open when the test navigates away (full page load).
    /was interrupted while the page was loading/, ...(opts.ignore || [])];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (ignore.some((r) => r.test(t))) return;
    errors.push(`${label} console: ${t}`);
  });
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("response", (r) => {
    if ((r.status() >= 500 || (r.status() === 403 && !opts.allow403)) && r.url().startsWith(API)) errors.push(`${label} ${r.status()} ${r.request().method()} ${r.url().replace(API, "")}`);
  });
  return errors;
}

async function login(page, role, { expectPath } = {}) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email(role));
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  if (expectPath) await page.waitForURL((u) => u.pathname.startsWith(expectPath), { timeout: 15000 }).catch(() => {});
  await settle(page);
}

/** New context + page logged in as `role`; returns { ctx, page, errors }. */
async function session(browser, role, opts = {}) {
  const ctx = await newContext(browser, opts.context);
  const page = await ctx.newPage();
  const errors = watch(page, role, opts);
  await login(page, role);
  return { ctx, page, errors };
}

async function settle(page, ms = 400) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function goto(page, route) {
  state.lastPage = page;
  await page.goto(BASE + route);
  await settle(page);
}

const bodyText = (page) => page.locator("body").innerText();
const crashed = async (page) => /Something went wrong|Application error|Unhandled Runtime Error/i.test(await bodyText(page));

// ---------- API (node side) ----------
let apiIp = 0;
async function apiLogin(role) {
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.0.${(++apiIp % 250) + 1}` },
    body: JSON.stringify({ email: email(role), password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error(`api login ${role}: ${r.status} ${JSON.stringify(j)}`);
  const outlets = await (await fetch(`${API}/outlets`, { headers: { authorization: `Bearer ${j.accessToken}` } })).json();
  return { token: j.accessToken, outletId: Array.isArray(outlets) && outlets[0] ? outlets[0].id : null };
}
async function call(auth, method, p, body) {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { authorization: `Bearer ${auth.token}`, ...(auth.outletId && { "x-outlet-id": auth.outletId }), ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const t = await r.text();
  let b;
  try {
    b = t ? JSON.parse(t) : null;
  } catch {
    b = t;
  }
  return { status: r.status, body: b };
}

// ---------- POS helpers ----------
async function addFirstItems(page, n = 1) {
  // Plain items only (no variant / add-on picker), so each click adds exactly one line.
  const cards = page.locator('[data-testid="item-card"]:not([disabled])').filter({ hasNotText: "Options" });
  await cards.first().waitFor({ timeout: 20000 });
  const lines = page.locator('[data-testid="cart-line"]');
  for (let i = 0; i < n; i++) {
    const before = await lines.count();
    await cards.nth(i).click();
    await page.waitForFunction(([sel, b]) => document.querySelectorAll(sel).length > b, ['[data-testid="cart-line"]', before], { timeout: 5000 }).catch(() => {});
  }
}

// ---------- axe ----------
async function axe(page) {
  axe.src ??= fs.readFileSync(path.join(path.dirname(require.resolve(process.env.AXE_PATH || path.join(NM, "axe-core"))), "axe.min.js"), "utf8");
  await page.evaluate(axe.src);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")), why: v.nodes.slice(0, 3).map((n) => (n.any[0] || n.all[0] || n.none[0] || {}).message || "").map((m) => m.slice(0, 160)), html: v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)), all: v.nodes.map((n) => ({ target: n.target.join(" "), msg: ((n.any[0] || n.all[0] || n.none[0] || {}).message || "").slice(0, 200) })) }));
  });
}

// ---------- pixel diff ----------
function pixelDiff(aPath, bPath, diffPath) {
  const { PNG } = req("pngjs", "PNGJS_PATH");
  const pixelmatch = req("pixelmatch", "PIXELMATCH_PATH");
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, reason: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
  if (diffPath && n) fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { ratio: n / (a.width * a.height), pixels: n };
}

module.exports = {
  pw, BASE, API, PASSWORD, SLUG, OUT, email,
  suite, check, step, finish, results, state,
  launch, newContext, watch, login, session, settle, goto, bodyText, crashed,
  apiLogin, call, addFirstItems, axe, pixelDiff,
};
