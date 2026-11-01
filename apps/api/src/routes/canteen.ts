import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  corporateAccountSchema,
  corporateAccountUpdateSchema,
  mealTokenPurchaseSchema,
  memberImportSchema,
  memberSchema,
  memberUpdateSchema,
  statementCreateSchema,
  statementQuerySchema,
  statementUpdateSchema,
  subsidyRuleSchema,
  walletAdjustSchema,
  walletTopupSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { requireBusinessId } from "../lib/tenant";
import { authenticate, requireAnyPermission, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { adjustWallet, corporateOutstanding, corporateStatement, findMember, memberSnapshot, purchaseTokens, topUpWallet } from "../services/canteen";
import { sendExport } from "../services/report-export";

/**
 * Canteen (Phase 5.1 / 5.2, CANTEEN module): corporate accounts, subsidy rules, statements,
 * members (cards, wallets, meal tokens). Owners / managers manage; cashiers scan cards, top up
 * wallets and sell tokens at the counter.
 */
export const canteenRouter = Router();
canteenRouter.use(authenticate, requireOutlet, requireModule("CANTEEN"));

const manage = requirePermission("canteen:manage");
const counter = requireAnyPermission("payment:collect", "canteen:manage");

async function getAccount(id: string) {
  const a = await prisma.corporateAccount.findFirst({ where: { id } });
  if (!a) throw notFound("Corporate account");
  return a;
}

async function outletTimezone(outletId: string) {
  return (await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } })).timezone;
}

/** Unique-constraint failures as plain messages. */
function friendly(e: unknown, what: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    const target = String((e.meta as { target?: unknown })?.target ?? "");
    if (target.includes("cardUid")) throw conflict("That card is already given to another member");
    if (target.includes("phone")) throw conflict("Another customer already uses this phone number");
    throw conflict(`${what} already exists`);
  }
  throw e;
}

// ---------- Corporate accounts ----------
canteenRouter.get("/accounts", manage, async (_req, res) => {
  const accounts = await prisma.corporateAccount.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { members: true } } } });
  res.json(await Promise.all(accounts.map(async (a) => ({ ...a, outstanding: await corporateOutstanding(prisma, a.id) }))));
});

canteenRouter.post("/accounts", manage, async (req, res) => {
  const data = parse(corporateAccountSchema, req.body);
  const a = await prisma.corporateAccount.create({ data: { ...data, businessId: requireBusinessId() } }).catch((e) => friendly(e, "An account with this name"));
  await audit(req, "corporate_account.create", "CorporateAccount", a.id, { name: a.name });
  res.status(201).json(a);
});

canteenRouter.patch("/accounts/:id", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  const data = parse(corporateAccountUpdateSchema, req.body);
  const u = await prisma.corporateAccount.update({ where: { id: a.id }, data }).catch((e) => friendly(e, "An account with this name"));
  await audit(req, "corporate_account.update", "CorporateAccount", a.id, { changes: Object.keys(data) });
  res.json(u);
});

// ---------- Subsidy rules ----------
/** This outlet's meal slots, for picking a rule's slot (slot set-up lives on the meal slots screen). */
canteenRouter.get("/rule-slots", manage, async (req, res) => {
  res.json(await prisma.mealSlot.findMany({ where: { outletId: req.outletId! }, select: { id: true, name: true, active: true }, orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }] }));
});

canteenRouter.get("/accounts/:id/rules", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  res.json(await prisma.corporateSubsidyRule.findMany({ where: { corporateAccountId: a.id }, orderBy: { createdAt: "asc" } }));
});

async function checkRuleSlot(accountId: string, mealSlotId: string | null, exceptId?: string) {
  if (mealSlotId && !(await prisma.mealSlot.findFirst({ where: { id: mealSlotId }, select: { id: true } }))) throw badRequest("Unknown meal slot");
  // One rule per slot (and one all-slots rule) keeps "which rule applies" obvious.
  const clash = await prisma.corporateSubsidyRule.findFirst({ where: { corporateAccountId: accountId, mealSlotId, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true } });
  if (clash) throw conflict(mealSlotId ? "This account already has a rule for that meal slot" : "This account already has an all-slots rule");
}

