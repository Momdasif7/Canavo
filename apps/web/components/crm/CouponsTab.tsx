"use client";

import { useState } from "react";
import { MagnifyingGlass, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { Coupon, CouponDeleteResult } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { CouponForm } from "./CouponForm";
import { formatDate } from "./shared";

export const couponValueLabel = (c: Pick<Coupon, "discountType" | "value" | "maxDiscount">) =>
  c.discountType === "FLAT" ? `${formatINR(c.value)} off` : `${c.value}% off${c.maxDiscount ? ` (max ${formatINR(c.maxDiscount)})` : ""}`;

function couponStatus(c: Coupon): { label: string; tone: "success" | "neutral" | "danger" | "warning" | "info" } {
  const now = Date.now();
  if (!c.active) return { label: "Inactive", tone: "neutral" };
  if (c.expiresAt && new Date(c.expiresAt).getTime() < now) return { label: "Expired", tone: "danger" };
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return { label: "Used up", tone: "warning" };
  if (c.startsAt && new Date(c.startsAt).getTime() > now) return { label: "Scheduled", tone: "info" };
  return { label: "Active", tone: "success" };
}

export function CouponsTab() {
  const { outletId } = useSession();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [active, setActive] = useState<"" | "1" | "0">("");
  const [editing, setEditing] = useState<Coupon | null | undefined>(null);
  const [deleting, setDeleting] = useState<Coupon | null>(null);

  const coupons = useApiQuery<Coupon[]>(outletId ? `coupons:${outletId}:${q}:${active}` : null, () =>
    api.get<Coupon[]>("/offers/coupons", { query: { search: q, active } }),
  );
  const list = coupons.data ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <Input
          wrapperClassName="min-w-[220px] flex-1 max-w-md"
          type="search"
          aria-label="Search coupons"
          placeholder="Search by code"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          prefix={<MagnifyingGlass size={18} />}
        />
        <Select aria-label="Coupon status" value={active} onChange={(e) => setActive(e.target.value as typeof active)} className="w-40">
          <option value="">Any status</option>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </Select>
        <div className="flex-1" />
        <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)}>
          New coupon
        </Button>
      </div>

      {coupons.loading && !coupons.data ? (
        <LoadingState />
      ) : coupons.error ? (
        <ErrorState message={coupons.error} onRetry={coupons.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          title={q || active ? "No coupons match" : "No coupons yet"}
          action={!q && !active && <Button onClick={() => setEditing(undefined)}>Create a coupon</Button>}
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Code</Th>
              <Th>Discount</Th>
              <Th className="text-right">Min order</Th>
              <Th>Usage</Th>
              <Th>Validity</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {list.map((c) => {
              const st = couponStatus(c);
              const pct = c.usageLimit ? Math.min(100, (c.usedCount / c.usageLimit) * 100) : 0;
              return (
                <Tr key={c.id}>
                  <Td className="max-w-xs">
                    <p className="font-mono font-bold tracking-wide">{c.code}</p>
                    {c.description && <p className="truncate text-xs text-muted">{c.description}</p>}
                  </Td>
                  <Td className="whitespace-nowrap font-semibold">{couponValueLabel(c)}</Td>
                  <Td className="tabular text-right">{c.minOrder ? formatINR(c.minOrder) : "—"}</Td>
                  <Td className="min-w-[120px]">
                    <p className="tabular text-sm">
                      {c.usedCount}
                      <span className="text-muted"> / {c.usageLimit ?? "∞"}</span>
                      {c.perCustomerLimit && <span className="text-xs text-muted"> · {c.perCustomerLimit}/customer</span>}
                    </p>
                    {c.usageLimit && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-sm text-muted">
                    {c.startsAt || c.expiresAt ? (
                      <>
                        {c.startsAt && <p>From {formatDate(c.startsAt)}</p>}
                        {c.expiresAt && <p>Until {formatDate(c.expiresAt)}</p>}
                      </>
                    ) : (
                      "No expiry"
                    )}
                  </Td>
                  <Td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <IconButton label={`Edit coupon ${c.code}`} onClick={() => setEditing(c)}>
                      <PencilSimple size={20} />
                    </IconButton>
                    <IconButton label={`Delete coupon ${c.code}`} onClick={() => setDeleting(c)} className="text-red-600 dark:text-red-400">
                      <Trash size={20} />
                    </IconButton>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <CouponForm coupon={editing} onClose={() => setEditing(null)} onSaved={coupons.reload} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete coupon ${deleting?.code ?? ""}?`}
        description={
          deleting && deleting.usedCount > 0
            ? "This coupon has been used, so it will be deactivated instead to keep its redemption history."
            : "The code will stop working immediately."
        }
        confirmLabel={deleting && deleting.usedCount > 0 ? "Deactivate" : "Delete coupon"}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            const r = await api.del<CouponDeleteResult | undefined>(`/offers/coupons/${deleting.id}`);
            if (r?.deactivated) {
              coupons.setData((l) => l?.map((x) => (x.id === deleting.id ? { ...x, active: false } : x)));
              toast(`${deleting.code} has redemptions, so it was deactivated instead`, "info");
            } else {
              coupons.setData((l) => l?.filter((x) => x.id !== deleting.id));
              toast(`Coupon ${deleting.code} deleted`, "success");
            }
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
    </Card>
  );
}
