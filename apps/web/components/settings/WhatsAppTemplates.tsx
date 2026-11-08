"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowSquareOut, FloppyDisk, PaperPlaneTilt, WhatsappLogo } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import type { WhatsAppProvider, WhatsAppSendResult } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

type Purpose = "receipt" | "khata_reminder" | "birthday" | "anniversary" | "delivery_update" | "staff_alert" | "test";

/** GET /integrations/whatsapp/templates */
interface TemplateRow {
  purpose: Purpose;
  label: string;
  description: string;
  category: "UTILITY" | "MARKETING";
  variables: { name: string; sample: string }[];
  suggestedBody: string;
  defaultName: string;
  name: string | null;
  language: string | null;
  body: string | null;
  effectiveName: string;
  effectiveLanguage: string;
  preview: string;
}
interface TemplatesView {
  provider: WhatsAppProvider;
  editable: boolean;
  defaultLanguage: string;
  metaManagerUrl: string;
  purposes: TemplateRow[];
}
type Draft = Record<Purpose, { name: string; language: string; body: string }>;

const render = (body: string, values: string[]) => body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => values[Number(n) - 1] ?? m);

/** Settings → WhatsApp templates: what each message looks like, which approved template it uses, and a test send. */
export function WhatsAppTemplates() {
  const { me } = useSession();
  const toast = useToast();
  const bizId = me?.business?.id ?? null;
  const q = useApiQuery<TemplatesView>(bizId ? `wa-templates:${bizId}` : null, () => api.get<TemplatesView>("/integrations/whatsapp/templates"));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.purposes.map((p) => [p.purpose, { name: p.name ?? "", language: p.language ?? "", body: p.body ?? "" }])) as Draft);
  }, [q.data]);

  if (q.loading && !q.data) return <Card><LoadingState /></Card>;
  if (q.error) return <Card><ErrorState message={q.error} onRetry={q.reload} /></Card>;
  if (!q.data || !draft) return null;
  const v = q.data;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.put("/integrations/whatsapp/templates", { templates: draft });
      toast("Templates saved", "success");
      await q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <HowTo view={v} />
      {error && <Alert>{error}</Alert>}
      {v.purposes.map((p) => (
        <TemplateCard
          key={p.purpose}
          row={p}
          view={v}
          draft={draft[p.purpose]}
          onChange={(d) => setDraft({ ...draft, [p.purpose]: d })}
          saving={saving}
          onSave={() => void save()}
        />
      ))}
    </div>
  );
}

function HowTo({ view }: { view: TemplatesView }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <WhatsappLogo size={22} /> How WhatsApp templates work
          </span>
        }
        subtitle="Messages a business starts (receipts, reminders, wishes) must use a template that Meta has approved. The text is written and approved in Meta — CANAVO fills in the variables."
      />
      <div className="space-y-3 p-5 text-sm">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Open{" "}
            <a href={view.metaManagerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary underline">
              Meta WhatsApp Manager → Message templates <ArrowSquareOut size={14} />
            </a>{" "}
            (or WATI → Templates if you use WATI) and click <b>Create template</b>.
          </li>
          <li>
            Pick the <b>category</b> shown on the card below (Utility or Marketing), a <b>name</b> (lowercase with underscores, e.g. <code>order_receipt</code>) and the
            <b> language</b>.
          </li>
          <li>
            Write the body. Use <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code>… exactly in the order of the variables listed on the card — CANAVO sends them in that order.
            You can start from the suggested text.
          </li>
          <li>Submit. Approval usually takes minutes, sometimes up to a day. To change an approved text, edit the template in WhatsApp Manager (it is reviewed again).</li>
          <li>
            Back here, enter the same <b>template name</b> and <b>language</b>, paste your approved text (for the preview only), save, and use <b>Send test</b>.
          </li>
        </ol>
        {view.provider === "NONE" && (
          <Alert tone="warning">
            No WhatsApp API is connected, so messages open as click-to-chat links and templates aren&apos;t used.{" "}
            {view.editable && (
              <Link href="/settings/integrations" className="font-semibold underline">
                Connect Meta or WATI in Integrations
              </Link>
            )}
          </Alert>
        )}
        {!view.editable && <Alert tone="info">Only the owner can change templates.</Alert>}
      </div>
    </Card>
  );
}

