import { z } from "zod";
import { MODULES } from "./modules";
import { indianPhone } from "./schemas";

const moduleList = z.array(z.enum(MODULES)).min(1, "Enable at least one module");

export const accountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: indianPhone,
  email: z.string().trim().toLowerCase().email().optional(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

/** Super admin: onboard a client business with its owner login and (optionally) its first outlet. */
export const businessCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  notes: z.string().max(1000).optional(),
  modules: moduleList,
  owner: accountSchema,
  outlet: z
    .object({
      name: z.string().trim().min(2).max(120),
      address: z.string().max(500).default(""),
      stateCode: z.string().regex(/^\d{2}$/, "Two-digit GST state code, e.g. 29 for Karnataka"),
      gstEnabled: z.boolean().default(true),
    })
    .optional(),
});
export type BusinessCreateInput = z.infer<typeof businessCreateSchema>;

export const businessUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  modules: moduleList.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

/**
 * Super admin: add an owner account to a business. Only owners — the owner
 * (and their managers) create every other staff account inside the hotel.
 */
export const platformUserCreateSchema = accountSchema.extend({
  role: z.literal("BUSINESS_OWNER", { errorMap: () => ({ message: "The super admin creates owner accounts only; owners create their staff" }) }).default("BUSINESS_OWNER"),
});

/** Super admin: set a new password for an owner who is locked out (signs them out everywhere). */
export const ownerPasswordResetSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/** Super admin: create another platform administrator. */
export const platformAdminCreateSchema = accountSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
});
