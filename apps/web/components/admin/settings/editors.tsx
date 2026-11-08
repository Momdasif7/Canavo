"use client";

import { useState } from "react";
import clsx from "clsx";
import { Bell, ChatCircleText, DeviceMobile, EnvelopeSimple, Plus, Trash, WhatsappLogo } from "@phosphor-icons/react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Textarea, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import type { EditorProps } from "./SettingCard";

// =====================================================================
// Notification preferences: event × channel matrix
// =====================================================================

type Channel = "push" | "sms" | "email" | "whatsapp";
type ChannelPrefs = Record<Channel, boolean>;

const CHANNELS: { key: Channel; label: string; icon: React.ReactNode }[] = [
  { key: "push", label: "Push", icon: <DeviceMobile size={16} /> },
  { key: "sms", label: "SMS", icon: <ChatCircleText size={16} /> },
  { key: "email", label: "Email", icon: <EnvelopeSimple size={16} /> },
  { key: "whatsapp", label: "WhatsApp", icon: <WhatsappLogo size={16} /> },
];

/** Event kinds the API emits (see services/notify + callers); prefixes act as group defaults. */
const EVENTS: { key: string; label: string; depth: 0 | 1 | 2 }[] = [
  { key: "*", label: "All events (default)", depth: 0 },
  { key: "attendance", label: "Attendance", depth: 1 },
  { key: "attendance.late", label: "Late clock-in", depth: 2 },
  { key: "attendance.early", label: "Early clock-out", depth: 2 },
  { key: "attendance.overtime", label: "Overtime", depth: 2 },
  { key: "leave", label: "Leave", depth: 1 },
  { key: "leave.request", label: "New leave request", depth: 2 },
  { key: "leave.review", label: "Leave approved / rejected", depth: 2 },
  { key: "inventory", label: "Inventory", depth: 1 },
  { key: "inventory.low", label: "Low stock alert", depth: 2 },
  { key: "inventory.digest", label: "Daily stock digest", depth: 2 },
  { key: "inventory.transfer", label: "Stock transfer", depth: 2 },
  { key: "delivery", label: "Delivery assignments & updates", depth: 1 },
];

const FALLBACK: ChannelPrefs = { push: true, sms: false, email: false, whatsapp: false };

/** Mirrors the API's resolvePrefs: exact kind → its prefixes → "*" → push only. */
function resolve(prefs: Record<string, ChannelPrefs>, kind: string): { prefs: ChannelPrefs; from: string } {
  const parts = kind.split(".");
  for (let i = parts.length; i > 0; i--) {
    const k = parts.slice(0, i).join(".");
    if (k !== kind && prefs[k]) return { prefs: { ...FALLBACK, ...prefs[k] }, from: k };
  }
  if (kind !== "*" && prefs["*"]) return { prefs: { ...FALLBACK, ...prefs["*"] }, from: "*" };
  return { prefs: FALLBACK, from: "built-in" };
}

