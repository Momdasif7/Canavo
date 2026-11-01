"use client";

import { useState } from "react";
import { Briefcase, DownloadSimple, Plus, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { downloadApiFile } from "@/lib/download";
import { formatDateTime, parseRupees, rupeesInput } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Toggle } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

interface Account {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  gstin: string | null;
  billingCycle: "MONTHLY" | "WEEKLY";
  creditLimit: number;
  dailyMealLimit: number | null;
  active: boolean;
  outstanding: number;
  _count: { members: number };
}
interface Rule {
  id: string;
  mealSlotId: string | null;
  type: "PERCENT" | "FLAT";
  value: number;
  maxPerMeal: number | null;
  maxPerDay: number | null;
  slotMealLimit: number | null;
  active: boolean;
}
interface Statement {
  id: string;
  periodFrom: string;
  periodTo: string;
  meals: number;
  amount: number;
  status: "INVOICED" | "PAID";
  invoiceRef: string | null;
  createdAt: string;
  paidAt: string | null;
}
interface StatementView {
  rows: { date: string; bill: string; member: string; employeeCode: string; department: string; slot: string; billTotal: number; amount: number }[];
  totals: { meals: number; billTotal: number; employerShare: number; refunds: number; net: number };
}

const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const todayYmd = () => new Date().toISOString().slice(0, 10);
const optInt = (v: string) => (v.trim() ? Number(v) : null);
const optPaise = (v: string) => (v.trim() ? parseRupees(v) : null);

function describeRule(r: Rule, slotName: (id: string | null) => string) {
  const pays = r.type === "PERCENT" ? `${r.value}% of the meal` : `${formatINR(r.value)} a meal`;
  const caps = [r.maxPerMeal != null && `up to ${formatINR(r.maxPerMeal)} a meal`, r.maxPerDay != null && `${formatINR(r.maxPerDay)} a day`].filter(Boolean).join(", ");
  return `${slotName(r.mealSlotId)}: company pays ${pays}${caps ? ` (${caps})` : ""}${r.slotMealLimit != null ? ` · max ${r.slotMealLimit} meal(s) a day in this slot` : ""}`;
}

