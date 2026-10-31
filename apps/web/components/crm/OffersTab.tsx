"use client";

import { useMemo, useState } from "react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { OFFER_TYPES, type OfferTypeName } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { Menu } from "@/lib/types";
import type { Offer } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { OFFER_TYPE_LABELS, OfferForm } from "./OfferForm";
import { WEEKDAYS, formatDate } from "./shared";

const typeTone: Record<OfferTypeName, "primary" | "success" | "info" | "warning" | "neutral"> = {
  HAPPY_HOUR: "warning",
  ITEM_DISCOUNT: "primary",
  BUY_X_GET_Y: "success",
  COMBO: "info",
  BILL_DISCOUNT: "neutral",
};

function scheduleSummary(o: Offer): string[] {
  const parts: string[] = [];
  if (o.startsAt || o.endsAt) {
    parts.push(o.startsAt && o.endsAt ? `${formatDate(o.startsAt)} – ${formatDate(o.endsAt)}` : o.startsAt ? `From ${formatDate(o.startsAt)}` : `Until ${formatDate(o.endsAt)}`);
  }
  if (o.daysOfWeek.length && o.daysOfWeek.length < 7) {
    const sorted = [...o.daysOfWeek].sort();
    const weekdays = sorted.join() === "1,2,3,4,5";
    const weekend = sorted.join() === "0,6";
    parts.push(weekdays ? "Weekdays" : weekend ? "Weekends" : sorted.map((d) => WEEKDAYS[d]).join(", "));
  }
  if (o.startTime && o.endTime) parts.push(`${o.startTime}–${o.endTime}`);
  return parts.length ? parts : ["Always"];
}

function isExpired(o: Offer) {
  return !!o.endsAt && new Date(o.endsAt).getTime() < Date.now();
}

export function OffersTab() {
  const { outletId, me } = useSession();
  const toast = useToast();
  const [type, setType] = useState<OfferTypeName | "">("");
  const [active, setActive] = useState<"" | "1" | "0">("");
  const [editing, setEditing] = useState<Offer | null | undefined>(null);
  const [deleting, setDeleting] = useState<Offer | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const offers = useApiQuery<Offer[]>(outletId ? `offers:${outletId}:${type}:${active}` : null, () => api.get<Offer[]>("/offers", { query: { type, active } }));
  // Menu is needed only for the editor's pickers; load it once.
  const menu = useApiQuery<Menu>(outletId ? `offer-menu:${outletId}` : null, () => api.get<Menu>("/menu"));
  useSocketEvent("offers:changed", () => void offers.reload());

  const outletName = useMemo(() => new Map((me?.outlets ?? []).map((o) => [o.id, o.name])), [me]);

  const toggle = async (o: Offer) => {
    setToggling(o.id);
    try {
      const updated = await api.post<Offer>(`/offers/${o.id}/toggle`, { active: !o.active });
      offers.setData((l) => l?.map((x) => (x.id === o.id ? { ...x, active: updated.active } : x)));
      toast(`${o.name} ${updated.active ? "activated" : "paused"}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setToggling(null);
    }
  };

  const list = offers.data ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <Select aria-label="Offer type" value={type} onChange={(e) => setType(e.target.value as OfferTypeName | "")} className="w-48">
          <option value="">All types</option>
          {OFFER_TYPES.map((t) => (
            <option key={t} value={t}>
              {OFFER_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Offer status" value={active} onChange={(e) => setActive(e.target.value as typeof active)} className="w-40">
          <option value="">Any status</option>
          <option value="1">Active</option>
          <option value="0">Paused</option>
        </Select>
        <div className="flex-1" />
        <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)}>
          New offer
        </Button>
      </div>

      {offers.loading && !offers.data ? (
        <LoadingState />
      ) : offers.error ? (
        <ErrorState message={offers.error} onRetry={offers.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          title={type || active ? "No offers match" : "No offers yet"}
          description="Offers apply automatically at the POS when their rules and schedule match."
          action={<Button onClick={() => setEditing(undefined)}>Create an offer</Button>}
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Offer</Th>
              <Th>Type</Th>
              <Th>Schedule</Th>
              <Th>Outlets</Th>
              <Th className="text-right">Priority</Th>
              <Th>Active</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {list.map((o) => (
              <Tr key={o.id} className={!o.active || isExpired(o) ? "opacity-70" : undefined}>
                <Td className="max-w-sm">
                  <p className="font-semibold">{o.name}</p>
                  {o.summary && <p className="text-xs text-muted">{o.summary}</p>}
                </Td>
                <Td>
                  <Badge tone={typeTone[o.type]}>{OFFER_TYPE_LABELS[o.type]}</Badge>
                </Td>
                <Td className="text-sm">
                  {scheduleSummary(o).map((s) => (
                    <p key={s} className="whitespace-nowrap">
                      {s}
                    </p>
                  ))}
                  {isExpired(o) && <Badge tone="danger">Expired</Badge>}
                </Td>
                <Td className="text-sm text-muted">{o.outletIds.length ? o.outletIds.map((id) => outletName.get(id) ?? "Other outlet").join(", ") : "All outlets"}</Td>
                <Td className="tabular text-right">{o.priority}</Td>
                <Td>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={o.active}
                    aria-label={`${o.active ? "Pause" : "Activate"} ${o.name}`}
                    disabled={toggling === o.id}
                    onClick={() => toggle(o)}
                    className="inline-flex min-h-tap items-center px-1 disabled:opacity-50"
                  >
                    <span className={`relative inline-block h-7 w-12 shrink-0 rounded-full transition-colors ${o.active ? "bg-secondary" : "bg-line"}`}>
                      <span className={`pointer-events-none absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${o.active ? "translate-x-5" : "translate-x-0"}`} />
                    </span>
                  </button>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <IconButton label={`Edit ${o.name}`} onClick={() => setEditing(o)}>
                    <PencilSimple size={20} />
                  </IconButton>
                  <IconButton label={`Delete ${o.name}`} onClick={() => setDeleting(o)} className="text-red-600 dark:text-red-400">
                    <Trash size={20} />
                  </IconButton>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <OfferForm offer={editing} menu={menu.data} onClose={() => setEditing(null)} onSaved={offers.reload} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="The offer stops applying immediately. Past bills keep their discounts. To stop it temporarily, pause it instead."
        confirmLabel="Delete offer"
        onConfirm={async () => {
          if (!deleting) return;
          await api.del(`/offers/${deleting.id}`);
          offers.setData((l) => l?.filter((x) => x.id !== deleting.id));
          toast("Offer deleted", "success");
        }}
      />
    </Card>
  );
}
