"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import type { AuditDetail } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { AuditCountSheet } from "@/components/inventory/AuditCountSheet";

export default function AuditDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { outletId } = useSession();
  const q = useApiQuery<AuditDetail>(outletId && id ? `inv-audit:${outletId}:${id}` : null, () => api.get<AuditDetail>(`/inventory/audits/${id}`));
  const a = q.data;

  return (
    <PageContainer>
      <PageHeader
        title={a?.status === "IN_PROGRESS" ? "Count sheet" : "Stock audit"}
        subtitle={a?.status === "IN_PROGRESS" ? "Enter counted quantities — Enter / ↓ moves to the next item, ↑ to the previous" : undefined}
        actions={
          <Link href="/inventory/audits" className="inline-flex min-h-tap items-center gap-2 rounded-xl px-3 font-semibold text-fg hover:bg-surface-2">
            <ArrowLeft size={18} /> All audits
          </Link>
        }
      />
      <InventoryTabs />
      {q.loading && !a ? <LoadingState /> : q.error && !a ? <ErrorState message={q.error} onRetry={q.reload} /> : a ? <AuditCountSheet audit={a} onChange={(next) => q.setData(next)} /> : null}
    </PageContainer>
  );
}
