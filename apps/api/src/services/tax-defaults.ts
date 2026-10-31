import type { Prisma } from "@prisma/client";

/** Standard Indian GST slabs every new business starts with (editable afterwards). New items default to 0%. */
export const DEFAULT_TAX_RATES = [
  { name: "GST 0% (Exempt)", cgst: 0, sgst: 0, igst: 0, isDefault: true },
  { name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5, isDefault: false },
  { name: "GST 12%", cgst: 6, sgst: 6, igst: 12, isDefault: false },
  { name: "GST 18%", cgst: 9, sgst: 9, igst: 18, isDefault: false },
  { name: "GST 28%", cgst: 14, sgst: 14, igst: 28, isDefault: false },
] as const;

export async function createDefaultTaxRates(tx: Prisma.TransactionClient, businessId: string) {
  await tx.taxRate.createMany({ data: DEFAULT_TAX_RATES.map((r) => ({ ...r, businessId })) });
}
