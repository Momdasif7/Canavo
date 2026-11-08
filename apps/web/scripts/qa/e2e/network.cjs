#!/usr/bin/env node
/* eslint-disable */
/**
 * Network conditions (Chromium): slow 3G via CDP throttling, offline → online (the POS offline
 * billing queue syncs each bill exactly once), API failures shown as friendly errors.
 */
const L = require("./lib.cjs");
const { suite, check, step, API } = L;

const RAW = /Internal server error|Request failed \(\d+\)|TypeError|Failed to fetch|NetworkError|Unexpected token|<html|stack|undefined/i;

async function recentBills(auth, t0) {
  const r = await L.call(auth, "GET", "/orders?limit=100");
  return (Array.isArray(r.body) ? r.body : []).filter((o) => Date.parse(o.createdAt) >= t0);
}

async function slow3g(browser) {
  suite("network: slow 3G (CDP)");
  const s = await L.session(browser, "cashier");
  const p = s.page;
  await L.goto(p, "/pos"); // warm the JS cache; the throttled run measures data, not the dev bundle
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Network.enable");
  // Chrome DevTools "Slow 3G": 400 ms RTT, ~400 kbit/s down, ~400 kbit/s up.
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });
  await step("POS on slow 3G", async () => {
    const t = Date.now();
    await p.goto(L.BASE + "/pos");
    const sawLoading = await p.getByText(/Loading/).first().isVisible({ timeout: 4000 }).catch(() => false);
    await p.locator('[data-testid="item-card"]').first().waitFor({ timeout: 60000 });
    const ms = Date.now() - t;
    check("POS menu usable on slow 3G within 30 s", ms < 30000, `${ms} ms`);
    check("a loading state is shown while the menu loads", sawLoading);
    await L.addFirstItems(p, 1);
    const charge = p.getByRole("button", { name: /^Charge/ });
    await charge.click();
    await p.getByRole("dialog", { name: /Payment/ }).getByTestId("payment-confirm").click({ timeout: 30000 });
    await p.getByRole("dialog", { name: /^Paid/ }).waitFor({ timeout: 45000 });
    check("bill charged and paid on slow 3G", true, `${Date.now() - t} ms total`);
    await p.getByRole("button", { name: "New bill" }).click();
  });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check("no console errors (slow 3G)", s.errors.length === 0, s.errors.slice(0, 4).join(" | "));
  await s.ctx.close();
}

async function offline(browser) {
  suite("network: offline → online (POS queue)");
  const auth = await L.apiLogin("owner");
  const s = await L.session(browser, "cashier", { ignore: [/ERR_INTERNET_DISCONNECTED|net::ERR_|WebSocket connection/] });
  const p = s.page;
  const ctx = s.ctx;
  await L.goto(p, "/pos");
  await p.locator('[data-testid="item-card"]').first().waitFor();
  const t0 = Date.now() - 1000;
  await step("two bills while offline", async () => {
    await ctx.setOffline(true);
    await p.getByText(/Offline/).first().waitFor({ timeout: 10000 });
    check("offline indicator shown", true);
    for (let i = 0; i < 2; i++) {
      await L.addFirstItems(p, 1);
      await p.getByRole("button", { name: /^Charge/ }).click();
      const d = p.getByRole("dialog", { name: /Payment|offline/i });
      await d.waitFor();
      const exact = d.getByRole("button", { name: "Exact" });
      if (await exact.count()) await exact.click();
      await d.getByTestId("payment-confirm").dblclick();
      await p.getByRole("button", { name: "New bill" }).click({ timeout: 10000 });
    }
    const queued = await p.getByText(/2 (bills? )?(pending|queued|to sync|waiting)|pending.*2|2 offline/i).first().isVisible().catch(() => false);
    check("two bills queued (indicator)", queued, (await p.locator("header").innerText().catch(() => "")).slice(0, 120));
    check("nothing reached the server while offline", (await recentBills(auth, t0)).length === 0);
  });
  await step("back online: queue syncs once", async () => {
    await ctx.setOffline(false);
    let n = 0;
    for (let i = 0; i < 30 && n < 2; i++) {
      await p.waitForTimeout(1000);
      n = (await recentBills(auth, t0)).length;
    }
    check("queue synced after reconnect", n === 2, `${n} bills on the server after 30 s; page says: ${(await p.locator("header").innerText()).replace(/\s+/g, " ").slice(0, 120)}`);
    // Flap the connection: a second "online" must not re-send anything.
    await ctx.setOffline(true);
    await p.waitForTimeout(1000);
    await ctx.setOffline(false);
    await p.waitForTimeout(4000);
    await p.reload();
    await L.settle(p, 2000);
    const bills = await recentBills(auth, t0);
    check("exactly 2 bills on the server after sync + flap + reload", bills.length === 2, `${bills.length}: ${bills.map((b) => b.invoiceNumber).join(", ")}`);
    check("synced bills are paid", bills.every((b) => b.status === "PAID"), bills.map((b) => b.status).join(","));
  });
  check("no console errors (offline)", s.errors.length === 0, s.errors.slice(0, 4).join(" | "));
  await s.ctx.close();
}

