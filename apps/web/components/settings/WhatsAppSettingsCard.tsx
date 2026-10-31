"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { FloppyDisk, PaperPlaneTilt, WhatsappLogo } from "@phosphor-icons/react";
import { indianPhone } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { WhatsAppProvider, WhatsAppSendResult } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

export type WaPurpose = "receipt" | "khata_reminder" | "birthday" | "anniversary" | "delivery_update" | "staff_alert" | "test";

/** GET /admin/whatsapp (tokens are masked as "••••abcd"). */
export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  /** No saved setup: the server's own WATI account (env) is used */
  fromEnv: boolean;
  meta: { phoneNumberId: string; language: string; token: string | null } | null;
  wati: { apiUrl: string; token: string | null } | null;
  templates: Record<WaPurpose, string>;
  defaultTemplates: Record<WaPurpose, string>;
  autoDeliveryUpdates: boolean;
  staffAlerts: boolean;
}

const PROVIDERS: { value: WhatsAppProvider; label: string; description: string }[] = [
  {
    value: "NONE",
    label: "None — click-to-chat links",
    description: "Staff tap Share and WhatsApp opens on their device with the message ready to send. Free, nothing to set up.",
  },
  {
    value: "META",
    label: "Meta WhatsApp Cloud API",
    description: "Messages are sent automatically from your business number through Meta. Needs a Meta Business account, a phone number ID and an access token.",
  },
  {
    value: "WATI",
    label: "WATI",
    description: "Messages are sent automatically through your WATI account. Needs your WATI API endpoint and token.",
  },
];

const PURPOSES: { key: WaPurpose; label: string; description: string; params: string[] }[] = [
  { key: "receipt", label: "Receipt", description: "Bill shared from Bills / POS", params: ["outlet", "invoice", "amount", "link"] },
  { key: "khata_reminder", label: "Khata reminder", description: "Credit balance reminder to a customer", params: ["name", "outlet", "amount"] },
  { key: "birthday", label: "Birthday", description: "Birthday wish with a coupon", params: ["name", "outlet", "coupon code"] },
  { key: "anniversary", label: "Anniversary", description: "Anniversary wish with a coupon", params: ["name", "outlet", "coupon code"] },
  { key: "delivery_update", label: "Delivery update", description: "Delivery status sent to the customer", params: ["outlet", "invoice", "status message"] },
  { key: "staff_alert", label: "Staff alert", description: "Alerts to staff who turned WhatsApp on", params: ["title", "body"] },
  { key: "test", label: "Test", description: "The test message on this page", params: [] },
];

interface Form {
  provider: WhatsAppProvider;
  phoneNumberId: string;
  accessToken: string;
  language: string;
  apiUrl: string;
  watiToken: string;
  templates: Record<WaPurpose, string>;
  autoDeliveryUpdates: boolean;
  staffAlerts: boolean;
}

function toForm(c: WhatsAppConfig): Form {
  // Only names that differ from the default are shown; the default is the placeholder.
  const templates = Object.fromEntries(
    PURPOSES.map(({ key }) => [key, c.templates[key] && c.templates[key] !== c.defaultTemplates[key] ? c.templates[key] : ""]),
  ) as Record<WaPurpose, string>;
  return {
    provider: c.provider,
    phoneNumberId: c.meta?.phoneNumberId ?? "",
    accessToken: "",
    language: c.meta?.language ?? "en",
    apiUrl: c.wati?.apiUrl ?? "",
    watiToken: "",
    templates,
    autoDeliveryUpdates: c.autoDeliveryUpdates,
    staffAlerts: c.staffAlerts,
  };
}

