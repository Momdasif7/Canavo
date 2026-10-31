"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EnvelopeSimple, LockKey, Moon, Sun } from "@phosphor-icons/react";
import { errorMessage, isSuspendedMessage, login } from "@/lib/api";
import { useSession } from "@/components/providers/SessionProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { firstAllowedRoute } from "@/components/layout/nav";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { Logo } from "@/components/layout/Logo";

export default function LoginPage() {
  const router = useRouter();
  const { status, me, outletId } = useSession();
  const { theme, toggle } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated" && me) router.replace(firstAllowedRoute({ me, outletId }));
  }, [status, me, outletId, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      // SessionProvider picks up the new session and the effect above redirects.
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg px-4">
      <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} className="absolute right-4 top-4">
        {theme === "dark" ? <Sun size={22} /> : <Moon size={22} />}
      </IconButton>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={56} />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">CANAVO</h1>
            <p className="text-sm text-muted">POS &amp; management for hotels and canteens</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
          {error &&
            (isSuspendedMessage(error) ? (
              <Alert tone="warning">
                <span className="block font-bold">Business account suspended</span>
                <span className="mt-0.5 block font-normal">
                  Sign-in is paused for everyone in this business. Please contact your CANAVO administrator to reactivate it.
                </span>
              </Alert>
            ) : (
              <Alert>{error}</Alert>
            ))}
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            prefix={<EnvelopeSimple size={18} />}
            placeholder="you@canteen.in"
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            prefix={<LockKey size={18} />}
          />
          <Button type="submit" block size="lg" loading={busy}>
            Log in
          </Button>
        </form>
      </div>
    </main>
  );
}
