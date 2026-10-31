"use client";

import { useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { downloadApiFile } from "@/lib/download";
import { formatTime } from "@/lib/format";
import type {
  ConsumptionReport,
  MovementReport,
  PurchasesReport,
  ValuationReport,
  VendorSpendReport,
  WastageReport,
} from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { ItemSelect, PurchaseStatusBadge, Stat, useStockItems } from "@/components/inventory/common";
import { TXN_LABELS, UNIT_LABELS, formatQty, formatYmd } from "@/components/inventory/units";

type ReportKey = "consumption" | "movement" | "valuation" | "wastage" | "vendor-spend" | "purchases";

const REPORTS: { key: ReportKey; label: string; range: boolean; itemFilter: boolean; description: string }[] = [
  { key: "consumption", label: "Consumption", range: true, itemFilter: true, description: "Daily ingredient usage from sales and wastage" },
  { key: "movement", label: "Movement", range: true, itemFilter: true, description: "Opening, in, out and closing per item" },
  { key: "valuation", label: "Valuation", range: false, itemFilter: false, description: "Current stock × weighted-average cost" },
  { key: "wastage", label: "Wastage", range: true, itemFilter: true, description: "Every wastage entry with reason" },
  { key: "vendor-spend", label: "Vendor spend", range: true, itemFilter: false, description: "Received purchases by vendor" },
  { key: "purchases", label: "Purchases", range: true, itemFilter: false, description: "All purchases created in the period" },
];

type ReportData = ConsumptionReport | MovementReport | ValuationReport | WastageReport | VendorSpendReport | PurchasesReport;

export default function InventoryReportsPage() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const allowed = can("inventory:manage");
  const [report, setReport] = useState<ReportKey>("consumption");
  const [to, setTo] = useState(() => todayISO());
  const [from, setFrom] = useState(() => addDaysISO(todayISO(), -6));
  const [itemId, setItemId] = useState("");
  const [downloading, setDownloading] = useState(false);
  const meta = REPORTS.find((r) => r.key === report)!;
  const stock = useStockItems(allowed && meta.itemFilter);

  const rangeValid = !meta.range || (!!from && !!to && from <= to);
  const query = {
    from: meta.range ? from : undefined,
    to: meta.range ? to : undefined,
    itemId: meta.itemFilter && itemId ? itemId : undefined,
  };
  const key = allowed && outletId && rangeValid ? `inv-report:${outletId}:${report}:${query.from}:${query.to}:${query.itemId}` : null;
  const data = useApiQuery<{ key: string; report: ReportData }>(key, async () => ({
    key: key!,
    report: await api.get<ReportData>(`/inventory/reports/${report}`, { query }),
  }));
  // Ignore data that belongs to a previously selected report/range while the new one loads.
  const current = data.data && data.data.key === key ? data.data.report : undefined;

  const download = async () => {
    setDownloading(true);
    try {
      await downloadApiFile(`/inventory/reports/${report}`, { ...query, format: "xlsx" }, `${report}.xlsx`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Inventory reports"
        subtitle={meta.description}
        actions={
          allowed && (
            <Button variant="outline" icon={<DownloadSimple size={20} />} onClick={download} loading={downloading} disabled={!rangeValid}>
              Download xlsx
            </Button>
          )
        }
      />
      <InventoryTabs />
      {!allowed ? (
        <Card>
          <EmptyState title="Reports are not available for your role" />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
            <Select label="Report" aria-label="Report" value={report} onChange={(e) => setReport(e.target.value as ReportKey)} wrapperClassName="w-full sm:w-52">
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
            {meta.range && (
              <>
                <Input label="From" aria-label="From date" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} wrapperClassName="w-[46%] sm:w-44" />
                <Input label="To" aria-label="To date" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} wrapperClassName="w-[46%] sm:w-44" />
              </>
            )}
            {meta.itemFilter && (
              <div className="w-full sm:w-64">
                <ItemSelect label="Item" aria-label="Item filter" items={stock.data?.items ?? []} value={itemId} onChange={setItemId} />
              </div>
            )}
            {meta.itemFilter && itemId && (
              <Button variant="ghost" size="sm" onClick={() => setItemId("")}>
                All items
              </Button>
            )}
          </div>
          {!rangeValid ? (
            <EmptyState title="Invalid date range" description="The start date must be on or before the end date." />
          ) : data.error ? (
            <ErrorState message={data.error} onRetry={data.reload} />
          ) : !current ? (
            <LoadingState />
          ) : (
            <ReportBody report={report} data={current} />
          )}
        </Card>
      )}
    </PageContainer>
  );
}

function ReportBody({ report, data }: { report: ReportKey; data: ReportData }) {
  switch (report) {
    case "consumption":
      return <ConsumptionTable d={data as ConsumptionReport} />;
    case "movement":
      return <MovementTable d={data as MovementReport} />;
    case "valuation":
      return <ValuationTable d={data as ValuationReport} />;
    case "wastage":
      return <WastageTable d={data as WastageReport} />;
    case "vendor-spend":
      return <VendorSpendTable d={data as VendorSpendReport} />;
    case "purchases":
      return <PurchasesTable d={data as PurchasesReport} />;
  }
}

