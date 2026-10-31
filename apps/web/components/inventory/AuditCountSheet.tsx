"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, FloppyDisk, MagnifyingGlass, XCircle } from "@phosphor-icons/react";
import clsx from "clsx";
import { formatINR, type StockAuditCountsInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AuditDetail, AuditLine } from "@/lib/types-inventory";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AuditStatusBadge, Stat } from "./common";
import { ScanInput } from "./Scanner";
import { UNIT_LABELS, formatQty, parseQty, qtyChars, round3 } from "./units";

const toInput = (n: number | null) => (n == null ? "" : String(n));
const AUTOSAVE_MS = 4000;

export function AuditCountSheet({ audit, onChange }: { audit: AuditDetail; onChange: (a: AuditDetail) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const editable = audit.status === "IN_PROGRESS" && can("inventory:manage");

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [uncountedOnly, setUncountedOnly] = useState(false);
  const [autosave, setAutosave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"complete" | "cancel" | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLInputElement>());

  // (Re)initialise inputs from the server whenever a different audit loads.
  useEffect(() => {
    setInputs(Object.fromEntries(audit.lines.map((l) => [l.inventoryItemId, toInput(l.countedQty)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audit.id]);

  const serverCount = useMemo(() => new Map(audit.lines.map((l) => [l.inventoryItemId, l.countedQty])), [audit.lines]);

  /** Lines whose input differs from the saved count. */
  const changes = useMemo(() => {
    const out: StockAuditCountsInput["counts"] = [];
    for (const [id, raw] of Object.entries(inputs)) {
      const parsed = raw.trim() === "" ? null : parseQty(raw);
      if (raw.trim() !== "" && (parsed == null || parsed < 0)) continue; // invalid — skip until fixed
      const saved = serverCount.get(id) ?? null;
      if ((parsed == null ? null : round3(parsed)) !== saved) out.push({ inventoryItemId: id, countedQty: parsed == null ? null : round3(parsed) });
    }
    return out;
  }, [inputs, serverCount]);
  const dirty = changes.length > 0;

  const save = useCallback(
    async (quiet = false): Promise<AuditDetail | null> => {
      if (!changes.length) return audit;
      setSaving(true);
      setSaveError(null);
      try {
        const body: StockAuditCountsInput = { counts: changes };
        const next = await api.put<AuditDetail>(`/inventory/audits/${audit.id}/counts`, body);
        onChange(next);
        if (!quiet) toast(`Saved ${changes.length} count${changes.length === 1 ? "" : "s"}`, "success");
        return next;
      } catch (e) {
        setSaveError(errorMessage(e));
        if (!quiet) toast(errorMessage(e), "error");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [changes, audit, onChange, toast],
  );

  // Optional autosave a few seconds after the last keystroke.
  useEffect(() => {
    if (!autosave || !dirty || saving || !editable) return;
    const t = window.setTimeout(() => void save(true), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [autosave, dirty, saving, editable, inputs, save]);

  // Warn before leaving with unsaved counts.
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return audit.lines.filter((l) => {
      if (uncountedOnly && (inputs[l.inventoryItemId] ?? "").trim() !== "") return false;
      if (!f) return true;
      return [l.item.name, l.item.category, l.item.sku ?? "", l.item.barcode ?? ""].some((s) => s.toLowerCase().includes(f));
    });
  }, [audit.lines, filter, uncountedOnly, inputs]);

  const focusRow = (id: string) => {
    const el = refs.current.get(id);
    if (!el) return;
    el.focus();
    el.select();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(id);
    window.setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1500);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, idx: number) => {
    let target: number | null = null;
    if (e.key === "Enter" || e.key === "ArrowDown") target = idx + 1;
    else if (e.key === "ArrowUp") target = idx - 1;
    if (target == null) return;
    e.preventDefault();
    const line = visible[target];
    if (line) focusRow(line.inventoryItemId);
    else if (e.key === "Enter" && dirty) void save();
  };

  const scan = (code: string) => {
    const c = code.toLowerCase();
    const line = audit.lines.find((l) => l.item.barcode === code || (l.item.sku ?? "").toLowerCase() === c);
    if (!line) return toast(`“${code}” is not part of this audit`, "error");
    if (!visible.some((l) => l.inventoryItemId === line.inventoryItemId)) {
      setFilter("");
      setUncountedOnly(false);
      window.setTimeout(() => focusRow(line.inventoryItemId), 50);
    } else focusRow(line.inventoryItemId);
  };

  // Live summary from the inputs (not just saved values).
  const live = useMemo(() => {
    let counted = 0;
    let withVariance = 0;
    let varianceValue = 0;
    for (const l of audit.lines) {
      const q = parseQty(inputs[l.inventoryItemId] ?? "");
      if (q == null || q < 0) continue;
      counted++;
      const v = round3(q - l.systemQty);
      if (v !== 0) withVariance++;
      varianceValue += Math.round(v * l.item.costPerUnit);
    }
    return { counted, withVariance, varianceValue };
  }, [audit.lines, inputs]);
  const summary = editable ? live : audit.summary;

  const complete = async () => {
    const saved = await save(true);
    if (!saved) throw new Error("Could not save counts — fix the error and try again");
    let next: AuditDetail;
    try {
      next = await api.post<AuditDetail>(`/inventory/audits/${audit.id}/complete`);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    onChange(next);
    toast("Audit completed — stock adjusted", "success");
  };

  const cancelAudit = async () => {
    let next: AuditDetail;
    try {
      next = await api.post<AuditDetail>(`/inventory/audits/${audit.id}/cancel`);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    onChange(next);
    toast("Audit cancelled", "info");
  };

  let lastCategory = "";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <AuditStatusBadge status={audit.status} />
        <span className="text-sm text-muted">
          Started {formatDateTime(audit.createdAt)}
          {audit.completedAt && ` · completed ${formatDateTime(audit.completedAt)}`}
        </span>
        {audit.notes && <span className="whitespace-pre-line text-sm text-muted">· {audit.notes}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Items" value={audit.summary.items} />
        <Stat label="Counted" value={`${summary.counted} / ${audit.summary.items}`} />
        <Stat label="With variance" value={summary.withVariance} tone={summary.withVariance ? "warning" : undefined} />
        <Stat
          label="Variance value"
          value={`${summary.varianceValue > 0 ? "+" : ""}${formatINR(summary.varianceValue)}`}
          tone={summary.varianceValue < 0 ? "danger" : summary.varianceValue > 0 ? "success" : undefined}
        />
      </div>

      {editable && saveError && <Alert>{saveError}</Alert>}

      <Card>
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-t-2xl border-b border-line bg-surface p-4">
          <Input
            type="search"
            aria-label="Filter audit items"
            placeholder="Filter items"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="w-full sm:w-56"
          />
          {editable && <ScanInput onScan={scan} placeholder="Scan to jump to item" label="Scan item to count" className="w-full sm:w-56" />}
          <Toggle checked={uncountedOnly} onChange={setUncountedOnly} label="Only uncounted" />
          {editable && <Toggle checked={autosave} onChange={setAutosave} label="Autosave" />}
          {editable && (
            <div className="flex w-full flex-wrap gap-2 lg:ml-auto lg:w-auto">
              <Button variant="ghost" icon={<XCircle size={18} />} className="text-red-600 dark:text-red-400" onClick={() => setConfirm("cancel")}>
                Cancel audit
              </Button>
              <Button variant="outline" icon={<FloppyDisk size={18} />} onClick={() => void save()} loading={saving} disabled={!dirty}>
                Save counts{dirty ? ` (${changes.length})` : ""}
              </Button>
              <Button variant="secondary" icon={<CheckCircle size={18} />} onClick={() => setConfirm("complete")} disabled={live.counted === 0 || saving}>
                Complete audit
              </Button>
            </div>
          )}
        </div>
        {visible.length === 0 ? (
          <EmptyState title={uncountedOnly ? "Everything is counted" : "No items match"} />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th className="text-right">System</Th>
                <Th className="w-40 text-right">Counted</Th>
                <Th className="text-right">Variance</Th>
                <Th className="text-right">Value</Th>
              </tr>
            </THead>
            <tbody>
              {visible.map((l, idx) => {
                const header = l.item.category !== lastCategory;
                lastCategory = l.item.category;
                return (
                  <Fragment key={l.inventoryItemId}>
                    {header && (
                      <tr className="bg-surface-2/60">
                        <td colSpan={5} className="border-t border-line px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-muted">
                          {l.item.category}
                        </td>
                      </tr>
                    )}
                    <CountRow
                      line={l}
                      value={inputs[l.inventoryItemId] ?? ""}
                      editable={editable}
                      highlight={highlight === l.inventoryItemId}
                      saved={serverCount.get(l.inventoryItemId) ?? null}
                      inputRef={(el) => {
                        if (el) refs.current.set(l.inventoryItemId, el);
                        else refs.current.delete(l.inventoryItemId);
                      }}
                      onChange={(v) => setInputs((s) => ({ ...s, [l.inventoryItemId]: v }))}
                      onKeyDown={(e) => onKey(e, idx)}
                    />
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={confirm === "complete"}
        tone="primary"
        title="Complete audit?"
        description={`${live.counted} counted item(s) will be adjusted to match your counts (${live.withVariance} with variance, ${formatINR(live.varianceValue)}). Uncounted items are left unchanged. This can't be undone.`}
        confirmLabel="Complete audit"
        onConfirm={complete}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        title="Cancel this audit?"
        description="Counts are discarded and no stock is changed."
        confirmLabel="Cancel audit"
        onConfirm={cancelAudit}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function CountRow({
  line,
  value,
  saved,
  editable,
  highlight,
  inputRef,
  onChange,
  onKeyDown,
}: {
  line: AuditLine;
  value: string;
  saved: number | null;
  editable: boolean;
  highlight: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const q = editable ? parseQty(value) : line.countedQty;
  const invalid = editable && value.trim() !== "" && (q == null || q < 0);
  const variance = q == null || invalid ? null : round3(q - line.systemQty);
  const varianceValue = variance == null ? null : Math.round(variance * line.item.costPerUnit);
  const unsaved = editable && (value.trim() === "" ? null : q) !== saved && !invalid;
  const unit = UNIT_LABELS[line.item.unit];
  return (
    <tr className={clsx("transition-colors", highlight && "bg-primary-50 dark:bg-primary/15")} data-testid="audit-line">
      <Td>
        <p className="font-semibold">{line.item.name}</p>
        <p className="text-xs text-muted">{[line.item.sku, line.item.barcode].filter(Boolean).join(" · ") || unit}</p>
      </Td>
      <Td className="tabular whitespace-nowrap text-right">
        {formatQty(line.systemQty)} <span className="text-xs text-muted">{unit}</span>
      </Td>
      <Td className="text-right">
        {editable ? (
          <div className="relative">
            <input
              ref={inputRef}
              aria-label={`Counted quantity for ${line.item.name}`}
              inputMode="decimal"
              enterKeyHint="next"
              autoComplete="off"
              value={value}
              onChange={(e) => onChange(qtyChars(e.target.value))}
              onKeyDown={onKeyDown}
              onFocus={(e) => e.target.select()}
              placeholder="—"
              className={clsx(
                "tabular min-h-tap w-full rounded-xl border bg-surface px-3 pr-12 text-right text-[15px] font-semibold text-fg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
                invalid ? "border-red-500" : unsaved ? "border-amber-400 dark:border-amber-500/60" : "border-line",
              )}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{unit}</span>
          </div>
        ) : (
          <span className="tabular font-semibold">{line.countedQty == null ? <span className="text-muted">Not counted</span> : `${formatQty(line.countedQty)} ${unit}`}</span>
        )}
      </Td>
      <Td
        className={clsx(
          "tabular whitespace-nowrap text-right font-semibold",
          variance != null && variance < 0 && "text-red-600 dark:text-red-400",
          variance != null && variance > 0 && "text-secondary dark:text-green-300",
        )}
      >
        {variance == null ? "—" : `${variance > 0 ? "+" : ""}${formatQty(variance)}`}
      </Td>
      <Td className="tabular whitespace-nowrap text-right">{varianceValue == null ? "—" : `${varianceValue > 0 ? "+" : ""}${formatINR(varianceValue)}`}</Td>
    </tr>
  );
}
