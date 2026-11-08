#!/usr/bin/env node
/* eslint-disable */
/**
 * Accessibility: axe-core (WCAG 2.1 A/AA + best practice) on the main pages, light and dark theme;
 * serious / critical violations fail. Keyboard: POS billing without a mouse, dialog focus trap,
 * Escape and focus return. Report: OUT_DIR/a11y-report.json (every violation with its targets).
 * Env: THEMES=light,dark
 */
const fs = require("fs");
const path = require("path");
const L = require("./lib.cjs");
const { suite, check, step, BASE, SLUG } = L;

// Scope agreed for Phase 11 (time-boxed): the counter-facing screens. Add routes here to widen it.
const PAGES = {
  anon: ["/login", `/o/${SLUG}`],
  cashier: ["/pos", "/bills"],
  kitchen: ["/kitchen"],
};

async function keyboard(browser) {
  suite("keyboard: POS + dialogs");
  const s = await L.session(browser, "cashier");
  const p = s.page;
  await L.goto(p, "/pos");
  await step("POS bill without a mouse", async () => {
    const search = p.getByRole("searchbox", { name: "Search menu" });
    await search.focus();
    await p.keyboard.type("Badam");
    await p.waitForTimeout(400);
    // Tab from the search box should reach the first matching item card.
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await p.keyboard.press("Tab");
      reached = await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "item-card");
    }
    check("Tab reaches the item cards", reached);
    await p.keyboard.press("Enter");
    check("Enter adds the item", (await p.locator('[data-testid="cart-line"]').count()) === 1);
    const charge = p.getByRole("button", { name: /^Charge/ });
    await charge.focus();
    await p.keyboard.press("Enter");
    const d = p.getByRole("dialog", { name: /Payment/ });
    await d.waitFor();
    await p.waitForTimeout(300);
    const inside = await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    check("focus moves into the payment dialog", inside);
    let trapped = true;
    for (let i = 0; i < 30; i++) {
      await p.keyboard.press("Tab");
      if (!(await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) trapped = false;
    }
    check("Tab stays inside the dialog (focus trap)", trapped);
    await p.keyboard.press("Escape");
    await d.waitFor({ state: "hidden", timeout: 5000 });
    const back = await p.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    check("Escape closes and focus returns to Charge", /^Charge/.test(back), back.slice(0, 40));
    const focusVisible = await charge.evaluate((el) => {
      el.focus();
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== "none" || cs.boxShadow !== "none";
    });
    check("focused button shows a focus indicator", focusVisible);
  });
  await s.ctx.close();
}

async function scan(browser, theme, summary, report) {
  suite(`axe: ${theme} theme`);
  for (const [role, routes] of Object.entries(PAGES)) {
    const ctxOpts = { colorScheme: theme, viewport: { width: 1366, height: 900 } };
    let ctx, page;
    if (role === "anon") {
      ctx = await L.newContext(browser, ctxOpts);
      page = await ctx.newPage();
    } else {
      ({ ctx, page } = await L.session(browser, role, { context: ctxOpts }));
    }
    for (const route of routes) {
      await step(`${theme} ${route}`, async () => {
        await page.goto(BASE + route);
        await L.settle(page, 1200);
        if (route.startsWith("/o/")) await page.locator('[data-testid="menu-item"]').first().waitFor({ timeout: 15000 }).catch(() => {});
        const v = await L.axe(page);
        for (const x of v) {
          summary[x.impact] = (summary[x.impact] || 0) + 1;
          report.push({ theme, role, route, ...x });
        }
        // Known, product-owned exception: the CANAVO brand orange #FF6B35 is 2.83:1 against white (white text
        // on orange buttons, orange text / chips on white or orange tints). Changing it is a brand decision (see appearance.ts);
        // those nodes are counted under "brand" and don't fail the gate. Everything else does.
        const isBrand = (n) => /#ff6b35/i.test(n.msg);
        const bad = [];
        for (const x of v) {
          if (x.impact !== "serious" && x.impact !== "critical") continue;
          const rest = x.id === "color-contrast" ? x.all.filter((n) => !isBrand(n)) : x.all;
          summary.brand = (summary.brand || 0) + (x.all.length - rest.length);
          if (rest.length) bad.push({ ...x, nodes: rest.length, targets: rest.map((n) => n.target) });
        }
        check(`${theme} ${route}: no serious/critical axe issues`, bad.length === 0, bad.map((x) => `${x.id}(${x.nodes}) ${x.targets[0]}`).join(" | "));
      });
    }
    await ctx.close();
  }
}

(async () => {
  const browser = await L.launch("chromium");
  const summary = {};
  const report = [];
  try {
    if (!process.env.ONLY || process.env.ONLY.includes("keyboard")) await keyboard(browser);
    if (!process.env.ONLY || process.env.ONLY.includes("axe"))
      for (const theme of (process.env.THEMES || "light,dark").split(",")) await scan(browser, theme, summary, report);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(L.OUT, "a11y-report.json"), JSON.stringify({ summary, report }, null, 2));
    console.log("\naxe violations by impact:", JSON.stringify(summary));
    L.finish("a11y");
  }
})();
