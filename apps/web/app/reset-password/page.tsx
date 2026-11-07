"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LockKey } from "@phosphor-icons/react";
import { passwordProblems } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/**
 * Set a password from a one-time link (#token=… in the URL fragment, so the token never
 * reaches server logs). Used for new accounts (invite) and resets.
 */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneLogin, setDoneLogin] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t);
    // Drop the token from the address bar and history once read.
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const problems = useMemo(() => (password ? passwordProblems(password) : []), [password]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (problems.length) return setError(problems.join(". "));
    if (password !== confirm) return setError("The passwords don't match");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: true; login: string }>("/auth/password/reset", { token, password }, { auth: false, outletId: null });
      setDoneLogin(r.login);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (doneLogin) {
    return (
      <AuthShell title="Password set" subtitle="You're signed out on other devices">
        <Alert tone="info">
          Your new password is saved. Log in as <b>{doneLogin}</b>.
        </Alert>
        <Link href="/login" className="block">
          <Button block size="lg">
            Log in
          </Button>
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set your password" subtitle="Choose a password only you know">
      {token === null ? (
        <>
          <Alert tone="warning">This page needs the link from your email or SMS. Ask for a new link if it expired.</Alert>
          <Link href="/forgot-password" className="block text-center text-sm font-semibold text-primary hover:underline">
            Get a new link
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            prefix={<LockKey size={18} />}
            placeholder="10+ characters, letters and a number"
          />
          {password && problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <Input label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} prefix={<LockKey size={18} />} />
          <Button type="submit" block size="lg" loading={busy} disabled={!password || !confirm}>
            Save password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