async function failures(browser) {
  suite("network: API failures → friendly errors");
  // Menu fails with a proxy-style 502 (non-JSON body) on a fresh device (no cached menu).
  const s = await L.session(browser, "cashier", { ignore: [/status of 5\d\d/] });
  const p = s.page;
  s.errors.length = 0;
  await step("menu 502 → error state with Retry", async () => {
    let fail = true;
    await p.route(`${API}/menu**`, (r) => (fail ? r.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" }) : r.continue()));
    await p.goto(L.BASE + "/pos");
    const retry = p.getByRole("button", { name: /Retry|Try again/ });
    await retry.waitFor({ timeout: 20000 });
    const text = await p.locator("main").innerText();
    check("menu error is friendly", !RAW.test(text) && /server|try again|reach/i.test(text), text.slice(0, 160));
    fail = false;
    await retry.click();
    await p.locator('[data-testid="item-card"]').first().waitFor({ timeout: 15000 });
    check("Retry recovers the menu", true);
    await p.unroute(`${API}/menu**`);
  });
  await step("create bill 500 → friendly toast, cart kept", async () => {
    await L.addFirstItems(p, 1);
    await p.route(`${API}/orders`, (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal server error", requestId: "abcdef1234567890" }) }) : r.continue()));
    await p.getByRole("button", { name: /^Charge/ }).click();
    const toast = p.getByRole("status").or(p.getByRole("alert")).filter({ hasText: /server|try again/i }).first();
    await toast.waitFor({ timeout: 10000 });
    const t = await toast.innerText();
    check("bill error is friendly", !/Internal server error/.test(t) && /try again/i.test(t), t);
    check("cart kept after the failure", (await p.locator('[data-testid="cart-line"]').count()) >= 1);
    await p.unroute(`${API}/orders`);
  });
  await step("request aborted (no network) → offline checkout, not a crash", async () => {
    await p.route(`${API}/orders`, (r) => (r.request().method() === "POST" ? r.abort("internetdisconnected") : r.continue()));
    await p.getByRole("button", { name: /^Charge/ }).click();
    const d = p.getByRole("dialog");
    await d.waitFor({ timeout: 10000 });
    const text = await d.innerText();
    check("aborted create falls back to offline billing", /offline|saved on this device|sync/i.test(text), text.slice(0, 160));
    await d.getByRole("button", { name: /Cancel|Close/ }).first().click();
    await p.unroute(`${API}/orders`);
  });
  check("no unexpected console errors (failures)", s.errors.filter((e) => !/ 5\d\d |status of 5|ERR_INTERNET_DISCONNECTED/.test(e)).length === 0, s.errors.slice(0, 4).join(" | "));
  await s.ctx.close();
}

(async () => {
  const browser = await L.launch("chromium");
  const only = (process.env.ONLY || "slow3g,offline,failures").split(",");
  try {
    if (only.includes("slow3g")) await slow3g(browser);
    if (only.includes("offline")) await offline(browser);
    if (only.includes("failures")) await failures(browser);
  } finally {
    await browser.close();
    L.finish("network");
  }
})();
