#!/usr/bin/env node
/* eslint-disable */
/**
 * Robustness (Chromium): double-click on Charge, refresh / back mid-bill, refresh with the payment
 * dialog open (no duplicate bill), two tabs billing at once, access-token expiry mid-bill (silent
 * refresh) and full session loss (re-login keeps the cart), empty states. Zero console errors.
 */
const L = require("./lib.cjs");
const { suite, check, step, BASE } = L;

const cartCount = (p) => p.locator('[data-testid="cart-line"]').count();
async function recent(auth, t0) {
  const r = await L.call(auth, "GET", "/orders?limit=100");
  return (Array.isArray(r.body) ? r.body : []).filter((o) => Date.parse(o.createdAt) >= t0);
}
async function pay(p) {
  const d = p.getByRole("dialog", { name: /Payment/ });
  await d.getByRole("button", { name: "Exact" }).click();
  await d.getByTestId("payment-confirm").click();
  await p.getByRole("dialog", { name: /^Paid/ }).waitFor({ timeout: 15000 });
  const inv = (await p.getByRole("dialog", { name: /^Paid/ }).getByRole("heading").first().innerText()).split("·").pop().trim();
  await p.getByRole("button", { name: "New bill" }).click();
  return inv;
}

(async () => {
  const browser = await L.launch("chromium");
  const owner = await L.apiLogin("owner");
  try {
    suite("robustness: mid-bill");
    const s = await L.session(browser, "cashier");
    const p = s.page;
    await L.goto(p, "/pos");
    await step("refresh mid-bill keeps the cart", async () => {
      await L.addFirstItems(p, 2);
      const before = await cartCount(p);
      check("two lines in the cart before refresh", before === 2, `${before}`);
      await p.waitForTimeout(500);
      await p.reload();
      await L.settle(p);
      check("cart survives a refresh", (await cartCount(p)) === 2, `${await cartCount(p)} lines`);
    });
    await step("back mid-bill keeps the cart", async () => {
      await p.getByRole("link", { name: "Bills" }).first().click();
      await p.waitForURL(/\/bills/);
      await p.goBack();
      await p.locator('[data-testid="item-card"]').first().waitFor();
      check("cart survives Back", (await cartCount(p)) === 2);
    });
    await step("double-click Charge + refresh with payment open → one bill", async () => {
      const t0 = Date.now() - 1000;
      await p.getByRole("button", { name: /^Charge/ }).dblclick();
      const d = p.getByRole("dialog", { name: /Payment/ });
      await d.waitFor();
      const first = (await d.getByRole("heading").innerText()).split("·").pop().trim();
      await p.reload();
      await L.settle(p);
      check("cart still there after refresh with the payment dialog open", (await cartCount(p)) === 2);
      await p.getByRole("button", { name: /^Charge/ }).click();
      await d.waitFor();
      const again = (await d.getByRole("heading").innerText()).split("·").pop().trim();
      check("re-charging returns the same bill", first === again, `${first} vs ${again}`);
      await pay(p);
      const bills = await recent(owner, t0);
      check("exactly one bill created", bills.length === 1, bills.map((b) => b.invoiceNumber).join(","));
    });
    await step("identical next bill is a new bill (ui-6)", async () => {
      const t0 = Date.now() - 500;
      await L.addFirstItems(p, 1);
      await p.getByRole("button", { name: /^Charge/ }).click();
      const a = await pay(p);
      await L.addFirstItems(p, 1);
      await p.getByRole("button", { name: /^Charge/ }).click();
      const b = await pay(p);
      check("two identical carts make two bills", a !== b && (await recent(owner, t0)).length === 2, `${a} / ${b}`);
    });

    suite("robustness: multi-tab");
    await step("two tabs bill independently", async () => {
      const t0 = Date.now() - 500;
      const p2 = await s.ctx.newPage();
      const e2 = L.watch(p2, "tab2");
      await L.goto(p2, "/pos");
      await L.addFirstItems(p, 1);
      await p2.getByRole("button", { name: /Mango Lassi/ }).click();
      await p.getByRole("button", { name: /^Charge/ }).click();
      await p2.getByRole("button", { name: /^Charge/ }).click();
      const [a, b] = [await pay(p), await pay(p2)];
      check("both tabs got their own bill", a && b && a !== b && (await recent(owner, t0)).length === 2, `${a} / ${b}`);
      check("no console errors (tab 2)", e2.length === 0, e2.join(" | "));
      await p2.close();
    });

    suite("robustness: session expiry");
    await step("expired access token mid-bill → silent refresh, bill goes through", async () => {
      await L.addFirstItems(p, 1);
      let once = true;
      await p.route(`${L.API}/orders`, (r) =>
        r.request().method() === "POST" && once ? ((once = false), r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Token expired" }) })) : r.continue(),
      );
      await p.getByRole("button", { name: /^Charge/ }).click();
      await pay(p);
      check("bill paid after a token refresh", !once);
      await p.unroute(`${L.API}/orders`);
    });
    await step("session lost mid-bill → login, cart kept", async () => {
      await L.addFirstItems(p, 2);
      await p.waitForTimeout(600);
      await s.ctx.clearCookies(); // refresh cookie gone = session over
      await p.route(`${L.API}/**`, (r) => (/\/auth\//.test(r.request().url()) ? r.continue() : r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Token expired" }) })));
      await p.getByRole("button", { name: /^Charge/ }).click();
      await p.waitForURL(/\/login/, { timeout: 15000 });
      const msg = await L.bodyText(p);
      check("sent to login with a clear message", /session|log in again|expired|signed out/i.test(msg), msg.slice(0, 120));
      await p.unroute(`${L.API}/**`);
      await p.getByLabel("Email").fill("cashier@canavo.local");
      await p.getByLabel("Password").fill(L.PASSWORD);
      await p.getByRole("button", { name: "Log in", exact: true }).click();
      await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
      await L.goto(p, "/pos");
      check("cart restored after re-login", (await cartCount(p)) === 2, `${await cartCount(p)} lines`);
    });

    suite("states");
    await step("empty + validation states", async () => {
      await L.goto(p, "/bills?search=zzzz-no-such-bill");
      const search = p.getByRole("searchbox").first();
      if (await search.count()) {
        await search.fill("zzzz-no-such-bill");
        await p.waitForTimeout(1200);
      }
      check("Bills shows an empty state", /No bills|Nothing|No results|no matching/i.test(await L.bodyText(p)));
      await L.goto(p, "/pos");
      const phone = p.getByRole("button", { name: /Add customer/ });
      if (await phone.count()) {
        await phone.click();
        await p.getByLabel("Customer phone").fill("12345");
        await p.getByRole("button", { name: /^Charge/ }).click().catch(() => {});
        await p.waitForTimeout(500);
        check("invalid phone shows a validation message", /valid|10-digit|mobile/i.test(await p.getByRole("region", { name: "Current bill" }).innerText()));
      }
    });
    const errs = s.errors.filter((e) => !/ 401 /.test(e));
    check("no console errors (robustness)", errs.length === 0, errs.slice(0, 4).join(" | "));
    await s.ctx.close();
  } finally {
    await browser.close();
    L.finish("robust");
  }
})();