const Empty = () => <EmptyState title="No data for this period" />;
const R = "tabular whitespace-nowrap text-right";

function ConsumptionTable({ d }: { d: ConsumptionReport }) {
  if (!d.rows?.length) return <Empty />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Ingredient</Th>
          <Th className="text-right">Sales</Th>
          <Th className="text-right">Wastage</Th>
          <Th className="text-right">Total</Th>
          <Th className="text-right">Value</Th>
        </tr>
      </THead>
      <tbody>
        {d.rows.map((r) => (
          <Tr key={`${r.date}:${r.inventoryItemId}`}>
            <Td className="whitespace-nowrap">{formatYmd(r.date)}</Td>
            <Td>
              {r.name} <span className="text-xs text-muted">({UNIT_LABELS[r.unit]})</span>
            </Td>
            <Td className={R}>{formatQty(r.sale)}</Td>
            <Td className={R}>{formatQty(r.wastage)}</Td>
            <Td className={`${R} font-semibold`}>{formatQty(r.total)}</Td>
            <Td className={R}>{formatINR(r.value)}</Td>
          </Tr>
        ))}
      </tbody>
      <Foot cols={5} label="Total value" value={formatINR(d.totalValue)} />
    </Table>
  );
}

function MovementTable({ d }: { d: MovementReport }) {
  if (!d.rows?.length) return <Empty />;
  const total = d.rows.reduce((s, r) => s + r.closingValue, 0);
  return (
    <Table>
      <THead>
        <tr>
          <Th>Item</Th>
          <Th className="text-right">Opening</Th>
          <Th className="text-right">In</Th>
          <Th className="text-right">Out</Th>
          <Th className="text-right">Closing</Th>
          <Th className="text-right">Closing value</Th>
          <Th>Breakdown</Th>
        </tr>
      </THead>
      <tbody>
        {d.rows.map((r) => (
          <Tr key={r.inventoryItemId}>
            <Td>
              <p className="font-medium">
                {r.name} <span className="text-xs text-muted">({UNIT_LABELS[r.unit]})</span>
              </p>
              <p className="text-xs text-muted">{r.category}</p>
            </Td>
            <Td className={R}>{formatQty(r.opening)}</Td>
            <Td className={`${R} text-secondary dark:text-green-300`}>+{formatQty(r.in)}</Td>
            <Td className={`${R} text-red-600 dark:text-red-400`}>−{formatQty(r.out)}</Td>
            <Td className={`${R} font-semibold`}>{formatQty(r.closing)}</Td>
            <Td className={R}>{formatINR(r.closingValue)}</Td>
            <Td className="text-xs text-muted">
              {Object.entries(r.byType)
                .map(([t, q]) => `${TXN_LABELS[t as keyof typeof TXN_LABELS] ?? t} ${q! > 0 ? "+" : ""}${formatQty(q)}`)
                .join(" · ") || "—"}
            </Td>
          </Tr>
        ))}
      </tbody>
      <Foot cols={5} label="Closing value" value={formatINR(total)} trailing={1} />
    </Table>
  );
}

function ValuationTable({ d }: { d: ValuationReport }) {
  if (!d.rows?.length) return <Empty />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        <Stat label="Total value" value={formatINR(d.totalValue)} />
        {d.byCategory.slice(0, 7).map((c) => (
          <Stat key={c.category} label={c.category} value={formatINR(c.value)} />
        ))}
      </div>
      <Table>
        <THead>
          <tr>
            <Th>Item</Th>
            <Th>Category</Th>
            <Th className="text-right">Quantity</Th>
            <Th className="text-right">Cost / unit</Th>
            <Th className="text-right">Value</Th>
          </tr>
        </THead>
        <tbody>
          {d.rows.map((r) => (
            <Tr key={r.inventoryItemId}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-muted">{r.category}</Td>
              <Td className={R}>
                {formatQty(r.quantity)} <span className="text-xs text-muted">{UNIT_LABELS[r.unit]}</span>
              </Td>
              <Td className={R}>{formatINR(r.costPerUnit)}</Td>
              <Td className={`${R} font-semibold`}>{formatINR(r.value)}</Td>
            </Tr>
          ))}
        </tbody>
        <Foot cols={4} label="Total" value={formatINR(d.totalValue)} />
      </Table>
    </>
  );
}

