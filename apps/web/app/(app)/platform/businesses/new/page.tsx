"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, CheckCircle } from "@phosphor-icons/react";
import { MODULE_INFO, businessCreateSchema, type BusinessCreateInput, type ModuleKey } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { platformApi } from "@/lib/platform";
import type { BusinessCreateResult } from "@/lib/types-platform";
import { LinkSentNotice } from "@/components/platform/OwnerDialogs";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Toggle } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { useSession } from "@/components/providers/SessionProvider";
import { canManagePlatform } from "@/lib/roles";
import { ModuleChips, ModulePicker } from "@/components/platform/modules";

const STEPS = ["Business", "Modules", "Owner", "First outlet", "Review"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

interface WizardState {
  name: string;
  legalName: string;
  phone: string;
  email: string;
  notes: string;
  modules: ModuleKey[];
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  withOutlet: boolean;
  outletName: string;
  outletAddress: string;
  stateCode: string;
  gstEnabled: boolean;
}

const INITIAL: WizardState = {
  name: "",
  legalName: "",
  phone: "",
  email: "",
  notes: "",
  modules: ["BILLING", "KOT", "REPORTS"],
  ownerName: "",
  ownerPhone: "",
  ownerEmail: "",
  withOutlet: true,
  outletName: "",
  outletAddress: "",
  stateCode: "",
  gstEnabled: true,
};

const opt = (s: string) => (s.trim() ? s.trim() : undefined);

function toInput(w: WizardState): unknown {
  return {
    name: w.name.trim(),
    legalName: opt(w.legalName),
    phone: opt(w.phone),
    email: opt(w.email),
    notes: opt(w.notes),
    modules: w.modules,
    owner: { name: w.ownerName.trim(), phone: w.ownerPhone.trim(), email: opt(w.ownerEmail) },
    outlet: w.withOutlet
      ? { name: w.outletName.trim(), address: w.outletAddress.trim(), stateCode: w.stateCode, gstEnabled: w.gstEnabled }
      : undefined,
  };
}

/** Which top-level fields each step owns (for step-by-step validation). */
const STEP_FIELDS: Record<Step, string[]> = {
  0: ["name", "legalName", "phone", "email", "notes"],
  1: ["modules"],
  2: ["owner"],
  3: ["outlet"],
  4: [],
};

const FIELD_LABELS: Record<string, string> = {
  owner: "Owner",
  outlet: "Outlet",
  modules: "Modules",
  name: "name",
  legalName: "legal name",
  phone: "phone",
  email: "email",
  stateCode: "state code",
  address: "address",
  gstEnabled: "GST",
};

function stepError(w: WizardState, step: Step): string | null {
  if (step === 2 && !w.ownerEmail.trim()) return "The owner signs in with an email address";
  const parsed = businessCreateSchema.safeParse(toInput(w));
  if (parsed.success) return null;
  const fields = step === 4 ? null : STEP_FIELDS[step];
  const issue = parsed.error.issues.find((i) => !fields || fields.includes(String(i.path[0])));
  if (!issue) return null;
  const path = issue.path.map(String);
  // Human words, never schema keys (QA ui-1: "Outlet stateCode: …").
  const words = path.filter((p) => !/^\d+$/.test(p)).map((p) => FIELD_LABELS[p] ?? p.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  const label = words.join(" ").replace(/^./, (c) => c.toUpperCase());
  return `${label}: ${issue.message}`;
}

/** Onboarding is for super admins; platform support users only look. */
export default function NewBusinessPage() {
  const { me } = useSession();
  if (me && !canManagePlatform(me)) {
    return (
      <PageContainer>
        <Alert tone="warning">Only a super admin can add businesses. Platform support accounts can only view them.</Alert>
      </PageContainer>
    );
  }
  return <NewBusinessWizard />;
}

function NewBusinessWizard() {
  const router = useRouter();
  const [w, setW] = useState<WizardState>(INITIAL);
  const [step, setStep] = useState<Step>(0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<BusinessCreateResult | null>(null);

  const set = <K extends keyof WizardState>(k: K, v: WizardState[K]) => setW((s) => ({ ...s, [k]: v }));

  const next = () => {
    const err = stepError(w, step);
    if (err) return setError(err);
    setError(null);
    setStep((s) => Math.min(4, s + 1) as Step);
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1) as Step);
  };

  const create = async () => {
    const parsed = businessCreateSchema.safeParse(toInput(w));
    if (!parsed.success) return setError(stepError(w, 4));
    setSaving(true);
    setError(null);
    try {
      const body: BusinessCreateInput = parsed.data;
      setDone(await platformApi.post<BusinessCreateResult>("/platform/businesses", body));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <PageContainer>
        <Card className="mx-auto max-w-xl p-8 text-center">
          <CheckCircle size={56} weight="duotone" className="mx-auto text-secondary" />
          <h1 className="mt-3 text-2xl font-extrabold">{done.business.name} is live</h1>
          <p className="mt-1 text-sm text-muted">
            {done.owner.name} signs in with <b>{done.owner.email}</b> after setting a password from the link
            {done.outlet ? <>, then starts billing at {done.outlet.name}.</> : <>. Add an outlet next.</>}
          </p>
          <div className="mt-4 text-left">
            <LinkSentNotice delivery={done.invite} who={done.owner.email ?? `+91 ${done.owner.phone}`} />
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => router.push("/platform/businesses")}>
              All businesses
            </Button>
            <Button onClick={() => router.push(`/platform/businesses/${done.business.id}`)}>Open business</Button>
          </div>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Link data-nav="back" href="/platform/businesses" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft size={16} /> Businesses
      </Link>
      <PageHeader title="New business" subtitle="Onboard a client: their details, modules, owner login and first outlet." />

      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > step}
              onClick={() => i < step && setStep(i as Step)}
              aria-current={i === step ? "step" : undefined}
              className={clsx(
                "flex min-h-[40px] items-center gap-2 rounded-full border px-3 text-sm font-semibold",
                i === step ? "border-primary bg-primary text-primary-fg" : i < step ? "border-secondary/40 bg-secondary-50 text-secondary-700 dark:bg-secondary/20 dark:text-green-200" : "border-line text-muted",
              )}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs">{i < step ? <Check size={12} weight="bold" /> : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <Card className="max-w-3xl">
        <div className="space-y-4 p-5">
          {error && <Alert>{error}</Alert>}

          {step === 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Business name" maxLength={120} value={w.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Hotel Annapurna" data-autofocus />
              <Input label="Legal name" maxLength={200} value={w.legalName} onChange={(e) => set("legalName", e.target.value)} hint="Optional — as registered" />
              <Input label="Contact phone" maxLength={20} value={w.phone} onChange={(e) => set("phone", e.target.value)} />
              <Input label="Contact email" type="email" value={w.email} onChange={(e) => set("email", e.target.value)} />
              <div className="sm:col-span-2">
                <Textarea label="Notes (internal)" maxLength={1000} value={w.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Plan, billing contact, onboarding notes…" />
              </div>
            </div>
          )}

          {step === 1 && (
            <ModulePicker
              value={w.modules}
              note={note}
              onChange={(modules, n) => {
                set("modules", modules);
                setNote(n);
              }}
            />
          )}

          {step === 2 && (
            <>
              <p className="text-sm text-muted">The business owner manages all outlets, staff and settings of {w.name || "the business"}.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Owner name" maxLength={100} value={w.ownerName} onChange={(e) => set("ownerName", e.target.value)} />
                <Input
                  label="Owner mobile"
                  inputMode="numeric"
                  maxLength={10}
                  prefix={<span className="text-sm font-semibold">+91</span>}
                  className="pl-12"
                  value={w.ownerPhone}
                  onChange={(e) => set("ownerPhone", e.target.value.replace(/\D/g, ""))}
                />
                <Input label="Owner email (login)" type="email" autoComplete="off" value={w.ownerEmail} onChange={(e) => set("ownerEmail", e.target.value)} />
              </div>
              <p className="text-xs text-muted">The owner gets a link by email (or SMS) to set their own password. You never see it. Until then they can sign in with an OTP on their mobile.</p>
            </>
          )}

          {step === 3 && (
            <>
              <Toggle label="Create the first outlet now" description="You can also let the owner add outlets later." checked={w.withOutlet} onChange={(v) => set("withOutlet", v)} />
              {w.withOutlet && (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input label="Outlet name" maxLength={120} value={w.outletName} onChange={(e) => set("outletName", e.target.value)} placeholder="e.g. Main branch" />
                    <Input
                      label="State code"
                      maxLength={2}
                      inputMode="numeric"
                      value={w.stateCode}
                      onChange={(e) => set("stateCode", e.target.value.replace(/\D/g, ""))}
                      hint="Two-digit GST state code, e.g. 29 Karnataka"
                    />
                  </div>
                  <Textarea label="Address" maxLength={500} value={w.outletAddress} onChange={(e) => set("outletAddress", e.target.value)} />
                  <div className="rounded-xl border border-line p-4">
                    <Toggle
                      label="GST registered"
                      description={w.gstEnabled ? "Bills are tax invoices with GST lines. The owner adds the GSTIN in settings." : "Plain bills (“BILL”) with no tax and no GSTIN — for unregistered shops."}
                      checked={w.gstEnabled}
                      onChange={(v) => set("gstEnabled", v)}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {step === 4 && (
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <Review label="Business">
                <b>{w.name}</b>
                {w.legalName && <span className="block text-muted">{w.legalName}</span>}
                {(w.phone || w.email) && <span className="block text-muted">{[w.phone, w.email].filter(Boolean).join(" · ")}</span>}
              </Review>
              <Review label="Owner">
                <b>{w.ownerName}</b>
                <span className="block text-muted">
                  +91 {w.ownerPhone} · {w.ownerEmail}
                </span>
              </Review>
              <Review label={`Modules (${w.modules.length})`}>
                <ModuleChips modules={w.modules} />
                <span className="mt-1 block text-xs text-muted">{w.modules.map((m) => MODULE_INFO[m].label).join(", ")}</span>
              </Review>
              <Review label="First outlet">
                {w.withOutlet ? (
                  <>
                    <b>{w.outletName}</b> · state {w.stateCode}
                    <span className="block text-muted">{w.gstEnabled ? "GST registered" : "Not GST registered (plain bills)"}</span>
                  </>
                ) : (
                  <span className="text-muted">None — the owner will add outlets</span>
                )}
              </Review>
            </dl>
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" icon={<ArrowLeft size={18} />} onClick={back} disabled={step === 0 || saving}>
            Back
          </Button>
          {step < 4 ? (
            <Button onClick={next}>
              Next <ArrowRight size={18} />
            </Button>
          ) : (
            <Button variant="secondary" icon={<Check size={18} />} loading={saving} onClick={create}>
              Create business
            </Button>
          )}
        </div>
      </Card>
    </PageContainer>
  );
}

function Review({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <dt className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
