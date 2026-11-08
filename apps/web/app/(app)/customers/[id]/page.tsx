"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Cake,
  Coins,
  Heart,
  HandCoins,
  LockSimple,
  LockSimpleOpen,
  PencilSimple,
  WhatsappLogo,
} from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import type { Customer, CustomerProfile } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { CustomerForm } from "@/components/crm/CustomerForm";
import { AdjustPointsDialog, SettleKhataDialog, useKhataReminder } from "@/components/crm/CustomerActions";
import {
  CouponRedemptionsTable,
  FavouriteItems,
  KhataLedgerTable,
  LoyaltyLedgerTable,
  RecentOrdersTable,
} from "@/components/crm/CustomerLedgers";
import { VisitHeatmap } from "@/components/crm/VisitHeatmap";
import { StatTile, TIER_LABELS, TierBadge, formatDate, formatMMDD, relativeDays } from "@/components/crm/shared";

type Tab = "orders" | "loyalty" | "khata" | "coupons";

export default function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { outletId, can } = useSession();
  const toast = useToast();
  const profile = useApiQuery<CustomerProfile>(outletId && id ? `customer:${outletId}:${id}` : null, () =>
    api.get<CustomerProfile>(`/customers/${id}`),
  );
  const [tab, setTab] = useState<Tab>("orders");
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [settling, setSettling] = useState(false);
  const { remind, sending } = useKhataReminder();

  if (profile.loading && !profile.data) return <LoadingState label="Loading customer…" />;
  if (profile.error || !profile.data)
    return (
      <PageContainer>
        <BackLink />
        <ErrorState message={profile.error ?? "Customer not found"} onRetry={profile.reload} />
      </PageContainer>
    );

  const { customer: c, stats } = profile.data;
  const manage = can("customer:manage");
  const collect = can("payment:collect");
  const ref = { id: c.id, name: c.name, phone: c.phone, khataBalance: c.khataBalance, points: c.points };
  const patchCustomer = (next: Customer) =>
    profile.setData((p) => (p ? { ...p, customer: next, stats: { ...p.stats, points: next.points, khataBalance: next.khataBalance, khataLimit: next.khataLimit } } : p));

  const overLimit = c.khataLimit > 0 && c.khataBalance > c.khataLimit;
  const tierProgress = stats.nextTier ? Math.min(100, Math.max(0, ((stats.nextTier.at - stats.nextTier.remaining) / stats.nextTier.at) * 100)) : 100;

  return (
    <PageContainer>
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-extrabold tracking-tight">{c.name || "Unnamed customer"}</h1>
            <TierBadge tier={c.tier} />
            {c.blocked && (
              <Badge tone="danger">
                <LockSimple size={12} weight="bold" /> Blocked
              </Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="tabular">+91 {c.phone}</span>
            {c.email && <span>{c.email}</span>}
            {c.birthday && (
              <span className="inline-flex items-center gap-1">
                <Cake size={16} /> {formatMMDD(c.birthday)}
              </span>
            )}
            {c.anniversary && (
              <span className="inline-flex items-center gap-1">
                <Heart size={16} /> {formatMMDD(c.anniversary)}
              </span>
            )}
            <span>Customer since {formatDate(c.createdAt)}</span>
          </p>
          {c.notes && <p className="mt-2 max-w-2xl rounded-xl bg-surface-2 px-3 py-2 text-sm">{c.notes}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {collect && c.khataBalance > 0 && (
            <Button variant="secondary" icon={<HandCoins size={20} />} onClick={() => setSettling(true)}>
              Settle khata
            </Button>
          )}
          {c.khataBalance > 0 && (
            <Button variant="outline" icon={<WhatsappLogo size={20} />} loading={sending === c.id} onClick={() => remind(ref)}>
              Send reminder
            </Button>
          )}
          {manage && (
            <>
              <Button variant="outline" icon={<Coins size={20} />} onClick={() => setAdjusting(true)}>
                Adjust points
              </Button>
              <Button variant="outline" icon={<PencilSimple size={20} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant={c.blocked ? "outline" : "ghost"}
                className={c.blocked ? undefined : "text-red-600 dark:text-red-400"}
                icon={c.blocked ? <LockSimpleOpen size={20} /> : <LockSimple size={20} />}
                onClick={() => setBlocking(true)}
              >
                {c.blocked ? "Unblock" : "Block"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Total spend" value={formatINR(stats.totalSpend)} note={`${stats.paidOrders} paid · ${stats.cancelledOrders} cancelled`} />
        <StatTile label="Visits" value={stats.visitCount} note={stats.openOrders ? `${stats.openOrders} open bill${stats.openOrders > 1 ? "s" : ""}` : undefined} />
        <StatTile label="Avg bill" value={formatINR(stats.avgBill)} />
        <StatTile
          label="Points"
          value={stats.points.toLocaleString("en-IN")}
          note={`Worth ${formatINR(stats.pointsValue)} · ${stats.redeemablePoints} redeemable`}
        />
        <StatTile
          label="Khata balance"
          value={formatINR(stats.khataBalance)}
          tone={stats.khataBalance > 0 ? "danger" : undefined}
          note={overLimit ? `Over limit of ${formatINR(stats.khataLimit)}` : stats.khataLimit ? `Limit ${formatINR(stats.khataLimit)}` : "No limit"}
        />
        <StatTile label="Last visit" value={<span className="text-base">{relativeDays(stats.lastVisitAt)}</span>} note={`First visit ${formatDate(stats.firstVisitAt)}`} />
      </div>

      {/* Tier progress */}
      <Card className="mt-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">
            {stats.nextTier ? (
              <>
                {formatINR(stats.nextTier.remaining)} more to reach <span className="text-primary">{TIER_LABELS[stats.nextTier.tier]}</span>
              </>
            ) : (
              <>Top tier reached — {TIER_LABELS[stats.tier]}</>
            )}
          </p>
          {stats.nextTier && (
            <p className="tabular text-xs text-muted">
              {formatINR(stats.totalSpend)} / {formatINR(stats.nextTier.at)}
            </p>
          )}
        </div>
        <div
          className="mt-3 h-3 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label="Progress to next tier"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(tierProgress)}
        >
          <div className="h-full rounded-full bg-gradient-to-r from-primary-200 to-primary transition-all" style={{ width: `${tierProgress}%` }} />
        </div>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Visit pattern" subtitle="Paid visits by weekday and hour (outlet time)" />
          <div className="p-4">
            <VisitHeatmap grid={profile.data.visitHeatmap} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Favourite items" />
          <FavouriteItems items={profile.data.favouriteItems} />
        </Card>
      </div>

      <Card className="mt-4">
        <div className="border-b border-line p-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "orders", label: `Recent orders (${profile.data.recentOrders.length})` },
              { value: "loyalty", label: "Points ledger" },
              { value: "khata", label: "Khata ledger" },
              { value: "coupons", label: `Coupons (${profile.data.couponRedemptions.length})` },
            ]}
          />
        </div>
        {tab === "orders" && <RecentOrdersTable orders={profile.data.recentOrders} />}
        {tab === "loyalty" && <LoyaltyLedgerTable rows={profile.data.loyaltyLedger} />}
        {tab === "khata" && <KhataLedgerTable rows={profile.data.khataLedger} balance={c.khataBalance} />}
        {tab === "coupons" && <CouponRedemptionsTable rows={profile.data.couponRedemptions} />}
      </Card>

      <CustomerForm customer={editing ? c : null} onClose={() => setEditing(false)} onSaved={patchCustomer} />
      <SettleKhataDialog customer={settling ? ref : null} onClose={() => setSettling(false)} onSettled={() => void profile.reload()} />
      <AdjustPointsDialog customer={adjusting ? ref : null} onClose={() => setAdjusting(false)} onAdjusted={() => void profile.reload()} />
      <ConfirmDialog
        open={blocking}
        onClose={() => setBlocking(false)}
        title={c.blocked ? `Unblock ${c.name || c.phone}?` : `Block ${c.name || c.phone}?`}
        description={c.blocked ? "They can earn and redeem points and use khata again." : "Blocked customers can't use khata, coupons or points at the POS."}
        confirmLabel={c.blocked ? "Unblock" : "Block customer"}
        tone={c.blocked ? "primary" : "danger"}
        reason={{ label: "Reason", placeholder: c.blocked ? "Optional" : "e.g. Repeated unpaid khata", required: false }}
        onConfirm={async (reason) => {
          const updated = await api.post<Customer>(`/customers/${c.id}/block`, { blocked: !c.blocked, reason: reason || undefined });
          patchCustomer(updated);
          toast(updated.blocked ? "Customer blocked" : "Customer unblocked", "success");
        }}
      />
    </PageContainer>
  );
}

function BackLink() {
  return (
    <Link data-nav="back" href="/customers" className="mb-3 inline-flex min-h-tap items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg">
      <ArrowLeft size={18} /> Customers
    </Link>
  );
}
