"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChatCircleDots, DeviceMobile, EnvelopeSimple, LockKey, Moon, Sun } from "@phosphor-icons/react";
import { otpRequestSchema } from "@canavo/shared";
import { errorMessage, isSuspendedMessage, login, loginWithOtp, requestLoginOtp, verifyTwoFactor } from "@/lib/api";
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
  // Two-step login: the ticket from the first step, and which kind of code is being entered.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  // Mobile OTP sign-in (staff without an email / password): phone → 6-digit code.
  const [mode, setMode] = useState<"password" | "otp">("password");
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const sendOtp = async () => {
    const parsed = otpRequestSchema.safeParse({ phone: phone.trim() });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Enter a valid 10-digit mobile number");
    setBusy(true);
    setError(null);
    try {
      const r = await requestLoginOtp(parsed.data.phone);
      setOtpSent(true);
      setOtp("");
      setDevCode(r.devCode ?? null);
      setResendIn(30);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: "password" | "otp") => {
    setMode(next);
    setError(null);
    setOtpSent(false);
    setOtp("");
    setDevCode(null);
  };

  useEffect(() => {
    if (status === "authenticated" && me) router.replace(firstAllowedRoute({ me, outletId }));
  }, [status, me, outletId, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await verifyTwoFactor(mfaToken, useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, "") });
      } else if (mode === "otp" && !otpSent) {
        setBusy(false);
        return void sendOtp();
      } else {
        const r = mode === "otp" ? await loginWithOtp(phone.trim(), otp) : await login(email.trim(), password);
        if ("mfaRequired" in r) {
          setMfaToken(r.mfaToken);
          setBusy(false);
          return;
        }
      }
      // SessionProvider picks up the new session and the effect above redirects.
    } catch (err) {
      const message = errorMessage(err);
      // The ticket lasts 5 minutes: start over from the password.
      if (mfaToken && /expired/i.test(message)) {
        setMfaToken(null);
        setCode("");
      }
      setError(message);
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
          {mfaToken ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 text-sm">
                <DeviceMobile size={22} className="mt-0.5 shrink-0 text-primary" />
                <span>
                  {useRecovery ? "Enter one of the recovery codes you saved when you turned on two-step login." : "Open your authenticator app and enter the 6-digit code for CANAVO."}
                </span>
              </div>
              <Input
                label={useRecovery ? "Recovery code" : "6-digit code"}
                inputMode={useRecovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                required
                autoFocus
                maxLength={useRecovery ? 20 : 7}
                value={code}
                onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/[^\d ]/g, ""))}
                placeholder={useRecovery ? "xxxx-xxxx" : "123 456"}
              />
              <Button type="submit" block size="lg" loading={busy}>
                Verify
              </Button>
              <div className="flex justify-between text-sm font-semibold text-muted">
                <button type="button" className="hover:text-fg" onClick={() => {
                    setUseRecovery((v) => !v);
                    setCode("");
                    setError(null);
                  }}>
                  {useRecovery ? "Use the app code" : "Use a recovery code"}
                </button>
                <button type="button" className="hover:text-fg" onClick={() => {
                    setMfaToken(null);
                    setCode("");
                    setError(null);
                  }}>
                  Back
                </button>
              </div>
            </>
          ) : mode === "otp" ? (
            <>
              <Input
                label="Mobile number"
                inputMode="numeric"
                autoComplete="tel"
                required
                autoFocus
                maxLength={10}
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                  setOtpSent(false);
                }}
                prefix={<span className="text-sm font-semibold">+91</span>}
                className="pl-12"
                placeholder="98765 43210"
              />
              {otpSent ? (
                <>
                  <p className="text-sm text-muted">Enter the 6-digit code sent to +91 {phone}.</p>
                  <Input
                    label="6-digit code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    autoFocus
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    prefix={<ChatCircleDots size={18} />}
                  />
                  {devCode && <Alert tone="info">SMS isn&apos;t set up on this server. Your code is {devCode}.</Alert>}
                  <Button type="submit" block size="lg" loading={busy} disabled={otp.length !== 6}>
                    Verify &amp; log in
                  </Button>
                  <button type="button" className="block w-full text-center text-sm font-semibold text-muted hover:text-fg disabled:opacity-50" disabled={resendIn > 0 || busy} onClick={() => void sendOtp()}>
                    {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                  </button>
                </>
              ) : (
                <Button type="submit" block size="lg" loading={busy} disabled={phone.length !== 10}>
                  Send OTP
                </Button>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
          {!mfaToken && (
            <div className="space-y-2 text-center text-sm font-semibold">
              <button type="button" className="block w-full text-primary hover:underline" onClick={() => switchMode(mode === "otp" ? "password" : "otp")}>
                {mode === "otp" ? "Use email & password instead" : "Log in with mobile OTP"}
              </button>
              {mode === "password" && (
                <Link href="/forgot-password" className="block text-muted hover:text-fg">
                  Forgot password?
                </Link>
              )}
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