function TemplateCard({
  row,
  view,
  draft,
  onChange,
  saving,
  onSave,
}: {
  row: TemplateRow;
  view: TemplatesView;
  draft: { name: string; language: string; body: string };
  onChange: (d: { name: string; language: string; body: string }) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const values = row.variables.map((x) => x.sample);
  const preview = render(draft.body || row.suggestedBody, values);
  const name = draft.name || row.defaultName;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {row.label} <Badge tone={row.category === "MARKETING" ? "warning" : "neutral"}>{row.category === "MARKETING" ? "Marketing" : "Utility"}</Badge>
          </span>
        }
        subtitle={row.description}
        action={
          view.editable && (
            <Button size="sm" icon={<FloppyDisk size={18} />} loading={saving} onClick={onSave}>
              Save
            </Button>
          )
        }
      />
      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <fieldset disabled={!view.editable || saving} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <Input
              label="Template name"
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value.trim() })}
              placeholder={row.defaultName}
              spellCheck={false}
              hint={draft.name ? undefined : `Empty = ${row.defaultName}`}
            />
            <Input label="Language" value={draft.language} onChange={(e) => onChange({ ...draft, language: e.target.value.trim() })} placeholder={view.defaultLanguage} hint={draft.language ? undefined : `Empty = ${view.defaultLanguage}`} />
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold">Variables CANAVO sends (in this order)</p>
            {row.variables.length ? (
              <ol className="space-y-1 text-sm">
                {row.variables.map((x, n) => (
                  <li key={x.name} className="flex flex-wrap items-baseline gap-2">
                    <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-semibold">{`{{${n + 1}}}`}</code>
                    <span className="font-medium">{x.name}</span>
                    <span className="break-all text-xs text-muted">e.g. {x.sample}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">None — Meta&apos;s sample <code>hello_world</code> template takes no variables.</p>
            )}
          </div>
          <Textarea
            label="Approved text (for the preview only)"
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            placeholder={row.suggestedBody}
            rows={3}
            maxLength={1024}
          />
          {view.editable && !draft.body && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, body: row.suggestedBody })}>
              Use the suggested text
            </Button>
          )}
        </fieldset>
        <div className="space-y-3">
          <p className="text-sm font-semibold">Preview</p>
          <div className="rounded-2xl bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
            <div className="max-w-sm rounded-xl rounded-tl-none bg-white px-3 py-2 text-sm text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
              <p className="whitespace-pre-wrap break-words">{preview}</p>
              <p className="mt-1 text-right text-[11px] text-[#667781] dark:text-[#8696a0]">
                {name} · {draft.language || view.defaultLanguage}
              </p>
            </div>
          </div>
          {view.editable && <SendTest purpose={row.purpose} disabled={view.provider === "NONE"} />}
        </div>
      </div>
    </Card>
  );
}

function SendTest({ purpose, disabled }: { purpose: Purpose; disabled: boolean }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WhatsAppSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<WhatsAppSendResult>(`/integrations/whatsapp/templates/${purpose}/test`, { phone }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          wrapperClassName="min-w-[180px] flex-1"
          aria-label="Mobile number for the test"
          inputMode="numeric"
          placeholder="10-digit mobile"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
        />
        <Button type="submit" variant="outline" icon={<PaperPlaneTilt size={18} />} loading={busy} disabled={disabled || phone.length !== 10}>
          Send test
        </Button>
      </form>
      <p className="text-xs text-muted">Sends this message with the sample values above, using the saved name and language — save first.</p>
      {error && <Alert>{error}</Alert>}
      {result &&
        (result.method === "sent" ? (
          <Alert tone="info">Sent through {result.provider === "META" ? "Meta" : "WATI"}. Check the phone.</Alert>
        ) : (
          <Alert>
            Not sent{result.error ? `: ${result.error}` : ""}.{" "}
            <a href={result.waLink} target="_blank" rel="noreferrer" className="font-semibold underline">
              Open as click-to-chat
            </a>
          </Alert>
        ))}
    </div>
  );
}