/** Canteen → Corporate accounts (Phase 5.1): companies, subsidy rules and monthly statements. */
export default function CorporateAccountsPage() {
  const { outletId } = useSession();
  const toast = useToast();
  const list = useApiQuery(outletId ? `canteen-accounts:${outletId}` : null, () => api.get<Account[]>("/canteen/accounts"));
  const slots = useApiQuery(outletId ? `meal-slots:${outletId}` : null, () => api.get<{ id: string; name: string }[]>("/canteen/rule-slots"));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const account = list.data?.find((a) => a.id === selected) ?? null;

  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <PageContainer>
      <PageHeader
        title="Corporate accounts"
        subtitle="Companies whose employees eat here: what the company pays per meal, meal limits, and the monthly statement you bill them."
        actions={
          <Button icon={<Plus size={20} />} onClick={() => setEditing("new")}>
            Add company
          </Button>
        }
      />
      {editing && (
        <AccountForm
          account={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(a) => {
            setEditing(null);
            setSelected(a.id);
            toast(`${a.name} saved`, "success");
            void list.reload();
          }}
        />
      )}
      {!list.data ? (
        <LoadingState />
      ) : list.data.length === 0 ? (
        <EmptyState title="No corporate accounts yet" description="Add a company, then set what it pays per meal and import its employees under Members & cards." />
      ) : (
        <Card className="mb-5">
          <Table>
            <THead>
              <tr>
                <Th>Company</Th>
                <Th className="text-right">Members</Th>
                <Th className="text-right">Unpaid</Th>
                <Th className="text-right">Credit limit</Th>
                <Th>Meals / day</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className={a.id === selected ? "bg-primary-50/60 dark:bg-primary/10" : undefined}>
                  <Td>
                    <button type="button" className="font-semibold hover:underline" onClick={() => setSelected(a.id)}>
                      {a.name}
                    </button>
                    {!a.active && (
                      <Badge tone="warning" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                    {a.gstin && <span className="block text-xs text-muted">GSTIN {a.gstin}</span>}
                  </Td>
                  <Td className="tabular text-right">{a._count.members}</Td>
                  <Td className="tabular text-right">{formatINR(a.outstanding)}</Td>
                  <Td className="tabular text-right">{a.creditLimit ? formatINR(a.creditLimit) : "No limit"}</Td>
                  <Td>{a.dailyMealLimit ?? "No limit"}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {account && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Rules account={account} slots={slots.data ?? []} />
          <Statements account={account} onChange={() => void list.reload()} />
        </div>
      )}
    </PageContainer>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: (a: Account) => void }) {
  const [f, setF] = useState({
    name: account?.name ?? "",
    contactName: account?.contactName ?? "",
    contactPhone: account?.contactPhone ?? "",
    contactEmail: account?.contactEmail ?? "",
    gstin: account?.gstin ?? "",
    billingCycle: account?.billingCycle ?? "MONTHLY",
    creditLimit: account?.creditLimit ? rupeesInput(account.creditLimit) : "",
    dailyMealLimit: account?.dailyMealLimit != null ? String(account.dailyMealLimit) : "",
    active: account?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: f.name.trim(),
        contactName: f.contactName.trim() || undefined,
        contactPhone: f.contactPhone.trim() || undefined,
        contactEmail: f.contactEmail.trim() || undefined,
        gstin: f.gstin.trim() || undefined,
        billingCycle: f.billingCycle,
        creditLimit: parseRupees(f.creditLimit) ?? 0,
        dailyMealLimit: optInt(f.dailyMealLimit),
        active: f.active,
      };
      onSaved(account ? await api.patch<Account>(`/canteen/accounts/${account.id}`, body) : await api.post<Account>("/canteen/accounts", body));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-5">
      <CardHeader title={account ? `Edit ${account.name}` : "Add company"} />
      <div className="space-y-3 p-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Company name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          <Input label="GSTIN (optional)" value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} />
          <Select label="Billing cycle" value={f.billingCycle} onChange={(e) => set({ billingCycle: e.target.value as "MONTHLY" | "WEEKLY" })}>
            <option value="MONTHLY">Monthly</option>
            <option value="WEEKLY">Weekly</option>
          </Select>
          <Input label="Contact person" value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} />
          <Input label="Contact phone" inputMode="numeric" value={f.contactPhone} onChange={(e) => set({ contactPhone: e.target.value.replace(/\D/g, "") })} />
          <Input label="Contact email" type="email" value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} />
          <Input label="Credit limit (₹)" inputMode="decimal" prefix="₹" value={f.creditLimit} onChange={(e) => set({ creditLimit: e.target.value })} hint="Unpaid company share allowed. Empty = no limit." />
          <Input label="Meals per employee per day" inputMode="numeric" value={f.dailyMealLimit} onChange={(e) => set({ dailyMealLimit: e.target.value.replace(/\D/g, "") })} hint="Empty = no limit." />
          <div className="flex items-end pb-2">
            <Toggle label="Active" checked={f.active} onChange={(active) => set({ active })} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button loading={busy} disabled={f.name.trim().length < 2} onClick={() => void save()}>
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Rules({ account, slots }: { account: Account; slots: { id: string; name: string }[] }) {
  const rules = useApiQuery(`canteen-rules:${account.id}`, () => api.get<Rule[]>(`/canteen/accounts/${account.id}/rules`));
  const [f, setF] = useState({ mealSlotId: "", type: "PERCENT" as Rule["type"], value: "", maxPerMeal: "", maxPerDay: "", slotMealLimit: "" });
  const [error, setError] = useState<string | null>(null);
  const slotName = (id: string | null) => (id ? (slots.find((s) => s.id === id)?.name ?? "Meal slot") : "Every meal");
  const add = async () => {
    setError(null);
    try {
      await api.post(`/canteen/accounts/${account.id}/rules`, {
        mealSlotId: f.mealSlotId || null,
        type: f.type,
        value: f.type === "PERCENT" ? Number(f.value) : (parseRupees(f.value) ?? 0),
        maxPerMeal: optPaise(f.maxPerMeal),
        maxPerDay: optPaise(f.maxPerDay),
        slotMealLimit: optInt(f.slotMealLimit),
      });
      setF({ mealSlotId: "", type: "PERCENT", value: "", maxPerMeal: "", maxPerDay: "", slotMealLimit: "" });
      void rules.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader title={`What ${account.name} pays`} subtitle="A rule for a meal slot wins over the 'every meal' rule. The employee pays the rest." />
      <div className="space-y-3 p-5">
        {(rules.data ?? []).length === 0 && <p className="text-sm text-muted">No subsidy yet: employees pay the full price.</p>}
        <ul className="space-y-2">
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
              <span className="flex-1">{describeRule(r, slotName)}</span>
              <IconButton label="Delete rule" onClick={() => void api.del(`/canteen/rules/${r.id}`).then(() => rules.reload())}>
                <Trash size={18} />
              </IconButton>
            </li>
          ))}
        </ul>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Meal" value={f.mealSlotId} onChange={(e) => setF({ ...f, mealSlotId: e.target.value })}>
            <option value="">Every meal</option>
            {slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select label="Company pays" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Rule["type"] })}>
            <option value="PERCENT">% of the meal</option>
            <option value="FLAT">Fixed ₹ per meal</option>
          </Select>
          <Input label={f.type === "PERCENT" ? "Percent" : "Amount (₹)"} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          <Input label="Max per meal (₹)" inputMode="decimal" value={f.maxPerMeal} onChange={(e) => setF({ ...f, maxPerMeal: e.target.value })} />
          <Input label="Max per day (₹)" inputMode="decimal" value={f.maxPerDay} onChange={(e) => setF({ ...f, maxPerDay: e.target.value })} />
          <Input label="Meals a day in this slot" inputMode="numeric" value={f.slotMealLimit} onChange={(e) => setF({ ...f, slotMealLimit: e.target.value.replace(/\D/g, "") })} />
        </div>
        <Button size="sm" icon={<Plus size={18} />} disabled={!f.value.trim()} onClick={() => void add()}>
          Add rule
        </Button>
      </div>
    </Card>
  );
}