function WastageTable({ d }: { d: WastageReport }) {
  if (!d.rows?.length) return <Empty />;
  return (
    <>
      {d.byItem.length > 0 && (
        <div className="flex flex-wrap gap-2 p-4">
          {d.byItem.slice(0, 8).map((i) => (
            <span key={i.inventoryItemId} className="rounded-xl border border-line px-3 py-2 text-sm">
              {i.name} <span className="tabular font-semibold">{formatQty(i.quantity)} {UNIT_LABELS[i.unit]}</span>{" "}
              <span className="tabular text-muted">· {formatINR(i.value)}</span>
            </span>
          ))}
        </div>
      )}
      <Table>
        <THead>
          <tr>
            <Th>When</Th>
            <Th>Item</Th>
            <Th className="text-right">Quantity</Th>
            <Th className="text-right">Value</Th>
            <Th>Reason</Th>
            <Th>By</Th>
          </tr>
        </THead>
        <tbody>
          {d.rows.map((r) => (
            <Tr key={r.id}>
              <Td className="whitespace-nowrap">
                {formatYmd(r.date)} <span className="text-xs text-muted">{formatTime(r.createdAt)}</span>
              </Td>
              <Td className="font-medium">{r.name}</Td>
              <Td className={R}>
                {formatQty(r.quantity)} <span className="text-xs text-muted">{UNIT_LABELS[r.unit]}</span>
              </Td>
              <Td className={R}>{formatINR(r.value)}</Td>
              <Td className="text-muted">{r.reason ?? "—"}</Td>
              <Td className="text-muted">{r.by ?? "—"}</Td>
            </Tr>
          ))}
        </tbody>
        <Foot cols={3} label="Total" value={formatINR(d.totalValue)} trailing={2} />
      </Table>
    </>
  );
}

function VendorSpendTable({ d }: { d: VendorSpendReport }) {
  if (!d.rows?.length) return <Empty />;
  const sum = (k: "subtotal" | "tax" | "paid" | "purchases") => d.rows.reduce((s, r) => s + r[k], 0);
  return (
    <Table>
      <THead>
        <tr>
          <Th>Vendor</Th>
          <Th className="text-right">Purchases</Th>
          <Th className="text-right">Subtotal</Th>
          <Th className="text-right">GST</Th>
          <Th className="text-right">Total</Th>
          <Th className="text-right">Paid</Th>
          <Th className="text-right">Outstanding</Th>
        </tr>
      </THead>
      <tbody>
        {d.rows.map((r) => (
          <Tr key={r.vendorId}>
            <Td className="font-medium">{r.vendor}</Td>
            <Td className={R}>{r.purchases}</Td>
            <Td className={R}>{formatINR(r.subtotal)}</Td>
            <Td className={R}>{formatINR(r.tax)}</Td>
            <Td className={`${R} font-semibold`}>{formatINR(r.total)}</Td>
            <Td className={R}>{formatINR(r.paid)}</Td>
            <Td className={R}>{formatINR(r.outstanding)}</Td>
          </Tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-surface-2 font-semibold">
          <Td>Total</Td>
          <Td className={R}>{sum("purchases")}</Td>
          <Td className={R}>{formatINR(sum("subtotal"))}</Td>
          <Td className={R}>{formatINR(sum("tax"))}</Td>
          <Td className={R}>{formatINR(d.total)}</Td>
          <Td className={R}>{formatINR(sum("paid"))}</Td>
          <Td className={R}>{formatINR(d.outstanding)}</Td>
        </tr>
      </tfoot>
    </Table>
  );
}

function PurchasesTable({ d }: { d: PurchasesReport }) {
  if (!d.rows?.length) return <Empty />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        <Stat label="Received" value={d.totals.received} />
        <Stat label="Received total" value={formatINR(d.totals.total)} />
        <Stat label="GST" value={formatINR(d.totals.tax)} />
        <Stat label="Balance due" value={formatINR(d.totals.balance)} tone={d.totals.balance > 0 ? "warning" : undefined} />
      </div>
      <Table>
        <THead>
          <tr>
            <Th>Date</Th>
            <Th>Invoice</Th>
            <Th>Vendor</Th>
            <Th>Status</Th>
            <Th className="text-right">Items</Th>
            <Th className="text-right">Subtotal</Th>
            <Th className="text-right">GST</Th>
            <Th className="text-right">Total</Th>
            <Th className="text-right">Paid</Th>
            <Th className="text-right">Balance</Th>
          </tr>
        </THead>
        <tbody>
          {d.rows.map((r) => (
            <Tr key={r.id}>
              <Td className="whitespace-nowrap">{formatYmd(r.date)}</Td>
              <Td>{r.invoiceNo ?? "—"}</Td>
              <Td className="font-medium">{r.vendor}</Td>
              <Td>
                <PurchaseStatusBadge status={r.status} />
              </Td>
              <Td className={R}>{r.items}</Td>
              <Td className={R}>{formatINR(r.subtotal)}</Td>
              <Td className={R}>{formatINR(r.tax)}</Td>
              <Td className={`${R} font-semibold`}>{formatINR(r.total)}</Td>
              <Td className={R}>{formatINR(r.paid)}</Td>
              <Td className={R}>{r.status === "RECEIVED" ? formatINR(r.balance) : "—"}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/** Totals row: label spans `cols`, then the value, then `trailing` empty cells. */
function Foot({ cols, label, value, trailing = 0 }: { cols: number; label: string; value: string; trailing?: number }) {
  return (
    <tfoot>
      <tr className="bg-surface-2 font-semibold">
        <Td colSpan={cols} className="text-right">
          {label}
        </Td>
        <Td className={R}>{value}</Td>
        {Array.from({ length: trailing }, (_, i) => (
          <Td key={i} />
        ))}
      </tr>
    </tfoot>
  );
}
