"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import clsx from "clsx";
import { BellRinging, CheckCircle, ForkKnife, Receipt, ShoppingCartSimple } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { publicCall, STAGE_LABEL, type TableOrder } from "@/lib/storefront";
import type { SeatTablePage } from "@/lib/theatre";
import { SeatOrderView } from "@/components/theatre/SeatOrder";
import { useCinemaMode } from "@/components/theatre/cinema";
import { useToast } from "@/components/providers/ToastProvider";
import { BrandStyle, CartBar, CartLines, EmptyCart, MenuSkeleton, StoreHero, StoreMenu, useCart, type Cart } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert, ErrorState } from "@/components/ui/States";

const STAGE_TONE: Record<string, string> = {
  waiting: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  ready: "bg-secondary-50 text-secondary-700 dark:bg-green-500/15 dark:text-green-300",
  served: "bg-surface-2 text-muted",
};

/** Phase 6.3: the page a guest opens by scanning the QR code on their table. */
export default function TableOrderPage() {
  const { token } = useParams<{ token: string }>();
  const toast = useToast();
  const [page, setPage] = useState<SeatTablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<TableOrder[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);
  const [calling, setCalling] = useState<"WAITER" | "BILL" | null>(null);
  const cart = useCart(`canavo.qrcart.${token}`);
  // Cinema seat (THEATRE): its own dark, quiet ordering flow.
  const seat = Boolean(page?.theatre);
  useCinemaMode(seat);
  const { prune } = cart;

  const load = useCallback(async () => {
    try {
      const p = await publicCall<SeatTablePage>("GET", `/public/t/${token}`);
      setPage(p);
      setError(null);
      document.title = p.theatre ? `${p.outlet.name} · ${p.theatre.seat.screenName} · ${p.theatre.seat.row}${p.theatre.seat.seatNumber}` : `${p.outlet.name} · Table ${p.table.label}`;
      // Opened with the cinema flag but it's a normal table: back to the usual look.
      if (!p.theatre) document.documentElement.classList.remove("cinema");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [token]);
  const loadOrders = useCallback(async () => {
    try {
      setOrders(await publicCall<TableOrder[]>("GET", `/public/t/${token}/orders`));
    } catch {
      /* keep the last list */
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page && !seat) void loadOrders();
  }, [page, seat, loadOrders]);
  useEffect(() => {
    if (page) prune(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  // Order status: poll while something is still on its way (slower otherwise); menu every few minutes.
  const active = orders.some((o) => !["served", "cancelled"].includes(o.stage));
  useEffect(() => {
    if (!page || seat) return;
    const id = window.setInterval(() => document.visibilityState === "visible" && void loadOrders(), active ? 8_000 : 30_000);
    return () => window.clearInterval(id);
  }, [loadOrders, active, page, seat]);
  useEffect(() => {
    if (seat) return;
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), 180_000);
    return () => window.clearInterval(id);
  }, [load, seat]);

  const place = async () => {
    setPlacing(true);
    try {
      await publicCall("POST", `/public/t/${token}/orders`, {
        items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes?.trim() || undefined })),
        notes: notes.trim() || undefined,
        customerName: name.trim() || undefined,
        customerPhone: phone.trim() || undefined,
      });
      cart.clear();
      setNotes("");
      setCartOpen(false);
      toast(page?.needsConfirmation ? "Order sent — a waiter will confirm it shortly" : "Order sent to the kitchen", "success");
      void loadOrders();
    } catch (e) {
      toast(errorMessage(e), "error");
      void load();
    } finally {
      setPlacing(false);
    }
  };

  const call = async (kind: "WAITER" | "BILL") => {
    setCalling(kind);
    try {
      await publicCall("POST", `/public/t/${token}/call`, { kind });
      toast(kind === "WAITER" ? "A waiter is on the way" : "We'll bring your bill", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setCalling(null);
    }
  };

  if (error && !page)
    return (
      <main className="mx-auto max-w-md p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  if (!page) return <MenuSkeleton />;
  if (page.theatre) return <SeatOrderView token={token} page={page} onReload={load} />;

  const phoneBad = phone.trim() !== "" && !/^[6-9]\d{9}$/.test(phone.trim());
  const checkout = (c: Cart) => (
    <div className="space-y-4">
      <CartLines cart={c} menu={page} />
      <Input label="Anything else?" placeholder="e.g. less spicy, no onion" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Your name (optional)" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Phone (optional)"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          error={phoneBad ? "Enter a 10-digit mobile number" : null}
        />
      </div>
      <p className="rounded-xl bg-surface-2 p-3 text-xs text-muted">
        Added to your table&apos;s bill — pay when you leave. {page.outlet.gstEnabled && !page.outlet.pricesIncludeTax ? "GST is added to the bill. " : ""}
        {page.needsConfirmation ? "A waiter confirms your order before it goes to the kitchen." : "Your order goes straight to the kitchen."}
      </p>
    </div>
  );

  return (
    <main className="min-h-screen bg-bg">
      <BrandStyle accent={page.outlet.accent} />
      <StoreHero
        brand={page.outlet}
        open={page.ordering}
        status={
          <>
            Table <strong className="text-fg">{page.table.label}</strong>
            {page.hours ? ` · Orders ${page.hours.from}–${page.hours.to}` : ""}
          </>
        }
        tagline={page.outlet.address}
      >
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" icon={<BellRinging size={20} />} loading={calling === "WAITER"} onClick={() => void call("WAITER")}>
            Call waiter
          </Button>
          <Button variant="outline" icon={<Receipt size={20} />} loading={calling === "BILL"} onClick={() => void call("BILL")}>
            Ask for bill
          </Button>
        </div>
      </StoreHero>

      <div className="mx-auto max-w-6xl px-4">
        {page.notice && (
          <div className="mt-4">
            <Alert tone={page.ordering ? "info" : "warning"}>{page.notice}</Alert>
          </div>
        )}
        {orders.length > 0 && (
          <section aria-label="Your orders" className="mt-4 rounded-2xl border border-line bg-surface p-3">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-extrabold text-fg">
              <ForkKnife size={18} className="text-primary" /> Your orders
            </h2>
            <ul className="space-y-2" aria-live="polite">
              {orders.map((o) => (
                <li key={o.id} className="rounded-xl bg-surface-2/60 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold", STAGE_TONE[o.stage] ?? "bg-primary-50 text-primary dark:bg-primary/10")}>
                      {o.stage === "ready" && <CheckCircle size={14} weight="fill" />}
                      {STAGE_LABEL[o.stage]}
                    </span>
                    <span className="text-xs text-muted">{formatTime(o.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-muted">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}</p>
                  {o.rejectReason && <p className="mt-1 text-red-600 dark:text-red-400">{o.rejectReason}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
          <div className="min-w-0">
            <StoreMenu menu={page} brand={page.outlet} cart={cart} canOrder={page.ordering} closedLabel="Order with your waiter" />
          </div>
          {page.ordering && (
            <aside className="hidden lg:block" aria-label="Your order">
              <div className="sticky top-4 mt-4 rounded-3xl border border-line bg-surface p-4 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-extrabold text-fg">
                  <ShoppingCartSimple size={22} weight="bold" className="text-primary" /> Table {page.table.label}
                </h2>
                {cart.count === 0 ? (
                  <EmptyCart />
                ) : (
                  <>
                    {checkout(cart)}
                    <Button block size="lg" className="mt-3" loading={placing} disabled={phoneBad} onClick={() => void place()}>
                      Place order · {formatINR(cart.total)}
                    </Button>
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>

      {page.ordering && <CartBar cart={cart} onOpen={() => setCartOpen(true)} />}

      <Dialog
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        title={`Your order · Table ${page.table.label}`}
        footer={
          cart.count > 0 ? (
            <Button block size="lg" loading={placing} disabled={phoneBad} onClick={() => void place()}>
              Place order · {formatINR(cart.total)}
            </Button>
          ) : undefined
        }
      >
        {cart.count === 0 ? <EmptyCart onBrowse={() => setCartOpen(false)} /> : checkout(cart)}
      </Dialog>
    </main>
  );
}
