"use client";

import { useState } from "react";
import clsx from "clsx";
import { CloudSlash, Gift, Minus, NotePencil, Plus, ShoppingCartSimple, Sparkle, Trash, User, Warning } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { ORDER_TYPE_LABELS } from "@/lib/format";
import type { DocumentType, OrderType, TaxDetail } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { FoodMark } from "@/components/ui/FoodMark";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { freeBadge, type CartLine, type CartMeta } from "./cart";

/** Bill totals shown in the cart — from the server preview, or computed locally as a fallback. */
export interface CartTotals {
  source: "server" | "local";
  documentType: DocumentType;
  subtotal: number;
  discount: number;
  serviceCharge: number;
  charges: { label: string; amount: number }[];
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number;
  otherTaxes?: number;
  /** Named tax lines (cess, VAT…) when the API itemises them */
  taxDetails?: TaxDetail[];
  roundOff: number;
  grandTotal: number;
  /** Promotions applied by the server (pre-tax amounts) */
  applied: { kind: string; label: string; amount: number }[];
  /** Manual discount part (pre-tax) when known */
  manualDiscount?: number;
}

interface Props {
  lines: CartLine[];
  meta: CartMeta;
  totals: CartTotals;
  /** Preview request in flight */
  previewing: boolean;
  /** Why server totals aren't shown (offline, invalid coupon…) */
  previewNote?: string | null;
  /** Other preview warnings (e.g. incomplete delivery details) */
  notices?: string[];
  discountError?: string;
  phoneError?: string;
  serviceChargePercent: number;
  charging: boolean;
  /** Customer lookup card, delivery address, pre-order time… */
  details?: React.ReactNode;
  /** Coupon & points controls */
  promotions?: React.ReactNode;
  chargeBlocker?: string | null;
  /** Order types the business's modules allow (default: all) */
  orderTypes?: OrderType[];
  /** Cash on Delivery chosen in the cart: charging places the order without taking payment */
  codOrder?: boolean;
  onMeta: (patch: Partial<CartMeta>) => void;
  onQty: (key: string, qty: number) => void;
  onNotes: (key: string, notes: string) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onCharge: () => void;
}

export const ORDER_TYPES: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY", "PRE_ORDER"];

/** Delivery needs the Delivery module, pre-orders the Reservations module (null modules = all). */
export function allowedOrderTypes(modules: readonly string[] | null | undefined): OrderType[] {
  return ORDER_TYPES.filter((t) => !modules || (t === "DELIVERY" ? modules.includes("DELIVERY") : t === "PRE_ORDER" ? modules.includes("RESERVATIONS") : true));
}

