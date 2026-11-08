"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { Copy, FloppyDisk, Printer, QrCode, WhatsappLogo } from "@phosphor-icons/react";
import { formatINR, type StorefrontSettings } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import { publicPageUrl, type StorefrontSettingsView } from "@/lib/storefront";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input, Toggle } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Settings → Online ordering (channel:manage): QR ordering, the online page, and its share kit. */
export function OnlineOrderingSettings() {
  const { outletId } = useSession();
  const toast = useToast();
  const q = useApiQuery<StorefrontSettingsView>(outletId ? `storefront:${outletId}` : null, () => api.get<StorefrontSettingsView>("/storefront/settings"));
  const [s, setS] = useState<StorefrontSettings | null>(null);
  const [slug, setSlug] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setS(q.data.settings);
    setSlug(q.data.slug ?? slugify(q.data.outletName));
    setMinOrder(q.data.settings.minOrder ? rupeesInput(q.data.settings.minOrder) : "");
  }, [q.data]);

  if (q.loading && !q.data) return <LoadingState label="Loading…" />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!s || !q.data) return null;
  const view = q.data;
  const set = (patch: Partial<StorefrontSettings>) => setS({ ...s, ...patch });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const min = minOrder.trim() ? parseRupees(minOrder) : 0;
      if (min === null) throw new Error("Minimum order: enter an amount in rupees");
      const r = await api.put<StorefrontSettingsView>("/storefront/settings", { ...s, minOrder: min, slug: slug.trim() || null, acceptFrom: s.acceptFrom || null, acceptTo: s.acceptTo || null });
      q.setData(r);
      toast("Online ordering settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const savedSlug = view.slug;
  const pageUrl = savedSlug ? publicPageUrl(`/o/${savedSlug}`) : null;
  const waText = pageUrl ? `Order from ${view.outletName} online: ${pageUrl}` : "";
  const waLink = pageUrl ? `https://wa.me/?text=${encodeURIComponent(waText)}` : null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "success");
    } catch {
      toast("Couldn't copy — select the text and copy it", "error");
    }
  };

  return (
    <div className="space-y-4">
      {view.tablesAvailable && (
        <Card>
          <CardHeader
            title="QR table ordering"
            subtitle="Guests scan the code on their table, see the menu and order. Items go on the table's running bill."
            action={
              <Link href="/tables/qr-codes" className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold hover:bg-surface-2">
                <QrCode size={18} /> Print table QR codes
              </Link>
            }
          />
          <div className="divide-y divide-line px-5">
            <Toggle checked={s.qrOrdering} onChange={(v) => set({ qrOrdering: v })} label="Take orders from table QR codes" description="Off: the code shows the menu only (if the digital menu is on below)." />
            <Toggle
              checked={s.qrNeedsConfirmation}
              onChange={(v) => set({ qrNeedsConfirmation: v })}
              label="QR orders need staff confirmation"
              description="Recommended. A waiter or cashier accepts each order on the Tables screen before the kitchen gets the KOT. Off: straight to the kitchen."
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Online ordering page" subtitle="Your own page for takeaway and delivery orders — no commission. Customers order with their name and mobile number." />
        <div className="space-y-4 px-5 py-4">
          <Input
            label="Web address"
            prefix={<span className="text-sm text-muted">/o/</span>}
            value={slug}
            maxLength={40}
            onChange={(e) => setSlug(slugify(e.target.value))}
            hint={pageUrl ? pageUrl : "Letters, numbers and dashes. Save to create the link."}
          />
          <div className="divide-y divide-line">
            <Toggle checked={s.onlineOrdering} onChange={(v) => set({ onlineOrdering: v })} label="Take online orders" />
            <Toggle checked={s.menuView} onChange={(v) => set({ menuView: v })} label="Show the digital menu when ordering is off" description="The page and table codes still show your menu (view only)." />
            <Toggle
              checked={s.onlineNeedsConfirmation}
              onChange={(v) => set({ onlineNeedsConfirmation: v })}
              label="Online orders need staff confirmation"
              description="The cashier accepts each order on the POS before the kitchen gets it. Off: straight to the kitchen."
            />
            <Toggle
              checked={s.verifyPhoneOtp}
              onChange={(v) => set({ verifyPhoneOtp: v })}
              label="Verify customer phone by OTP"
              description="Recommended. Customers confirm their mobile number with a 6-digit SMS code before ordering, so fake orders can't reach your kitchen."
            />
            <Toggle checked={s.takeaway} onChange={(v) => set({ takeaway: v })} label="Takeaway / pickup" />
            <Toggle
              checked={s.delivery && view.deliveryAvailable}
              disabled={!view.deliveryAvailable}
              onChange={(v) => set({ delivery: v })}
              label="Delivery"
              description={
                !view.deliveryAvailable
                  ? "Turn on delivery for this outlet first (needs the Delivery module)."
                  : view.deliveryMode === "ADDRESS"
                    ? "Address only (no map): customers type the address and PIN code; flat fee and allowed areas from Delivery → Zones & settings."
                    : "Map pin: uses your delivery zones and fees. Switch to address-only in Delivery → Zones & settings."
              }
            />
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold text-fg">Payment options</p>
            <div className="divide-y divide-line">
              <Toggle checked={s.payAtCounter} onChange={(v) => set({ payAtCounter: v })} label="Pay at the counter (takeaway)" />
              <Toggle checked={s.cashOnDelivery} onChange={(v) => set({ cashOnDelivery: v })} label="Cash on delivery" />
              <Toggle
                checked={s.upiPrepaid}
                onChange={(v) => set({ upiPrepaid: v })}
                label="UPI prepaid"
                description={view.upiReady ? "Customers pay by UPI QR before collecting." : "Add the outlet's UPI ID in Outlet settings first."}
                disabled={!view.upiReady && !s.upiPrepaid}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Orders from" type="time" value={s.acceptFrom ?? ""} onChange={(e) => set({ acceptFrom: e.target.value || null })} hint="Empty = any time" />
            <Input label="Orders until" type="time" value={s.acceptTo ?? ""} onChange={(e) => set({ acceptTo: e.target.value || null })} />
            <Input label="Minimum order (₹)" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} hint={s.minOrder ? `Now ${formatINR(s.minOrder)}` : "No minimum"} />
          </div>
          <p className="text-xs text-muted">Accepting hours also apply to QR table orders.</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end">
            <Button icon={<FloppyDisk size={20} />} loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </Card>

      {pageUrl && (
        <Card>
          <CardHeader title="Share kit" subtitle="Put the link in your Instagram bio and Google profile, print the poster for the counter, and send the WhatsApp message to regulars." />
          <div className="grid gap-5 px-5 py-4 md:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input aria-label="Online ordering link" readOnly value={pageUrl} onFocus={(e) => e.target.select()} wrapperClassName="flex-1" />
                <Button variant="outline" icon={<Copy size={18} />} onClick={() => void copy(pageUrl)}>
                  Copy link
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={waLink!} target="_blank" rel="noreferrer" className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-[#25D366] px-4 font-semibold text-white hover:opacity-90">
                  <WhatsappLogo size={20} weight="fill" /> Share &quot;Order now&quot; on WhatsApp
                </a>
                <Button variant="outline" icon={<Printer size={18} />} onClick={() => window.print()}>
                  Print poster
                </Button>
              </div>
              {!s.onlineOrdering && <p className="text-sm text-muted">Online ordering is off — the link shows {s.menuView ? "your menu only" : "nothing until you turn it on"}.</p>}
            </div>
            <div className="print-sheet flex flex-col items-center gap-3 rounded-2xl border border-line bg-white p-5 text-center text-black print:mx-auto print:mt-16 print:max-w-md print:border-0">
              <p className="text-xl font-extrabold print:text-4xl">{view.outletName}</p>
              <QRCodeSVG value={pageUrl} size={180} level="M" marginSize={1} className="print:h-80 print:w-80" />
              <p className="text-lg font-bold print:text-3xl">Scan to order online</p>
              <p className="text-sm text-neutral-600 print:text-xl">{pageUrl.replace(/^https?:\/\//, "")}</p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
