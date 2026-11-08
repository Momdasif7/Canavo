#!/usr/bin/env node
/* eslint-disable */
/**
 * Cross-browser (Chromium / Firefox / WebKit): cashier bill journey + online ordering order.
 * Viewports (Chromium): 360, 768, 1024, 1440 and POS tablet landscape 1280×800 for POS, KDS,
 * online ordering and Bills — no horizontal page scroll, the main action visible, no console errors.
 * Env: BROWSERS=chromium,firefox,webkit
 */
const path = require("path");
const fs = require("fs");
const L = require("./lib.cjs");
const { suite, check, step, BASE, SLUG } = L;

async function cashierBill(page) {
  await L.goto(page, "/pos");
  await L.addFirstItems(page, 1);
  await page.getByRole("button", { name: /^Charge/ }).click();
  const d = page.getByRole("dialog", { name: /Payment/ });
  await d.getByRole("button", { name: "Exact" }).click();
  await d.getByTestId("payment-confirm").click();
  await page.getByRole("dialog", { name: /^Paid/ }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "New bill" }).click();
}

async function onlineOrder(page) {
  await page.goto(`${BASE}/o/${SLUG}`);
  await page.locator('[data-testid="menu-item"]').first().waitFor({ timeout: 20000 });
  await page.locator('[data-testid="menu-item"]').first().getByRole("button", { name: /add/i }).first().click();
  await page.getByRole("button", { name: /View cart/ }).click();
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: /^Continue ·/ }).click();
  check("checkout validates name / phone", (await d.getByRole("button", { name: "Continue to payment" }).isDisabled()) || /Enter your name/.test(await d.innerText()));
  await d.getByRole("textbox").first().fill("QA Guest");
  await d.getByLabel("Mobile number").fill("9812345670");
  await d.getByRole("button", { name: "Continue to payment" }).click();
  await d.getByRole("button", { name: /^Place order/ }).click();
  await page.waitForURL(/\/o\/.+\/(order|track|o)\b|[?&]order=/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const text = await L.bodyText(page);
  if (!/order (is )?(placed|received|confirmed)|token|track|preparing|accepted|thank/i.test(text)) throw new Error("no confirmation: " + text.slice(0, 160));
}

async function crossBrowser() {
  const kinds = (process.env.BROWSERS || "chromium,firefox,webkit").split(",");
  for (const kind of kinds) {
    suite(`cross-browser: ${kind}`);
    const browser = await L.launch(kind);
    try {
      const s = await L.session(browser, "cashier");
      await step(`${kind}: cashier bill journey`, async () => {
        await cashierBill(s.page);
        check(`${kind}: bill paid`, true);
      });
      check(`${kind}: no console errors (cashier)`, s.errors.length === 0, s.errors.slice(0, 4).join(" | "));
      await s.ctx.close();
      const ctx = await L.newContext(browser, { viewport: { width: 390, height: 844 }, ...(kind !== "firefox" && { isMobile: true, hasTouch: true }) });
      const g = await ctx.newPage();
      const ge = L.watch(g, "guest");
      await step(`${kind}: online ordering order`, async () => {
        await onlineOrder(g);
        check(`${kind}: online order confirmed`, true);
      });
      check(`${kind}: no console errors (online ordering)`, ge.length === 0, ge.slice(0, 4).join(" | "));
      await ctx.close();
    } finally {
      await browser.close();
    }
  }
}

const VIEWPORTS = [
  { name: "360", width: 360, height: 780, mobile: true },
  { name: "768", width: 768, height: 1024, mobile: true },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
  { name: "pos-tablet-1280x800", width: 1280, height: 800 },
];

