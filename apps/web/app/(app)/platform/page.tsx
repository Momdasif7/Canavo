"use client";

import Link from "next/link";
import { ArrowRight, Buildings, CheckCircle, LockSimple, Pause, Plus, Storefront, UserCircle } from "@phosphor-icons/react";
import { platformApi } from "@/lib/platform";
import type { BusinessListItem, PlatformSummary } from "@/lib/types-platform";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { BusinessTable } from "@/components/platform/BusinessTable";
import { SupportGrantsCard } from "@/components/platform/SupportGrantsCard";

/** Platform console home: account totals across every business, plus the newest clients. */
export default function PlatformHome() {
  const { me } = useSession();
  const summary = useApiQuery<PlatformSummary>("platform-summary", () => platformApi.get<PlatformSummary>("/platform/summary"));
  const recent = useApiQuery<BusinessListItem[]>("platform-businesses:recent", () => platformApi.get<BusinessListItem[]>("/platform/businesses"));
  const s = summary.data;

  return (
    <PageContainer>
      <PageHeader
        title="Platform console"
        subtitle={`Welcome, ${me?.name ?? "admin"}. Manage CANAVO client businesses, their modules and owner logins.`}
        actions={
          <Link href="/platform/businesses/new" className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-white shadow-sm hover:bg-primary-600">
            <Plus size={20} /> New business
          </Link>
        }
      />
      {summary.loading && !s ? (
        <LoadingState />
      ) : summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : s ? (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Tile icon={<Buildings size={24} weight="duotone" />} label="Businesses" value={String(s.businesses)} />
          <Tile icon={<CheckCircle size={24} weight="duotone" />} label="Active" value={String(s.activeBusinesses)} />
          <Tile icon={<Pause size={24} weight="duotone" />} label="Suspended" value={String(s.suspendedBusinesses)} accent />
          <Tile icon={<Storefront size={24} weight="duotone" />} label="Outlets" value={String(s.outlets)} />
          <Tile icon={<UserCircle size={24} weight="duotone" />} label="Owners" value={String(s.owners)} />
        </div>
      ) : null}

      <p className="mb-5 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
        <LockSimple size={18} className="mt-0.5 shrink-0 text-primary" />
        Hotel data (sales, bills, staff, customers, reports) is private to each hotel and isn&apos;t visible here, except read-only when its owner grants support access.
      </p>

      <SupportGrantsCard />

      <Card>
        <CardHeader
          title="Newest businesses"
          action={
            <Link href="/platform/businesses" className="inline-flex min-h-[40px] items-center gap-1 text-sm font-semibold text-primary hover:underline">
              All businesses <ArrowRight size={16} />
            </Link>
          }
        />
        {recent.loading && !recent.data ? (
          <LoadingState />
        ) : recent.error ? (
          <ErrorState message={recent.error} onRetry={recent.reload} />
        ) : !recent.data?.length ? (
          <EmptyState title="No businesses yet" description="Onboard your first client business to get started." />
        ) : (
          <BusinessTable rows={recent.data.slice(0, 6)} compact />
        )}
      </Card>
    </PageContainer>
  );
}

function Tile({ icon, label, value, note, accent }: { icon: React.ReactNode; label: string; value: string; note?: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
        <span className={accent ? "text-secondary" : "text-primary"}>{icon}</span>
      </div>
      <p className="tabular mt-2 text-2xl font-extrabold">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </Card>
  );
}
