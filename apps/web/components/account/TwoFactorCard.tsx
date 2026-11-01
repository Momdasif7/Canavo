"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, DownloadSimple, ShieldCheck } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

/**
 * Two-step login (authenticator app + recovery codes). Setup: scan the QR, confirm with a
 * code, save the recovery codes (shown once).
 */
export function TwoFactorCard() {
  const toast = useToast();
  const { me, refreshMe } = useSession();
  const status = useApiQuery("auth-2fa", () => api.get<Status>("/auth/2fa", { outletId: null }));
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<"disable" | "regenerate" | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => setSetup(await api.post("/auth/2fa/setup", {}, { outletId: null })));

  const confirm = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code: code.replace(/\s/g, "") }, { outletId: null });
      setSetup(null);
      setCode("");
      setCodes(r.recoveryCodes);
      await status.reload();
      await refreshMe();
    });

  const disable = () =>
    run(async () => {
      await api.post("/auth/2fa/disable", { password: password || undefined, ...codeInput(code) }, { outletId: null });
      setDialog(null);
      setCode("");
      setPassword("");
      toast("Two-step login is off", "success");
      await status.reload();
      await refreshMe();
    });

  const regenerate = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", codeInput(code), { outletId: null });
      setDialog(null);
      setCode("");
      setCodes(r.recoveryCodes);
      await status.reload();
    });

  const s = status.data;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Two-step login {s?.enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
          </span>
        }
        subtitle="After your password, also enter a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). A stolen password alone can't open your account."
      />
      <div className="space-y-4 p-5">
        {error && !dialog && <Alert>{error}</Alert>}
        {me?.twoFactorSetupRequired && !s?.enabled && <Alert tone="warning">Your hotel requires two-step login for your role. Turn it on to continue using CANAVO.</Alert>}
        {!s ? (
          <LoadingState />
        ) : setup ? (
          <div className="grid gap-5 sm:grid-cols-[auto,1fr]">
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={setup.otpauthUri} size={168} />
            </div>
            <div className="space-y-3 text-sm">
              <p>
                <b>1.</b> In your authenticator app, add an account and scan this QR code.
              </p>
              <p className="text-muted">
                Can&apos;t scan? Enter this key: <span className="select-all break-all font-mono text-fg">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
              </p>
              <p>
                <b>2.</b> Enter the 6-digit code the app shows.
              </p>
              <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} />
              <div className="flex gap-2">
                <Button onClick={confirm} loading={busy} disabled={code.replace(/\s/g, "").length !== 6}>
                  Turn on
                </Button>
                <Button variant="ghost" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : s.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              <ShieldCheck size={18} className="mr-1 inline text-secondary" weight="fill" />
              {s.recoveryCodesLeft} of 10 recovery codes left.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog("regenerate")}>
                New recovery codes
              </Button>
              <Button variant="ghost" size="sm" className="text-red-600 dark:text-red-300" onClick={() => setDialog("disable")}>
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <Button icon={<ShieldCheck size={20} />} onClick={start} loading={busy}>
            Turn on two-step login
          </Button>
        )}
      </div>

      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />

      <Dialog
        open={dialog !== null}
        onClose={() => {
          setDialog(null);
          setError(null);
        }}
        size="sm"
        title={dialog === "disable" ? "Turn off two-step login" : "New recovery codes"}
        description={dialog === "disable" ? "Your account will be protected by the password only." : "Your old recovery codes stop working."}
        footer={
          <Button onClick={dialog === "disable" ? disable : regenerate} loading={busy} variant={dialog === "disable" ? "danger" : "primary"} disabled={!code.trim()}>
            {dialog === "disable" ? "Turn off" : "Create new codes"}
          </Button>
        }
      >
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {dialog === "disable" && <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          <Input label="Code from the app, or a recovery code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
      </Dialog>
    </Card>
  );
}

const codeInput = (c: string) => (/^[\d\s]{6,7}$/.test(c.trim()) ? { code: c.replace(/\s/g, "") } : { recoveryCode: c.trim() });

/** Shown once after setup / regeneration: copy or download, then confirm. */
function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const toast = useToast();
  const text = (codes ?? []).join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`CANAVO recovery codes (each works once)\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "canavo-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open={codes !== null}
      onClose={onClose}
      size="sm"
      title="Save your recovery codes"
      description="If you lose your phone, sign in with one of these. Each works once. They won't be shown again."
      footer={<Button onClick={onClose}>I&apos;ve saved them</Button>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-4 font-mono text-sm">
          {(codes ?? []).map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={<Copy size={18} />}
            onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Copied", "success"))}
          >
            Copy
          </Button>
          <Button variant="outline" size="sm" icon={<DownloadSimple size={18} />} onClick={download}>
            Download
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
