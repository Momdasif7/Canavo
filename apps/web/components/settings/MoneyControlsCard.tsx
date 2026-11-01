"use client";

import { useEffect, useState } from "react";
import { FloppyDisk } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/** Settings → owner's money controls for this outlet (Phase 3): manager-approval limit. */
export function MoneyControlsCard() {
  const toast = useToast();
  const { me, outlet, reloadOutlet, can } = useSession();
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvals = Boolean(me?.features?.APPROVAL_PINS);

  useEffect(() => {
    if (outlet) setLimit(String(outlet.approvalDiscountPercent ?? 10));
  }, [outlet]);

  if (!can("outlet:manage") || !outlet) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch("/outlets/current", { approvalDiscountPercent: Number(limit) });
      await reloadOutlet();
      toast("Saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Money controls" subtitle="Who must approve discounts, voids and refunds at this outlet." />
      <div className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        {!approvals && (
          <Alert tone="info">Manager approval PINs are off for your hotel. Ask CANAVO support to turn them on; then voids, refunds and big discounts need a manager&apos;s PIN.</Alert>
        )}
        <Input
          label="Discounts above this need a manager's PIN (%)"
          type="number"
          min={0}
          max={100}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          hint="Manual discount as a share of the bill. Voids and refunds always need approval when approval PINs are on."
          wrapperClassName="max-w-xs"
        />
        <Button icon={<FloppyDisk size={20} />} loading={saving} disabled={limit === "" || Number(limit) < 0 || Number(limit) > 100} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Card>
  );
}
