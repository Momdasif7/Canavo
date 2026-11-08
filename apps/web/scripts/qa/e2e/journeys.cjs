#!/usr/bin/env node
/* eslint-disable */
/**
 * Role journeys (Chromium): super admin onboarding → owner menu + staff → cashier bill → kitchen KOT
 * → payment → owner report; delivery partner day; inventory day; waiter table tab; cinema seat order
 * → runner board. Every page must stay free of console errors, page errors and API 5xx.
 */
const L = require("./lib.cjs");
const { suite, check, step, BASE } = L;

const stamp = Date.now().toString(36).slice(-5);

async function chain(browser) {
  suite("journey: onboarding → menu/staff → bill → KOT → pay → report");
  const all = [];

  // 1. Super admin onboards a business.
  const admin = await L.session(browser, "admin");
  all.push(admin.errors);
  await step("admin onboards a business", async () => {
    const p = admin.page;
    await L.goto(p, "/platform/businesses/new");
    await p.getByRole("button", { name: "Next" }).click();
    check("wizard validates the business name", /name/i.test(await p.getByRole("alert").first().innerText().catch(() => "")));
    await p.getByLabel("Business name").fill(`QA Bistro ${stamp}`);
    await p.getByLabel("Contact phone").fill("9876501234");
    await p.getByRole("button", { name: "Next" }).click();
    await p.getByRole("button", { name: "Next" }).click(); // modules: defaults
    await p.getByLabel("Owner name").fill("QA Owner");
    await p.getByLabel("Owner mobile").fill(`98${String(Date.now()).slice(-8)}`);
    await p.getByLabel("Owner email (login)").fill(`qa-owner-${stamp}@example.com`);
    await p.getByRole("button", { name: "Next" }).click();
    const outlet = p.getByLabel("Outlet name");
    if (await outlet.isVisible().catch(() => false)) {
      await outlet.fill("QA Main");
      await p.getByLabel("Address").fill("1 MG Road, Bengaluru");
      await p.getByRole("button", { name: "Next" }).click();
      const msg = await p.getByRole("alert").first().innerText().catch(() => "");
      check("outlet step error uses words, not schema keys (ui-1)", /state code/i.test(msg) && !/stateCode/.test(msg), msg);
      await p.getByLabel("State code").fill("29");
    }
    await p.getByRole("button", { name: "Next" }).click();
    const create = p.getByRole("button", { name: "Create business" });
    await create.dblclick(); // double-click must create exactly one business
    await p.getByRole("heading", { name: /is live/ }).waitFor({ timeout: 15000 });
    check("business created (wizard success)", true);
    const auth = await L.apiLogin("admin");
    const list = await L.call(auth, "GET", `/platform/businesses?search=${encodeURIComponent(`QA Bistro ${stamp}`)}`);
    const rows = (Array.isArray(list.body) ? list.body : list.body?.items ?? list.body?.businesses ?? []).filter((b) => b.name === `QA Bistro ${stamp}`);
    check("double-click on Create business made one business", rows.length === 1, `found ${rows.length} (${list.status})`);
  });

  // 2. Owner adds a menu item and a staff member.
  const owner = await L.session(browser, "owner");
  all.push(owner.errors);
  const itemName = `QA Paneer Roll ${stamp}`;
  await step("owner adds a menu item", async () => {
    const p = owner.page;
    await L.goto(p, "/menu");
    await p.getByRole("button", { name: /^(Add|New) item/ }).click();
    const d = p.getByRole("dialog");
    await d.getByRole("button", { name: /^Save/ }).click();
    check("item form shows a validation message", (await d.getByRole("alert").count()) > 0 || /required|enter/i.test(await d.innerText()));
    await d.getByLabel("Name").fill(itemName);
    await d.getByLabel("Base price").fill("75");
    await d.getByRole("button", { name: /^Save/ }).click();
    await d.waitFor({ state: "hidden", timeout: 10000 });
    await p.getByText(itemName).first().waitFor({ timeout: 10000 });
    check("menu item saved and listed", true);
  });
  await step("owner adds a staff member", async () => {
    const p = owner.page;
    await L.goto(p, "/staff");
    await p.getByRole("button", { name: /Add staff/ }).click();
    const d = p.getByRole("dialog");
    await d.getByLabel("Full name").fill(`QA Cashier ${stamp}`);
    await d.getByLabel("Mobile").fill(`97${String(Date.now()).slice(-8)}`);
    await d.getByLabel("Role").selectOption("CASHIER");
    const pin = d.getByLabel("Attendance PIN");
    if (await pin.count()) await pin.fill(String(1000 + Math.floor(Math.random() * 8999)));
    const pw = d.getByLabel("Password", { exact: true });
    if (await pw.count()) await pw.fill("Qa-Staff-2026!x");
    await d.getByRole("button", { name: /^(Save|Add|Create)/ }).last().click();
    await d.waitFor({ state: "hidden", timeout: 10000 });
    await p.getByText(`QA Cashier ${stamp}`).first().waitFor({ timeout: 10000 });
    check("staff member saved and listed", true);
  });

  // 3. Cashier bills the new item (KOT goes to the kitchen), 4. kitchen bumps it, 5. payment.
  const cashier = await L.session(browser, "cashier");
  all.push(cashier.errors);
  let invoice = null;
  await step("cashier raises the bill", async () => {
    const p = cashier.page;
    await L.goto(p, "/pos");
    await p.getByRole("searchbox", { name: "Search menu" }).fill(itemName);
    await p.getByRole("button", { name: new RegExp(itemName) }).click();
    await p.getByRole("button", { name: /^Charge/ }).click();
    const d = p.getByRole("dialog", { name: /Payment/ });
    await d.waitFor();
    invoice = (await d.getByRole("heading").innerText()).split("·").pop().trim();
    check("bill created with an invoice number", /\w+-\d{4}-\d+/.test(invoice), invoice);
  });
  const kitchen = await L.session(browser, "kitchen");
  all.push(kitchen.errors);
  await step("kitchen moves the KOT to Ready", async () => {
    const p = kitchen.page;
    await L.goto(p, "/kitchen");
    const card = p.locator("article", { hasText: invoice });
    await card.waitFor({ timeout: 15000 });
    await card.getByRole("button", { name: "Start", exact: true }).click();
    await p.getByRole("region", { name: "Preparing" }).locator("article", { hasText: invoice }).waitFor({ timeout: 10000 });
    await p.getByRole("region", { name: "Preparing" }).locator("article", { hasText: invoice }).getByRole("button", { name: /^Ready/ }).click();
    await p.getByRole("region", { name: "Ready" }).locator("article", { hasText: invoice }).waitFor({ timeout: 10000 });
    check("KOT reached Ready on the KDS", true);
  });
  await step("cashier collects the payment", async () => {
    const p = cashier.page;
    const d = p.getByRole("dialog", { name: /Payment/ });
    await d.getByRole("button", { name: "Exact" }).click();
    await d.getByTestId("payment-confirm").dblclick();
    await p.getByRole("dialog", { name: /^Paid/ }).waitFor({ timeout: 15000 });
    check("paid receipt shown", true);
    const auth = await L.apiLogin("owner");
    const bills = await L.call(auth, "GET", `/orders?search=${encodeURIComponent(invoice)}`);
    const list = Array.isArray(bills.body) ? bills.body : bills.body?.items ?? bills.body?.orders ?? [];
    const o = list.find((x) => x.invoiceNumber === invoice);
    const paid = (o?.payments ?? []).filter((x) => x.status !== "VOID" && x.status !== "FAILED");
    check("double-click on Collect recorded one payment", o && paid.length === 1, `payments ${paid.length}, status ${o?.status}`);
    await p.getByRole("button", { name: "New bill" }).click();
  });

  // 6. Owner sees it in Bills and today's report.
  await step("owner finds the bill in Bills and Reports", async () => {
    const p = owner.page;
    await L.goto(p, "/bills");
    await p.getByText(invoice).first().waitFor({ timeout: 10000 });
    check("bill listed in Bills", true);
    await L.goto(p, "/reports");
    check("reports page renders", !(await L.crashed(p)) && /Sales|Revenue|Net/i.test(await L.bodyText(p)));
  });

  for (const s of [admin, owner, cashier, kitchen]) await s.ctx.close();
  const errs = all.flat();
  check("no console errors in the chain journey", errs.length === 0, errs.slice(0, 5).join(" | "));
}

