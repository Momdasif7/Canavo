"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import clsx from "clsx";
import { BellRinging, CheckCircle, Receipt } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { publicCall, STAGE_LABEL, type TableOrder, type TablePage } from "@/lib/storefront";
import { useToast } from "@/components/providers/ToastProvider";
import { CartBar, CartLines, StoreHeader, StoreMenu, useCart } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

const STAGE_TONE: Record<string, string> = {
  waiting: "text-amber-700 dark:text-amber-300",
  cancelled: "text-red-600 dark:text-red-400",
  ready: "text-secondary dark:text-green-300",
  served: "text-muted",
};

/** Phase 6.3: the page a guest opens by scanning the QR code on their table. */
export default function TableOrderPage() {
  const { token } = useParams<{ token: string }>();
  const toast = useToast();
  const [page, setPage] = useState<TablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<TableOrder[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);
  const [calling, setCalling] = useState<"WAITER" | "BILL" | null>(null);
  const cart = useCart(`canavo.qrcart.${token}`);
  const { prune } = cart;

  const load = useCallback(async () => {
    try {
      const p = await publicCall<TablePage>("GET", `/public/t/${token}`);
      setPage(p);
      setError(null);
      document.title = `${p.outlet.name} · Table ${p.table.label}`;
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
    void loadOrders();
  }, [load, loadOrders]);
  useEffect(() => {
    if (page) prune(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  // Order status: poll while something is still on its way (slower otherwise); menu every few minutes.
  const active = orders.some((o) => !["served", "cancelled"].includes(o.stage));
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === "visible" && void loadOrders(), active ? 8_000 : 30_000);
    return () => window.clearInterval(id);
  }, [loadOrders, active]);
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), 180_000);
    return () => window.clearInterval(id);
  }, [load]);

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

  if (error && !page) return <main className="mx-auto max-w-md p-6"><ErrorState message={error} onRetry={load} /></main>;
  if (!page) return <LoadingState label="Opening the menu…" />;

  const phoneBad = phone.trim() !== "" && !/^[6-9]\d{9}$/.test(phone.trim());

  return (
    <main className="min-h-screen">
      <StoreHeader brand={page.outlet} subtitle={<>Table <strong className="text-fg">{page.table.label}</strong></>} />

      <div className="mx-auto max-w-3xl space-y-3 px-4 pt-3">
        {page.notice && <Alert tone="info">{page.notice}</Alert>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" icon={<BellRinging size={20} />} loading={calling === "WAITER"} onClick={() => void call("WAITER")}>
            Call waiter
          </Button>
          <Button variant="outline" icon={<Receipt size={20} />} loading={calling === "BILL"} onClick={() => void call("BILL")}>
            Ask for bill
          </Button>
        </div>
        {orders.length > 0 && (
          <section aria-label="Your orders" className="rounded-2xl border border-line bg-surface p-3">
            <h2 className="mb-2 text-sm font-bold text-fg">Your orders</h2>
            <ul className="space-y-2" aria-live="polite">
              {orders.map((o) => (
                <li key={o.id} className="rounded-xl bg-surface-2 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className={clsx("flex items-center gap-1.5 font-bold", STAGE_TONE[o.stage] ?? "text-primary")}>
                      {o.stage === "ready" && <CheckCircle size={18} weight="fill" />}
                      {STAGE_LABEL[o.stage]}
                    </span>
                    <span className="text-muted">{formatTime(o.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-muted">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}</p>
                  {o.rejectReason && <p className="mt-1 text-red-600 dark:text-red-400">{o.rejectReason}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <StoreMenu menu={page} brand={page.outlet} cart={cart} canOrder={page.ordering} />
      {page.ordering && <CartBar cart={cart} onOpen={() => setCartOpen(true)} />}

      <Dialog
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        title={`Your order · Table ${page.table.label}`}
        footer={
          <Button block size="lg" loading={placing} disabled={!cart.count || phoneBad} onClick={() => void place()}>
            Place order · {formatINR(cart.total)}
          </Button>
        }
      >
        {cart.count === 0 ? (
          <p className="py-6 text-center text-muted">Your cart is empty.</p>
        ) : (
          <div className="space-y-4">
            <CartLines cart={cart} />
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
            <p className="text-xs text-muted">
              Added to your table&apos;s bill. {page.outlet.gstEnabled && !page.outlet.pricesIncludeTax ? "GST is added to the bill. " : ""}
              {page.needsConfirmation ? "A waiter confirms your order before it goes to the kitchen." : "Your order goes straight to the kitchen."}
            </p>
          </div>
        )}
      </Dialog>
    </main>
  );
}
