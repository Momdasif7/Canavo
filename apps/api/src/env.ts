import { z } from "zod";

/** Optional number where an empty string in .env means "not set". */
const optNum = (def: number) => z.preprocess((v) => (v === "" || v === undefined ? def : v), z.coerce.number());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  RECEIPT_LINK_SECRET: z.string().min(32),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  WATI_API_URL: z.string().optional(),
  WATI_API_TOKEN: z.string().optional(),
  WATI_RECEIPT_TEMPLATE: z.string().default("receipt_share"),
  // --- Platform: SMS alerts, email, uploads, push, encryption, storage ---
  MSG91_ALERT_TEMPLATE_ID: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: optNum(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("CANAVO Reports <reports@canavo.local>"),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default("canavo"),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  DATA_ENCRYPTION_KEY: z.string().optional(),
  STORAGE_DIR: z.string().optional(),
  BACKUP_RETENTION: optNum(14),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Treat empty strings in .env as "not configured"
export const env = Object.fromEntries(
  Object.entries(parsed.data).map(([k, v]) => [k, v === "" ? undefined : v]),
) as z.infer<typeof schema>;

export const isProd = env.NODE_ENV === "production";