export function CartPanel(p: Props) {
  const { lines, meta, totals } = p;
  const [showCustomer, setShowCustomer] = useState(false);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
  const isTax = totals.documentType === "TAX_INVOICE";
  const needsCustomer = meta.orderType === "DELIVERY";
  const customerOpen = showCustomer || !!p.phoneError || needsCustomer;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Current bill">
      {/* Order type & customer */}
      <div className="space-y-2 border-b border-line p-3">
        <Segmented
          className="w-full"
          size="sm"
          value={meta.orderType}
          onChange={(orderType) => p.onMeta({ orderType })}
          options={(p.orderTypes ?? ORDER_TYPES).map((t) => ({ value: t, label: ORDER_TYPE_LABELS[t] }))}
        />
        <div className="flex gap-2">
          {meta.orderType === "DINE_IN" && (
            <input
              aria-label="Table"
              placeholder="Table"
              maxLength={20}
              value={meta.tableLabel}
              onChange={(e) => p.onMeta({ tableLabel: e.target.value })}
              className="min-h-[44px] w-24 rounded-xl border border-line bg-surface px-3 text-sm font-semibold focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          )}
          <button
            type="button"
            onClick={() => setShowCustomer((s) => !s)}
            className={clsx("flex min-h-[44px] flex-1 items-center gap-2 rounded-xl border px-3 text-left text-sm hover:bg-surface-2", p.phoneError ? "border-red-500" : "border-line")}
            aria-expanded={customerOpen}
          >
            <User size={18} className="text-muted" />
            <span className={clsx("truncate", !(meta.customerName || meta.customerPhone) && "text-muted")}>
              {meta.customerName || meta.customerPhone
                ? [meta.customerName, meta.customerPhone].filter(Boolean).join(" · ")
                : needsCustomer
                  ? "Customer (required)"
                  : "Add customer (optional)"}
            </span>
          </button>
        </div>
        {customerOpen && (
          <div className="grid grid-cols-2 gap-2">
            <input
              aria-label="Customer phone"
              placeholder="10-digit mobile"
              inputMode="numeric"
              maxLength={10}
              value={meta.customerPhone}
              onChange={(e) => p.onMeta({ customerPhone: e.target.value.replace(/\D/g, "") })}
              aria-invalid={!!p.phoneError}
              className={clsx(
                "min-h-[44px] w-full rounded-xl border bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30",
                p.phoneError ? "border-red-500" : "border-line focus:border-primary",
              )}
            />
            <input
              aria-label="Customer name"
              placeholder="Name"
              maxLength={100}
              value={meta.customerName}
              onChange={(e) => p.onMeta({ customerName: e.target.value })}
              className="min-h-[44px] rounded-xl border border-line bg-surface px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {p.phoneError && <p className="col-span-2 text-xs font-medium text-red-600">{p.phoneError}</p>}
          </div>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {p.details && <div className="space-y-2 border-b border-line p-3">{p.details}</div>}

        {/* Lines */}
        {lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-muted">
            <ShoppingCartSimple size={44} weight="duotone" />
            <p className="font-semibold text-fg">No items yet</p>
            <p className="text-sm">Tap an item to add it. Press / to search.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((l) => (
              <li key={l.key} className={clsx("px-3 py-2.5", l.free && "bg-secondary-50/60 dark:bg-secondary/10")} data-testid={l.free ? "free-line" : "cart-line"} data-item={l.name}>
                <div className="flex items-start gap-2">
                  <FoodMark type={l.foodType} size={12} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold leading-tight">
                      {l.name}
                      {l.variantName && <span className="font-normal text-muted"> ({l.variantName})</span>}
                    </p>
                    {l.addonNames.length > 0 && <p className="truncate text-xs text-muted">+ {l.addonNames.join(", ")}</p>}
                    {l.free ? (
                      <span
                        className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white"
                        data-testid="free-badge"
                        title={`Added automatically by the offer “${l.free.offerName}”`}
                      >
                        <Gift size={12} weight="fill" className="shrink-0" />
                        <span className="truncate">{freeBadge(l.free)}</span>
                      </span>
                    ) : (
                      <p className="tabular text-xs text-muted">{formatINR(l.unitPrice)} each</p>
                    )}
                  </div>
                  {l.free ? (
                    <span className="flex flex-col items-end pt-0.5">
                      <span className="tabular text-xs text-muted line-through">{formatINR(l.unitPrice * l.quantity)}</span>
                      <span className="tabular font-bold text-secondary dark:text-green-300">
                        {l.free.percent >= 100 ? "FREE" : formatINR(Math.round((l.unitPrice * l.quantity * (100 - l.free.percent)) / 100))}
                      </span>
                    </span>
                  ) : (
                    <span className="tabular pt-0.5 font-bold">{formatINR(l.unitPrice * l.quantity)}</span>
                  )}
                </div>
                {l.free ? (
                  <div className="mt-1.5 flex items-center gap-1">
                    <span className="tabular rounded-lg border border-line px-3 py-2 text-sm font-bold" aria-label={`Quantity ${l.quantity}`}>
                      × {l.quantity}
                    </span>
                    <span className="text-xs text-muted">Added by offer · updates with the cart</span>
                    <IconButton label={`Remove ${l.name}`} className="ml-auto min-h-[42px] min-w-[42px] text-red-600" onClick={() => p.onRemove(l.key)}>
                      <Trash size={20} />
                    </IconButton>
                  </div>
                ) : (
                <div className="mt-1.5 flex items-center gap-1">
                  <div className="flex items-center rounded-xl border border-line">
                    <IconButton label={`Decrease ${l.name}`} className="min-h-[42px] min-w-[42px]" onClick={() => p.onQty(l.key, l.quantity - 1)}>
                      <Minus size={16} weight="bold" />
                    </IconButton>
                    <span className="tabular w-8 text-center font-bold">{l.quantity}</span>
                    <IconButton label={`Increase ${l.name}`} className="min-h-[42px] min-w-[42px]" onClick={() => p.onQty(l.key, l.quantity + 1)}>
                      <Plus size={16} weight="bold" />
                    </IconButton>
                  </div>
                  <IconButton
                    label="Add note"
                    className={clsx("min-h-[42px] min-w-[42px]", l.notes && "text-primary")}
                    onClick={() => setNoteOpen((k) => (k === l.key ? null : l.key))}
                  >
                    <NotePencil size={20} weight={l.notes ? "fill" : "regular"} />
                  </IconButton>
                  <IconButton label={`Remove ${l.name}`} className="ml-auto min-h-[42px] min-w-[42px] text-red-600" onClick={() => p.onRemove(l.key)}>
                    <Trash size={20} />
                  </IconButton>
                </div>
                )}
                {(noteOpen === l.key || l.notes) && (
                  <input
                    autoFocus={noteOpen === l.key}
                    aria-label={`Note for ${l.name}`}
                    placeholder="e.g. less sugar, no onion"
                    maxLength={200}
                    value={l.notes}
                    onChange={(e) => p.onNotes(l.key, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && setNoteOpen(null)}
                    className="mt-1.5 min-h-[40px] w-full rounded-lg border border-line bg-surface-2 px-3 text-sm focus:border-primary focus:outline-none"
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Discount + promotions */}
        <div className="space-y-2 border-t border-line p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-muted">Discount</span>
            <Segmented
              size="sm"
              value={meta.discountMode}
              onChange={(discountMode) => p.onMeta({ discountMode })}
              options={[
                { value: "FLAT", label: "₹" },
                { value: "PERCENT", label: "%" },
              ]}
            />
            <input
              aria-label="Discount"
              inputMode="decimal"
              placeholder="0"
              value={meta.discountInput}
              onChange={(e) => p.onMeta({ discountInput: e.target.value.replace(/[^\d.]/g, "") })}
              className={clsx(
                "tabular min-h-[40px] w-24 rounded-lg border bg-surface px-3 text-right text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30",
                p.discountError ? "border-red-500" : "border-line",
              )}
            />
            {p.discountError && <span className="text-xs text-red-600">{p.discountError}</span>}
          </div>
          {p.promotions}
        </div>
      </div>

      {/* Totals */}
      <div className="border-t border-line p-3">
        {totals.applied.length > 0 && (
          <ul className="mb-2 space-y-1" aria-label="Applied promotions">
            {totals.applied.map((a, i) => (
              <li
                key={`${a.label}-${i}`}
                className="flex items-center gap-2 rounded-lg bg-secondary-50 px-2.5 py-1 text-sm font-semibold text-secondary-700 dark:bg-secondary/20 dark:text-green-200"
              >
                <Sparkle size={14} weight="fill" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="tabular">−{formatINR(a.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="tabular space-y-0.5 text-sm">
          <Row label={`Subtotal (${itemCount} item${itemCount === 1 ? "" : "s"})`} value={formatINR(totals.subtotal)} />
          {totals.discount > 0 && <Row label="Discounts" value={`−${formatINR(totals.discount)}`} className="text-secondary dark:text-green-300" />}
          {totals.serviceCharge > 0 && <Row label={`Service charge (${p.serviceChargePercent}%)`} value={formatINR(totals.serviceCharge)} />}
          {totals.charges.map((c) => (
            <Row key={c.label} label={c.label} value={formatINR(c.amount)} />
          ))}
          {isTax ? (
            <>
              {totals.igst > 0 ? (
                <Row label="IGST" value={formatINR(totals.igst)} />
              ) : (
                <>
                  <Row label="CGST" value={formatINR(totals.cgst)} />
                  <Row label="SGST" value={formatINR(totals.sgst)} />
                </>
              )}
              {extraTaxRows(totals).map((r) => (
                <Row key={r.label} label={r.label} value={formatINR(r.amount)} />
              ))}
            </>
          ) : (
            totals.documentType === "BILL_OF_SUPPLY" && lines.length > 0 && <Row label="Bill of supply (composition)" value="No GST" />
          )}
          {totals.roundOff !== 0 && <Row label="Round off" value={`${totals.roundOff > 0 ? "+" : "−"}${formatINR(Math.abs(totals.roundOff))}`} />}
        </dl>
        {lines.length > 0 && (
          <p className={clsx("mt-1 flex items-center gap-1.5 text-xs", totals.source === "server" ? "text-muted" : "text-amber-700 dark:text-amber-300")} aria-live="polite">
            {p.previewing ? (
              <>
                <Spinner className="h-3 w-3" /> Updating totals…
              </>
            ) : totals.source === "server" ? (
              "Totals confirmed by server"
            ) : (
              <>
                <CloudSlash size={14} /> {p.previewNote ?? "Estimated locally (promotions apply when billed)"}
              </>
            )}
          </p>
        )}
        {lines.length > 0 &&
          p.notices?.map((n) => (
            <p key={n} className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
              <Warning size={14} className="mt-px shrink-0" /> {n}
            </p>
          ))}
        {p.chargeBlocker && lines.length > 0 && <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-300">{p.chargeBlocker}</p>}

        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" onClick={p.onClear} disabled={!lines.length} aria-label="Clear bill (F2)" title="New bill (F2)">
            <Trash size={20} />
          </Button>
          <Button size="lg" className="flex-1 justify-between" onClick={p.onCharge} disabled={!lines.length || !!p.discountError || !!p.chargeBlocker} loading={p.charging}>
            <span>
              {p.codOrder ? "Place COD order" : "Charge"} <kbd className="ml-1 hidden rounded bg-white/20 px-1.5 text-xs font-semibold lg:inline">F10</kbd>
            </span>
            <span className="tabular text-xl font-extrabold" data-testid="cart-total">
              {formatINR(totals.grandTotal)}
            </span>
          </Button>
        </div>
      </div>
    </section>
  );
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={clsx("flex justify-between", className)}>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

/**
 * Cess and extra-tax rows. Uses the itemised `taxDetails` when present (adding a
 * cess row only if they don't already include one), else the cess / other totals.
 */
export function extraTaxRows(t: { cess?: number; otherTaxes?: number; taxDetails?: TaxDetail[] }): { label: string; amount: number }[] {
  const details = (t.taxDetails ?? []).filter((d) => d.amount > 0);
  const rows = details.map((d) => ({ label: d.percent ? `${d.label} (${d.percent}%)` : d.label, amount: d.amount }));
  if ((t.cess ?? 0) > 0 && !details.some((d) => /cess/i.test(d.label))) rows.unshift({ label: "Cess", amount: t.cess! });
  if (!details.length && (t.otherTaxes ?? 0) > 0) rows.push({ label: "Other taxes", amount: t.otherTaxes! });
  return rows;
}
