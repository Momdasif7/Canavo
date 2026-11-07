"use client";

import { useEffect, useState } from "react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { CUSTOM_ROLE_BASES, PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS, customRoleSchema, type Permission, type Role } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { CustomRole } from "@/lib/types";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/**
 * Owner's own roles (Phase 4.2), e.g. "Senior cashier" or "Manager without refunds".
 * A custom role starts from a built-in role and can only take permissions away.
 */
export function CustomRolesCard({ roles, loading, error, onReload }: { roles?: CustomRole[]; loading: boolean; error: string | null; onReload: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<CustomRole | null | undefined>(null);
  const [deleting, setDeleting] = useState<CustomRole | null>(null);

  return (
    <Card className="mt-5">
      <CardHeader
        title="Roles"
        subtitle="Your own roles, based on a built-in role with some permissions taken away. A custom role can never give more than its base role."
        action={
          <Button size="sm" icon={<Plus size={18} />} onClick={() => setEditing(undefined)}>
            New role
          </Button>
        }
      />
      {loading && !roles ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={onReload} />
      ) : !roles?.length ? (
        <EmptyState title="No custom roles" description="Everyone uses the built-in roles. Create one to limit what a group of staff can do." />
      ) : (
        <ul className="divide-y divide-line">
          {roles.map((r) => {
            const removed = ROLE_PERMISSIONS[r.baseRole].filter((p) => !r.permissions.includes(p));
            return (
              <li key={r.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-xs text-muted">
                    Based on {ROLE_LABELS[r.baseRole]} · {r.staffCount ?? 0} staff
                    {removed.length > 0 && ` · without: ${removed.map((p) => PERMISSION_LABELS[p]).join(", ")}`}
                  </p>
                </div>
                <div className="flex shrink-0">
                  <IconButton label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <PencilSimple size={20} />
                  </IconButton>
                  <IconButton label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                    <Trash size={20} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <CustomRoleDialog role={editing} onClose={() => setEditing(null)} onSaved={onReload} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete role"
        description={deleting ? `Delete "${deleting.name}"? Only roles nobody uses can be deleted.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(`/staff/roles/${deleting!.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast(`Role ${deleting!.name} deleted`, "success");
          setDeleting(null);
          onReload();
        }}
      />
    </Card>
  );
}

/** `role` undefined = create, object = edit, null = closed. */
function CustomRoleDialog({ role, onClose, onSaved }: { role: CustomRole | null | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const open = role !== null;
  const [name, setName] = useState("");
  const [baseRole, setBaseRole] = useState<Role>("CASHIER");
  const [perms, setPerms] = useState<Permission[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(role?.name ?? "");
    setBaseRole(role?.baseRole ?? "CASHIER");
    setPerms(role ? role.permissions : [...ROLE_PERMISSIONS.CASHIER]);
  }, [open, role]);

  const available = ROLE_PERMISSIONS[baseRole];
  const pickBase = (r: Role) => {
    setBaseRole(r);
    setPerms([...ROLE_PERMISSIONS[r]]);
  };
  const toggle = (p: Permission) => setPerms((l) => (l.includes(p) ? l.filter((x) => x !== p) : [...l, p]));

  const save = async () => {
    const parsed = customRoleSchema.safeParse({ name: name.trim(), baseRole, permissions: perms.filter((p) => available.includes(p)) });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setSaving(true);
    setError(null);
    try {
      if (role) await api.patch(`/staff/roles/${role.id}`, parsed.data);
      else await api.post("/staff/roles", parsed.data);
      toast(role ? "Role saved" : "Role created", "success");
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
      title={role ? `Edit ${role.name}` : "New role"}
      description="Untick what people with this role shouldn't do. You can only remove permissions from the base role, never add new ones."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Role name" maxLength={50} placeholder="e.g. Manager without refunds" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Based on" value={baseRole} disabled={Boolean(role?.staffCount)} onChange={(e) => pickBase(e.target.value as Role)}>
            {CUSTOM_ROLE_BASES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        {Boolean(role?.staffCount) && <p className="text-xs text-muted">Staff use this role, so its base role can&apos;t change.</p>}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">What this role can do</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {available.map((p) => (
              <label key={p} className="flex min-h-tap cursor-pointer items-center gap-2 rounded-xl border border-line px-3">
                <input type="checkbox" className="h-5 w-5 accent-primary" checked={perms.includes(p)} onChange={() => toggle(p)} />
                <span className="text-sm">{PERMISSION_LABELS[p]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
