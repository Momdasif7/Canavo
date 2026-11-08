import { z } from "zod";
import { gstinSchema } from "./india";
import { indianPhone } from "./schemas";

/**
 * Phase 5.1 / 5.2 (CANTEEN module): corporate accounts, subsidies and quotas, members with
 * RFID / QR cards, wallets and meal tokens. Money is integer paise.
 */
const paise = z.number().int().nonnegative();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const BILLING_CYCLES = ["MONTHLY", "WEEKLY"] as const;
export const SUBSIDY_TYPES = ["PERCENT", "FLAT"] as const;
export type SubsidyType = (typeof SUBSIDY_TYPES)[number];

export const corporateAccountSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: optText(100),
  contactPhone: indianPhone.optional(),
  contactEmail: z.string().trim().email().optional(),
  gstin: gstinSchema.optional(),
  billingCycle: z.enum(BILLING_CYCLES).default("MONTHLY"),
  /** Max unpaid employer share, paise; 0 = no limit */
  creditLimit: paise.default(0),
  /** Max meals per member per day across all slots; null = no limit */
  dailyMealLimit: z.number().int().min(1).max(20).nullable().optional(),
  active: z.boolean().default(true),
});
export const corporateAccountUpdateSchema = corporateAccountSchema.partial();
export type CorporateAccountInput = z.infer<typeof corporateAccountSchema>;

export const subsidyRuleSchema = z
  .object({
    /** null = every meal slot */
    mealSlotId: z.string().min(1).nullable().optional(),
    type: z.enum(SUBSIDY_TYPES),
    /** PERCENT: 0–100; FLAT: paise per meal */
    value: z.number().int().min(0),
    maxPerMeal: paise.nullable().optional(),
    maxPerDay: paise.nullable().optional(),
    /** Max meals per member per day in this slot */
    slotMealLimit: z.number().int().min(1).max(20).nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine((r) => r.type !== "PERCENT" || r.value <= 100, { message: "A percentage can't be more than 100", path: ["value"] });
export type SubsidyRuleInput = z.infer<typeof subsidyRuleSchema>;

const memberFields = {
  name: z.string().trim().min(1).max(100),
  phone: indianPhone,
  corporateAccountId: z.string().min(1).nullable().optional(),
  employeeCode: optText(40),
  department: optText(80),
  /** RFID / QR value as the reader types it */
  cardUid: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9:_-]*$/, "Card number: letters, digits, : _ - only")
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
  memberActive: z.boolean().default(true),
};
export const memberSchema = z.object(memberFields);
export const memberUpdateSchema = z.object({ ...memberFields, cardUid: memberFields.cardUid.nullable(), employeeCode: memberFields.employeeCode.nullable(), department: memberFields.department.nullable() }).partial();
export type MemberInput = z.infer<typeof memberSchema>;

/** CSV bulk import of employees (name, phone, employeeCode, department, cardUid). */
export const memberImportSchema = z.object({
  corporateAccountId: z.string().min(1).nullable().optional(),
  rows: z
    .array(z.object({ name: z.string(), phone: z.string(), employeeCode: z.string().optional(), department: z.string().optional(), cardUid: z.string().optional() }))
    .min(1)
    .max(2000),
});

export const TOPUP_MODES = ["CASH", "UPI", "CARD"] as const;
export const walletTopupSchema = z.object({
  /** ₹10 – ₹10,000 */
  amount: z.number().int().min(1000).max(1_000_000),
  mode: z.enum(TOPUP_MODES),
  reference: z.string().trim().max(100).optional(),
});
export const walletAdjustSchema = z.object({
  /** Signed, paise */
  amount: z.number().int().refine((v) => v !== 0, "Amount can't be zero"),
  note: z.string().trim().min(3).max(200),
});
export const mealTokenPurchaseSchema = z.object({
  /** null = usable in any slot */
  mealSlotId: z.string().min(1).nullable().optional(),
  count: z.number().int().min(1).max(200),
  /** Price of one token, paise */
  unitPrice: z.number().int().min(100).max(500_000),
  mode: z.enum(TOPUP_MODES),
  reference: z.string().trim().max(100).optional(),
});

export const statementQuerySchema = z.object({ from: ymd, to: ymd });
export const statementCreateSchema = z.object({ from: ymd, to: ymd, invoiceRef: optText(60), note: optText(300) });
export const statementUpdateSchema = z.object({ status: z.enum(["INVOICED", "PAID"]), invoiceRef: optText(60) });

/** A rule's employer share of one meal, after the per-meal and per-day caps. */
export function employerShare(
  rule: { type: SubsidyType; value: number; maxPerMeal?: number | null; maxPerDay?: number | null } | null | undefined,
  mealTotal: number,
  usedToday = 0,
): number {
  if (!rule || mealTotal <= 0) return 0;
  let share = rule.type === "PERCENT" ? Math.round((mealTotal * rule.value) / 100) : rule.value;
  if (rule.maxPerMeal != null) share = Math.min(share, rule.maxPerMeal);
  if (rule.maxPerDay != null) share = Math.min(share, Math.max(0, rule.maxPerDay - usedToday));
  return Math.max(0, Math.min(share, mealTotal));
}

/** Card scan / employee code / phone → member, for the POS. */
export interface MemberLookup {
  id: string;
  name: string | null;
  phone: string;
  employeeCode: string | null;
  department: string | null;
  cardUid: string | null;
  memberActive: boolean;
  walletBalance: number;
  account: { id: string; name: string; active: boolean } | null;
  /** Meal slot open now (if any) */
  slot: { id: string; name: string } | null;
  /** Subsidy rule that applies now */
  rule: { type: SubsidyType; value: number; maxPerMeal: number | null; maxPerDay: number | null } | null;
  /** Employer share already used today, paise */
  subsidyUsedToday: number;
  /** Meals left today (null = no limit); the smaller of the daily and this slot's limit */
  mealsLeftToday: number | null;
  tokens: { mealSlotId: string | null; slotName: string | null; balance: number; unitValue: number }[];
}
