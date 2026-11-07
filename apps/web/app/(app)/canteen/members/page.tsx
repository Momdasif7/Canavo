"use client";

import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, FileArrowUp, MagnifyingGlass, Plus, Ticket, Wallet } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, parseRupees } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Toggle } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

interface Member {
  id: string;
  name: string | null;
  phone: string;
  employeeCode: string | null;
  department: string | null;
  cardUid: string | null;
  memberActive: boolean;
  walletBalance: number;
  corporateAccountId: string | null;
  corporateAccount: { id: string; name: string } | null;
}
interface MemberDetail extends Member {
  walletLedger: { id: string; type: string; amount: number; mode: string | null; note: string | null; createdAt: string }[];
  tokens: { id: string; mealSlotId: string | null; balance: number; value: number }[];
}
interface Account {
  id: string;
  name: string;
}
const PAGE = 50;
type Mode = "CASH" | "UPI" | "CARD";

/** Minimal CSV: commas, quoted fields with "" escapes, first line = headers. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  // Headers are matched loosely: "Employee Code", "employee_code", "employeeCode" all work.
  const keys = head.map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const map: Record<string, string> = { name: "name", phone: "phone", mobile: "phone", employeecode: "employeeCode", empcode: "employeeCode", code: "employeeCode", department: "department", dept: "department", carduid: "cardUid", card: "cardUid", cardno: "cardUid", cardnumber: "cardUid" };
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [map[k] ?? k, (r[i] ?? "").trim()]).filter(([k]) => Object.values(map).includes(k))));
}

/** Canteen → Members & cards (Phase 5.1 / 5.2): employees, cards, wallets and meal tokens. */
export default function MembersPage() {
  const { outletId } = useSession();
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [accountId, setAccountId] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setPage(1), [q, accountId]);

  const accounts = useApiQuery(outletId ? `canteen-accounts:${outletId}` : null, () => api.get<Account[]>("/canteen/accounts"));
  const list = useApiQuery(outletId ? `canteen-members:${outletId}:${q}:${accountId}:${page}` : null, () =>
    api.get<{ items: Member[]; total: number; walletLiability: number }>("/canteen/members", { query: { search: q, accountId, page, limit: PAGE } }),
  );
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE)) : 1;
  const reload = () => void list.reload();

  if (list.error && !list.data) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <PageContainer>
      <PageHeader
        title="Members & cards"
        subtitle={list.data ? `${list.data.total} members · ${formatINR(list.data.walletLiability)} in wallets (prepaid, not sales)` : undefined}
        actions={
          <>
            <Button variant="outline" icon={<FileArrowUp size={20} />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button icon={<Plus size={20} />} onClick={() => setEditing("new")}>
              Add member
            </Button>
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <Input wrapperClassName="flex-1 min-w-[220px]" placeholder="Name, phone, employee code, card or department" prefix={<MagnifyingGlass size={18} />} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select aria-label="Company" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All companies</option>
            <option value="none">No company</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        {!list.data ? (
          <LoadingState />
        ) : list.data.items.length === 0 ? (
          <EmptyState title="No members" description="Add employees one by one or import a CSV with name, phone, employee code, department and card number." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Member</Th>
                <Th>Company</Th>
                <Th>Card</Th>
                <Th className="text-right">Wallet</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.data.items.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <button type="button" className="font-semibold hover:underline" onClick={() => setOpen(m.id)}>
                      {m.name || `+91 ${m.phone}`}
                    </button>
                    {!m.memberActive && (
                      <Badge tone="warning" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                    <span className="block text-xs text-muted">{[m.employeeCode, m.department, m.phone].filter(Boolean).join(" · ")}</span>
                  </Td>
                  <Td>{m.corporateAccount?.name ?? <span className="text-muted">—</span>}</Td>
                  <Td className="font-mono text-xs">{m.cardUid ?? <span className="font-sans text-muted">No card</span>}</Td>
                  <Td className="tabular text-right">{formatINR(m.walletBalance)}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                      Edit
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-line p-3 text-sm">
            <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <CaretLeft size={18} />
            </IconButton>
            Page {page} of {pages}
            <IconButton label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              <CaretRight size={18} />
            </IconButton>
          </div>
        )}
      </Card>
      {editing && (
        <MemberForm
          member={editing === "new" ? null : editing}
          accounts={accounts.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {importing && <ImportDialog accounts={accounts.data ?? []} onClose={() => setImporting(false)} onDone={reload} />}
      {open && <MemberDrawer id={open} onClose={() => setOpen(null)} onChange={reload} />}
    </PageContainer>
  );
}

function MemberForm({ member, accounts, onClose, onSaved }: { member: Member | null; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: member?.name ?? "",
    phone: member?.phone ?? "",
    corporateAccountId: member?.corporateAccountId ?? "",
    employeeCode: member?.employeeCode ?? "",
    department: member?.department ?? "",
    cardUid: member?.cardUid ?? "",
    memberActive: member?.memberActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, name: f.name.trim(), corporateAccountId: f.corporateAccountId || null, employeeCode: f.employeeCode.trim() || null, department: f.department.trim() || null, cardUid: f.cardUid.trim() || null };
      if (member) await api.patch(`/canteen/members/${member.id}`, body);
      else await api.post("/canteen/members", { ...body, employeeCode: body.employeeCode ?? undefined, department: body.department ?? undefined, cardUid: body.cardUid ?? undefined });
      toast("Member saved", "success");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={member ? "Edit member" : "Add member"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!f.name.trim() || f.phone.length !== 10} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          <Input label="Phone" inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => set({ phone: e.target.value.replace(/\D/g, "") })} />
          <Select label="Company" value={f.corporateAccountId} onChange={(e) => set({ corporateAccountId: e.target.value })}>
            <option value="">No company (pays in full)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Input label="Employee code" value={f.employeeCode} onChange={(e) => set({ employeeCode: e.target.value })} />
          <Input label="Department" value={f.department} onChange={(e) => set({ department: e.target.value })} />
          <Input label="Card number" placeholder="Scan the card here" value={f.cardUid} onChange={(e) => set({ cardUid: e.target.value.toUpperCase() })} hint="Click here and tap the card on the reader." />
        </div>
        <Toggle label="Card active" description="Inactive cards can't be used at the counter." checked={f.memberActive} onChange={(memberActive) => set({ memberActive })} />
      </div>
    </Dialog>
  );
}

function ImportDialog({ accounts, onClose, onDone }: { accounts: Account[]; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    setResult(null);
    setError(null);
    if (!file) return;
    const parsed = parseCsv(await file.text());
    if (!parsed.length || !("phone" in parsed[0]!) || !("name" in parsed[0]!)) return setError("The CSV needs a header row with at least 'name' and 'phone' columns.");
    if (parsed.length > 2000) return setError("At most 2,000 rows at a time.");
    setRows(parsed);
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post("/canteen/members/import", { corporateAccountId: accountId || null, rows }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import employees"
      description="CSV columns: name, phone, employeeCode, department, cardUid. Existing phone numbers are updated."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button loading={busy} disabled={!rows.length || !!result} onClick={() => void run()}>
            Import {rows.length || ""} rows
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="Company for these employees" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">No company</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="block text-sm" onChange={(e) => void pick(e.target.files?.[0])} />
        {error && <Alert>{error}</Alert>}
        {rows.length > 0 && !result && <p className="text-sm text-muted">{rows.length} rows ready. First: {[rows[0]!.name, rows[0]!.phone, rows[0]!.employeeCode].filter(Boolean).join(" · ")}</p>}
        {result && (
          <Alert tone={result.errors.length ? "warning" : "info"}>
            {result.created} added, {result.updated} updated{result.errors.length ? `, ${result.errors.length} skipped:` : "."}
            {result.errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e.row}>
                    Row {e.row}: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

function MemberDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const m = useApiQuery(`canteen-member:${id}`, () => api.get<MemberDetail>(`/canteen/members/${id}`));
  const slots = useApiQuery("canteen-rule-slots", () => api.get<{ id: string; name: string }[]>("/canteen/rule-slots"));
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<Mode>("CASH");
  const [tokens, setTokens] = useState({ count: "", price: "", slot: "" });
  const [adjust, setAdjust] = useState({ amount: "", note: "" });
  // Signed rupees → paise (parseRupees only takes positive amounts).
  const adjustPaise = (adjust.amount.trim().startsWith("-") ? -1 : 1) * (parseRupees(adjust.amount.replace("-", "")) ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done, "success");
      void m.reload();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const slotName = (sid: string | null) => (sid ? (slots.data?.find((s) => s.id === sid)?.name ?? "Slot") : "Any meal");
  const d = m.data;
  return (
    <Dialog open onClose={onClose} size="lg" title={d ? d.name || `+91 ${d.phone}` : "Member"} description={d ? [d.corporateAccount?.name, d.employeeCode, d.department, d.cardUid && `Card ${d.cardUid}`].filter(Boolean).join(" · ") : undefined}>
      {!d ? (
        <LoadingState />
      ) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Card>
            <CardHeader title={`Wallet ${formatINR(d.walletBalance)}`} subtitle="Top-ups are prepaid money, not sales: no GST until spent. Cash top-ups count in the cash drawer." />
            <div className="flex flex-wrap items-end gap-2 p-4">
              <Input label="Top up (₹)" inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} wrapperClassName="w-36" />
              <Select label="Paid by" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
              </Select>
              <Button
                icon={<Wallet size={18} />}
                loading={busy}
                disabled={!(parseRupees(amount) ?? 0)}
                onClick={() =>
                  void act(async () => {
                    await api.post(`/canteen/members/${d.id}/topup`, { amount: parseRupees(amount), mode });
                    setAmount("");
                  }, "Wallet topped up")
                }
              >
                Top up
              </Button>
            </div>
          </Card>
          <Card>
            <CardHeader title="Meal tokens" subtitle={d.tokens.filter((t) => t.balance > 0).map((t) => `${t.balance} × ${slotName(t.mealSlotId)}`).join(", ") || "None"} />
            <div className="flex flex-wrap items-end gap-2 p-4">
              <Input label="Tokens" inputMode="numeric" value={tokens.count} onChange={(e) => setTokens({ ...tokens, count: e.target.value.replace(/\D/g, "") })} wrapperClassName="w-24" />
              <Input label="Price each (₹)" inputMode="decimal" value={tokens.price} onChange={(e) => setTokens({ ...tokens, price: e.target.value })} wrapperClassName="w-32" />
              <Select label="For" value={tokens.slot} onChange={(e) => setTokens({ ...tokens, slot: e.target.value })}>
                <option value="">Any meal</option>
                {(slots.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                icon={<Ticket size={18} />}
                loading={busy}
                disabled={!Number(tokens.count) || !(parseRupees(tokens.price) ?? 0)}
                onClick={() =>
                  void act(async () => {
                    await api.post(`/canteen/members/${d.id}/tokens`, { count: Number(tokens.count), unitPrice: parseRupees(tokens.price), mealSlotId: tokens.slot || null, mode });
                    setTokens({ count: "", price: "", slot: "" });
                  }, "Tokens sold")
                }
              >
                Sell tokens ({mode.toLowerCase()})
              </Button>
            </div>
          </Card>
          {can("canteen:manage") && (
            <div className="flex flex-wrap items-end gap-2">
              <Input label="Correct wallet (₹, − to deduct)" inputMode="decimal" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value.replace(/[^\d.-]/g, "") })} wrapperClassName="w-44" />
              <Input label="Reason" value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} wrapperClassName="flex-1 min-w-[160px]" />
              <Button
                variant="outline"
                loading={busy}
                disabled={adjust.note.trim().length < 3 || !adjustPaise}
                onClick={() =>
                  void act(async () => {
                    await api.post(`/canteen/members/${d.id}/wallet/adjust`, { amount: adjustPaise, note: adjust.note.trim() });
                    setAdjust({ amount: "", note: "" });
                  }, "Wallet corrected")
                }
              >
                Save correction
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line rounded-xl border border-line text-sm">
            {d.walletLedger.length === 0 && <li className="px-3 py-2 text-muted">No wallet activity yet.</li>}
            {d.walletLedger.map((t) => (
              <li key={t.id} className="flex justify-between gap-2 px-3 py-1.5">
                <span className="text-muted">
                  {formatDateTime(t.createdAt)} · {t.note ?? t.type.toLowerCase()}
                  {t.mode && ` (${t.mode.toLowerCase()})`}
                </span>
                <span className="tabular">
                  {t.amount > 0 ? "+" : "−"}
                  {formatINR(Math.abs(t.amount))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
