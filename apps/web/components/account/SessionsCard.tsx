"use client";

import { useState } from "react";
import { DesktopTower, DeviceMobile } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { formatDateTime } from "@/lib/format";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert, LoadingState } from "@/components/ui/States";

export interface SessionRow {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
}

/** A short device label from the user agent ("Chrome on Windows", "CANAVO app on Android"). */
export function deviceLabel(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "Unknown device", mobile: false };
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "";
  const app = /okhttp|Expo|CFNetwork|Dalvik/i.test(ua) ? "CANAVO app" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return { label: os ? `${app} on ${os}` : app, mobile: os === "Android" || os === "iOS" };
}

/** Signed-in devices: sign out one, or every device except this one. */
export function SessionsCard() {
  const toast = useToast();
  const sessions = useApiQuery("auth-sessions", () => api.get<SessionRow[]>("/auth/sessions", { outletId: null }));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.del(`/auth/sessions/${id}`, { outletId: null });
      toast("Signed out on that device", "success");
      await sessions.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const revokeOthers = async () => {
    setBusy("others");
    setError(null);
    try {
      const r = await api.post<{ count: number }>("/auth/sessions/revoke-others", {}, { outletId: null });
      toast(r.count ? "Signed out on every other device" : "No other devices were signed in", "success");
      await sessions.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const others = (sessions.data ?? []).filter((s) => !s.current).length;

  return (
    <Card>
      <CardHeader
        title="Signed-in devices"
        subtitle="Where your account is signed in now. Sign out any device you don't recognise, then change your password."
        action={
          others > 0 ? (
            <Button size="sm" variant="outline" loading={busy === "others"} onClick={revokeOthers}>
              Sign out all others
            </Button>
          ) : undefined
        }
      />
      <div className="divide-y divide-line">
        {error && (
          <div className="p-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {sessions.loading && !sessions.data ? (
          <LoadingState />
        ) : (
          (sessions.data ?? []).map((s) => {
            const d = deviceLabel(s.userAgent);
            return (
              <div key={s.id} className="flex items-center gap-3 px-5 py-3">
                {d.mobile ? <DeviceMobile size={26} className="shrink-0 text-muted" /> : <DesktopTower size={26} className="shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {d.label}
                    {s.current && <Badge tone="success">This device</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted">
                    Signed in {formatDateTime(s.signedInAt)} · last active {formatDateTime(s.lastActiveAt)}
                    {s.ip && ` · IP ${s.ip}`}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-300" loading={busy === s.id} onClick={() => void revoke(s.id)}>
                    Sign out
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
