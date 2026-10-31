"use client";

import { Fragment, useMemo, useState } from "react";
import clsx from "clsx";
import { CaretDown, CaretLeft, CaretRight, CaretUp, FunnelSimple, X } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Staff } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { roleLabel } from "@/components/reports/shared";
import type { AuditLogPage } from "@/components/admin/types";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

interface Filters {
  entity: string;
  action: string;
  userId: string;
  outletId: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { entity: "", action: "", userId: "", outletId: "", from: "", to: "" };
const PAGE_SIZE = 50;
const KNOWN_ENTITIES = [
  "Order", "Payment", "MenuItem", "MenuCategory", "User", "Customer", "Offer", "Coupon", "Reservation", "Delivery",
  "InventoryItem", "Purchase", "Vendor", "Setting", "Backup", "ReportSchedule", "Export", "Outlet", "Shift", "LeaveRequest",
];

/** Action tone by verb, so destructive events stand out. */
function actionTone(action: string): "danger" | "warning" | "success" | "info" | "neutral" {
  if (/(delete|cancel|void|restore|reveal|reject)/.test(action)) return "danger";
  if (/(update|adjust|refund|export|download|override)/.test(action)) return "warning";
  if (/(create|add|approve|login)/.test(action)) return "success";
  if (/(view|send)/.test(action)) return "info";
  return "neutral";
}

export default function AuditLogPage() {
  const { me, can } = useSession();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const staff = useApiQuery<Staff[]>(can("staff:view") ? "audit-staff" : null, () => api.get<Staff[]>("/staff"));
  const query = useMemo(
    () => ({
      entity: applied.entity.trim() || undefined,
      // Prefix match unless the user typed an exact action with a trailing *.
      action: applied.action.trim() ? (applied.action.trim().endsWith("*") ? applied.action.trim() : `${applied.action.trim()}*`) : undefined,
      userId: applied.userId || undefined,
      outletId: applied.outletId || undefined,
      from: applied.from || undefined,
      to: applied.to || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [applied, page],
  );
  const logs = useApiQuery<AuditLogPage>(`audit:${JSON.stringify(query)}`, () => api.get<AuditLogPage>("/admin/audit-logs", { query, outletId: null }));

  // The platform admin's log holds platform actions only (no hotel outlets).
  const platformAdmin = Boolean(me?.platformAdmin);
  const outletName = (id: string | null) => (id ? me?.outlets.find((o) => o.id === id)?.name ?? id.slice(-6) : "—");
  const activeCount = Object.values(applied).filter(Boolean).length;
  const dateError = draft.from && draft.to && draft.from > draft.to ? "Start must be before end" : null;

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (dateError) return;
    setApplied(draft);
    setPage(1);
  };
  const reset = () => {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={
          platformAdmin
            ? "Platform actions: businesses, modules, owner accounts, backups and platform settings. Hotels' own activity stays private to each hotel."
            : "Who changed what, when and from where. Sensitive actions (reveals, restores, exports) are always recorded."
        }
      />
      <Card className="mb-5 p-4">
        <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Input label="Entity" list="audit-entities" placeholder="e.g. Order" value={draft.entity} onChange={(e) => setDraft({ ...draft, entity: e.target.value })} />
          <datalist id="audit-entities">
            {KNOWN_ENTITIES.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
          <Input label="Action starts with" placeholder="e.g. order.cancel" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
          <Select label="User" value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })}>
            <option value="">Anyone</option>
            {me && <option value={me.id}>{me.name} (you)</option>}
            {staff.data
              ?.filter((s) => s.id !== me?.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {roleLabel(s.role)}
                </option>
              ))}
          </Select>
          {!platformAdmin && (
            <Select label="Outlet" value={draft.outletId} onChange={(e) => setDraft({ ...draft, outletId: e.target.value })}>
              <option value="">All my outlets</option>
              {me?.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
          <Input label="From" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} error={dateError} />
          <Input label="To" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-6">
            <Button type="submit" size="sm" icon={<FunnelSimple size={18} />} disabled={!!dateError}>
              Apply filters
            </Button>
            {activeCount > 0 && (
              <Button variant="ghost" size="sm" icon={<X size={18} />} onClick={reset}>
                Clear ({activeCount})
              </Button>
            )}
            {logs.data && <span className="ml-auto text-sm text-muted">{logs.data.total.toLocaleString("en-IN")} events</span>}
          </div>
        </form>
      </Card>

      <Card>
        {logs.loading && !logs.data ? (
          <LoadingState />
        ) : logs.error && !logs.data ? (
          <ErrorState message={logs.error} onRetry={logs.reload} />
        ) : !logs.data || logs.data.items.length === 0 ? (
          <EmptyState title="No events match these filters" />
        ) : (
          <div className={clsx(logs.loading && "opacity-60")}>
            <Table>
              <THead>
                <tr>
                  <Th>When</Th>
                  <Th>User</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  {!platformAdmin && <Th className="hidden lg:table-cell">Outlet</Th>}
                  <Th className="hidden xl:table-cell">IP</Th>
                  <Th className="w-12">
                    <span className="sr-only">Details</span>
                  </Th>
                </tr>
              </THead>
              <tbody>
                {logs.data.items.map((l) => {
                  const expanded = open === l.id;
                  const hasMeta = l.meta !== null && l.meta !== undefined;
                  return (
                    <Fragment key={l.id}>
                      <tr className={clsx(hasMeta && "cursor-pointer hover:bg-surface-2")} onClick={() => hasMeta && setOpen(expanded ? null : l.id)}>
                        <Td className="whitespace-nowrap text-muted">{formatDateTime(l.createdAt)}</Td>
                        <Td>
                          {l.user ? (
                            <>
                              <p className="font-semibold">{l.user.name}</p>
                              <p className="text-xs text-muted">{roleLabel(l.user.role)}</p>
                            </>
                          ) : (
                            <Badge>System</Badge>
                          )}
                        </Td>
                        <Td>
                          <Badge tone={actionTone(l.action)} className="font-mono">
                            {l.action}
                          </Badge>
                        </Td>
                        <Td>
                          <p className="font-semibold">{l.entity}</p>
                          {l.entityId && <p className="max-w-[220px] truncate font-mono text-xs text-muted" title={l.entityId}>{l.entityId}</p>}
                        </Td>
                        {!platformAdmin && <Td className="hidden lg:table-cell">{outletName(l.outletId)}</Td>}
                        <Td className="hidden font-mono text-xs text-muted xl:table-cell">{l.ip ?? "—"}</Td>
                        <Td>
                          {hasMeta && (
                            <IconButton
                              label={expanded ? "Hide details" : "Show details"}
                              aria-expanded={expanded}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpen(expanded ? null : l.id);
                              }}
                              className="min-h-[36px] min-w-[36px]"
                            >
                              {expanded ? <CaretUp size={18} /> : <CaretDown size={18} />}
                            </IconButton>
                          )}
                        </Td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={platformAdmin ? 6 : 7} className="border-t border-line bg-surface-2/60 px-4 py-3">
                            <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-xs">
                              {JSON.stringify(l.meta, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <span className="text-sm text-muted">
                Page {logs.data.page} of {Math.max(1, logs.data.pages)}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" icon={<CaretLeft size={18} />} disabled={page <= 1 || logs.loading} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <Button variant="outline" size="sm" disabled={page >= logs.data.pages || logs.loading} onClick={() => setPage((p) => p + 1)}>
                  Older <CaretRight size={18} />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
