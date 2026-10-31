"use client";

import Link from "next/link";
import { formatINR } from "@canavo/shared";
import { ORDER_TYPE_LABELS, formatDateTime, titleCase } from "@/lib/format";
import type { CustomerProfile, KhataTransaction, LoyaltyTxnType } from "@/lib/types-crm";
import { useSession } from "@/components/providers/SessionProvider";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";

const orderTone = { OPEN: "warning", PAID: "success", CANCELLED: "danger" } as const;
const loyaltyTone: Record<LoyaltyTxnType, "success" | "primary" | "info" | "warning" | "danger"> = {
  EARN: "success",
  REDEEM: "primary",
  ADJUST: "info",
  EXPIRE: "warning",
  REVERSE: "danger",
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function RecentOrdersTable({ orders }: { orders: CustomerProfile["recentOrders"] }) {
  const { can } = useSession();
  const billsLink = can("bills:view");
  if (!orders.length) return <EmptyState title="No orders yet" />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Invoice</Th>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th className="text-right">Items</Th>
          <Th>Savings</Th>
          <Th className="text-right">Total</Th>
          <Th>Status</Th>
        </tr>
      </THead>
      <tbody>
        {orders.map((o) => (
          <Tr key={o.id}>
            <Td>
              {billsLink ? (
                <Link href={`/bills?search=${encodeURIComponent(o.invoiceNumber)}`} className="font-mono text-sm font-semibold hover:text-primary hover:underline">
                  {o.invoiceNumber}
                </Link>
              ) : (
                <span className="font-mono text-sm font-semibold">{o.invoiceNumber}</span>
              )}
            </Td>
            <Td className="whitespace-nowrap text-muted">{formatDateTime(o.createdAt)}</Td>
            <Td>{ORDER_TYPE_LABELS[o.orderType]}</Td>
            <Td className="tabular text-right">{o._count.items}</Td>
            <Td className="text-xs text-muted">
              {[
                o.promoDiscount > 0 && `Offers ${formatINR(o.promoDiscount)}`,
                o.couponCode && `Coupon ${o.couponCode}`,
                o.pointsRedeemed > 0 && `${o.pointsRedeemed} pts`,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </Td>
            <Td className="tabular text-right font-semibold">{formatINR(o.grandTotal)}</Td>
            <Td>
              <Badge tone={orderTone[o.status]}>{titleCase(o.status)}</Badge>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

export function LoyaltyLedgerTable({ rows }: { rows: CustomerProfile["loyaltyLedger"] }) {
  if (!rows.length) return <EmptyState title="No points activity" />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th>Note</Th>
          <Th className="text-right">Points</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((t) => (
          <Tr key={t.id}>
            <Td className="whitespace-nowrap text-muted">{formatDateTime(t.createdAt)}</Td>
            <Td>
              <Badge tone={loyaltyTone[t.type]}>{t.type}</Badge>
            </Td>
            <Td className="text-sm">{t.note || "—"}</Td>
            <Td className={`tabular text-right font-bold ${t.points < 0 ? "text-red-600 dark:text-red-400" : "text-secondary dark:text-green-300"}`}>
              {signed(t.points)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Newest-first khata rows with a running balance (derived back from the current balance). */
export function KhataLedgerTable({ rows, balance }: { rows: KhataTransaction[]; balance: number }) {
  if (!rows.length) return <EmptyState title="No khata activity" />;
  let running = balance;
  const withRunning = rows.map((t) => {
    const after = running;
    running -= t.type === "DEBIT" ? t.amount : -t.amount;
    return { ...t, after };
  });
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th>Mode</Th>
          <Th>Note</Th>
          <Th className="text-right">Amount</Th>
          <Th className="text-right">Balance</Th>
        </tr>
      </THead>
      <tbody>
        {withRunning.map((t) => (
          <Tr key={t.id}>
            <Td className="whitespace-nowrap text-muted">{formatDateTime(t.createdAt)}</Td>
            <Td>
              <Badge tone={t.type === "DEBIT" ? "danger" : "success"}>{t.type === "DEBIT" ? "Debit" : "Credit"}</Badge>
            </Td>
            <Td className="text-sm">{t.mode ? (t.mode === "UPI" ? "UPI" : titleCase(t.mode)) : "—"}</Td>
            <Td className="text-sm">{t.note || "—"}</Td>
            <Td className={`tabular text-right font-semibold ${t.type === "DEBIT" ? "text-red-600 dark:text-red-400" : "text-secondary dark:text-green-300"}`}>
              {t.type === "DEBIT" ? "+" : "−"}
              {formatINR(t.amount)}
            </Td>
            <Td className="tabular text-right">{formatINR(t.after)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

export function CouponRedemptionsTable({ rows }: { rows: CustomerProfile["couponRedemptions"] }) {
  if (!rows.length) return <EmptyState title="No coupons used" />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Code</Th>
          <Th className="text-right">Discount</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.orderId}>
            <Td className="whitespace-nowrap text-muted">{formatDateTime(r.createdAt)}</Td>
            <Td className="font-mono font-semibold">{r.code}</Td>
            <Td className="tabular text-right font-semibold">{formatINR(r.amount)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

export function FavouriteItems({ items }: { items: CustomerProfile["favouriteItems"] }) {
  if (!items.length) return <p className="px-5 py-6 text-center text-sm text-muted">No favourites yet.</p>;
  const max = Math.max(...items.map((i) => i.quantity));
  return (
    <ul className="divide-y divide-line">
      {items.map((i, idx) => (
        <li key={i.menuItemId} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold">
              <span className="mr-2 text-muted">{idx + 1}.</span>
              {i.name}
            </span>
            <span className="tabular text-sm text-muted">
              {i.quantity}× · {formatINR(i.amount)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-secondary" style={{ width: `${(i.quantity / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
