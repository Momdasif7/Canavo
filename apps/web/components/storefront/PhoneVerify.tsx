"use client";

import { useEffect, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { publicCall } from "@/lib/storefront";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const storeKey = (slug: string) => `canavo.phoneproof.${slug}`;

/** A verified-phone token kept for this tab (it expires on the server after 30 minutes anyway). */
export function savedPhoneToken(slug: string, phone: string): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(storeKey(slug)) ?? "null") as { phone: string; token: string; exp: number } | null;
    return v && v.phone === phone && v.exp > Date.now() ? v.token : null;
  } catch {
    return null;
  }
}

export function forgetPhoneToken(slug: string) {
  try {
    sessionStorage.removeItem(storeKey(slug));
  } catch {
    /* ignore */
  }
}

/**
 * Phone → OTP step of the online checkout (outlets with "Verify customer phone by OTP").
 * Calls `onVerified` with the signed token the order request carries.
 */
export function PhoneVerify({ slug, phone, token, onVerified }: { slug: string; phone: string; token: string | null; onVerified: (token: string | null) => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneOk = /^[6-9]\d{9}$/.test(phone);

  // A changed number needs a new code.
  useEffect(() => {
    if (sentTo && sentTo !== phone) {
      setSentTo(null);
      setCode("");
      setDevCode(null);
      setError(null);
    }
  }, [phone, sentTo]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  if (token) {
    return (
      <p className="flex items-center gap-1.5 text-sm font-semibold text-secondary dark:text-green-300" data-testid="phone-verified">
        <CheckCircle size={18} weight="fill" /> Mobile number verified
      </p>
    );
  }

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await publicCall<{ cooldown: number; devCode?: string }>("POST", `/public/o/${slug}/otp/request`, { phone });
      setSentTo(phone);
      setDevCode(r.devCode ?? null);
      setCooldown(r.cooldown);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await publicCall<{ phoneToken: string; expiresIn: number }>("POST", `/public/o/${slug}/otp/verify`, { phone, code });
      try {
        sessionStorage.setItem(storeKey(slug), JSON.stringify({ phone, token: r.phoneToken, exp: Date.now() + (r.expiresIn - 60) * 1000 }));
      } catch {
        /* ignore */
      }
      onVerified(r.phoneToken);
    } catch (e) {
      setError(errorMessage(e));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-2xl border border-primary/30 bg-primary-50/60 p-3 dark:bg-primary/10" data-testid="phone-verify">
      {!sentTo ? (
        <>
          <p className="text-sm text-fg"><span className="font-bold">Verify your number</span> — we&apos;ll text a 6-digit code (helps the restaurant trust your order).</p>
          <Button variant="outline" block loading={busy} disabled={!phoneOk} onClick={() => void send()}>
            {phoneOk ? `Send code to ${phone}` : "Enter your mobile number above"}
          </Button>
        </>
      ) : (
        <>
          <Input
            label={`Code sent to ${sentTo}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            hint={devCode ? `Test mode (no SMS set up): the code is ${devCode}` : "The code is valid for 5 minutes."}
            autoFocus
          />
          <div className="flex gap-2">
            <Button className="flex-1" loading={busy} disabled={code.length !== 6} onClick={() => void verify()}>
              Verify
            </Button>
            <Button variant="ghost" disabled={busy || cooldown > 0} onClick={() => void send()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </Button>
          </div>
        </>
      )}
      {error && <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
