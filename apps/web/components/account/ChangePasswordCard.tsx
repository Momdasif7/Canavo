"use client";

import { useMemo, useState } from "react";
import { passwordProblems } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/** Change your own password. Other devices are signed out; this one stays signed in. */
export function ChangePasswordCard({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = useMemo(() => (next ? passwordProblems(next) : []), [next]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length) return setError(problems.join(". "));
    if (next !== confirm) return setError("The new passwords don't match");
    setSaving(true);
    setError(null);
    try {
      await api.post("/auth/password/change", { currentPassword: current, newPassword: next }, { outletId: null });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Other devices were signed out.", "success");
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Password" subtitle="Change the password you log in with. Your other devices are signed out." />
      <form onSubmit={save} className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="New password" type="password" autoComplete="new-password" required placeholder="10+ characters, letters and a number" value={next} onChange={(e) => setNext(e.target.value)} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {next && problems.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-muted">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Button type="submit" loading={saving} disabled={!current || !next || !confirm}>
          Change password
        </Button>
      </form>
    </Card>
  );
}
