#!/usr/bin/env node
/* eslint-disable */
/**
 * Visual regression: POS, KDS and the receipt, compared with PNG baselines in ./baselines
 * (pixelmatch, per-pixel threshold 0.15, page tolerance MAX_DIFF = 1 % of pixels by default).
 * Dynamic text (invoice numbers, dates, times, timers, stock notes) is normalised before the shot and
 * animations are frozen. UPDATE_BASELINES=1 rewrites the baselines. Baselines were made with Chrome
 * on macOS at 1280×800, light theme: other OS / font stacks need their own baselines.
 * Diffs land in OUT_DIR/visual/<name>.diff.png.
 */
const fs = require("fs");
const path = require("path");
const L = require("./lib.cjs");
const { suite, check, step } = L;

const DIR = path.join(__dirname, "baselines");
const OUTV = path.join(L.OUT, "visual");
const UPDATE = process.env.UPDATE_BASELINES === "1";
const MAX = Number(process.env.MAX_DIFF || 0.01);
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(OUTV, { recursive: true });

async function freeze(page) {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important} ::-webkit-scrollbar{display:none}" });
  await page.evaluate(() => {
    const rules = [
      [/[A-Z]{2,5}\d?-\d{4}-\d{3,6}/g, "INV-2026-00000"],
      [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "01/01/2026"],
      [/\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm|AM|PM)\b/g, "12:00 pm"],
      [/\b\d{1,2}:\d{2}\b/g, "0:00"],
      [/\b\d+\s?(m|min|h|s)\b/g, "0m"],
      [/#\d+\b/g, "#1"],
    ];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      let t = n.nodeValue;
      for (const [re, v] of rules) t = t.replace(re, v);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
  });
  await page.waitForTimeout(300);
}

async function compare(name, shot) {
  const base = path.join(DIR, `${name}.png`);
  const cur = path.join(OUTV, `${name}.png`);
  fs.writeFileSync(cur, shot);
  if (UPDATE || !fs.existsSync(base)) {
    fs.writeFileSync(base, shot);
    return check(`${name}: baseline ${UPDATE ? "updated" : "created"}`, true);
  }
  const r = L.pixelDiff(base, cur, path.join(OUTV, `${name}.diff.png`));
  return check(`${name}: matches baseline (≤ ${(MAX * 100).toFixed(1)} %)`, r.ratio <= MAX, r.reason || `${(r.ratio * 100).toFixed(2)} % (${r.pixels} px)`);
}

(async () => {
  suite("visual regression");
  const browser = await L.launch("chromium");
  const vp = { viewport: { width: 1280, height: 800 }, colorScheme: "light", deviceScaleFactor: 1 };
  try {
    const cashier = await L.session(browser, "cashier", { context: vp });
    const p = cashier.page;
    await step("POS", async () => {
      await L.goto(p, "/pos");
      const clear = p.getByRole("button", { name: /Clear bill/ });
      if (await clear.isEnabled().catch(() => false)) {
        await clear.click();
        const c = p.getByRole("dialog").getByRole("button", { name: /Clear|Yes|New bill/ });
        if (await c.count()) await c.last().click();
      }
      await p.getByRole("button", { name: /Badam Milk/ }).first().click();
      await p.getByText("Totals confirmed by server").waitFor({ timeout: 10000 }).catch(() => {});
      await freeze(p);
      await compare("pos", await p.screenshot({ mask: [p.locator('[data-testid="item-stock-note"], [data-testid="item-badge"], [data-testid="notification-badge"]')] }));
    });
    await step("receipt", async () => {
      await p.getByRole("button", { name: /^Charge/ }).click();
      const d = p.getByRole("dialog", { name: /Payment/ });
      await d.getByRole("button", { name: "Exact" }).click();
      await d.getByTestId("payment-confirm").click();
      const receipt = p.getByLabel("Receipt preview");
      await receipt.waitFor({ timeout: 15000 });
      await freeze(p);
      await compare("receipt", await receipt.screenshot());
      await p.getByRole("button", { name: "New bill" }).click();
    });
    const kitchen = await L.session(browser, "kitchen", { context: vp });
    await step("KDS", async () => {
      const k = kitchen.page;
      // Tickets differ between runs: serve one real ticket (the newest) as a fixed fixture.
      const auth = await L.apiLogin("kitchen");
      const live = (await L.call(auth, "GET", "/kot")).body;
      const list = Array.isArray(live) ? live : live?.kots ?? live?.tickets ?? [];
      const one = list.filter((t) => !/SERVED|CANCEL|DONE|BUMPED/.test(t.status)).slice(0, 1).map((t) => ({ ...t, createdAt: new Date(Date.now() - 60e3).toISOString() }));
      await k.route(`${L.API}/kot**`, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(live) ? one : { ...live, kots: one, tickets: one }) }) : r.continue()));
      await L.goto(k, "/kitchen");
      await freeze(k);
      check("KDS fixture ticket is on the board", (await k.locator("article").count()) === 1);
      await compare("kds", await k.screenshot({ mask: [k.locator('article li, [data-testid="notification-badge"]')] }));
    });
    await Promise.all([cashier.ctx.close(), kitchen.ctx.close()]);
  } finally {
    await browser.close();
    L.finish("visual");
  }
})();
