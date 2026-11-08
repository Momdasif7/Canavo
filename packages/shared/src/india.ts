import { z } from "zod";

/**
 * India-specific identifiers (QA Phase 14): GST state codes, GSTIN checksum,
 * mobile numbers, FSSAI licence numbers.
 */

/** GST state / UT codes (first two digits of a GSTIN and the "place of supply"). */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/** A known two-digit GST state / UT code. */
export const gstStateCode = z
  .string()
  .trim()
  .refine((c) => /^\d{2}$/.test(c) && c in GST_STATES, "Two-digit GST state code, e.g. 29 for Karnataka");

/** "29" → "29-Karnataka" (Rule 46(n): place of supply with the name of the state). */
export const placeOfSupplyLabel = (stateCode: string) => (GST_STATES[stateCode] ? `${stateCode}-${GST_STATES[stateCode]}` : stateCode);

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GSTN check character (mod-36 Luhn variant) for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]!);
    if (v < 0) return "";
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}

/** Why a GSTIN is invalid, or null when it is valid (shape, state code, PAN, check character). */
export function gstinProblem(gstin: string): string | null {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_SHAPE.test(g)) return "Enter a valid 15-character GSTIN (e.g. 29ABCDE1234F1Z5)";
  if (!GST_STATES[g.slice(0, 2)]) return `GSTIN starts with an unknown state code ${g.slice(0, 2)}`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return "GSTIN check character is wrong (typo?)";
  return null;
}
export const isValidGstin = (gstin: string) => gstinProblem(gstin) === null;

/** Zod GSTIN: trims, upper-cases, then checks shape, state code and checksum. */
export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((g, ctx) => {
    const p = gstinProblem(g);
    if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
  });

/**
 * Indian mobile number → canonical 10 digits. Accepts "+91 98765 43210", "+91-9876543210",
 * "919876543210" and "09876543210"; anything else is returned unchanged (and then fails validation).
 */
export function normalizeIndianMobile(input: string): string {
  const s = input.trim().replace(/[\s\-().]/g, "");
  const m = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(s);
  return m ? m[1]! : s;
}
export const isValidIndianMobile = (input: string) => /^[6-9]\d{9}$/.test(normalizeIndianMobile(input));

/** FSSAI licence / registration number: 14 digits (FSS (Licensing) Regulations; printed on bills). */
export const isValidFssai = (s: string) => /^\d{14}$/.test(s.trim());
