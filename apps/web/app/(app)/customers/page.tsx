"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CaretLeft, CaretRight, Crown, MagnifyingGlass, Notebook, UserPlus } from "@phosphor-icons/react";
import { LOYALTY_TIERS, formatINR, type LoyaltyTierName } from "@canavo/shared";
import { api } from "@/lib/api";
import type { CustomerList } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { CustomerForm } from "@/components/crm/CustomerForm";
import { TIER_LABELS, TierBadge, relativeDays } from "@/components/crm/shared";

type Sort = "recent" | "spend" | "points" | "khata" | "name";
const PAGE_SIZE = 25;

export default function CustomersPage() {
  const router = useRouter();
  const { outletId, can } = useSession();
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [tier, setTier] = useState<LoyaltyTierName | "">("");
  const [khata, setKhata] = useState<"" | "1" | "0">("");
  const [blocked, setBlocked] = useState<"" | "1" | "0">("");
  const [sort, setSort] = useState<Sort>("recent");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);

  useEffect(() => setPage(1), [q, tier, khata, blocked, sort]);

  const key = outletId ? `customers:${outletId}:${q}:${tier}:${khata}:${blocked}:${sort}:${page}` : null;
  const list = useApiQuery<CustomerList>(key, () =>
    api.get<CustomerList>("/customers", { query: { search: q, tier, hasKhata: khata, blocked, sort, page, limit: PAGE_SIZE } }),
  );
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = Boolean(q || tier || khata || blocked);

  return (
    <PageContainer>
      <PageHeader
        title="Customers"
        subtitle={data ? `${data.total} customer${data.total === 1 ? "" : "s"}${filtered ? " match" : ""}` : undefined}
        actions={
          <>
            <Link href="/customers/khata" className="inline-flex min-h-tap items-center gap-2 rounded-xl border border-line bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
              <Notebook size={20} /> Khata
            </Link>
            {can("customer:manage") && (
              <Link
                href="/customers/loyalty"
                className="inline-flex min-h-tap items-center gap-2 rounded-xl border border-line bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
              >
                <Crown size={20} /> Loyalty settings
              </Link>
            )}
            <Button icon={<UserPlus size={20} />} onClick={() => setAdding(true)}>
              Add customer
            </Button>
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <Input
            wrapperClassName="min-w-[240px] flex-1"
            type="search"
            aria-label="Search customers"
            placeholder="Search by name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
          />
          <Select aria-label="Tier" value={tier} onChange={(e) => setTier(e.target.value as LoyaltyTierName | "")} className="w-36">
            <option value="">All tiers</option>
            {LOYALTY_TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select aria-label="Khata" value={khata} onChange={(e) => setKhata(e.target.value as typeof khata)} className="w-40">
            <option value="">Any khata</option>
            <option value="1">With dues</option>
            <option value="0">No dues</option>
          </Select>
          <Select aria-label="Blocked" value={blocked} onChange={(e) => setBlocked(e.target.value as typeof blocked)} className="w-36">
            <option value="">All status</option>
            <option value="0">Active</option>
            <option value="1">Blocked</option>
          </Select>
          <Select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-44">
            <option value="recent">Recent visit</option>
            <option value="spend">Top spend</option>
            <option value="points">Most points</option>
            <option value="khata">Highest khata</option>
            <option value="name">Name A–Z</option>
          </Select>
        </div>

        {list.loading && !data ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={filtered ? "No customers match" : "No customers yet"}
            description={filtered ? "Try a different search or filter." : "Customers are added automatically when a phone number is attached to a bill."}
            action={!filtered && <Button onClick={() => setAdding(true)}>Add customer</Button>}
          />
        ) : (
          <div className={list.loading ? "opacity-60 transition-opacity" : undefined}>
            <Table>
              <THead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Tier</Th>
                  <Th className="text-right">Visits</Th>
                  <Th className="text-right">Total spend</Th>
                  <Th className="text-right">Points</Th>
                  <Th className="text-right">Khata</Th>
                  <Th>Last visit</Th>
                </tr>
              </THead>
              <tbody>
                {data.items.map((c) => (
                  <Tr key={c.id} onClick={() => router.push(`/customers/${c.id}`)}>
                    <Td>
                      <Link
                        href={`/customers/${c.id}`}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Open profile of ${c.name || c.phone}`}
                        className="font-semibold hover:text-primary hover:underline"
                      >
                        {c.name || "Unnamed"}
                      </Link>
                      <p className="flex items-center gap-2 text-xs text-muted">
                        +91 {c.phone}
                        {c.blocked && <Badge tone="danger">Blocked</Badge>}
                      </p>
                    </Td>
                    <Td>
                      <TierBadge tier={c.tier} />
                    </Td>
                    <Td className="tabular text-right">{c.visitCount}</Td>
                    <Td className="tabular text-right font-semibold">{formatINR(c.totalSpend)}</Td>
                    <Td className="tabular text-right">{c.points.toLocaleString("en-IN")}</Td>
                    <Td className={`tabular text-right font-semibold ${c.khataBalance > 0 ? "text-red-600 dark:text-red-400" : "text-muted"}`}>
                      {c.khataBalance > 0 ? formatINR(c.khataBalance) : "—"}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{relativeDays(c.lastVisitAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-sm text-muted">
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
              </span>
              <div className="flex items-center gap-1">
                <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <CaretLeft size={20} />
                </IconButton>
                <span className="tabular px-2">
                  Page {page} of {pages}
                </span>
                <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  <CaretRight size={20} />
                </IconButton>
              </div>
            </div>
          </div>
        )}
      </Card>

      <CustomerForm customer={adding ? undefined : null} onClose={() => setAdding(false)} onSaved={(c) => router.push(`/customers/${c.id}`)} />
    </PageContainer>
  );
}
