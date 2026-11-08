"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, HandCoins, MagnifyingGlass, Warning, WhatsappLogo } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { fuzzyFilter } from "@/lib/fuzzy";
import type { KhataOutstanding, KhataOutstandingRow } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { SettleKhataDialog, useKhataReminder } from "@/components/crm/CustomerActions";
import { StatTile, TierBadge, daysSince, formatDate } from "@/components/crm/shared";

export default function KhataPage() {
  const { outletId, outlet, can } = useSession();
  const data = useApiQuery<KhataOutstanding>(outletId ? `khata:${outletId}` : null, () => api.get<KhataOutstanding>("/customers/khata/outstanding"));
  const [search, setSearch] = useState("");
  const [settling, setSettling] = useState<KhataOutstandingRow | null>(null);
  const { remind, sending } = useKhataReminder();
  const collect = can("payment:collect");

  const items = data.data?.items ?? [];
  const list = fuzzyFilter(items, search, (r) => `${r.name ?? ""} ${r.phone}`);
  const overLimit = items.filter((r) => r.khataLimit > 0 && r.khataBalance > r.khataLimit).length;
  const oldest = items.reduce<number | null>((m, r) => {
    const d = daysSince(r.lastDebitAt);
    return d !== null && (m === null || d > m) ? d : m;
  }, null);

  return (
    <PageContainer>
      <Link data-nav="back" href="/customers" className="mb-3 inline-flex min-h-tap items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft size={18} /> Customers
      </Link>
      <PageHeader title="Khata" subtitle={outlet ? `Outstanding credit at ${outlet.name}` : "Outstanding credit"} />

      {data.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Total outstanding" value={formatINR(data.data.totalOutstanding)} tone={data.data.totalOutstanding > 0 ? "danger" : undefined} />
          <StatTile label="Customers with dues" value={data.data.customers} />
          <StatTile label="Over limit" value={overLimit} tone={overLimit ? "danger" : undefined} />
          <StatTile label="Oldest unpaid debit" value={oldest === null ? "—" : `${oldest} days`} />
        </div>
      )}

      <Card>
        <div className="border-b border-line p-4">
          <Input
            type="search"
            aria-label="Search khata"
            placeholder="Search by name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="max-w-md"
          />
        </div>
        {data.loading && !data.data ? (
          <LoadingState />
        ) : data.error ? (
          <ErrorState message={data.error} onRetry={data.reload} />
        ) : list.length === 0 ? (
          <EmptyState title={search ? "No matches" : "No outstanding khata"} description={search ? undefined : "All customers are settled up at this outlet."} />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Customer</Th>
                <Th>Tier</Th>
                <Th className="text-right">Due here</Th>
                <Th className="text-right">Total balance</Th>
                <Th className="text-right">Limit</Th>
                <Th>Last debit</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.map((r) => {
                const over = r.khataLimit > 0 && r.khataBalance > r.khataLimit;
                const days = daysSince(r.lastDebitAt);
                return (
                  <Tr key={r.id}>
                    <Td>
                      <Link href={`/customers/${r.id}`} className="font-semibold hover:text-primary hover:underline" aria-label={`Open profile of ${r.name || r.phone}`}>
                        {r.name || "Unnamed"}
                      </Link>
                      <p className="flex items-center gap-2 text-xs text-muted">
                        +91 {r.phone}
                        {r.blocked && <Badge tone="danger">Blocked</Badge>}
                      </p>
                    </Td>
                    <Td>
                      <TierBadge tier={r.tier} />
                    </Td>
                    <Td className="tabular text-right font-bold text-red-600 dark:text-red-400">{formatINR(r.outletDue)}</Td>
                    <Td className="tabular text-right">{formatINR(r.khataBalance)}</Td>
                    <Td className="tabular text-right">
                      {r.khataLimit ? (
                        <span className={over ? "inline-flex items-center gap-1 font-semibold text-red-600 dark:text-red-400" : undefined}>
                          {over && <Warning size={16} weight="fill" aria-label="Over limit" />}
                          {formatINR(r.khataLimit)}
                        </span>
                      ) : (
                        <span className="text-muted">No limit</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <p>{formatDate(r.lastDebitAt)}</p>
                      {days !== null && (
                        <p className={`text-xs ${days > 30 ? "font-semibold text-red-600 dark:text-red-400" : days > 14 ? "text-amber-700 dark:text-amber-300" : "text-muted"}`}>
                          {days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}
                        </p>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <IconButton label={`Send WhatsApp reminder to ${r.name || r.phone}`} onClick={() => remind(r)} disabled={sending === r.id}>
                        <WhatsappLogo size={22} className="text-[#25D366]" />
                      </IconButton>
                      {collect && (
                        <Button size="sm" variant="secondary" icon={<HandCoins size={18} />} onClick={() => setSettling(r)} aria-label={`Settle khata of ${r.name || r.phone}`}>
                          Settle
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <SettleKhataDialog customer={settling} onClose={() => setSettling(null)} onSettled={() => void data.reload()} />
    </PageContainer>
  );
}
