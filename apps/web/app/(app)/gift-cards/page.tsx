"use client";

import { useState } from "react";
import { Gift, MagnifyingGlass } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Alert, EmptyState } from "@/components/ui/States";

interface GiftCard {
  id: string;
  code: string;
  initialValue: number;
  balance: number;
  soldMode: string | null;
  customerName: string | null;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  expired?: boolean;
  transactions?: { id: string; type: string; amount: number; note: string | null; createdAt: string }[];
}

/** Billing → Gift cards (Phase 3.8, closed-loop): sell, check a balance, block a lost card. */
export default function GiftCardsPage() {
  const toast = useToast();
  const { me, can } = useSession();
  const enabled = Boolean(me?.features?.GIFT_CARDS);
  const list = useApiQuery(enabled && can("report:view") ? "gift-cards" : null, () => api.get<{ cards: GiftCard[]; outstanding: { count: number; balance: number } }>("/gift-cards"));
  const [value, setValue] = useState("");
  const [soldMode, setSoldMode] = useState<"CASH" | "UPI" | "CARD">("CASH");
  const [customerName, setCustomerName] = useState("");
  const [sold, setSold] = useState<GiftCard | null>(null);
  const [lookup, setLookup] = useState("");
  const [found, setFound] = useState<GiftCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) {
    return (
      <PageContainer>
        <PageHeader title="Gift cards" />
        <Alert tone="info">Gift cards are off for your hotel. Ask CANAVO support to turn them on.</Alert>
      </PageContainer>
    );
  }

  const sell = async () => {
    setBusy(true);
    setError(null);
    try {
      const card = await api.post<GiftCard>("/gift-cards", { value: Math.round(Number(value) * 100), soldMode, customerName: customerName.trim() || undefined });
      setSold(card);
      setValue("");
      setCustomerName("");
      toast(`Gift card ${card.code} sold`, "success");
      void list.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const find = async () => {
    setError(null);
    try {
      setFound(await api.get<GiftCard>(`/gift-cards/code/${encodeURIComponent(lookup.trim())}`));
    } catch (e) {
      setFound(null);
      setError(errorMessage(e));
    }
  };

  return (
    <PageContainer>
      <PageHeader title="Gift cards" subtitle="Closed-loop cards: usable only at your hotel, no cash-out. No GST when sold; the bill they're spent on carries the GST." />
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sell a gift card" />
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Value (₹)" type="number" min={50} value={value} onChange={(e) => setValue(e.target.value)} />
              <Select label="Paid by" value={soldMode} onChange={(e) => setSoldMode(e.target.value as typeof soldMode)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
              </Select>
            </div>
            <Input label="For (optional)" maxLength={100} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            <Button icon={<Gift size={20} />} loading={busy} disabled={!(Number(value) >= 50)} onClick={() => void sell()}>
              Sell card
            </Button>
            {sold && (
              <Alert tone="info">
                Card code <b className="font-mono">{sold.code}</b> · {formatINR(sold.balance)}. Write it on the card or share it with the customer.
              </Alert>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Check a card" />
          <div className="space-y-4 p-5">
            <div className="flex items-end gap-2">
              <Input label="Code" wrapperClassName="flex-1" value={lookup} onChange={(e) => setLookup(e.target.value.toUpperCase())} />
              <Button variant="outline" icon={<MagnifyingGlass size={18} />} disabled={lookup.trim().length < 6} onClick={() => void find()}>
                Check
              </Button>
            </div>
            {found && (
              <div className="space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <b className="font-mono">{found.code}</b> · balance <b className="tabular">{formatINR(found.balance)}</b> of {formatINR(found.initialValue)}
                  {!found.active && <Badge tone="danger">Blocked</Badge>}
                  {found.expired && <Badge tone="warning">Expired</Badge>}
                </p>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {(found.transactions ?? []).map((t) => (
                    <li key={t.id} className="flex justify-between px-3 py-1.5">
                      <span className="text-muted">
                        {formatDateTime(t.createdAt)} · {t.note ?? t.type.toLowerCase()}
                      </span>
                      <span className="tabular">
                        {t.amount > 0 ? "+" : "−"}
                        {formatINR(Math.abs(t.amount))}
                      </span>
                    </li>
                  ))}
                </ul>
                {can("outlet:manage") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void api.post<GiftCard>(`/gift-cards/${found.id}/active`, {}).then((c) => {
                        setFound({ ...found, active: c.active });
                        toast(c.active ? "Card unblocked" : "Card blocked", "success");
                      })
                    }
                  >
                    {found.active ? "Block card (lost / stolen)" : "Unblock card"}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
      {list.data && (
        <Card className="mt-5">
          <CardHeader title="Cards" subtitle={`${list.data.outstanding.count} active · ${formatINR(list.data.outstanding.balance)} not yet spent (a liability until used)`} />
          {list.data.cards.length === 0 ? (
            <EmptyState title="No gift cards sold yet" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {list.data.cards.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-2">
                  <span className="font-mono font-semibold">{c.code}</span>
                  <span className="text-muted">
                    {formatDateTime(c.createdAt)}
                    {c.customerName && ` · ${c.customerName}`}
                  </span>
                  <span className="tabular ml-auto">
                    {formatINR(c.balance)} / {formatINR(c.initialValue)}
                  </span>
                  {!c.active && <Badge tone="danger">Blocked</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </PageContainer>
  );
}