canteenRouter.post("/accounts/:id/rules", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  const data = parse(subsidyRuleSchema, req.body);
  await checkRuleSlot(a.id, data.mealSlotId ?? null);
  const rule = await prisma.corporateSubsidyRule.create({ data: { ...data, mealSlotId: data.mealSlotId ?? null, corporateAccountId: a.id } });
  await audit(req, "subsidy_rule.create", "CorporateAccount", a.id, { rule });
  res.status(201).json(rule);
});

canteenRouter.patch("/rules/:id", manage, async (req, res) => {
  const rule = await prisma.corporateSubsidyRule.findFirst({ where: { id: param(req, "id") } });
  if (!rule) throw notFound("Subsidy rule");
  const data = parse(subsidyRuleSchema, { ...rule, ...req.body });
  if ((data.mealSlotId ?? null) !== rule.mealSlotId) await checkRuleSlot(rule.corporateAccountId, data.mealSlotId ?? null, rule.id);
  const u = await prisma.corporateSubsidyRule.update({ where: { id: rule.id }, data: { ...data, mealSlotId: data.mealSlotId ?? null } });
  await audit(req, "subsidy_rule.update", "CorporateAccount", rule.corporateAccountId, { before: rule, after: u });
  res.json(u);
});

canteenRouter.delete("/rules/:id", manage, async (req, res) => {
  const rule = await prisma.corporateSubsidyRule.findFirst({ where: { id: param(req, "id") } });
  if (!rule) throw notFound("Subsidy rule");
  await prisma.corporateSubsidyRule.delete({ where: { id: rule.id } });
  await audit(req, "subsidy_rule.delete", "CorporateAccount", rule.corporateAccountId, { rule });
  res.status(204).end();
});

// ---------- Statements ----------
/** The company's share for a period; format=xlsx|pdf downloads it. */
canteenRouter.get("/accounts/:id/statement", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  const q = parse(statementQuerySchema.extend({ format: z.enum(["json", "xlsx", "pdf"]).default("json") }), req.query);
  if (q.from > q.to) throw badRequest("'from' date is after 'to' date");
  const st = await corporateStatement(a.id, q.from, q.to, await outletTimezone(req.outletId!));
  if (q.format === "json") return res.json({ account: a, ...st });
  await sendExport(
    res,
    q.format,
    `statement_${a.name.replace(/[^A-Za-z0-9]+/g, "_")}_${q.from}_${q.to}`,
    [
      {
        title: `Statement · ${a.name}`,
        subtitle: [`${q.from} to ${q.to}`, a.gstin && `GSTIN ${a.gstin}`, `${st.totals.meals} meals`].filter(Boolean).join(" · "),
        columns: [
          { key: "date", header: "Date & time", width: 20 },
          { key: "bill", header: "Bill", width: 18 },
          { key: "member", header: "Member", width: 20 },
          { key: "employeeCode", header: "Emp. code", width: 12 },
          { key: "department", header: "Department", width: 16 },
          { key: "slot", header: "Meal", width: 12 },
          { key: "billTotal", header: "Bill total", type: "money", width: 12 },
          { key: "amount", header: "Company share", type: "money", width: 14 },
        ],
        rows: st.rows,
        totals: true,
      },
      ...(st.refunds.length
        ? [
            {
              title: "Refunds to the company",
              columns: [
                { key: "number", header: "Credit note", width: 18 },
                { key: "bill", header: "Bill", width: 18 },
                { key: "date", header: "Date", width: 20 },
                { key: "amount", header: "Amount", type: "money" as const, width: 14 },
              ],
              rows: st.refunds,
              totals: true as const,
            },
          ]
        : []),
    ],
    `Statement · ${a.name}`,
  );
});

