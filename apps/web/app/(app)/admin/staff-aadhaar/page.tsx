"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Eye, EyeSlash, IdentificationCard, LockKey, MagnifyingGlass, ShieldCheck, Trash } from "@phosphor-icons/react";
import { aadhaarConsentText, aadhaarSchema } from "@canavo/shared";
import { ApiError, api, errorMessage } from "@/lib/api";
import { canManageRole, isBusinessWideRole } from "@/lib/roles";
import type { Staff } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { groupAadhaar, verhoeffValid } from "@/components/admin/aadhaar";
import type { AadhaarResponse, AadhaarSettings } from "@/components/admin/types";
import { roleLabel } from "@/components/reports/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Seconds a revealed number stays on screen before it's masked again. */
const REVEAL_SECONDS = 30;

export default function StaffAadhaarPage() {
  const { outletId, me } = useSession();
  // Owners see everyone in the business; managers the staff of their outlets below them (and themselves).
  const owner = !!me && isBusinessWideRole(me.role);
  const staff = useApiQuery<Staff[]>(outletId ? `aadhaar-staff:${outletId}:${owner ? "business" : "outlet"}` : null, () =>
    api.get<Staff[]>("/staff", { query: { scope: owner ? "business" : undefined } }),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = (staff.data ?? []).filter((m) => m.role !== "SUPER_ADMIN" && (owner || m.id === me?.id || (!!me && canManageRole(me.role, m.role))));
    return s ? all.filter((m) => m.name.toLowerCase().includes(s) || m.phone.includes(s)) : all;
  }, [staff.data, q, owner, me]);
  const member = staff.data?.find((m) => m.id === selected) ?? null;
  const settings = useApiQuery<AadhaarSettings>(outletId ? "aadhaar-settings" : null, () => api.get<AadhaarSettings>("/admin/aadhaar-settings"));

  return (
    <>
      <PageHeader
        title="Staff Aadhaar"
        subtitle={
          settings.data?.mode === "FULL"
            ? `Your hotel keeps full Aadhaar numbers, encrypted (AES-256-GCM), with each person's consent. A revealed number hides again after ${REVEAL_SECONDS} seconds. Every view and reveal is audited.`
            : "Your hotel keeps only the last 4 digits of each Aadhaar, with each person's consent. The full number is checked and never stored."
        }
      />
      {settings.data && <AadhaarSettingsCard settings={settings.data} onChanged={settings.reload} owner={owner} />}
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card className="self-start">
          <CardHeader title="Staff" />
          <div className="p-3">
            <Input aria-label="Search staff" placeholder="Search name or phone" prefix={<MagnifyingGlass size={18} />} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {staff.loading && !staff.data ? (
            <LoadingState />
          ) : staff.error ? (
            <ErrorState message={staff.error} onRetry={staff.reload} />
          ) : list.length === 0 ? (
            <EmptyState title="No staff found" />
          ) : (
            <ul className="max-h-[520px] overflow-y-auto border-t border-line">
              {list.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(m.id)}
                    aria-pressed={selected === m.id}
                    className={clsx(
                      "flex min-h-[56px] w-full items-center justify-between gap-3 border-b border-line px-4 text-left last:border-0",
                      selected === m.id ? "bg-primary-50 dark:bg-primary/10" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{m.name}</span>
                      <span className="block text-xs text-muted">
                        {roleLabel(m.role)} · {m.phone}
                      </span>
                    </span>
                    {m.status !== "ACTIVE" && <Badge>{m.status.toLowerCase()}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {member ? <AadhaarPanel key={member.id} member={member} mode={settings.data?.mode ?? "LAST4"} hotelName={me?.business?.name ?? "the hotel"} /> : (
          <Card className="self-start">
            <EmptyState title="Select a staff member" description="Pick someone from the list to view or update their Aadhaar." />
          </Card>
        )}
      </div>
    </>
  );
}

function AadhaarPanel({ member, mode, hotelName }: { member: Staff; mode: "LAST4" | "FULL"; hotelName: string }) {
  const toast = useToast();
  const { can } = useSession();
  const canSet = can("staff:manage");
  const [current, setCurrent] = useState<AadhaarResponse | null>(null);
  const [loading, setLoading] = useState<"view" | "reveal" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The API answered 404: this person is outside the viewer's scope. */
  const [hidden, setHidden] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const mask = (r: AadhaarResponse): AadhaarResponse => ({ ...r, aadhaar: r.aadhaar ? `XXXX-XXXX-${r.aadhaar.replace(/\D/g, "").slice(-4)}` : null, revealed: false });

  // A revealed number masks itself again after REVEAL_SECONDS.
  const revealed = Boolean(current?.revealed && current.aadhaar);
  useEffect(() => {
    if (!revealed) return;
    setSecondsLeft(REVEAL_SECONDS);
    const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(tick);
  }, [revealed, current]);
  useEffect(() => {
    if (revealed && secondsLeft === 0) setCurrent((c) => (c ? mask(c) : c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const fetchAadhaar = async (reveal: boolean) => {
    setLoading(reveal ? "reveal" : "view");
    setLoadError(null);
    try {
      setCurrent(await api.get<AadhaarResponse>(`/admin/staff/${member.id}/aadhaar`, reveal ? { query: { reveal: 1 } } : {}));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setHidden(true);
      else if (reveal) toast(errorMessage(e), "error");
      else setLoadError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  };

  const hide = () => setCurrent((c) => (c ? mask(c) : c));

  const digits = input.replace(/\D/g, "");
  const formatError =
    digits.length === 0
      ? null
      : digits.length < 12
        ? null
        : !aadhaarSchema.safeParse({ aadhaar: digits }).success
          ? "Aadhaar must be 12 digits and cannot start with 0 or 1"
          : !verhoeffValid(digits)
            ? "This number fails the Aadhaar checksum — check for a typo"
            : null;
  const valid = digits.length === 12 && !formatError && consent;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.patch<AadhaarResponse>(`/admin/staff/${member.id}/aadhaar`, { aadhaar: digits, consent: true });
      setCurrent({ ...r, revealed: false });
      setInput("");
      setConsent(false);
      toast(`Aadhaar saved for ${member.name}`, "success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setHidden(true);
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const display = current?.aadhaar ? (current.revealed ? groupAadhaar(current.aadhaar) : current.aadhaar) : null;

  return (
    <Card className="self-start">
      <CardHeader title={member.name} subtitle={`${roleLabel(member.role)} · ${member.phone}`} action={<IdentificationCard size={26} className="text-muted" />} />
      <div className="space-y-5 p-5">
        <div className="rounded-2xl border border-line bg-surface-2/60 p-4">
          <p className="text-sm font-semibold text-muted">Aadhaar on file</p>
          {hidden ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-muted">
              <LockKey size={18} /> — You can&apos;t view this person&apos;s Aadhaar.
            </p>
          ) : loadError ? (
            <p className="mt-1 text-sm text-red-600">{loadError}</p>
          ) : current && !current.aadhaar ? (
            <p className="mt-1 text-sm text-muted">Not recorded yet.</p>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <span className="tabular font-mono text-2xl font-bold tracking-wider">{display ?? "XXXX-XXXX-XXXX"}</span>
              {current?.revealed && <Badge tone="danger">Revealed · hides in {secondsLeft}s</Badge>}
              {!current && (
                <Button variant="outline" size="sm" icon={<Eye size={18} />} loading={loading === "view"} disabled={loading !== null} onClick={() => void fetchAadhaar(false)}>
                  View
                </Button>
              )}
              {current?.revealed ? (
                <Button variant="outline" size="sm" icon={<EyeSlash size={18} />} onClick={hide}>
                  Hide
                </Button>
              ) : current?.fullStored ? (
                <Button variant="outline" size="sm" icon={<Eye size={18} />} loading={loading === "reveal"} disabled={loading !== null} onClick={() => void fetchAadhaar(true)}>
                  Reveal
                </Button>
              ) : current ? (
                <Badge tone="neutral">Last 4 digits only</Badge>
              ) : null}
              {current?.aadhaar && canSet && (
                <Button variant="ghost" size="sm" icon={<Trash size={18} />} className="text-red-600 dark:text-red-300" onClick={() => setDeleting(true)}>
                  Delete
                </Button>
              )}
            </div>
          )}
          {current?.consent && (
            <p className="mt-2 text-xs text-muted">Consent recorded {new Date(current.consent.at).toLocaleDateString("en-IN", { dateStyle: "medium" })}.</p>
          )}
        </div>
        <ConfirmDialog
          open={deleting}
          title="Delete Aadhaar record"
          description={`Removes ${member.name}'s Aadhaar and consent record. Use this when they ask for it, or after they leave.`}
          confirmLabel="Delete"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await api.del(`/admin/staff/${member.id}/aadhaar`);
            } catch (e) {
              throw new Error(errorMessage(e));
            }
            setCurrent({ userId: member.id, aadhaar: null, consent: null });
            setDeleting(false);
            toast("Aadhaar record deleted", "success");
          }}
        />

        {canSet && !hidden && (
          <form onSubmit={save} className="space-y-3">
            {error && <Alert>{error}</Alert>}
            <Input
              label={current?.aadhaar ? "Replace Aadhaar number" : "Aadhaar number"}
              inputMode="numeric"
              autoComplete="off"
              placeholder="XXXX XXXX XXXX"
              value={groupAadhaar(input)}
              onChange={(e) => setInput(e.target.value)}
              error={formatError}
              hint={mode === "FULL" ? "12 digits. Stored encrypted; only the last 4 digits appear in the audit log." : "12 digits. Checked, then only the last 4 digits are kept."}
              className="font-mono tracking-wider"
              wrapperClassName="max-w-sm"
            />
            <label className="flex max-w-xl items-start gap-3 rounded-xl border border-line p-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{aadhaarConsentText(mode, member.name, hotelName)}</span>
            </label>
            <Button type="submit" icon={<ShieldCheck size={20} />} loading={saving} disabled={!valid}>
              Save securely
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

/** Owner: how the hotel stores Aadhaar (last 4 by default), and reducing stored full numbers. */
function AadhaarSettingsCard({ settings, onChanged, owner }: { settings: AadhaarSettings; onChanged: () => Promise<void>; owner: boolean }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [reducing, setReducing] = useState(false);
  const setMode = async (mode: "LAST4" | "FULL") => {
    setSaving(true);
    try {
      await api.patch("/admin/aadhaar-settings", { mode });
      toast(mode === "FULL" ? "New Aadhaar entries keep the full number (encrypted)" : "New Aadhaar entries keep the last 4 digits only", "success");
      await onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };
  if (!owner && settings.fullNumbersStored === 0) return null;
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-center gap-4 p-4">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">What the hotel keeps</p>
          <p className="text-muted">
            Keeping only the last 4 digits is safest and is enough to match a staff record. Keep full numbers only if you must (e.g. a contractor requires it).
            {settings.fullNumbersStored > 0 && ` ${settings.fullNumbersStored} full number${settings.fullNumbersStored === 1 ? " is" : "s are"} stored.`}
          </p>
        </div>
        {owner && (
          <Select aria-label="Aadhaar storage" value={settings.mode} disabled={saving} onChange={(e) => void setMode(e.target.value as "LAST4" | "FULL")} className="w-56">
            <option value="LAST4">Last 4 digits only</option>
            <option value="FULL">Full number (encrypted)</option>
          </Select>
        )}
        {owner && settings.fullNumbersStored > 0 && (
          <Button variant="outline" size="sm" onClick={() => setReducing(true)}>
            Keep last 4 only for all
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={reducing}
        title="Keep only the last 4 digits"
        description={`The full numbers of ${settings.fullNumbersStored} staff are deleted for good, keeping the last 4 digits. This can't be undone.`}
        confirmLabel="Delete full numbers"
        onClose={() => setReducing(false)}
        onConfirm={async () => {
          try {
            const r = await api.post<{ reduced: number }>("/admin/aadhaar/reduce-to-last4", { confirm: "REDUCE" });
            toast(`${r.reduced} full number${r.reduced === 1 ? "" : "s"} deleted`, "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setReducing(false);
          await onChanged();
        }}
      />
    </Card>
  );
}
