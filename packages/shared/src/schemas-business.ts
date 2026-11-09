import { z } from "zod";
import { MODULES } from "./modules";
import { FEATURE_KEYS, type FeatureKey } from "./features";
import { indianPhone } from "./schemas";
import { gstStateCode } from "./india";
import { newPasswordSchema } from "./password";

const moduleList = z.array(z.enum(MODULES)).min(1, "Enable at least one module");

export const accountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: indianPhone,
  email: z.string().trim().toLowerCase().email().optional(),
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
      stateCode: gstStateCode,
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
  /** Feature flags to change (others keep their value) */
  features: z.record(z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]]), z.boolean()).optional(),
});

/**
 * QA 16b (gap 8): super admin archives a business that left the platform. Typing the business name
 * confirms it; nobody in the business can sign in afterwards, and the data is kept for the statutory
 * retention period (see businessRetentionEnd in the API).
 */
export const businessArchiveSchema = z.object({
  confirmName: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
});
export type BusinessArchiveInput = z.infer<typeof businessArchiveSchema>;

/** P2 gap 8b: permanently delete an archived business past its retention date — type its name and DELETE. */
export const businessPurgeSchema = z.object({
  confirmName: z.string().trim().min(1).max(120),
  confirmText: z.literal("DELETE", { errorMap: () => ({ message: 'Type DELETE to confirm' }) }),
});
export type BusinessPurgeInput = z.infer<typeof businessPurgeSchema>;

/**
 * Super admin: add an owner account to a business. Only owners — the owner
 * (and their managers) create every other staff account inside the hotel.
 */
export const platformUserCreateSchema = accountSchema.extend({
  role: z.literal("BUSINESS_OWNER", { errorMap: () => ({ message: "The super admin creates owner accounts only; owners create their staff" }) }).default("BUSINESS_OWNER"),
});


/** Super admin: create another platform administrator, or a read-only platform support user (Phase 4.2). */
export const platformAdminCreateSchema = accountSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  password: newPasswordSchema,
  role: z.enum(["SUPER_ADMIN", "PLATFORM_SUPPORT"]).default("SUPER_ADMIN"),
});
