"use client";

import { useEffect, useState } from "react";
import { ROLE_LABELS, staffCreateSchema, staffUpdateSchema, type Role } from "@canavo/shared";
import { assignableRoles, businessOutlets, canManageRole, isBusinessWideRole } from "@/lib/roles";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { CustomRole, SalaryType, Shift, Staff } from "@/lib/types";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";

interface FormState {
  name: string;
  phone: string;
  email: string;
  role: Role;
  /** "" = the standard built-in role */
  customRoleId: string;
  outletIds: string[];
  shiftId: string;
  salaryType: SalaryType;
  salary: string;
  pin: string;
  password: string;
}

/** `staff` undefined = create, object = edit, null = closed. */
export function StaffForm({
  staff,
  shifts,
  customRoles = [],
  onClose,
  onSaved,
}: {
  staff: Staff | null | undefined;
  shifts: Shift[];
  customRoles?: CustomRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { me, outletId } = useSession();
  const toast = useToast();
  const open = staff !== null;
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      staff
        ? {
            name: staff.name,
            phone: staff.phone,
            email: staff.email ?? "",
            role: staff.role,
            customRoleId: staff.customRoleId ?? "",
            outletIds: staff.outlets.map((o) => o.outletId),
            shiftId: staff.shiftId ?? "",
            salaryType: staff.salaryType,
            salary: rupeesInput(staff.salaryAmount),
            pin: "",
            password: "",
          }
        : {
            name: "",
            phone: "",
            email: "",
            role: "CASHIER",
            customRoleId: "",
            outletIds: outletId ? [outletId] : [],
            shiftId: "",
            salaryType: "MONTHLY",
            salary: "",
            pin: "",
            password: "",
          },
    );
  }, [open, staff, outletId]);

  if (!form || !me) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  // Only roles strictly below this user (the API enforces the same hierarchy).
  const assignable = assignableRoles(me.role);
  // Someone at or above your level (another owner, a fellow manager, yourself): view only.
  const readOnly = !!staff && (staff.id === me.id || !canManageRole(me.role, staff.role));
  const roles = staff && !assignable.includes(staff.role) ? [staff.role, ...assignable] : assignable;
  const outlets = businessOutlets(me);
  const wide = isBusinessWideRole(form.role);
  // Custom roles built on the chosen role (they can only narrow it).
  const roleOptions = customRoles.filter((r) => r.baseRole === form.role);

  const save = async () => {
    if (readOnly) return;
    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      role: form.role,
      // Only send it when there's something to say (keeps old payloads unchanged).
      ...(form.customRoleId || staff?.customRoleId ? { customRoleId: form.customRoleId || null } : {}),
      outletIds: form.outletIds,
      shiftId: form.shiftId || undefined,
      salaryType: form.salaryType,
      salaryAmount: parseRupees(form.salary) ?? 0,
      pin: form.pin || undefined,
      password: form.password || undefined,
    };
    const parsed = (staff ? staffUpdateSchema : staffCreateSchema).safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Form"}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      if (staff) await api.patch(`/staff/${staff.id}`, parsed.data);
      else await api.post("/staff", parsed.data);
      toast(staff ? "Staff updated" : "Staff member added", "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={staff ? (readOnly ? staff.name : `Edit ${staff.name}`) : "Add staff member"}
      footer={
        readOnly ? (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="space-y-4">
        {readOnly && <Alert tone="info">You can&apos;t change this account — it&apos;s at or above your level.</Alert>}
        {error && <Alert>{error}</Alert>}
        {staff && form.role !== staff.role && <Alert tone="warning">Changing the role signs this person out of all devices.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full name" maxLength={100} value={form.name} onChange={(e) => set("name", e.target.value)} />
          <Input
            label="Mobile"
            inputMode="numeric"
            maxLength={10}
            prefix={<span className="text-sm font-semibold">+91</span>}
            className="pl-12"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))}
          />
          <Input label="Email (for password login)" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          <Select label="Role" value={form.role} onChange={(e) => setForm((f) => (f ? { ...f, role: e.target.value as Role, customRoleId: "" } : f))}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          {roleOptions.length > 0 && (
            <Select label="Custom role" hint="Limits what this role can do; never adds to it." value={form.customRoleId} onChange={(e) => set("customRoleId", e.target.value)}>
              <option value="">Standard {ROLE_LABELS[form.role]}</option>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Outlets{wide && <span className="font-normal text-muted"> (optional)</span>}</legend>
          <p className="mb-2 text-xs text-muted">
            {wide ? "Business owners can work in every outlet of the business — no assignment needed." : "Pick at least one outlet this person works in."}
          </p>
          <div className="flex flex-wrap gap-2">
            {outlets.map((o) => {
              const on = form.outletIds.includes(o.id);
              return (
                <label key={o.id} className={`flex min-h-tap cursor-pointer items-center gap-2 rounded-xl border px-3 ${on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line"}`}>
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[#FF6B35]"
                    checked={on}
                    onChange={() => set("outletIds", on ? form.outletIds.filter((x) => x !== o.id) : [...form.outletIds, o.id])}
                  />
                  <span className="font-medium">{o.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Select label="Shift" value={form.shiftId} onChange={(e) => set("shiftId", e.target.value)}>
            <option value="">No fixed shift</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startTime}–{s.endTime})
              </option>
            ))}
          </Select>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Salary type</span>
            <Segmented
              value={form.salaryType}
              onChange={(v) => set("salaryType", v)}
              options={[
                { value: "MONTHLY", label: "Monthly" },
                { value: "DAILY", label: "Daily" },
              ]}
            />
          </div>
          <Input
            label={form.salaryType === "DAILY" ? "Per day" : "Per month"}
            inputMode="decimal"
            prefix="₹"
            value={form.salary}
            onChange={(e) => set("salary", e.target.value.replace(/[^\d.]/g, ""))}
          />
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Input
            label="Attendance PIN"
            inputMode="numeric"
            maxLength={6}
            placeholder={staff ? "Leave blank to keep" : "4–6 digits"}
            value={form.pin}
            onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder={staff ? "Leave blank to keep" : "10+ characters, letters and a number"}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
          />
        </div>
      </fieldset>
    </Dialog>
  );
}