function Statements({ account, onChange }: { account: Account; onChange: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayYmd());
  const [invoiceRef, setInvoiceRef] = useState("");
  const [view, setView] = useState<StatementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useApiQuery(`canteen-statements:${account.id}`, () => api.get<Statement[]>(`/canteen/accounts/${account.id}/statements`));
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader title="Statements" subtitle="The company's share of its employees' meals for a period. Raise it as an invoice, then mark it paid." />
      <div className="space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input label="Invoice no. (optional)" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void run(async () => setView(await api.get<StatementView>(`/canteen/accounts/${account.id}/statement`, { query: { from, to } })))}>
            Show
          </Button>
          <Button size="sm" variant="outline" icon={<DownloadSimple size={18} />} onClick={() => void run(() => downloadApiFile(`/canteen/accounts/${account.id}/statement`, { from, to, format: "xlsx" }, "statement.xlsx"))}>
            Excel
          </Button>
          <Button size="sm" variant="outline" icon={<DownloadSimple size={18} />} onClick={() => void run(() => downloadApiFile(`/canteen/accounts/${account.id}/statement`, { from, to, format: "pdf" }, "statement.pdf"))}>
            PDF
          </Button>
          <Button
            size="sm"
            icon={<Briefcase size={18} />}
            onClick={() =>
              void run(async () => {
                await api.post(`/canteen/accounts/${account.id}/statements`, { from, to, invoiceRef: invoiceRef.trim() || undefined });
                toast("Statement raised", "success");
                void history.reload();
                onChange();
              })
            }
          >
            Raise statement
          </Button>
        </div>
        {error && <Alert>{error}</Alert>}
        {view && (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
            {view.totals.meals} meals · bills {formatINR(view.totals.billTotal)} · company share <strong className="tabular">{formatINR(view.totals.employerShare)}</strong>
            {view.totals.refunds > 0 && ` − refunds ${formatINR(view.totals.refunds)}`} = <strong className="tabular">{formatINR(view.totals.net)}</strong>
          </p>
        )}
        <ul className="divide-y divide-line rounded-xl border border-line text-sm">
          {(history.data ?? []).length === 0 && <li className="px-3 py-2 text-muted">No statements raised yet.</li>}
          {(history.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-semibold">
                {s.periodFrom} to {s.periodTo}
              </span>
              <span className="text-muted">
                {s.meals} meals{s.invoiceRef && ` · ${s.invoiceRef}`} · raised {formatDateTime(s.createdAt)}
              </span>
              <span className="tabular ml-auto font-semibold">{formatINR(s.amount)}</span>
              {s.status === "PAID" ? (
                <Badge tone="success">Paid</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await api.patch(`/canteen/statements/${s.id}`, { status: "PAID" });
                      void history.reload();
                      onChange();
                    })
                  }
                >
                  Mark paid
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
