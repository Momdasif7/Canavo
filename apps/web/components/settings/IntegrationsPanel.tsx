"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CheckCircle, Copy, CreditCard, EnvelopeSimple, FloppyDisk, Lightning, Trash, WarningCircle, WhatsappLogo, ChatText, ArrowsClockwise } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import type { WhatsAppProvider } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

type Kind = "RAZORPAY" | "SMTP" | "SMS" | "WHATSAPP";
type Slug = "razorpay" | "email" | "sms" | "whatsapp";

/** GET /integrations — owners get settings + masked hints; managers get status only. */
interface Status {
  kind: Kind;
  slug: Slug;
  configured: boolean;
  enabled: boolean;
  source: "business" | "platform" | "none";
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  updatedAt: string | null;
}
interface SecretState {
  set: boolean;
  hint: string | null;
}
interface OwnerView extends Status {
  config: Record<string, unknown>;
  secrets: Record<string, SecretState>;
  lastTestMessage: string | null;
  platformFallbackAvailable: boolean;
  webhookUrl?: string | null;
}
interface ListResponse {
  items: (Status | OwnerView)[];
  editable: boolean;
}
interface TestResult {
  ok: boolean;
  message: string;
  waLink?: string;
}

const META: Record<Slug, { title: string; icon: React.ReactNode; what: string; fallback: Record<Status["source"], string> }> = {
  razorpay: {
    title: "Razorpay (UPI QR & online payments)",
    icon: <CreditCard size={22} />,
    what: "Dynamic UPI QR codes at the counter and on delivery, online-order payments and automatic refunds — paid straight into your Razorpay account.",
    fallback: {
      business: "Payments go to your Razorpay account",
      platform: "Using the platform's shared Razorpay account",
      none: "Not set up: bills show a plain UPI QR for the outlet's UPI ID, and the cashier confirms payment",
    },
  },
  email: {
    title: "Email (SMTP)",
    icon: <EnvelopeSimple size={22} />,
    what: "Scheduled reports and email notifications are sent from your own address.",
    fallback: { business: "Sent from your mail server", platform: "Sent from the platform's mail server", none: "Not set up: emails are saved on the server instead of being sent" },
  },
  sms: {
    title: "SMS (MSG91)",
    icon: <ChatText size={22} />,
    what: "Customer OTP on your online-ordering page and SMS alerts to staff, under your own DLT sender ID.",
    fallback: { business: "Sent from your MSG91 account", platform: "Sent from the platform's SMS account", none: "Not set up: SMS isn't sent" },
  },
  whatsapp: {
    title: "WhatsApp",
    icon: <WhatsappLogo size={22} />,
    what: "Receipts, khata reminders, wishes, delivery updates and staff alerts sent automatically from your business number.",
    fallback: { business: "Sent automatically from your number", platform: "Using the platform's WATI account", none: "Click-to-chat: staff tap Share and send from their phone" },
  },
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : null);

function StatusLine({ s }: { s: Status }) {
  const m = META[s.slug];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {s.configured ? (
        <Badge tone="success">
          <CheckCircle size={14} weight="fill" /> Connected
        </Badge>
      ) : s.source === "platform" ? (
        <Badge tone="info">Platform default</Badge>
      ) : (
        <Badge tone="neutral">Not set up</Badge>
      )}
      {s.updatedAt && !s.enabled && <Badge tone="warning">Turned off</Badge>}
      {s.lastTestedAt && (
        <Badge tone={s.lastTestOk ? "success" : "danger"}>
          Last test {s.lastTestOk ? "passed" : "failed"} · {fmt(s.lastTestedAt)}
        </Badge>
      )}
      <span className="text-muted">{m.fallback[s.source]}</span>
    </div>
  );
}