export function NotificationPrefsEditor({ value, onChange, readOnly }: EditorProps<"notifications.prefs">) {
  const prefs = value as Record<string, ChannelPrefs>;
  const extra = Object.keys(prefs)
    .filter((k) => !EVENTS.some((e) => e.key === k))
    .map((k) => ({ key: k, label: k, depth: 2 as const }));
  const rows = [...EVENTS, ...extra];

  const setCustom = (kind: string, on: boolean) => {
    const next = { ...prefs };
    if (on) next[kind] = { ...resolve(prefs, kind).prefs };
    else delete next[kind];
    onChange(next);
  };
  const setChannel = (kind: string, ch: Channel, v: boolean) => onChange({ ...prefs, [kind]: { ...FALLBACK, ...prefs[kind], [ch]: v } });

  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead className="bg-surface-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <tr>
            <th className="px-5 py-2.5 text-left">Event</th>
            <th className="px-2 py-2.5 text-center">Custom</th>
            {CHANNELS.map((c) => (
              <th key={c.key} className="px-2 py-2.5 text-center">
                <span className="inline-flex items-center gap-1">
                  {c.icon}
                  {c.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const own = prefs[e.key];
            const custom = e.key === "*" || !!own;
            const shown = own ? { ...FALLBACK, ...own } : resolve(prefs, e.key).prefs;
            const inheritedFrom = own ? null : resolve(prefs, e.key).from;
            return (
              <tr key={e.key} className="border-t border-line">
                <td className={clsx("px-5 py-2", e.depth === 0 && "font-bold", e.depth === 1 && "font-semibold", e.depth === 2 && "pl-10")}>
                  {e.label}
                  {!custom && inheritedFrom && (
                    <span className="block text-xs font-normal text-muted">
                      inherits {inheritedFrom === "*" ? "default" : inheritedFrom === "built-in" ? "built-in" : EVENTS.find((x) => x.key === inheritedFrom)?.label ?? inheritedFrom}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  {e.key === "*" ? (
                    <span className="text-xs text-muted">always</span>
                  ) : (
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-primary"
                      aria-label={`Custom channels for ${e.label}`}
                      checked={custom}
                      disabled={readOnly}
                      onChange={(ev) => setCustom(e.key, ev.target.checked)}
                    />
                  )}
                </td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      className={clsx("h-5 w-5 accent-[#2D6A4F]", !custom && "opacity-40")}
                      aria-label={`${c.label} for ${e.label}`}
                      checked={shown[c.key]}
                      disabled={readOnly || !custom}
                      onChange={(ev) => setChannel(e.key, c.key, ev.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 flex items-start gap-2 px-5 text-xs text-muted">
        <Bell size={16} className="mt-px shrink-0" />
        In-app notifications are always created. SMS, email and WhatsApp need the matching provider configured on the server; a channel without a provider is skipped.
      </p>
    </div>
  );
}

// =====================================================================
// Key → value rows (KOT printers, WhatsApp templates)
// =====================================================================

interface Row<V> {
  id: number;
  key: string;
  value: V;
}

let rowId = 1;

function useRows<V>(record: Record<string, V>) {
  return useState<Row<V>[]>(() => Object.entries(record).map(([key, value]) => ({ id: rowId++, key, value })));
}

const toRecord = <V,>(rows: Row<V>[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

// =====================================================================
// Printer defaults
// =====================================================================

export function PrinterDefaultsEditor({ value, onChange, readOnly }: EditorProps<"printer.defaults">) {
  const set = <F extends keyof typeof value>(k: F, v: (typeof value)[F]) => onChange({ ...value, [k]: v });
  const [rows, setRows] = useRows(value.kotPrinters ?? {});
  const updateRows = (next: Row<string>[]) => {
    setRows(next);
    onChange({ ...value, kotPrinters: toRecord(next) });
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-sm font-semibold">Paper width</p>
          <Segmented
            value={String(value.paperWidth) as "58" | "80"}
            onChange={(v) => !readOnly && set("paperWidth", v === "80" ? 80 : 58)}
            options={[
              { value: "58", label: "58 mm" },
              { value: "80", label: "80 mm" },
            ]}
          />
        </div>
        <Input label="Default printer name" maxLength={100} placeholder="e.g. EPSON TM-T82" value={value.printerName ?? ""} onChange={(e) => set("printerName", e.target.value || undefined)} />
      </div>
      <div className="space-y-1">
        <Toggle label="Auto-print receipt" description="Print the bill as soon as payment is recorded" checked={value.autoPrintReceipt} onChange={(v) => set("autoPrintReceipt", v)} disabled={readOnly} />
        <Toggle label="Auto-print KOT" description="Send kitchen tickets to the printer automatically" checked={value.autoPrintKot} onChange={(v) => set("autoPrintKot", v)} disabled={readOnly} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Receipt copies" type="number" min={1} max={5} value={value.receiptCopies} onChange={(e) => set("receiptCopies", Number(e.target.value))} />
        <Input label="KOT copies" type="number" min={1} max={5} value={value.kotCopies} onChange={(e) => set("kotCopies", Number(e.target.value))} />
      </div>
      <div>
        <p className="text-sm font-semibold">Kitchen station printers</p>
        <p className="mb-2 text-xs text-muted">Route KOTs per station (matches the menu item&apos;s kitchen station, e.g. MAIN, BEVERAGE).</p>
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input aria-label="Station" placeholder="Station" maxLength={40} value={r.key} onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, key: e.target.value.toUpperCase() } : x)))} wrapperClassName="w-40" />
              <Input aria-label="Printer" placeholder="Printer name" maxLength={100} value={r.value} onChange={(e) => updateRows(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))} wrapperClassName="flex-1" />
              {!readOnly && (
                <IconButton label="Remove station" onClick={() => updateRows(rows.filter((x) => x.id !== r.id))}>
                  <Trash size={20} />
                </IconButton>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button variant="outline" size="sm" icon={<Plus size={18} />} onClick={() => updateRows([...rows, { id: rowId++, key: "", value: "" }])}>
              Add station
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Pre-order lead time
// =====================================================================

export function LeadMinutesEditor({ value, onChange }: EditorProps<"service.preOrderLeadMinutes">) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Input
        label="Minimum lead time (minutes)"
        type="number"
        min={0}
        max={1440}
        step={5}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value)))}
        wrapperClassName="w-60"
        hint="0 – 1440. Pre-orders must be scheduled at least this far ahead."
      />
      <div className="flex gap-1.5 pb-6">
        {[15, 30, 60, 120].map((m) => (
          <Button key={m} variant={value === m ? "secondary" : "outline"} size="sm" onClick={() => onChange(m)}>
            {m < 60 ? `${m}m` : `${m / 60}h`}
          </Button>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Security: IP whitelist
// =====================================================================

export function IpWhitelistEditor({ value, onChange }: EditorProps<"security.ipWhitelist">) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <Textarea
      label="Allowed IP addresses / CIDR ranges"
      rows={6}
      className="font-mono text-sm"
      placeholder={"203.0.113.10\n198.51.100.0/24"}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
