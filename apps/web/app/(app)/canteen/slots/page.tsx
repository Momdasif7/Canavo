"use client";

import { useMemo, useState } from "react";
import { ForkKnife, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { Menu } from "@/lib/types";
import type { MealSlot, SlotsResponse } from "@/lib/types-meals";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Toggle } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Td, Th, Tr } from "@/components/ui/Table";

type Draft = { id?: string; name: string; startTime: string; endTime: string; preorderCutoff: string; active: boolean; sortOrder: string };
const blank: Draft = { name: "", startTime: "12:00", endTime: "14:30", preorderCutoff: "21:00", active: true, sortOrder: "0" };

/** Canteen → Meal slots: breakfast / lunch / dinner times, pre-order cutoffs, and each slot's menu and prices. */
export default function MealSlotsPage() {
  const toast = useToast();
  const q = useApiQuery("canteen-slots", () => api.get<SlotsResponse>("/canteen/slots"));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menuFor, setMenuFor] = useState<MealSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = { name: draft.name.trim(), startTime: draft.startTime, endTime: draft.endTime, preorderCutoff: draft.preorderCutoff || null, active: draft.active, sortOrder: Number(draft.sortOrder) || 0 };
    try {
      const r = draft.id ? await api.patch<{ warnings: string[] }>(`/canteen/slots/${draft.id}`, body) : await api.post<{ warnings: string[] }>("/canteen/slots", body);
      toast(draft.id ? "Slot saved" : "Slot added", "success");
      if (r.warnings.length) toast(r.warnings[0]!, "info");
      setDraft(null);
      void q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: MealSlot) => {
    try {
      const r = await api.del<{ deleted: boolean }>(`/canteen/slots/${s.id}`);
      toast(r.deleted ? "Slot deleted" : "Slot has bills, so it was switched off instead", "success");
      void q.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!q.data) return <LoadingState />;
  const { slots, currentSlotId, warnings } = q.data;

  return (
    <PageContainer>
      <PageHeader
        title="Meal slots"
        subtitle="Times are in outlet time. Items you put on a slot sell only during that slot (at the slot price, if you set one). Items on no slot sell all day."
        actions={
          <Button icon={<Plus size={20} />} onClick={() => setDraft({ ...blank })}>
            Add slot
          </Button>
        }
      />
      {warnings.map((w) => (
        <div key={w} className="mb-3">
          <Alert tone="warning">{w}</Alert>
        </div>
      ))}
      <Card>
        {slots.length === 0 ? (
          <EmptyState title="No meal slots yet" description="Add Breakfast, Lunch, Dinner… with their times. Until then the menu works as usual." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Slot</Th>
                <Th>Time</Th>
                <Th>Pre-orders close</Th>
                <Th>Menu</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {slots.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <span className="font-semibold">{s.name}</span> {s.id === currentSlotId && <Badge tone="success">Open now</Badge>} {!s.active && <Badge>Off</Badge>}
                  </Td>
                  <Td className="tabular">
                    {s.startTime}–{s.endTime}
                  </Td>
                  <Td>{s.preorderCutoff ? `${s.preorderCutoff} the day before` : "No pre-orders"}</Td>
                  <Td>{s.itemCount ? `${s.itemCount} item${s.itemCount === 1 ? "" : "s"}` : "No items yet"}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="outline" icon={<ForkKnife size={16} />} onClick={() => setMenuFor(s)}>
                      Menu & prices
                    </Button>{" "}
                    <Button size="sm" variant="ghost" onClick={() => setDraft({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, preorderCutoff: s.preorderCutoff ?? "", active: s.active, sortOrder: String(s.sortOrder) })}>
                      Edit
                    </Button>{" "}
                    <Button size="sm" variant="ghost" onClick={() => void remove(s)}>
                      Delete
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit slot" : "Add slot"}
        footer={
          <Button loading={busy} disabled={!draft?.name.trim()} onClick={() => void save()}>
            Save
          </Button>
        }
      >
        {draft && (
          <div className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <Input label="Name" maxLength={40} placeholder="Lunch" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Starts" type="time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
              <Input label="Ends" type="time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
            </div>
            <Input
              label="Pre-orders close (the day before)"
              type="time"
              value={draft.preorderCutoff}
              hint="Leave empty if this slot doesn't take pre-orders. Meal plans are sent to the kitchen at this time."
              onChange={(e) => setDraft({ ...draft, preorderCutoff: e.target.value })}
            />
            <Input label="Order in the list" type="number" min={0} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} />
            <Toggle checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label="Active" />
          </div>
        )}
      </Dialog>

      {menuFor && <SlotMenuDialog slot={menuFor} onClose={() => setMenuFor(null)} onSaved={() => void q.reload()} />}
    </PageContainer>
  );
}

/** Pick the slot's items and optional slot prices. */
function SlotMenuDialog({ slot, onClose, onSaved }: { slot: MealSlot; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const menu = useApiQuery("menu-all", () => api.get<Menu>("/menu"));
  const current = useApiQuery(`slot-items-${slot.id}`, () => api.get<{ menuItemId: string; price: number | null }[]>(`/canteen/slots/${slot.id}/items`));
  const [picked, setPicked] = useState<Record<string, string> | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  // Item id → slot price text ("" = normal price); seeded from the saved menu once loaded.
  const chosen = useMemo(() => picked ?? Object.fromEntries((current.data ?? []).map((r) => [r.menuItemId, r.price != null ? rupeesInput(r.price) : ""])), [picked, current.data]);
  const items = (menu.data?.items ?? []).filter((i) => i.status !== "HIDDEN" && i.name.toLowerCase().includes(search.trim().toLowerCase()));

  const toggle = (id: string) => {
    const next = { ...chosen };
    if (id in next) delete next[id];
    else next[id] = "";
    setPicked(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/canteen/slots/${slot.id}/items`, { items: Object.entries(chosen).map(([menuItemId, p]) => ({ menuItemId, price: parseRupees(p) })) });
      toast(`${slot.name} menu saved`, "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`${slot.name} menu`}
      description="Tick what sells in this slot. Leave the price empty to use the normal price."
      footer={
        <Button loading={busy} disabled={!menu.data || !current.data} onClick={() => void save()}>
          Save menu ({Object.keys(chosen).length})
        </Button>
      }
    >
      {!menu.data || !current.data ? (
        <LoadingState />
      ) : (
        <div className="space-y-3">
          <Input placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                <input type="checkbox" className="h-5 w-5" checked={i.id in chosen} onChange={() => toggle(i.id)} aria-label={i.name} />
                <span className="flex-1">
                  {i.name} <span className="text-xs text-muted">{formatINR(i.price)}</span>
                </span>
                {i.id in chosen && (
                  <Input
                    aria-label={`${i.name} slot price`}
                    wrapperClassName="w-32"
                    type="number"
                    min={0}
                    placeholder="Slot price ₹"
                    value={chosen[i.id]}
                    onChange={(e) => setPicked({ ...chosen, [i.id]: e.target.value })}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