/** Settings → Integrations. */
export function IntegrationsPanel() {
  const { me } = useSession();
  const bizId = me?.business?.id ?? null;
  const list = useApiQuery<ListResponse>(bizId ? `integrations:${bizId}` : null, () => api.get<ListResponse>("/integrations"));

  if (list.loading && !list.data) return <Card><LoadingState /></Card>;
  if (list.error) return <Card><ErrorState message={list.error} onRetry={list.reload} /></Card>;
  if (!list.data) return null;

  if (!list.data.editable) {
    return (
      <Card>
        <CardHeader title="Integrations" subtitle="Your business's payment, email, SMS and WhatsApp accounts. Only the owner can view or change them." />
        <ul className="divide-y divide-line">
          {list.data.items.map((s) => (
            <li key={s.kind} className="space-y-1.5 px-5 py-4">
              <p className="flex items-center gap-2 font-semibold">
                {META[s.slug].icon} {META[s.slug].title}
              </p>
              <StatusLine s={s} />
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  const byKind = Object.fromEntries(list.data.items.map((i) => [i.slug, i as OwnerView])) as Record<Slug, OwnerView>;
  return (
    <div className="space-y-5">
      <Alert tone="info">
        Each store uses its own accounts. Keys are encrypted on the server and never shown again after saving — leave a key field empty to keep the saved one.
        Only you (the owner) can see this page; CANAVO support can&apos;t, even with support access.
      </Alert>
      <RazorpayCard view={byKind.razorpay} onSaved={list.reload} />
      <WhatsAppCard view={byKind.whatsapp} onSaved={list.reload} />
      <EmailCard view={byKind.email} onSaved={list.reload} />
      <SmsCard view={byKind.sms} onSaved={list.reload} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared card shell: status, save / remove, test
// ---------------------------------------------------------------------------

function useSaver(slug: Slug, onSaved: () => unknown) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>) => {
    setError(null);
    setSaving(true);
    try {
      await api.put(`/integrations/${slug}`, body);
      toast(`${META[slug].title.split(" (")[0]} saved`, "success");
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, setError, save };
}

function Shell({
  view,
  onSaved,
  saving,
  error,
  onSave,
  help,
  test,
  children,
}: {
  view: OwnerView;
  onSaved: () => unknown;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  help: React.ReactNode;
  test?: React.ReactNode;
  children: React.ReactNode;
}) {
  const m = META[view.slug];
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {m.icon} {m.title}
          </span>
        }
        subtitle={m.what}
        action={
          <div className="flex shrink-0 gap-2">
            {view.updatedAt && (
              <Button variant="ghost" size="sm" icon={<Trash size={18} />} onClick={() => setConfirm(true)} aria-label={`Remove ${m.title}`}>
                Remove
              </Button>
            )}
            <Button size="sm" icon={<FloppyDisk size={18} />} onClick={onSave} loading={saving}>
              Save
            </Button>
          </div>
        }
      />
      <div className="space-y-5 p-5">
        <StatusLine s={view} />
        {view.lastTestMessage && <p className={clsx("text-xs", view.lastTestOk ? "text-muted" : "text-red-600 dark:text-red-300")}>Last test: {view.lastTestMessage}</p>}
        {error && <Alert>{error}</Alert>}
        <fieldset disabled={saving} className="space-y-4">
          {children}
        </fieldset>
        <details className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
          <summary className="cursor-pointer font-semibold">Where do I find these?</summary>
          <div className="mt-2 space-y-1.5 text-muted">{help}</div>
        </details>
        {view.updatedAt && test}
      </div>
      <ConfirmDialog
        open={confirm}
        title={`Remove your ${m.title.split(" (")[0]} account?`}
        description={view.platformFallbackAvailable ? "The platform's default account will be used again." : "This feature stops working until you set it up again."}
        confirmLabel="Remove"
        onConfirm={async () => {
          await api.del(`/integrations/${view.slug}`);
          toast("Removed", "success");
          await onSaved();
        }}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}

function SecretInput({ label, state, value, onChange, placeholder, hint }: { label: string; state?: SecretState; value: string; onChange: (v: string) => void; placeholder?: string; hint?: React.ReactNode }) {
  return (
    <Input
      label={label}
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={state?.set ? `Saved (${state.hint ?? "••••"}) — leave empty to keep` : placeholder}
      hint={hint}
    />
  );
}

/** "Test connection" with optional phone / email input. */
function TestBox({ slug, needs, onDone, label = "Test connection" }: { slug: Slug; needs?: "phone" | "email" | "phone?"; onDone: () => unknown; label?: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = needs === "email" ? { to: value.trim() } : needs ? { phone: value.replace(/\D/g, "") } : {};
      setResult(await api.post<TestResult>(`/integrations/${slug}/test`, body));
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {needs && (
          <Input
            wrapperClassName="min-w-[200px] flex-1 sm:max-w-xs"
            label={needs === "email" ? "Send a test email to (optional)" : needs === "phone" ? "Mobile number for the test SMS" : "Mobile for a test message (optional)"}
            inputMode={needs === "email" ? "email" : "numeric"}
            value={value}
            onChange={(e) => setValue(needs === "email" ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 10))}
            placeholder={needs === "email" ? "you@example.com" : "10-digit mobile"}
          />
        )}
        <Button type="submit" variant="outline" icon={<Lightning size={18} />} loading={busy}>
          {label}
        </Button>
      </form>
      {error && <Alert>{error}</Alert>}
      {result && (
        <Alert tone={result.ok ? "info" : "danger"}>
          <span className="flex items-start gap-2">
            {result.ok ? <CheckCircle size={18} weight="fill" className="shrink-0" /> : <WarningCircle size={18} weight="fill" className="shrink-0" />}
            <span>{result.message}</span>
          </span>
        </Alert>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

function RazorpayCard({ view, onSaved }: { view: OwnerView; onSaved: () => unknown }) {
  const toast = useToast();
  const s = useSaver("razorpay", onSaved);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [enabled, setEnabled] = useState(view.enabled || !view.updatedAt);
  const [rotating, setRotating] = useState(false);
  useEffect(() => {
    setKeySecret("");
    setWebhookSecret("");
    setEnabled(view.enabled || !view.updatedAt);
  }, [view.updatedAt, view.enabled]);
  const savedKeyId = view.config.keyId as string | null;

  const save = () => {
    const id = keyId.trim();
    if (!id && !savedKeyId) return s.setError("Enter the key ID");
    void s.save({ enabled, keyId: id, keySecret, webhookSecret }).then(() => setKeyId(""));
  };
  const copy = async () => {
    if (!view.webhookUrl) return;
    await navigator.clipboard.writeText(view.webhookUrl);
    toast("Webhook URL copied", "success");
  };
  const rotate = async () => {
    setRotating(true);
    try {
      await api.post("/integrations/razorpay/webhook-key");
      toast("New webhook URL — update it in Razorpay", "success");
      await onSaved();
    } catch (e) {
      s.setError(errorMessage(e));
    } finally {
      setRotating(false);
    }
  };

  return (
    <Shell
      view={view}
      onSaved={onSaved}
      saving={s.saving}
      error={s.error}
      onSave={save}
      test={<TestBox slug="razorpay" onDone={onSaved} />}
      help={
        <>
          <p>
            <b>Key ID and key secret:</b> Razorpay Dashboard → Account &amp; Settings → API Keys → Generate key. Use <i>Test mode</i> keys (rzp_test_…) to try it out, then
            Live keys (rzp_live_…).
          </p>
          <p>
            <b>Webhook:</b> Razorpay Dashboard → Account &amp; Settings → Webhooks → Add new webhook. Paste the webhook URL shown here, make up a secret and enter the same
            secret here, and tick the events <code>qr_code.credited</code>, <code>refund.processed</code> and <code>refund.failed</code>.
          </p>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Key ID"
          value={keyId}
          onChange={(e) => setKeyId(e.target.value.trim())}
          placeholder={savedKeyId ? `Saved (${savedKeyId}) — leave empty to keep` : "rzp_live_XXXXXXXXXXXX"}
          spellCheck={false}
          hint={view.config.mode ? `Saved key is in ${String(view.config.mode)} mode` : undefined}
        />
        <SecretInput label="Key secret" state={view.secrets.keySecret} value={keySecret} onChange={setKeySecret} placeholder="Key secret" />
        <SecretInput label="Webhook secret" state={view.secrets.webhookSecret} value={webhookSecret} onChange={setWebhookSecret} placeholder="The secret you set on the webhook" hint="Payments confirm automatically only with a webhook." />
      </div>
      {view.webhookUrl && (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Your webhook URL (paste it into Razorpay)</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 px-3 py-2 text-xs">{view.webhookUrl}</code>
            <Button variant="outline" size="sm" icon={<Copy size={18} />} onClick={() => void copy()}>
              Copy
            </Button>
            <Button variant="ghost" size="sm" icon={<ArrowsClockwise size={18} />} loading={rotating} onClick={() => void rotate()}>
              New URL
            </Button>
          </div>
          <p className="text-xs text-muted">Unique to your business. Only payments of your business can be confirmed through it.</p>
        </div>
      )}
      {view.updatedAt && <Toggle checked={enabled} onChange={setEnabled} label="Use my Razorpay account" description="Turn off to stop creating Razorpay QR codes (keys stay saved)." />}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function EmailCard({ view, onSaved }: { view: OwnerView; onSaved: () => unknown }) {
  const s = useSaver("email", onSaved);
  const c = view.config as { host: string | null; port: number | null; secure: boolean | null; user: string | null; fromEmail: string | null; fromName: string | null };
  const [f, setF] = useState({ host: "", port: "587", user: "", password: "", fromEmail: "", fromName: "", enabled: true });
  useEffect(() => {
    setF({ host: c.host ?? "", port: String(c.port ?? 587), user: c.user ?? "", password: "", fromEmail: c.fromEmail ?? "", fromName: c.fromName ?? "", enabled: view.enabled || !view.updatedAt });
  }, [view.updatedAt, view.enabled, c.host, c.port, c.user, c.fromEmail, c.fromName]);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const save = () => {
    const port = Number(f.port);
    if (!f.host.trim()) return s.setError("Enter the SMTP server");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return s.setError("Port is a number, usually 587 or 465");
    void s.save({ enabled: f.enabled, host: f.host.trim(), port, user: f.user.trim(), password: f.password, fromEmail: f.fromEmail.trim(), fromName: f.fromName.trim() });
  };
  return (
    <Shell
      view={view}
      onSaved={onSaved}
      saving={s.saving}
      error={s.error}
      onSave={save}
      test={<TestBox slug="email" needs="email" onDone={onSaved} />}
      help={
        <>
          <p>
            <b>Gmail / Google Workspace:</b> server smtp.gmail.com, port 587, user = your address, password = an <i>App password</i> (Google Account → Security →
            2-Step Verification → App passwords).
          </p>
          <p>
            <b>Zoho:</b> smtp.zoho.in, port 587. <b>Microsoft 365:</b> smtp.office365.com, port 587. <b>Amazon SES / SendGrid / Brevo:</b> the SMTP host and SMTP
            credentials from their console.
          </p>
          <p>Password reset links are always sent by the platform, not from this account.</p>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <Input label="SMTP server" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.gmail.com" spellCheck={false} />
        <Input label="Port" inputMode="numeric" value={f.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} hint="587 (STARTTLS) or 465 (SSL)" />
        <Input label="User name" value={f.user} onChange={(e) => set("user", e.target.value)} placeholder="reports@yourhotel.in" autoComplete="off" />
        <SecretInput label="Password" state={view.secrets.password} value={f.password} onChange={(v) => set("password", v)} placeholder="SMTP / app password" />
        <Input label="From address" type="email" value={f.fromEmail} onChange={(e) => set("fromEmail", e.target.value)} placeholder="reports@yourhotel.in" />
        <Input label="From name" value={f.fromName} onChange={(e) => set("fromName", e.target.value)} placeholder="Spice Garden" />
      </div>
      {view.updatedAt && <Toggle checked={f.enabled} onChange={(v) => set("enabled", v)} label="Use my mail server" />}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

function SmsCard({ view, onSaved }: { view: OwnerView; onSaved: () => unknown }) {
  const s = useSaver("sms", onSaved);
  const c = view.config as { senderId: string | null; otpTemplateId: string | null; alertTemplateId: string | null };
  const [f, setF] = useState({ authKey: "", senderId: "", otpTemplateId: "", alertTemplateId: "", enabled: true });
  useEffect(() => {
    setF({ authKey: "", senderId: c.senderId ?? "", otpTemplateId: c.otpTemplateId ?? "", alertTemplateId: c.alertTemplateId ?? "", enabled: view.enabled || !view.updatedAt });
  }, [view.updatedAt, view.enabled, c.senderId, c.otpTemplateId, c.alertTemplateId]);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Shell
      view={view}
      onSaved={onSaved}
      saving={s.saving}
      error={s.error}
      onSave={() => void s.save({ enabled: f.enabled, authKey: f.authKey.trim(), senderId: f.senderId.trim(), otpTemplateId: f.otpTemplateId.trim(), alertTemplateId: f.alertTemplateId.trim() })}
      test={<TestBox slug="sms" needs="phone" onDone={onSaved} label="Send test SMS" />}
      help={
        <>
          <p>
            <b>Auth key:</b> MSG91 → API (top-right menu) → Auth key. <b>Sender ID</b> is your 6-letter DLT header.
          </p>
          <p>
            <b>Templates:</b> MSG91 → Templates (DLT-approved). The <i>OTP template</i> is used for customer OTP on your online-ordering page; the <i>alert</i> flow
            template must contain the variable <code>##message##</code> and is used for staff SMS alerts.
          </p>
          <p>Staff sign-in OTP and password links are always sent by the platform.</p>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <SecretInput label="Auth key" state={view.secrets.authKey} value={f.authKey} onChange={(v) => set("authKey", v)} placeholder="MSG91 auth key" />
        <Input label="Sender ID (DLT)" value={f.senderId} maxLength={6} onChange={(e) => set("senderId", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} placeholder="SPICEG" />
        <Input label="OTP template ID" value={f.otpTemplateId} onChange={(e) => set("otpTemplateId", e.target.value.trim())} spellCheck={false} />
        <Input label="Alert flow template ID" value={f.alertTemplateId} onChange={(e) => set("alertTemplateId", e.target.value.trim())} spellCheck={false} />
      </div>
      {view.updatedAt && <Toggle checked={f.enabled} onChange={(v) => set("enabled", v)} label="Use my MSG91 account" />}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp (provider + keys; template names live on Settings → WhatsApp templates)
// ---------------------------------------------------------------------------

const PROVIDERS: { value: WhatsAppProvider; label: string; description: string }[] = [
  { value: "NONE", label: "None — click-to-chat", description: "Staff tap Share and WhatsApp opens on their phone with the message ready. Free, nothing to set up." },
  { value: "META", label: "Meta WhatsApp Cloud API", description: "Sent automatically from your business number. Needs a phone number ID and a permanent access token." },
  { value: "WATI", label: "WATI", description: "Sent automatically through your WATI account. Needs your WATI API endpoint and token." },
];

function WhatsAppCard({ view, onSaved }: { view: OwnerView; onSaved: () => unknown }) {
  const s = useSaver("whatsapp", onSaved);
  const c = view.config as { provider: WhatsAppProvider; meta: { phoneNumberId: string | null; language: string } | null; wati: { apiUrl: string | null } | null; autoDeliveryUpdates: boolean; staffAlerts: boolean };
  const init = () => ({
    provider: c.provider ?? "NONE",
    phoneNumberId: c.meta?.phoneNumberId ?? "",
    language: c.meta?.language ?? "en",
    accessToken: "",
    apiUrl: c.wati?.apiUrl ?? "",
    watiToken: "",
    autoDeliveryUpdates: c.autoDeliveryUpdates,
    staffAlerts: c.staffAlerts,
  });
  const [f, setF] = useState(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(init()), [view.updatedAt]);
  const set = <K extends keyof ReturnType<typeof init>>(k: K, v: ReturnType<typeof init>[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = () => {
    const body: Record<string, unknown> = { provider: f.provider, autoDeliveryUpdates: f.autoDeliveryUpdates, staffAlerts: f.staffAlerts };
    if (f.provider === "META") {
      if (!/^\d{6,20}$/.test(f.phoneNumberId)) return s.setError("Phone number ID is the numeric id from Meta's WhatsApp → API setup page");
      body.meta = { phoneNumberId: f.phoneNumberId, language: f.language.trim() || "en", accessToken: f.accessToken.trim() };
    }
    if (f.provider === "WATI") {
      if (!f.apiUrl.trim().startsWith("https://")) return s.setError("WATI API URL must start with https://");
      body.wati = { apiUrl: f.apiUrl.trim(), token: f.watiToken.trim() };
    }
    void s.save(body);
  };
  return (
    <Shell
      view={view}
      onSaved={onSaved}
      saving={s.saving}
      error={s.error}
      onSave={save}
      test={c.provider !== "NONE" ? <TestBox slug="whatsapp" needs="phone?" onDone={onSaved} /> : undefined}
      help={
        <>
          <p>
            <b>Meta:</b> business.facebook.com → WhatsApp Manager → your number → API setup: copy the <i>Phone number ID</i> (digits, not the phone number). Create a
            permanent token: Business settings → Users → System users → Add → Generate token with <code>whatsapp_business_messaging</code>.
          </p>
          <p>
            <b>WATI:</b> WATI dashboard → API Docs: the API endpoint URL and the access token.
          </p>
          <p>
            Message texts are approved by Meta — see{" "}
            <Link className="font-semibold text-primary underline" href="/settings/whatsapp">
              Settings → WhatsApp templates
            </Link>{" "}
            for the template names, variables and a preview.
          </p>
        </>
      }
    >
      <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="WhatsApp provider">
        {PROVIDERS.map((p) => {
          const on = f.provider === p.value;
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => set("provider", p.value)}
              className={clsx("flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors", on ? "border-primary bg-primary-50 ring-1 ring-primary dark:bg-primary/15" : "border-line hover:border-primary/60")}
            >
              <span className="font-semibold">{p.label}</span>
              <span className="text-xs text-muted">{p.description}</span>
            </button>
          );
        })}
      </div>
      {f.provider === "META" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Phone number ID" inputMode="numeric" value={f.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value.replace(/\D/g, ""))} />
          <Input label="Default template language" value={f.language} onChange={(e) => set("language", e.target.value)} placeholder="en" hint="e.g. en, en_US, hi — each template can override it" />
          <SecretInput label="Access token" state={view.secrets.metaAccessToken} value={f.accessToken} onChange={(v) => set("accessToken", v)} placeholder="Permanent access token" />
        </div>
      )}
      {f.provider === "WATI" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="API endpoint" type="url" value={f.apiUrl} onChange={(e) => set("apiUrl", e.target.value)} placeholder="https://live-mt-server.wati.io/123456" />
          <SecretInput label="API token" state={view.secrets.watiToken} value={f.watiToken} onChange={(v) => set("watiToken", v)} placeholder="Bearer token" />
        </div>
      )}
      <div className="space-y-1">
        <Toggle
          checked={f.autoDeliveryUpdates}
          onChange={(v) => set("autoDeliveryUpdates", v)}
          label="Send delivery status updates to customers automatically"
          description={f.provider === "NONE" ? "Needs Meta or WATI." : "Out for delivery, delivered… sent as the delivery moves."}
        />
        <Toggle checked={f.staffAlerts} onChange={(v) => set("staffAlerts", v)} label="Allow staff alerts on WhatsApp" description="Each person turns it on under Notification preferences." />
      </div>
    </Shell>
  );
}
