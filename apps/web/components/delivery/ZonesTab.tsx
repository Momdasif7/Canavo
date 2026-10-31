"use client";

import { useEffect, useState } from "react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { deliveryZoneSchema, formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { DeliveryZone } from "@/lib/types-service";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Toggle } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

export function ZonesTab() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const zones = useApiQuery<DeliveryZone[]>(outletId ? `zones:${outletId}` : null, () => api.get<DeliveryZone[]>("/delivery/zones"));
  const [editing, setEditing] = useState<DeliveryZone | null | undefined>(null);
  const [deleting, setDeleting] = useState<DeliveryZone | null>(null);
  const canEdit = can("settings:outlet");

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-bold">Delivery zones</h2>
          <p className="text-sm text-muted">Distance from the outlet picks the smallest zone that covers the address.</p>
        </div>
        {canEdit && (
          <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)}>
            Add zone
          </Button>
        )}
      </div>
      {zones.loading && !zones.data ? (
        <LoadingState />
      ) : zones.error ? (
        <ErrorState message={zones.error} onRetry={zones.reload} />
      ) : !zones.data?.length ? (
        <EmptyState title="No delivery zones" description="Without zones, delivery orders have no fee or distance limit." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Zone</Th>
              <Th className="text-right">Radius</Th>
              <Th className="text-right">Fee</Th>
              <Th className="text-right">Min order</Th>
              <Th className="text-right">ETA</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {zones.data.map((z) => (
              <Tr key={z.id}>
                <Td className="font-semibold">{z.name}</Td>
                <Td className="tabular text-right">{z.radiusKm} km</Td>
                <Td className="tabular text-right">{formatINR(z.fee)}</Td>
                <Td className="tabular text-right">{z.minOrder ? formatINR(z.minOrder) : "—"}</Td>
                <Td className="tabular text-right">{z.etaMinutes} min</Td>
                <Td>{z.active ? <Badge tone="success">Active</Badge> : <Badge>Off</Badge>}</Td>
                <Td className="whitespace-nowrap text-right">
                  {canEdit && (
                    <>
                      <IconButton label={`Edit ${z.name}`} onClick={() => setEditing(z)}>
                        <PencilSimple size={20} />
                      </IconButton>
                      <IconButton label={`Delete ${z.name}`} className="text-red-600" onClick={() => setDeleting(z)}>
                        <Trash size={20} />
                      </IconButton>
                    </>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <ZoneDialog
        zone={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void zones.reload();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete zone ${deleting?.name ?? ""}?`}
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.del(`/delivery/zones/${deleting.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast("Zone deleted", "success");
          void zones.reload();
        }}
      />
    </Card>
  );
}

function ZoneDialog({ zone, onClose, onSaved }: { zone: DeliveryZone | null | undefined; onClose: () => void; onSaved: () => void }) {
  const open = zone !== null;
  const [name, setName] = useState("");
  const [radius, setRadius] = useState("");
  const [fee, setFee] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [eta, setEta] = useState("30");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(zone?.name ?? "");
    setRadius(zone ? String(zone.radiusKm) : "");
    setFee(zone ? rupeesInput(zone.fee) : "");
    setMinOrder(zone?.minOrder ? rupeesInput(zone.minOrder) : "");
    setEta(String(zone?.etaMinutes ?? 30));
    setActive(zone?.active ?? true);
    setError(null);
  }, [open, zone]);

  const submit = async () => {
    const body = { name: name.trim(), radiusKm: Number(radius), fee: parseRupees(fee) ?? 0, minOrder: parseRupees(minOrder) ?? 0, etaMinutes: Math.floor(Number(eta)), active };
    const parsed = deliveryZoneSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setError(`${i.path.join(".") || "Zone"}: ${i.message}`);
    }
    setBusy(true);
    setError(null);
    try {
      if (zone) await api.patch(`/delivery/zones/${zone.id}`, body);
      else await api.post("/delivery/zones", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={zone ? `Edit ${zone.name}` : "New delivery zone"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Save zone
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" placeholder="Nearby (0–3 km)" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Radius (km)" inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value.replace(/[^\d.]/g, ""))} />
          <Input label="ETA (minutes)" inputMode="numeric" value={eta} onChange={(e) => setEta(e.target.value.replace(/\D/g, ""))} />
          <Input label="Delivery fee" prefix="₹" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))} />
          <Input label="Minimum order" prefix="₹" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
        <Toggle checked={active} onChange={setActive} label="Active" />
      </div>
    </Dialog>
  );
}