canteenRouter.get("/accounts/:id/statements", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  res.json(await prisma.corporateStatement.findMany({ where: { corporateAccountId: a.id }, orderBy: { periodFrom: "desc" } }));
});

/** Raise (invoice) a statement: its totals are frozen now. */
canteenRouter.post("/accounts/:id/statements", manage, async (req, res) => {
  const a = await getAccount(param(req, "id"));
  const input = parse(statementCreateSchema, req.body);
  if (input.from > input.to) throw badRequest("'from' date is after 'to' date");
  const overlap = await prisma.corporateStatement.findFirst({ where: { corporateAccountId: a.id, periodFrom: { lte: input.to }, periodTo: { gte: input.from } }, select: { periodFrom: true, periodTo: true } });
  if (overlap) throw conflict(`A statement for ${overlap.periodFrom} to ${overlap.periodTo} overlaps these dates`);
  const st = await corporateStatement(a.id, input.from, input.to, await outletTimezone(req.outletId!));
  const s = await prisma.corporateStatement.create({
    data: { businessId: requireBusinessId(), corporateAccountId: a.id, periodFrom: input.from, periodTo: input.to, meals: st.totals.meals, amount: st.totals.net, invoiceRef: input.invoiceRef, note: input.note, createdById: req.user!.id },
  });
  await audit(req, "corporate_statement.create", "CorporateAccount", a.id, { statementId: s.id, amount: s.amount, from: input.from, to: input.to });
  res.status(201).json(s);
});

canteenRouter.patch("/statements/:id", manage, async (req, res) => {
  const s = await prisma.corporateStatement.findFirst({ where: { id: param(req, "id") } });
  if (!s) throw notFound("Statement");
  const input = parse(statementUpdateSchema, req.body);
  const u = await prisma.corporateStatement.update({
    where: { id: s.id },
    data: { status: input.status, paidAt: input.status === "PAID" ? (s.paidAt ?? new Date()) : null, ...(input.invoiceRef !== undefined && { invoiceRef: input.invoiceRef }) },
  });
  await audit(req, "corporate_statement.update", "CorporateAccount", s.corporateAccountId, { statementId: s.id, status: input.status });
  res.json(u);
});

// ---------- Members ----------
const memberSelect = {
  id: true, name: true, phone: true, employeeCode: true, department: true, cardUid: true, memberActive: true, walletBalance: true, corporateAccountId: true, createdAt: true,
  corporateAccount: { select: { id: true, name: true } },
} satisfies Prisma.CustomerSelect;

canteenRouter.get("/members", manage, async (req, res) => {
  const q = parse(
    z.object({
      search: z.string().trim().max(100).optional(),
      accountId: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const where: Prisma.CustomerWhereInput = {
    canteenMember: true,
    ...(q.accountId && { corporateAccountId: q.accountId === "none" ? null : q.accountId }),
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: "insensitive" } },
        { phone: { contains: q.search } },
        { employeeCode: { contains: q.search, mode: "insensitive" } },
        { cardUid: { contains: q.search.toUpperCase() } },
        { department: { contains: q.search, mode: "insensitive" } },
      ],
    }),
  };
  const [items, total, wallets] = await Promise.all([
    prisma.customer.findMany({ where, select: memberSelect, orderBy: [{ name: "asc" }], skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.customer.count({ where }),
    prisma.customer.aggregate({ where: { canteenMember: true }, _sum: { walletBalance: true } }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit, walletLiability: wallets._sum.walletBalance ?? 0 });
});

/** Card scan / employee code / phone → member with wallet, quota left and today's subsidy. */
canteenRouter.get("/members/lookup", requireAnyPermission("order:create", "payment:collect", "canteen:manage"), async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(1).max(64) }), req.query);
  const member = await findMember(q);
  res.json(await memberSnapshot(member, { id: req.outletId!, timezone: await outletTimezone(req.outletId!) }));
});

async function checkAccount(id: string | null | undefined) {
  if (id && !(await prisma.corporateAccount.findFirst({ where: { id }, select: { id: true } }))) throw badRequest("Unknown corporate account");
}

