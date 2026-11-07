/** Bill detail shows the food's progress: KOTs carry when each stage was reached. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("KOT status");
});
afterAll(() => srv.close());

type Kot = { id: string; status: string; preparingAt: string | null; readyAt: string | null; servedAt: string | null };

describe("kitchen status on the bill", () => {
  it("stamps each stage, back-fills a skipped one, clears later ones on a step back, and the bill shows it", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    const kitchen = await login(srv.base, h.users.kitchen.email, h.outletId);
    const bill = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 2 }] });
    expect(bill.status).toBe(201);
    const kots = () => cashier.call("GET", `/orders/${bill.body.id}`).then((r) => r.body.kots as Kot[]);
    const [kot] = await kots();
    expect(kot).toMatchObject({ status: "RECEIVED", preparingAt: null, readyAt: null, servedAt: null });

    // Straight to Ready: Preparing is stamped too.
    expect((await kitchen.call("PATCH", `/kot/${kot!.id}`, { status: "READY" })).status).toBe(200);
    let [k] = await kots();
    expect(k!.status).toBe("READY");
    expect(k!.preparingAt).toBeTruthy();
    expect(k!.readyAt).toBeTruthy();
    expect(k!.servedAt).toBeNull();

    // Back to Preparing (pressed by mistake): Ready is cleared, Preparing keeps its time.
    await kitchen.call("PATCH", `/kot/${kot!.id}`, { status: "PREPARING" });
    const [back] = await kots();
    expect(back!.readyAt).toBeNull();
    expect(back!.preparingAt).toBe(k!.preparingAt);

    await kitchen.call("PATCH", `/kot/${kot!.id}`, { status: "SERVED" });
    [k] = await kots();
    expect(k!.status).toBe("SERVED");
    expect(k!.readyAt).toBeTruthy();
    expect(k!.servedAt).toBeTruthy();
  });
});