async function overflowX(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - w;
    if (over <= 1) return null;
    const culprits = [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== "fixed")
      .slice(-3)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 3).join(".")}`);
    return `${over}px (${culprits.join(", ")})`;
  });
}

async function viewports() {
  suite("viewports (chromium)");
  const shots = path.join(L.OUT, "viewports");
  fs.mkdirSync(shots, { recursive: true });
  const browser = await L.launch("chromium");
  try {
    for (const vp of VIEWPORTS) {
      const ctxOpts = { viewport: { width: vp.width, height: vp.height }, ...(vp.mobile && { isMobile: true, hasTouch: true }) };
      const cashier = await L.session(browser, "cashier", { context: ctxOpts });
      const kitchen = await L.session(browser, "kitchen", { context: ctxOpts });
      const pages = [
        { route: "/pos", page: cashier.page, main: async (p) => p.getByRole("button", { name: /^Charge|View bill|Bill ·|items? ·/ }).first() },
        { route: "/bills", page: cashier.page, main: async (p) => p.getByRole("heading", { name: "Bills" }).first() },
        { route: "/kitchen", page: kitchen.page, main: async (p) => p.getByRole("heading", { name: "Kitchen" }).first() },
      ];
      for (const t of pages) {
        await step(`${vp.name} ${t.route}`, async () => {
          await L.goto(t.page, t.route);
          if (t.route === "/pos") await L.addFirstItems(t.page, 1);
          const ov = await overflowX(t.page);
          check(`${vp.name} ${t.route}: no horizontal scroll`, !ov, ov);
          const m = await t.main(t.page);
          check(`${vp.name} ${t.route}: main control visible`, await m.isVisible());
          await t.page.screenshot({ path: path.join(shots, `${vp.name}${t.route.replace(/\//g, "_")}.png`) });
        });
      }
      await step(`${vp.name} POS cart reachable + Charge`, async () => {
        const p = cashier.page;
        await L.goto(p, "/pos");
        if (!(await p.locator('[data-testid="cart-line"]').count())) await L.addFirstItems(p, 1);
        const charge = p.getByRole("button", { name: /^Charge/ });
        if (!(await charge.isVisible())) {
          // Narrow screens put the bill in a sheet behind a "view bill" bar.
          await p.getByRole("button", { name: /View bill|Bill ·|items? ·|Cart/ }).first().click();
        }
        await charge.click();
        await p.getByRole("dialog", { name: /Payment/ }).waitFor();
        const ov = await overflowX(p);
        check(`${vp.name} payment dialog fits`, !ov, ov);
        await p.screenshot({ path: path.join(shots, `${vp.name}_pos-payment.png`) });
        await p.getByRole("dialog", { name: /Payment/ }).getByRole("button", { name: "Cancel" }).click();
      });
      const ctx = await L.newContext(browser, ctxOpts);
      const g = await ctx.newPage();
      const ge = L.watch(g, "guest");
      await step(`${vp.name} online ordering`, async () => {
        await g.goto(`${BASE}/o/${SLUG}`);
        await g.locator('[data-testid="menu-item"]').first().waitFor({ timeout: 20000 });
        const ov = await overflowX(g);
        check(`${vp.name} /o: no horizontal scroll`, !ov, ov);
        await g.locator('[data-testid="menu-item"]').first().getByRole("button", { name: /add/i }).first().click();
        check(`${vp.name} /o: cart bar or cart panel visible`, await g.getByRole("button", { name: /View cart|^Checkout/ }).first().isVisible());
        await g.screenshot({ path: path.join(shots, `${vp.name}_online.png`) });
      });
      const errs = [...cashier.errors, ...kitchen.errors, ...ge];
      check(`${vp.name}: no console errors`, errs.length === 0, errs.slice(0, 4).join(" | "));
      await Promise.all([cashier.ctx.close(), kitchen.ctx.close(), ctx.close()]);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  const only = (process.env.ONLY || "browsers,viewports").split(",");
  try {
    if (only.includes("browsers")) await crossBrowser();
    if (only.includes("viewports")) await viewports();
  } finally {
    L.finish("browsers");
  }
})();