/** Settings → WhatsApp: provider, keys, approved template names, automatic messages and a test send. */
export function WhatsAppSettingsCard() {
  const { me, can } = useSession();
  const toast = useToast();
  const editable = can("settings:outlet");
  const bizId = me?.business?.id ?? null;
  const config = useApiQuery<WhatsAppConfig>(bizId && editable ? `whatsapp:${bizId}` : null, () => api.get<WhatsAppConfig>("/admin/whatsapp"));
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config.data) setForm(toForm(config.data));
  }, [config.data]);

  if (config.loading && !config.data) return <Card><LoadingState /></Card>;
  if (config.error) return <Card><ErrorState message={config.error} onRetry={config.reload} /></Card>;
  if (!form || !config.data) return null;
  const c = config.data;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    setError(null);
    const body: Record<string, unknown> = {
      provider: form.provider,
      templates: Object.fromEntries(Object.entries(form.templates).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)),
      autoDeliveryUpdates: form.autoDeliveryUpdates,
      staffAlerts: form.staffAlerts,
    };
    if (form.provider === "META") {
      const phoneNumberId = form.phoneNumberId.replace(/\s/g, "");
      if (!/^\d{6,20}$/.test(phoneNumberId)) return setError("Phone number ID is the numeric id from Meta's WhatsApp → API setup page");
      if (!form.accessToken.trim() && !c.meta?.token) return setError("Enter the Meta access token");
      body.meta = { phoneNumberId, language: form.language.trim() || "en", ...(form.accessToken.trim() && { accessToken: form.accessToken.trim() }) };
    }
    if (form.provider === "WATI") {
      const apiUrl = form.apiUrl.trim();
      if (!apiUrl.startsWith("https://")) return setError("WATI API URL must start with https://");
      if (!form.watiToken.trim() && !c.wati?.token) return setError("Enter the WATI API token");
      body.wati = { apiUrl, ...(form.watiToken.trim() && { token: form.watiToken.trim() }) };
    }
    setSaving(true);
    try {
      await api.put("/admin/whatsapp", body);
      toast("WhatsApp settings saved", "success");
      await config.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const usingEnv = c.fromEnv && !c.meta && !c.wati;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="WhatsApp messages"
          subtitle="How receipts, khata reminders, wishes and delivery updates reach your customers."
          action={
            editable && (
              <Button icon={<FloppyDisk size={20} />} onClick={() => void save()} loading={saving}>
                Save
              </Button>
            )
          }
        />
        <fieldset disabled={!editable || saving} className="space-y-6 p-5">
          {error && <Alert>{error}</Alert>}
          {usingEnv && <Alert tone="info">Using the server&apos;s WATI account. Save your own provider below to send from your business number.</Alert>}

          <section className="space-y-2" aria-label="Provider">
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted">Provider</h3>
            <div className="grid gap-2 md:grid-cols-3" role="radiogroup">
              {PROVIDERS.map((p) => {
                const on = form.provider === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set("provider", p.value)}
                    className={clsx(
                      "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors",
                      on ? "border-primary bg-primary-50 ring-1 ring-primary dark:bg-primary/15" : "border-line hover:border-primary/60",
                    )}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span className={clsx("flex h-4 w-4 items-center justify-center rounded-full border-2", on ? "border-primary" : "border-line")}>
                        {on && <span className="h-2 w-2 rounded-full bg-primary" />}
                      </span>
                      {p.label}
                    </span>
                    <span className="text-xs text-muted">{p.description}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {form.provider === "META" && (
            <section className="grid gap-4 md:grid-cols-2" aria-label="Meta WhatsApp Cloud API">
              <Input
                label="Phone number ID"
                inputMode="numeric"
                value={form.phoneNumberId}
                onChange={(e) => set("phoneNumberId", e.target.value.replace(/[^\d]/g, ""))}
                hint="Meta Business → WhatsApp → API setup (digits only, not the phone number)"
              />
              <Input
                label="Template language"
                value={form.language}
                onChange={(e) => set("language", e.target.value)}
                placeholder="en"
                hint="Language code of your approved templates, e.g. en or en_US"
              />
              <Input
                label="Access token"
                type="password"
                autoComplete="new-password"
                wrapperClassName="md:col-span-2"
                value={form.accessToken}
                onChange={(e) => set("accessToken", e.target.value)}
                placeholder={c.meta?.token ?? "Permanent access token"}
                hint={c.meta?.token ? "Saved — leave blank to keep it" : "A permanent (system user) token with whatsapp_business_messaging"}
              />
            </section>
          )}

          {form.provider === "WATI" && (
            <section className="grid gap-4 md:grid-cols-2" aria-label="WATI">
              <Input
                label="API endpoint"
                type="url"
                value={form.apiUrl}
                onChange={(e) => set("apiUrl", e.target.value)}
                placeholder="https://live-mt-server.wati.io/123456"
                hint="WATI → API Docs: the API endpoint URL"
              />
              <Input
                label="API token"
                type="password"
                autoComplete="new-password"
                value={form.watiToken}
                onChange={(e) => set("watiToken", e.target.value)}
                placeholder={c.wati?.token ?? "Bearer token"}
                hint={c.wati?.token ? "Saved — leave blank to keep it" : "WATI → API Docs: the access token"}
              />
            </section>
          )}

          <section className="space-y-1" aria-label="Automatic messages">
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted">Automatic messages</h3>
            <Toggle
              checked={form.autoDeliveryUpdates}
              onChange={(v) => set("autoDeliveryUpdates", v)}
              label="Send delivery status updates to customers automatically"
              description={form.provider === "NONE" ? "Needs Meta or WATI — with click-to-chat, staff send updates by hand." : "Out for delivery, delivered… sent as the delivery moves."}
            />
            <Toggle
              checked={form.staffAlerts}
              onChange={(v) => set("staffAlerts", v)}
              label="Allow staff alerts on WhatsApp"
              description="Each person turns it on under Notification preferences."
            />
          </section>
        </fieldset>
      </Card>

      <Card>
        <CardHeader
          title="Message templates"
          subtitle="Business-initiated WhatsApp messages must use templates approved in Meta Business Manager / WATI, with the parameters in this order."
        />
        <fieldset disabled={!editable || saving}>
          <Table>
            <THead>
              <tr>
                <Th>Purpose</Th>
                <Th>Parameters (in order)</Th>
                <Th className="min-w-[200px]">Template name</Th>
              </tr>
            </THead>
            <tbody>
              {PURPOSES.map((p) => (
                <tr key={p.key}>
                  <Td>
                    <span className="block font-semibold">{p.label}</span>
                    <span className="block text-xs text-muted">{p.description}</span>
                  </Td>
                  <Td className="text-muted">
                    {p.params.length ? (
                      <ol className="flex flex-wrap gap-1">
                        {p.params.map((x, n) => (
                          <li key={x} className="whitespace-nowrap rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg">
                            {`{{${n + 1}}}`} {x}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <span className="text-xs">No parameters</span>
                    )}
                  </Td>
                  <Td>
                    <Input
                      aria-label={`${p.label} template name`}
                      value={form.templates[p.key]}
                      onChange={(e) => set("templates", { ...form.templates, [p.key]: e.target.value })}
                      placeholder={c.defaultTemplates[p.key] || "template_name"}
                      maxLength={512}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </fieldset>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Leave a name blank to use the default shown. Click Save above to apply changes.</p>
      </Card>

      {editable && <TestMessageCard provider={c.provider} />}
    </div>
  );
}

/** Sends the "test" template through the saved provider (or returns a click-to-chat link). */
function TestMessageCard({ provider }: { provider: WhatsAppProvider }) {
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WhatsAppSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const parsed = indianPhone.safeParse(phone);
    if (!parsed.success) return setPhoneError(parsed.error.issues[0].message);
    setPhoneError(null);
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await api.post<WhatsAppSendResult>("/admin/whatsapp/test", { phone: parsed.data }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Send test message" subtitle="Uses the saved settings — save your changes first." />
      <div className="space-y-4 p-5">
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            wrapperClassName="min-w-[200px] flex-1 sm:max-w-xs"
            aria-label="Phone number for the test"
            inputMode="numeric"
            maxLength={10}
            placeholder="10-digit mobile"
            value={phone}
            error={phoneError}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          />
          <Button type="submit" variant="secondary" icon={<PaperPlaneTilt size={20} />} loading={busy}>
            Send test
          </Button>
        </form>
        {error && <Alert>{error}</Alert>}
        {result &&
          (result.method === "sent" ? (
            <Alert tone="info">
              Sent through {result.provider === "META" ? "Meta" : result.provider === "WATI" ? "WATI" : "WhatsApp"}.
              {result.messageId && <span className="mt-0.5 block break-all text-xs">Message id: {result.messageId}</span>}
            </Alert>
          ) : (
            <div className="space-y-2">
              {result.error ? (
                <Alert>WhatsApp API failed: {result.error}</Alert>
              ) : (
                <Alert tone="info">
                  {provider === "NONE" ? "No provider is set up, so messages open as click-to-chat links." : "The message was not sent automatically."}
                </Alert>
              )}
              {result.waLink && (
                <a
                  href={result.waLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-bold text-white hover:bg-green-700"
                >
                  <WhatsappLogo size={20} weight="fill" /> Open in WhatsApp
                </a>
              )}
            </div>
          ))}
      </div>
    </Card>
  );
}
