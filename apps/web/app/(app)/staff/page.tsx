"use client";

import { useMemo, useState } from "react";
import { ChartLineUp, MagnifyingGlass, PencilSimple, UserPlus } from "@phosphor-icons/react";
import { ROLE_LABELS, formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { fuzzyFilter } from "@/lib/fuzzy";
import { formatMinutes } from "@/lib/format";
import type { Shift, Staff, StaffPerformance, StaffStatus } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Dialog } from "@/components/ui/Dialog";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { StaffForm } from "@/components/staff/StaffForm";
import { Badge } from "@/components/ui/Badge";
import { canManageRole, isBusinessWideRole } from "@/lib/roles";

export default function StaffPage() {
  const { outletId, can, me } = useSession();
  const toast = useToast();
  const manage = can("staff:manage");
  // Owners and super admins can see every account of the business (incl. owners).
  const businessWide = !!me && isBusinessWideRole(me.role);
  const [scope, setScope] = useState<"outlet" | "business">("outlet");
  const effectiveScope = businessWide ? scope : "outlet";
  const staff = useApiQuery<Staff[]>(outletId ? `staff:${outletId}:${effectiveScope}` : null, () =>
    api.get<Staff[]>("/staff", { query: { scope: effectiveScope === "business" ? "business" : undefined } }),
  );
  const outletName = useMemo(() => new Map((me?.outlets ?? []).map((o) => [o.id, o.name])), [me?.outlets]);
  const shifts = useApiQuery<Shift[]>(outletId ? `shifts:${outletId}` : null, () => api.get<Shift[]>("/outlets/current/shifts"));
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Staff | null | undefined>(null);
  const [perf, setPerf] = useState<Staff | null>(null);

  const shiftName = useMemo(() => new Map((shifts.data ?? []).map((s) => [s.id, `${s.name} ${s.startTime}–${s.endTime}`])), [shifts.data]);
  const list = fuzzyFilter(staff.data ?? [], search, (s) => `${s.name} ${s.phone}`);

  const changeStatus = async (s: Staff, status: StaffStatus) => {
    if (status !== "ACTIVE" && !window.confirm(`Set ${s.name} to ${status.toLowerCase()}? They will be signed out of all devices.`)) return;
    try {
      const updated = await api.patch<Staff>(`/staff/${s.id}`, { status });
      staff.setData((l) => l?.map((x) => (x.id === s.id ? updated : x)));
      toast(`${s.name} is now ${status.toLowerCase()}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Staff"
        subtitle={staff.data ? `${staff.data.filter((s) => s.status === "ACTIVE").length} active of ${staff.data.length}` : undefined}
        actions={
          manage && (
            <Button icon={<UserPlus size={20} />} onClick={() => setEditing(undefined)}>
              Add staff
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input type="search" placeholder="Search by name or phone" value={search} onChange={(e) => setSearch(e.target.value)} prefix={<MagnifyingGlass size={18} />} wrapperClassName="min-w-[220px] max-w-md flex-1" />
          {businessWide && (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: "outlet", label: "This outlet" },
                { value: "business", label: "All accounts" },
              ]}
            />
          )}
        </div>
        {staff.loading && !staff.data ? (
          <LoadingState />
        ) : staff.error ? (
          <ErrorState message={staff.error} onRetry={staff.reload} />
        ) : list.length === 0 ? (
          <EmptyState title="No staff found" />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                {effectiveScope === "business" ? <Th>Outlets</Th> : <Th>Shift</Th>}
                <Th className="text-right">Salary</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.map((s) => {
                const editable = manage && !!me && s.id !== me.id && canManageRole(me.role, s.role);
                return (
                  <Tr key={s.id}>
                    <Td>
                      <p className="font-semibold">{s.name}</p>
                      <p className="text-xs text-muted">
                        +91 {s.phone}
                        {s.email && ` · ${s.email}`}
                      </p>
                    </Td>
                    <Td>
                      {isBusinessWideRole(s.role) ? <Badge tone="primary">{ROLE_LABELS[s.role]}</Badge> : ROLE_LABELS[s.role]}
                    </Td>
                    {effectiveScope === "business" ? (
                      <Td className="max-w-[260px] text-muted">
                        {isBusinessWideRole(s.role) && s.outlets.length === 0
                          ? "All outlets"
                          : s.outlets.map((o) => outletName.get(o.outletId) ?? "Other outlet").join(", ") || "—"}
                      </Td>
                    ) : (
                      <Td className="text-muted">{(s.shiftId && shiftName.get(s.shiftId)) || "—"}</Td>
                    )}
                    <Td className="tabular text-right">
                      <span className="font-bold">{formatINR(s.salaryAmount)}</span>
                      <span className="text-xs text-muted"> /{s.salaryType === "DAILY" ? "day" : "month"}</span>
                    </Td>
                    <Td>
                      {editable ? (
                        <Select aria-label={`Status of ${s.name}`} value={s.status} onChange={(e) => changeStatus(s, e.target.value as StaffStatus)} className="min-h-[40px] w-36 text-sm">
                          <option value="ACTIVE">Active</option>
                          <option value="INACTIVE">Inactive</option>
                          <option value="SUSPENDED">Suspended</option>
                        </Select>
                      ) : (
                        <span className="text-sm">{s.status.toLowerCase()}</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      <IconButton label={`Performance of ${s.name}`} onClick={() => setPerf(s)}>
                        <ChartLineUp size={20} />
                      </IconButton>
                      {editable && (
                        <IconButton label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                          <PencilSimple size={20} />
                        </IconButton>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <StaffForm staff={editing} shifts={shifts.data ?? []} onClose={() => setEditing(null)} onSaved={staff.reload} />
      <PerformanceDialog staff={perf} onClose={() => setPerf(null)} />
    </PageContainer>
  );
}

function PerformanceDialog({ staff, onClose }: { staff: Staff | null; onClose: () => void }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const perf = useApiQuery<StaffPerformance>(staff ? `perf:${staff.id}:${days}` : null, () =>
    api.get<StaffPerformance>(`/staff/${staff!.id}/performance`, { query: { days } }),
  );
  const p = perf.data;
  return (
    <Dialog open={!!staff} onClose={onClose} title={staff ? `${staff.name} · performance` : ""}>
      <Segmented
        className="mb-4"
        value={days}
        onChange={setDays}
        options={[
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
        ]}
      />
      {perf.loading ? (
        <LoadingState />
      ) : perf.error ? (
        <ErrorState message={perf.error} onRetry={perf.reload} />
      ) : p ? (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Bills raised" value={String(p.billsRaised)} />
          <Stat label="Sales value" value={formatINR(p.salesValue)} />
          <Stat label="Items sold" value={String(p.itemsSold)} />
          <Stat label="Attendance" value={`${p.attendancePercent}%`} note={`${p.presentDays} of ${p.days} days`} />
          <Stat label="Late days" value={String(p.lateDays)} />
          <Stat label="Overtime" value={formatMinutes(p.overtimeMinutes)} />
        </div>
      ) : null}
    </Dialog>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="tabular mt-1 text-xl font-extrabold">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}
