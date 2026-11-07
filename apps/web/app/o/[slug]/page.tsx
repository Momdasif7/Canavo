"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { primaryCssVars } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { publicCall, type OutletPage } from "@/lib/storefront";
import { useCart } from "@/components/storefront/StoreMenu";
import { StoreBanner } from "@/components/storefront/online/StoreBanner";
import { OnlineMenu } from "@/components/storefront/online/OnlineMenu";
import { CartPanel, CheckoutSheet, FloatingCartBar } from "@/components/storefront/online/Checkout";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

/** Phase 6.4: the outlet's own online ordering page (takeaway / delivery) and digital menu. */
export default function OnlineOrderPage() {
  const { slug } = useParams<{ slug: string }>();
  const [page, setPage] = useState<OutletPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const cart = useCart(`canavo.onlinecart.${slug}`);
  const { prune } = cart;

  const load = useCallback(async () => {
    try {
      const p = await publicCall<OutletPage>("GET", `/public/o/${slug}`);
      setPage(p);
      setError(null);
      document.title = p.outlet.name;
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page) prune(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  // The store's brand colour for everything on this page (buttons, tabs, steppers, sheets).
  const brandVars = useMemo(() => (page?.accent ? (primaryCssVars(page.accent) as React.CSSProperties) : undefined), [page?.accent]);

  if (error && !page)
    return (
      <main className="mx-auto max-w-md p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  if (!page) return <LoadingState label="Opening the menu…" />;

  return (
    <div style={brandVars} className="min-h-screen bg-bg pb-28 lg:pb-12">
      <StoreBanner page={page} />
      <main className="mx-auto max-w-6xl px-4">
        {page.notice && (
          <div className="mt-4">
            <Alert tone="info">{page.notice}</Alert>
          </div>
        )}
        <div className="mt-2 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
          <OnlineMenu menu={page} brand={page.outlet} cart={cart} canOrder={page.ordering} />
          <div className="pt-4">
            <CartPanel cart={cart} canOrder={page.ordering} onCheckout={() => setOpen(true)} />
          </div>
        </div>
      </main>
      {page.ordering && <FloatingCartBar cart={cart} onOpen={() => setOpen(true)} />}
      {page.ordering && <CheckoutSheet open={open} onClose={() => setOpen(false)} slug={slug} page={page} cart={cart} reload={() => void load()} />}
    </div>
  );
}
