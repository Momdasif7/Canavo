"use client";

import { useState } from "react";
import Link from "next/link";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/** Ask for a password reset link (sent by email, or SMS without email). Same answer whether or not the account exists. */
export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/forgot", { identifier: identifier.trim() }, { auth: false, outletId: null });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Forgot password" subtitle="We'll send you a link to set a new one">
      {sent ? (
        <>
          <Alert tone="info">If an account matches, a reset link is on its way by email or SMS. It works once and expires in 30 minutes.</Alert>
          <Link href="/login" className="block text-center text-sm font-semibold text-primary hover:underline">
            Back to log in
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Input
            label="Email or mobile number"
            autoComplete="username"
            required
            autoFocus
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            prefix={<EnvelopeSimple size={18} />}
            placeholder="you@canteen.in or 98xxxxxxxx"
          />
          <Button type="submit" block size="lg" loading={busy}>
            Send reset link
          </Button>
          <Link href="/login" className="block text-center text-sm font-semibold text-muted hover:text-fg">
            Back to log in
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
