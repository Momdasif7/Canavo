"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowRight, CheckCircle, HandCoins, MapPin, MapTrifold, Phone, WhatsappLogo, XCircle } from "@phosphor-icons/react";
import { formatINR, type DeliveryStatusValue } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { formatTime } from "@/lib/format";
import type { AgentLocation, Delivery, DeliveryAgent } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useNow } from "@/hooks/useNow";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { DeliveryPinMap } from "./map/DeliveryMap";
import { MarkBackButton, PartnerStatusBadge } from "./AgentsPanel";
import {
  ACCENT,
  DELIVERY_FLOW,
  EtaCountdown,
  IssueList,
  NEXT_ACTION,
  STATUS_LABEL,
  confirmForceAssign,
  mapsAddressLink,
  mapsLink,
  partnerOptionLabel,
  partnerUnavailable,
  splitNotes,
} from "./common";

/** Live delivery board: today's deliveries plus anything still active, by status column. */
export function DeliveryBoard({ agents, onAgentsChanged }: { agents: DeliveryAgent[]; onAgentsChanged: () => void }) {
  const { outlet } = useSession();
  const toast = useToast();
  const now = useNow(30_000);
  const [list, setList] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);
  /** Latest WhatsApp status link per delivery (from status/assign responses) */
  const [links, setLinks] = useState<Record<string, string>>({});
  /** Deliveries whose latest status update was already sent to the customer through the WhatsApp provider */
  const [autoSent, setAutoSent] = useState<Record<string, boolean>>({});
  const [locations, setLocations] = useState<Record<string, AgentLocation & { remainingKm?: number | null }>>({});
  /** Card whose map is open */
  const [mapFor, setMapFor] = useState<string | null>(null);
  const outletPos = outlet?.latitude != null && outlet?.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null;

  const load = useCallback(async () => {
    try {
      const [active, today] = await Promise.all([
        api.get<Delivery[]>("/delivery", { query: { active: "1" } }),
        api.get<Delivery[]>("/delivery", { query: { date: todayISO(outlet?.timezone) } }),
      ]);
      const byId = new Map<string, Delivery>();
      [...today, ...active].forEach((d) => byId.set(d.id, d));
      setList([...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [outlet?.timezone]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  // The page refreshes the partner list on the same event.
  useSocketEvent("delivery:updated", () => void load());
  useSocketEvent<AgentLocation & { agentId: string; remainingKm?: number | null }>("delivery:location", (l) => setLocations((m) => ({ ...m, [l.agentId]: l })));

  const update = (d: Delivery) => setList((l) => l?.map((x) => (x.id === d.id ? { ...x, ...d } : x)) ?? l);

  const setStatus = async (d: Delivery, status: DeliveryStatusValue, note?: string) => {
    setBusy(d.id);
    try {
      const res = await api.patch<Delivery>(`/delivery/${d.id}/status`, { status, note });
      update(res);
      if (res.customerMessage?.waLink) setLinks((m) => ({ ...m, [d.id]: res.customerMessage!.waLink }));
      const sent = !!res.customerMessage?.autoSent;
      setAutoSent((m) => ({ ...m, [d.id]: sent }));
      toast(`${res.order.invoiceNumber}: ${STATUS_LABEL[status]}${sent ? " · Customer notified on WhatsApp" : ""}`, "success");
      onAgentsChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const assign = async (d: Delivery, agentId: string, force = false) => {
    setBusy(d.id);
    try {
      const res = await api.patch<Delivery>(`/delivery/${d.id}/assign`, { agentId: agentId || null, ...(force && { force: true }) });
      update(res);
      toast(agentId ? `Assigned to ${res.agent?.name ?? "agent"}` : "Unassigned", "success");
      onAgentsChanged();
    } catch (e) {
      // Partner at the limit / on a run: managers may override, cashiers just see why.
      const blocked = partnerUnavailable(e);
      if (blocked?.canForce && !force) {
        setBusy(null);
        if (confirmForceAssign(blocked.message)) await assign(d, agentId, true);
        return;
      }
      toast(errorMessage(e), "error");
    } finally {
      setBusy((b) => (b === d.id ? null : b));
    }
  };

  const openWhatsApp = async (d: Delivery) => {
    let link = links[d.id];
    if (!link) {
      try {
        const full = await api.get<Delivery>(`/delivery/${d.id}`);
        link = full.customerMessage?.waLink ?? "";
      } catch (e) {
        toast(errorMessage(e), "error");
        return;
      }
    }
    if (link) window.open(link, "_blank", "noopener");
  };

  const columns = useMemo(() => DELIVERY_FLOW.map((s) => ({ status: s, items: (list ?? []).filter((d) => d.status === s) })), [list]);
  const cancelled = (list ?? []).filter((d) => d.status === "CANCELLED");

  if (!list) return error ? <ErrorState message={error} onRetry={load} /> : <LoadingState label="Loading deliveries…" />;

  const onDuty = agents.filter((a) => a.onDuty);

  return (
    <>
      {onDuty.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" aria-label="Partners on duty" data-testid="partner-strip">
          {onDuty.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm">
              <span className="font-semibold">{a.name}</span>
              <PartnerStatusBadge agent={a} />
              <span className="tabular text-xs text-muted">
                {a.active} of {a.max} orders
              </span>
              <MarkBackButton agent={a} onDone={onAgentsChanged} className="!min-h-[32px] !px-2 !text-xs" />
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {columns.map((col) => (
          <section key={col.status} className="flex min-h-[200px] flex-col rounded-2xl bg-surface-2" aria-label={STATUS_LABEL[col.status]}>
            <header className="flex items-center gap-2 px-3 py-2.5">
              <span className={clsx("h-3 w-3 rounded-full", ACCENT[col.status])} />
              <h2 className="text-sm font-bold">{STATUS_LABEL[col.status]}</h2>
              <span className="ml-auto rounded-full bg-surface px-2 text-xs font-bold">{col.items.length}</span>
            </header>
            <div className="flex-1 space-y-2 px-2 pb-2">
              {col.items.length === 0 && <p className="py-6 text-center text-xs text-muted">—</p>}
              {col.items.map((d) => {
                const next = NEXT_ACTION[d.status];
                const loc = d.agentId ? locations[d.agentId] ?? d.agentLocation : null;
                const { issues } = splitNotes(d.notes);
                const openIssue = issues.length > 0 && d.status !== "DELIVERED";
                return (
                  <article
                    key={d.id}
                    className={clsx("rounded-xl border bg-surface p-3 text-sm shadow-sm", openIssue ? "border-red-400 ring-2 ring-red-400/40" : "border-line")}
                    data-testid="delivery-card"
                  >
                    <div className="flex items-center gap-2">
                      <strong>{d.order.invoiceNumber}</strong>
                      <span className="text-xs text-muted">{formatTime(d.createdAt)}</span>
                      <span className="ml-auto">
                        <EtaCountdown etaAt={d.etaAt} now={now} done={d.status === "DELIVERED"} />
                      </span>
                    </div>
                    <p className="mt-1 font-semibold">{d.customerName}</p>
                    <a href={`tel:${d.customerPhone}`} className="flex items-center gap-1 text-xs text-muted hover:text-primary">
                      <Phone size={12} /> {d.customerPhone}
                    </a>
                    <a
                      href={d.latitude != null && d.longitude != null ? mapsLink(d.latitude, d.longitude) : mapsAddressLink(d.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 flex items-start gap-1 text-xs hover:text-primary"
                    >
                      <MapPin size={12} className="mt-0.5 shrink-0" />
                      <span className="line-clamp-2">
                        {d.address}
                        {d.landmark && ` (${d.landmark})`}
                        {d.distanceKm != null && ` · ${d.distanceKm} km`}
                      </span>
                    </a>
                    {d.latitude != null && d.longitude != null && (
                      <button
                        type="button"
                        onClick={() => setMapFor((id) => (id === d.id ? null : d.id))}
                        aria-expanded={mapFor === d.id}
                        className="mt-1 flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300"
                      >
                        <MapTrifold size={14} /> {mapFor === d.id ? "Hide map" : "Show on map"}
                      </button>
                    )}
                    {mapFor === d.id && d.latitude != null && d.longitude != null && (
                      <div className="mt-2">
                        <DeliveryPinMap pin={{ lat: d.latitude, lng: d.longitude }} outlet={outletPos} height={150} />
                      </div>
                    )}
                    {openIssue && <IssueList issues={issues} compact />}
                    {d.order.items && <p className="mt-1 line-clamp-2 text-xs text-muted">{d.order.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</p>}
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="tabular font-bold">{formatINR(d.order.grandTotal)}</span>
                      {(d.amountDue ?? 0) > 0 ? (
                        d.cod ? (
                          <Badge tone="warning">
                            <HandCoins size={14} weight="fill" aria-hidden />
                            <span data-testid="board-cod-badge">COD · collect {formatINR(d.amountDue ?? 0)}</span>
                          </Badge>
                        ) : (
                          <Badge tone="danger">Unpaid {formatINR(d.amountDue ?? 0)}</Badge>
                        )
                      ) : d.cod ? (
                        <Badge tone="success">COD · {d.cashSettledAt ? "cash handed over" : "collected"}</Badge>
                      ) : (
                        <Badge tone="success">Paid</Badge>
                      )}
                    </div>
                    {d.status !== "DELIVERED" && (
                      <select
                        aria-label={`Agent for ${d.order.invoiceNumber}`}
                        value={d.agentId ?? ""}
                        disabled={busy === d.id}
                        onChange={(e) => void assign(d, e.target.value)}
                        className="mt-2 min-h-[40px] w-full rounded-lg border border-line bg-surface px-2 text-sm"
                      >
                        <option value="">Unassigned</option>
                        {agents.map((a) => (
                          // Unavailable partners stay selectable: the API refuses cashiers and asks managers to confirm.
                          <option key={a.id} value={a.id} className={a.available || a.id === d.agentId ? undefined : "text-muted"}>
                            {a.id === d.agentId ? `${a.name} (${a.active}/${a.max})` : partnerOptionLabel(a)}
                          </option>
                        ))}
                      </select>
                    )}
                    {!d.agentId && d.status !== "DELIVERED" && (
                      <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300" data-testid="awaiting-partner">
                        {agents.some((a) => a.available) ? "Unassigned — pick a partner" : "Waiting — will be auto-assigned when a partner is back"}
                      </p>
                    )}
                    {d.status === "DELIVERED" && d.agent && <p className="mt-1 text-xs text-muted">by {d.agent.name}</p>}
                    {loc && d.status === "OUT_FOR_DELIVERY" && (
                      <a href={mapsLink(loc.lat, loc.lng)} target="_blank" rel="noreferrer" className="mt-1 block text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300">
                        Rider seen {formatTime(loc.at)}
                        {"remainingKm" in loc && loc.remainingKm != null ? ` · ${loc.remainingKm} km away` : ""}
                      </a>
                    )}
                    <div className="mt-2 flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="!px-2" aria-label={`WhatsApp update for ${d.order.invoiceNumber}`} title="Send status on WhatsApp" onClick={() => void openWhatsApp(d)}>
                        <WhatsappLogo size={20} className={links[d.id] ? "text-green-600" : undefined} />
                      </Button>
                      {d.status !== "DELIVERED" && (
                        <Button size="sm" variant="ghost" className="!px-2 text-red-600" aria-label={`Cancel ${d.order.invoiceNumber}`} onClick={() => setCancelling(d)}>
                          <XCircle size={20} />
                        </Button>
                      )}
                      {next && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          loading={busy === d.id}
                          disabled={next.to === "OUT_FOR_DELIVERY" && !d.agentId}
                          title={next.to === "OUT_FOR_DELIVERY" && !d.agentId ? "Assign an agent first" : undefined}
                          onClick={() => void setStatus(d, next.to)}
                        >
                          {next.label} <ArrowRight size={16} weight="bold" />
                        </Button>
                      )}
                    </div>
                    {autoSent[d.id] ? (
                      <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-300" data-testid="wa-auto-sent">
                        <CheckCircle size={14} weight="fill" className="shrink-0" /> Customer notified on WhatsApp
                      </p>
                    ) : (
                      links[d.id] && (
                        <a href={links[d.id]} target="_blank" rel="noreferrer" className="mt-1 block text-xs font-semibold text-green-700 hover:underline dark:text-green-300">
                          Notify customer on WhatsApp →
                        </a>
                      )
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {cancelled.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Cancelled today: {cancelled.map((d) => d.order.invoiceNumber).join(", ")}
        </p>
      )}
      <ConfirmDialog
        open={!!cancelling}
        title={`Cancel delivery ${cancelling?.order.invoiceNumber ?? ""}?`}
        description="The bill stays; cancel it from Bills if the order is off."
        confirmLabel="Cancel delivery"
        reason={{ label: "Reason (optional)", required: false }}
        onClose={() => setCancelling(null)}
        onConfirm={async (reason) => {
          if (cancelling) await setStatus(cancelling, "CANCELLED", reason || undefined);
        }}
      />
    </>
  );
}