async function saveMember(input: z.infer<typeof memberSchema>) {
  // An existing customer with this phone becomes a member (keeps their history and khata).
  const existing = await prisma.customer.findFirst({ where: { phone: input.phone } });
  const data = { ...input, canteenMember: true, corporateAccountId: input.corporateAccountId ?? null, cardUid: input.cardUid ?? null, employeeCode: input.employeeCode ?? null, department: input.department ?? null };
  if (existing) return { member: await prisma.customer.update({ where: { id: existing.id }, data, select: memberSelect }), created: false };
  return { member: await prisma.customer.create({ data: { ...data, businessId: requireBusinessId() }, select: memberSelect }), created: true };
}

canteenRouter.post("/members", manage, async (req, res) => {
  const input = parse(memberSchema, req.body);
  await checkAccount(input.corporateAccountId);
  const { member, created } = await saveMember(input).catch((e) => friendly(e, "Member"));
  await audit(req, created ? "member.create" : "member.enrol", "Customer", member.id, { corporateAccountId: member.corporateAccountId });
  res.status(created ? 201 : 200).json(member);
});

canteenRouter.patch("/members/:id", manage, async (req, res) => {
  const m = await prisma.customer.findFirst({ where: { id: param(req, "id"), canteenMember: true } });
  if (!m) throw notFound("Member");
  const data = parse(memberUpdateSchema, req.body);
  await checkAccount(data.corporateAccountId);
  const u = await prisma.customer.update({ where: { id: m.id }, data, select: memberSelect }).catch((e) => friendly(e, "Member"));
  await audit(req, "member.update", "Customer", m.id, { changes: Object.keys(data) });
  res.json(u);
});

/** CSV import: each row is checked on its own; bad rows are reported, the rest saved. */
canteenRouter.post("/members/import", manage, async (req, res) => {
  const { corporateAccountId, rows } = parse(memberImportSchema, req.body);
  await checkAccount(corporateAccountId);
  let created = 0;
  let updated = 0;
  const errors: { row: number; error: string }[] = [];
  for (const [i, raw] of rows.entries()) {
    const r = memberSchema.safeParse({ ...raw, corporateAccountId: corporateAccountId ?? null });
    if (!r.success) {
      errors.push({ row: i + 1, error: r.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      continue;
    }
    try {
      const out = await saveMember(r.data);
      if (out.created) created++;
      else updated++;
    } catch (e) {
      try {
        friendly(e, "Member");
      } catch (err) {
        errors.push({ row: i + 1, error: (err as Error).message });
      }
    }
  }
  await audit(req, "member.import", "Customer", undefined, { created, updated, failed: errors.length, corporateAccountId });
  res.json({ created, updated, errors });
});

canteenRouter.get("/members/:id", counter, async (req, res) => {
  const m = await prisma.customer.findFirst({ where: { id: param(req, "id"), canteenMember: true }, select: memberSelect });
  if (!m) throw notFound("Member");
  const [wallet, tokens] = await Promise.all([
    prisma.walletTxn.findMany({ where: { customerId: m.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.mealTokenAccount.findMany({ where: { customerId: m.id } }),
  ]);
  res.json({ ...m, walletLedger: wallet, tokens });
});

canteenRouter.post("/members/:id/topup", counter, async (req, res) => {
  res.status(201).json(await topUpWallet(req, param(req, "id"), parse(walletTopupSchema, req.body)));
});

canteenRouter.post("/members/:id/wallet/adjust", manage, async (req, res) => {
  const m = await adjustWallet(req, param(req, "id"), parse(walletAdjustSchema, req.body));
  res.json({ id: m.id, walletBalance: m.walletBalance });
});

canteenRouter.post("/members/:id/tokens", counter, async (req, res) => {
  res.status(201).json(await purchaseTokens(req, param(req, "id"), parse(mealTokenPurchaseSchema, req.body)));
});
