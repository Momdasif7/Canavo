import { z } from "zod";

/** Optional number where an empty string in .env means "not set". */
const optNum = (def: number) => z.preprocess((v) => (v === "" || v === undefined ? def : v), z.coerce.number());
/** Optional validated string where an empty string in .env means "not set" (instead of failing validation). */
const optStr = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  /** Comma-separated browser origins; one "*" per entry for subdomains, e.g. https://*.vercel.app */
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  /** Redis for Socket.io across several API instances (optional; single instance without it) */
  REDIS_URL: optStr(z.string().url()),
  /** Where scheduled jobs run: "embedded" = in the API process; "worker" = only in `npm run worker` */
  JOBS_MODE: z.enum(["embedded", "worker"]).default("embedded"),
  /** Express "trust proxy": which proxies may set X-Forwarded-For (rate limits and audit IPs depend on it) */
  TRUST_PROXY: z.string().default("loopback, linklocal, uniquelocal"),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  /** Cookie domain for web sessions shared by app.<domain> and api.<domain>, e.g. ".example.in" (Phase 2.7) */
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  /** Web app URL, for links in emails/SMS (password setup and reset) */
  WEB_APP_URL: z.string().default("http://localhost:3000"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  RECEIPT_LINK_SECRET: z.string().min(32),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Razorpay API base (tests point it at a fake server) */
  RAZORPAY_BASE_URL: z.string().url().default("https://api.razorpay.com"),
  WATI_API_URL: z.string().optional(),
  WATI_API_TOKEN: z.string().optional(),
  WATI_RECEIPT_TEMPLATE: z.string().default("receipt_share"),
  /** WhatsApp Cloud API (Meta). Overridable for tests / a proxy. Per-business keys live in Settings → WhatsApp. */
  WHATSAPP_META_BASE_URL: z.string().default("https://graph.facebook.com"),
  WHATSAPP_META_GRAPH_VERSION: z.string().default("v21.0"),
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
  // --- Off-site backup copies (Phase 1.7): S3-compatible storage, or a mounted directory ---
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_REGION: z.string().default("ap-south-1"),
  /** Custom endpoint for R2 / Backblaze / MinIO (path-style) */
  BACKUP_S3_ENDPOINT: optStr(z.string().url()),
  BACKUP_S3_PREFIX: z.string().default("canavo-backups/"),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_OFFSITE_DIR: z.string().optional(),
  // --- Observability ---
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** "pretty" = short dev lines (morgan); "json" = structured logs (always JSON in production) */
  LOG_FORMAT: z.enum(["pretty", "json"]).default("pretty"),
  /** Bearer token for GET /metrics (required to expose metrics in production) */
  METRICS_TOKEN: optStr(z.string().min(16)),
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

/**
 * Production fail-fast (Phase 1.8): refuse to start with settings that are unsafe in
 * production, instead of failing later or running insecurely.
 */
export function productionConfigProblems(e = env): string[] {
  if (e.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  for (const k of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "RECEIPT_LINK_SECRET"] as const) {
    if (/change-me|^ci-|^test-|^it-|^qa-/.test(e[k])) problems.push(`${k} is a placeholder/test value`);
  }
  if (new Set([e.JWT_ACCESS_SECRET, e.JWT_REFRESH_SECRET, e.RECEIPT_LINK_SECRET]).size < 3) problems.push("JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and RECEIPT_LINK_SECRET must all differ");
  if (!e.DATA_ENCRYPTION_KEY) problems.push("DATA_ENCRYPTION_KEY is required (encrypted Aadhaar and WhatsApp tokens)");
  if (/localhost|127\.0\.0\.1/.test(e.PUBLIC_API_URL)) problems.push("PUBLIC_API_URL points at localhost (receipt links would be broken)");
  if (e.CORS_ORIGINS.split(",").some((o) => o.trim() === "*")) problems.push("CORS_ORIGINS must not be *");
  if (/localhost|127\.0\.0\.1/.test(e.WEB_APP_URL)) problems.push("WEB_APP_URL points at localhost (password links would be broken)");
  // D13: password setup/reset links must reach people by email or SMS.
  if (!e.SMTP_HOST && !(e.MSG91_AUTH_KEY && e.MSG91_ALERT_TEMPLATE_ID)) {
    problems.push("Configure email (SMTP_HOST) or SMS (MSG91_AUTH_KEY + MSG91_ALERT_TEMPLATE_ID): password setup and reset links are sent through them");
  }
  return problems;
}

const problems = productionConfigProblems();
if (problems.length && process.env.SKIP_PROD_CONFIG_CHECK !== "1") {
  console.error(`Refusing to start in production:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
