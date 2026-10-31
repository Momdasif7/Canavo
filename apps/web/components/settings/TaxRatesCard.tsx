"use client";

import { useState } from "react";
import { DotsThreeVertical, PencilSimple, Plus, Star, Trash } from "@phosphor-icons/react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { fetchTaxRates, pct, type TaxRateInUse, type TaxRateWriteResult } from "@/lib/tax";
import type { TaxRate } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { TaxRateDialog } from "./TaxRateDialog";

const UNAVAILABLE = /not available on this server/i;

/** Business tax rates: list, create/edit, default, deactivate, delete (with reassign on 409). */
export function TaxRatesCard() {
  const { can, me, outletId, outlet } = useSession();
  const toast = useToast();
  const manage = can("settings:billing");
  const rates = useApiQuery<TaxRate[]>(outletId ? `tax-rates:${me?.business?.id ?? outletId}` : null, fetchTaxRates);
  const [editing, setEditing] = useState<TaxRate | null | undefined>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ rate: TaxRate; inUse: number | null } | null>(null);
  const gstOn = outlet?.gstEnabled !== false;

  const afterSave = async (saved: TaxRateWriteResult, verb: string) => {
    toast(`${saved.name ?? "Tax rate"} ${verb}`, "success");
    for (const w of saved.warnings ?? []) toast(w, "info");
    await rates.reload();
  };

  const patch = async (r: TaxRate, body: Partial<Pick<TaxRate, "isDefault" | "active">>, verb: string) => {
    setMenuFor(null);
    try {
      const saved = await api.patch<TaxRateWriteResult>(`/tax-rates/${r.id}`, body);
      await afterSave({ ...r, ...saved }, verb);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const unavailable = rates.error && UNAVAILABLE.test(rates.error);

  return (
    <Card>
      <CardHeader
        title="Tax rates"
        subtitle="Assign a rate to each menu item. Items without one use the business default."
        action={
          manage &&
          !unavailable && (
            <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)}>
              New rate
            </Button>
          )
        }
      />
      {!gstOn && (
        <div className="px-5 pt-4">
          <Alert tone="info">GST is switched off for this outlet, so these rates are not charged on its bills. They still apply to outlets that are GST registered.</Alert>
        </div>
      )}
      {rates.loading && !rates.data ? (
        <LoadingState />
      ) : unavailable ? (
        <div className="p-5">
          <Alert tone="info">Custom tax rates are being rolled out to your server. Until then, items use the standard GST slab set on each item.</Alert>
        </div>
      ) : rates.error ? (
        <ErrorState message={rates.error} onRetry={rates.reload} />
      ) : !rates.data?.length ? (
        <EmptyState title="No tax rates yet" description="Create GST 5%, 12%, 18%… or a custom rate with cess." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th className="text-right">CGST</Th>
              <Th className="text-right">SGST</Th>
              <Th className="text-right">IGST</Th>
              <Th className="text-right">Cess</Th>
              <Th>Extra taxes</Th>
              <Th className="text-right">Items</Th>
              {manage && <Th />}
            </tr>
          </THead>
          <tbody>
            {rates.data.map((r) => (
              <tr key={r.id} className={r.active ? undefined : "opacity-60"}>
                <Td>
                  <span className="font-semibold">{r.name}</span>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {r.isDefault && (
                      <Badge tone="primary">
                        <Star size={12} weight="fill" /> Default
                      </Badge>
                    )}
                    {!r.active && <Badge>Inactive</Badge>}
                  </span>
                </Td>
                <Td className="tabular text-right">{pct(r.cgst)}%</Td>
                <Td className="tabular text-right">{pct(r.sgst)}%</Td>
                <Td className="tabular text-right">{pct(r.igst)}%</Td>
                <Td className="tabular text-right">{r.cess ? `${pct(r.cess)}%` : "—"}</Td>
                <Td className="text-muted">{r.extras?.length ? r.extras.map((x) => `${x.label} ${pct(x.percent)}%`).join(", ") : "—"}</Td>
                <Td className="tabular text-right">{r.itemCount}</Td>
                {manage && (
                  <Td className="relative whitespace-nowrap text-right">
                    <IconButton label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                      <PencilSimple size={20} />
                    </IconButton>
                    <IconButton label={`More actions for ${r.name}`} onClick={() => setMenuFor((m) => (m === r.id ? null : r.id))} aria-expanded={menuFor === r.id}>
                      <DotsThreeVertical size={20} weight="bold" />
                    </IconButton>
                    {menuFor === r.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} aria-hidden />
                        <div role="menu" className="absolute right-4 top-12 z-20 w-52 overflow-hidden rounded-xl border border-line bg-surface text-left shadow-lg">
                          {!r.isDefault && (
                            <MenuButton onClick={() => void patch(r, { isDefault: true, active: true }, "is now the default")}>Set as default</MenuButton>
                          )}
                          {!r.isDefault && (
                            <MenuButton onClick={() => void patch(r, { active: !r.active }, r.active ? "deactivated" : "activated")}>
                              {r.active ? "Deactivate" : "Activate"}
                            </MenuButton>
                          )}
                          <MenuButton
                            danger
                            disabled={r.isDefault}
                            onClick={() => {
                              setMenuFor(null);
                              setDeleting({ rate: r, inUse: null });
                            }}
                          >
                            <Trash size={16} /> {r.isDefault ? "Default can't be deleted" : "Delete"}
                          </MenuButton>
                        </div>
                      </>
                    )}
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <TaxRateDialog rate={editing} onClose={() => setEditing(null)} onSaved={(s) => void afterSave(s, editing ? "saved" : "created")} />
      <DeleteRateDialog
        state={deleting}
        rates={rates.data ?? []}
        onClose={() => setDeleting(null)}
        onInUse={(n) => setDeleting((d) => (d ? { ...d, inUse: n } : d))}
        onDeleted={async (name) => {
          toast(`${name} deleted`, "success");
          setDeleting(null);
          await rates.reload();
        }}
      />
    </Card>
  );
}

function MenuButton({ children, onClick, danger, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-[44px] w-full items-center gap-2 px-4 text-sm font-semibold hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${danger ? "text-red-600" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * Delete flow: confirm → DELETE. When items still use the rate the API answers
 * 409 { details: { itemCount } }; we then offer to move them to another rate.
 */
function DeleteRateDialog({
  state,
  rates,
  onClose,
  onInUse,
  onDeleted,
}: {
  state: { rate: TaxRate; inUse: number | null } | null;
  rates: TaxRate[];
  onClose: () => void;
  onInUse: (itemCount: number) => void;
  onDeleted: (name: string) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rate = state?.rate;
  const others = rates.filter((r) => r.id !== rate?.id && r.active);
  const needsTarget = state?.inUse != null;

  const run = async () => {
    if (!rate) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/tax-rates/${rate.id}`, { query: { reassignTo: needsTarget ? target || undefined : undefined } });
      setTarget("");
      await onDeleted(rate.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const n = (e.details as TaxRateInUse | undefined)?.itemCount ?? rate.itemCount;
        onInUse(n);
        setTarget(others.find((r) => r.isDefault)?.id ?? others[0]?.id ?? "");
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!state}
      onClose={() => {
        setError(null);
        setTarget("");
        onClose();
      }}
      size="sm"
      title={rate ? `Delete ${rate.name}?` : ""}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button variant="danger" loading={busy} disabled={needsTarget && !target} onClick={run}>
            {needsTarget ? "Move items & delete" : "Delete"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <Alert>{error}</Alert>}
        {needsTarget ? (
          <>
            <Alert tone="warning">
              {state!.inUse} menu item{state!.inUse === 1 ? " uses" : "s use"} this rate. Choose a rate to move {state!.inUse === 1 ? "it" : "them"} to.
            </Alert>
            {others.length ? (
              <Select label="Move items to" value={target} onChange={(e) => setTarget(e.target.value)}>
                {others.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-muted">Create another active rate first.</p>
            )}
          </>
        ) : (
          <p className="text-muted">This can&apos;t be undone. Past bills keep the tax they were charged.</p>
        )}
      </div>
    </Dialog>
  );
}
