"use client";

import { useState } from "react";
import Link from "next/link";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { platformApi } from "@/lib/platform";
import type { BusinessListItem } from "@/lib/types-platform";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { canManagePlatform } from "@/lib/roles";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { BusinessTable } from "@/components/platform/BusinessTable";

type StatusFilter = "ALL" | "ACTIVE" | "SUSPENDED";

export default function BusinessesPage() {
  const { me } = useSession();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const q = useDebouncedValue(search.trim(), 300);
  const list = useApiQuery<BusinessListItem[]>(`platform-businesses:${q}`, () => platformApi.get<BusinessListItem[]>("/platform/businesses", { search: q || undefined }));
  const rows = (list.data ?? []).filter((b) => status === "ALL" || b.status === status);

  return (
    <PageContainer>
      <PageHeader
        title="Businesses"
        subtitle={list.data ? `${list.data.length} client business${list.data.length === 1 ? "" : "es"}` : undefined}
        actions={
          canManagePlatform(me) ? (
            <Link href="/platform/businesses/new" className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-primary-fg shadow-sm hover:bg-primary-600">
              <Plus size={20} /> New business
            </Link>
          ) : undefined
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input
            type="search"
            placeholder="Search by name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="min-w-[220px] max-w-md flex-1"
          />
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: "ALL", label: "All" },
              { value: "ACTIVE", label: "Active" },
              { value: "SUSPENDED", label: "Suspended" },
            ]}
          />
        </div>
        {list.loading && !list.data ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title={q || status !== "ALL" ? "No matching businesses" : "No businesses yet"} description={q ? "Try a different search." : undefined} />
        ) : (
          <BusinessTable rows={rows} />
        )}
      </Card>
    </PageContainer>
  );
}