async function deliveryDay(browser) {
  suite("journey: delivery partner day");
  const mgrAuth = await L.apiLogin("manager");
  const outlet = ((await L.call(mgrAuth, "GET", "/outlets")).body ?? []).find((o) => o.id === mgrAuth.outletId) ?? {};
  const geo = { latitude: outlet.latitude ?? 12.9716, longitude: outlet.longitude ?? 77.5946 };
  const dp = await L.session(browser, "delivery", { context: { geolocation: geo, permissions: ["geolocation"] } });
  const p = dp.page;
  await step("partner clocks in", async () => {
    await L.goto(p, "/delivery");
    const clockIn = p.getByRole("button", { name: "Clock in" });
    if (await clockIn.isVisible().catch(() => false)) {
      await clockIn.click();
      const d = p.getByRole("dialog");
      await d.waitFor({ timeout: 5000 }).catch(() => {});
      if (await d.isVisible().catch(() => false)) {
        await d.getByLabel("PIN").fill("1234");
        await d.getByRole("button", { name: "Clock in" }).click();
      }
    }
    await p.getByRole("button", { name: /Clock out/ }).waitFor({ timeout: 10000 });
    check("partner on duty", true);
  });
  let orderId = null, invoice = null, deliveryId = null;
  const deliveryStatus = async () => {
    const d = await L.call(mgrAuth, "GET", `/delivery/${deliveryId}`);
    if (d.status === 200) return d.body.status;
    const list = await L.call(mgrAuth, "GET", "/delivery?status=ALL");
    const rows = Array.isArray(list.body) ? list.body : list.body?.items ?? list.body?.deliveries ?? [];
    const row = rows.find((x) => x.orderId === orderId || x.order?.id === orderId);
    if (row) deliveryId = row.id;
    return row?.status ?? `?${list.status}`;
  };
  await step("manager assigns a COD delivery", async () => {
    const mgr = await L.apiLogin("manager");
    const agents = await L.call(mgr, "GET", "/delivery/agents");
    const me = (agents.body?.agents ?? agents.body ?? []).find((a) => /delivery/i.test(a.email ?? "") || /Delivery|Ravi|Partner/i.test(a.name ?? ""));
    const zones = await L.call(mgr, "GET", "/delivery/zones");
    const zone = (zones.body?.zones ?? zones.body ?? [])[0];
    const menu = await L.call(mgr, "GET", "/menu");
    const item = (menu.body.items ?? []).find((i) => !i.variants?.length && i.status !== "OUT_OF_STOCK" && !i.availableFrom);
    const r = await L.call(mgr, "POST", "/orders", {
      orderType: "DELIVERY",
      customerName: "QA Guest",
      customerPhone: "9812345678",
      items: [{ menuItemId: item.id, quantity: 2 }],
      delivery: { address: "12 Residency Road, Bengaluru", pincode: "560025", zoneId: zone?.id, agentId: me?.id, cod: true, forceAssign: true },
    });
    orderId = r.body?.id;
    invoice = r.body?.invoiceNumber;
    deliveryId = r.body?.delivery?.id ?? orderId;
    check("delivery order created + assigned", r.status === 201 && orderId, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  await step("partner runs the delivery", async () => {
    await L.goto(p, "/delivery");
    const card = () => p.locator("article, li, section").filter({ hasText: invoice }).filter({ has: p.getByRole("button") }).last();
    await card().waitFor({ timeout: 15000 });
    const seen = [];
    for (let i = 0; i < 8; i++) {
      const btns = card().getByRole("button");
      const names = (await btns.allInnerTexts()).map((t) => t.trim());
      const idx = names.findIndex((n) => n && !/Report a problem|Call|Navigate|Share|Maps|Copy/i.test(n));
      if (idx < 0) break;
      seen.push(names[idx]);
      await btns.nth(idx).click();
      await p.waitForTimeout(700);
      const d = p.getByRole("dialog");
      if (await d.isVisible().catch(() => false)) {
        const txt = await d.innerText();
        const cash = d.getByRole("button", { name: /^Cash/ });
        if (await cash.count()) await cash.first().click();
        const exact = d.getByRole("button", { name: "Exact" });
        if (await exact.count()) await exact.click();
        const otp = d.getByLabel(/OTP|code/i);
        if (await otp.count()) seen.push("otp-dialog:" + txt.slice(0, 60));
        await d.getByRole("button", { name: /Confirm|Delivered|Collect|Done|Save|Yes|Received|Complete/ }).last().click();
        await p.waitForTimeout(1000);
      }
      if ((await deliveryStatus()) === "DELIVERED") break;
    }
    const st = await deliveryStatus();
    check("delivery completed by the partner", st === "DELIVERED", `${st} via ${seen.join(" → ")}`);
  });
  await step("partner sees cash in hand", async () => {
    await L.goto(p, "/delivery/cash");
    check("cash handover page renders", !(await L.crashed(p)) && /Cash/i.test(await L.bodyText(p)));
  });
  check("no console errors (delivery partner)", dp.errors.length === 0, dp.errors.slice(0, 5).join(" | "));
  await dp.ctx.close();
}

async function inventoryDay(browser) {
  suite("journey: inventory day");
  const s = await L.session(browser, "inventory");
  const p = s.page;
  for (const route of ["/inventory", "/inventory/purchases", "/inventory/vendors", "/inventory/recipes", "/inventory/reports"]) {
    await step(`inventory ${route}`, async () => {
      await L.goto(p, route);
      check(`${route} renders`, !(await L.crashed(p)) && !/404|could not be found/i.test(await p.locator("h1").first().innerText().catch(() => "")));
    });
  }
  await step("stock adjustment", async () => {
    await L.goto(p, "/inventory");
    const row = p.getByRole("row").nth(1);
    await row.waitFor({ timeout: 10000 });
    const adjust = row.getByRole("button", { name: /Adjust|Stock/ }).first();
    if (!(await adjust.count())) return check("adjust action available", false, "no Adjust button on the first row");
    await adjust.click();
    const d = p.getByRole("dialog");
    await d.getByRole("button", { name: /^(Save|Adjust|Apply)/ }).last().click();
    check("adjust validates the quantity", (await d.isVisible()) && /enter|required|quantity/i.test(await d.innerText()));
    await d.getByLabel(/^Quantity to add/).fill("2");
    const reason = d.getByLabel(/reason|note/i).first();
    if (await reason.count()) {
      const tag = await reason.evaluate((e) => e.tagName);
      if (tag === "SELECT") await reason.selectOption({ index: 1 });
      else await reason.fill("QA count");
    }
    await d.getByRole("button", { name: /^(Save|Adjust|Apply)/ }).last().click();
    await d.waitFor({ state: "hidden", timeout: 10000 });
    check("stock adjusted", true);
  });
  check("no console errors (inventory)", s.errors.length === 0, s.errors.slice(0, 5).join(" | "));
  await s.ctx.close();
}

async function waiterTab(browser) {
  suite("journey: waiter table tab");
  const s = await L.session(browser, "waiter");
  const p = s.page;
  let table = null;
  await step("waiter opens a table and sends a KOT", async () => {
    // A fresh table per run (earlier runs leave their tabs open): first area, unique label.
    const own = await L.apiLogin("owner");
    const areas = (await L.call(own, "GET", "/tables/areas")).body;
    table = `Q${stamp}`.slice(0, 8);
    const made = await L.call(own, "POST", "/tables", { label: table, areaId: (Array.isArray(areas) ? areas : areas?.areas ?? [])[0]?.id ?? null, capacity: 2, posX: 0, posY: 0 });
    check("test table created", made.status === 201 || made.status === 200, `${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);
    await L.goto(p, "/tables");
    const free = p.getByRole("button", { name: new RegExp(`^Table ${table}, Available`) });
    await free.click();
    await p.getByRole("dialog", { name: `Open tab · Table ${table}` }).getByRole("button", { name: "Open tab" }).dblclick();
    const tab = p.getByRole("dialog", { name: `Table ${table}`, exact: true });
    await tab.getByRole("button", { name: "Add items" }).click();
    const add = p.getByRole("dialog", { name: `Add to Table ${table}` });
    await add.locator('[data-testid="item-card"]:not([disabled])').first().waitFor();
    const first = add.locator('[data-testid="item-card"]:not([disabled])').filter({ hasNotText: "Options" });
    await first.nth(0).click();
    await first.nth(1).click();
    await add.getByRole("button", { name: "Send to kitchen" }).dblclick();
    await add.waitFor({ state: "hidden", timeout: 10000 });
    const items = await tab.getByRole("region", { name: "Items" }).innerText();
    check("tab lists the sent items", !/Nothing ordered/.test(items), items.slice(0, 120));
    const auth = await L.apiLogin("manager");
    const kots = await L.call(auth, "GET", "/kot");
    const list = (Array.isArray(kots.body) ? kots.body : kots.body?.kots ?? kots.body?.items ?? []).filter((k) => JSON.stringify(k).includes(`"${table}"`));
    // Items may split across stations (one KOT each): count item quantity, not tickets.
    const qty = list.flatMap((k) => k.items ?? []).reduce((n, i) => n + (i.quantity ?? 1), 0);
    check("double-click on Send to kitchen sent the items once", qty === 2, `${list.length} KOTs, qty ${qty} for ${table}`);
  });
  await step("tab shows as running on the floor", async () => {
    await L.goto(p, "/tables");
    check("the table shows as occupied", (await p.getByRole("button", { name: new RegExp(`^Table ${table}, Occupied`) }).count()) === 1);
  });
  check("no console errors (waiter)", s.errors.length === 0, s.errors.slice(0, 5).join(" | "));
  await s.ctx.close();
}

async function cinema(browser) {
  suite("journey: cinema seat order → runner board");
  const owner = await L.apiLogin("owner");
  let seat;
  await step("set up a screen + show (API)", async () => {
    await L.call(owner, "PATCH", "/theatre/settings", { seatOrdering: true });
    await L.call(owner, "PATCH", "/storefront/settings", { qrOrdering: true, qrNeedsConfirmation: false });
    let screens = (await L.call(owner, "GET", "/theatre/screens")).body;
    let scr = Array.isArray(screens) ? screens.find((x) => x.name === "Screen QA") : null;
    if (!scr) scr = (await L.call(owner, "POST", "/theatre/screens", { name: "Screen QA" })).body;
    await L.call(owner, "POST", `/theatre/screens/${scr.id}/seats`, { rows: ["A", "B"], from: 1, to: 8 });
    const now = Date.now();
    await L.call(owner, "POST", "/theatre/showtimes", { screenId: scr.id, title: "QA Premiere", startsAt: new Date(now - 10 * 60e3).toISOString(), intervalAt: new Date(now + 50 * 60e3).toISOString(), endsAt: new Date(now + 120 * 60e3).toISOString(), orderCutoffMin: 10 });
    screens = (await L.call(owner, "GET", "/theatre/screens")).body;
    scr = screens.find((x) => x.id === scr.id);
    seat = scr.rows.find((r) => r.row === "B").seats.find((x) => x.seatNumber === 4);
    check("seat with QR token", !!seat?.qrToken);
  });
  const ctx = await L.newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const g = await ctx.newPage();
  const gErr = L.watch(g, "guest");
  const t0 = Date.now() - 2000;
  await step("guest orders from the seat", async () => {
    await g.goto(`${BASE}/t/${seat.qrToken}`);
    await g.locator('[data-testid="menu-item"]').first().waitFor({ timeout: 20000 });
    check("seat banner names the seat", /B4/.test(await L.bodyText(g)));
    await g.locator('[data-testid="menu-item"]').first().getByRole("button", { name: /add/i }).first().click();
    await g.getByRole("button", { name: /Next/ }).first().click();
    await g.getByRole("button", { name: /Next: when/ }).click();
    await g.getByRole("radio", { name: /seat now/ }).click();
    await g.getByRole("button", { name: /^Pay .* by UPI/ }).dblclick();
    await g.getByRole("heading", { name: "Pay by UPI" }).waitFor({ timeout: 15000 });
    check("guest reaches the UPI payment step", true);
    const st = await L.call(owner, "GET", `/public/t/${seat.qrToken}/orders`);
    const mine = (Array.isArray(st.body) ? st.body : st.body?.orders ?? []).filter((o) => Date.parse(o.createdAt ?? o.placedAt ?? 0) > t0);
    check("double-click on Pay by UPI placed one order", mine.length === 1, `${mine.length} orders (${st.status}) ${JSON.stringify(st.body).slice(0, 120)}`);
  });
  const s = await L.session(browser, "owner");
  await step("runner board shows the seat order", async () => {
    await L.goto(s.page, "/theatre/board");
    await s.page.getByText("B4").first().waitFor({ timeout: 15000 });
    check("board lists B4", true);
    const upi = s.page.getByRole("button", { name: /UPI received/i }).first();
    if (await upi.count()) {
      await upi.click();
      const c = s.page.getByRole("dialog").getByRole("button", { name: /confirm|yes|received/i });
      if (await c.count()) await c.last().click();
      await s.page.waitForTimeout(1200);
    }
    for (const name of [/^Ready/i, /Delivered/i]) {
      const b = s.page.locator("article, li", { hasText: "B4" }).getByRole("button", { name }).first();
      if (await b.count()) { await b.click(); await s.page.waitForTimeout(1000); }
    }
    const st = await L.call(owner, "GET", `/public/t/${seat.qrToken}/orders`).catch(() => null);
    const last = (Array.isArray(st?.body) ? st.body : st?.body?.orders ?? []).slice(-1)[0];
    check("runner board took the seat order to Delivered", last?.stage === "DELIVERED", JSON.stringify(last && { stage: last.stage }));
  });
  const errs = [...gErr, ...s.errors];
  check("no console errors (cinema)", errs.length === 0, errs.slice(0, 5).join(" | "));
  await ctx.close();
  await s.ctx.close();
}

(async () => {
  const browser = await L.launch("chromium");
  const only = (process.env.ONLY || "chain,delivery,inventory,waiter,cinema").split(",");
  try {
    if (only.includes("chain")) await chain(browser);
    if (only.includes("delivery")) await deliveryDay(browser);
    if (only.includes("inventory")) await inventoryDay(browser);
    if (only.includes("waiter")) await waiterTab(browser);
    if (only.includes("cinema")) await cinema(browser);
  } finally {
    await browser.close();
    L.finish("journeys");
  }
})();
