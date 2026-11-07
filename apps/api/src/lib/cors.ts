import { env } from "../env";

/**
 * Allowed browser origins from CORS_ORIGINS (comma separated). An entry may use
 * one "*" for a subdomain wildcard, e.g. https://*.vercel.app for Vercel preview
 * deployments. Requests without an Origin header (mobile app, curl, server to
 * server) are allowed; CORS only governs browsers.
 */
export function allowedOrigin(list = env.CORS_ORIGINS) {
  const entries = list.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  const exact = new Set(entries.filter((e) => !e.includes("*")));
  const patterns = entries
    .filter((e) => e.includes("*"))
    .map((e) => new RegExp(`^${e.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+")}$`, "i"));
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/$/, "");
    cb(null, exact.has(o) || patterns.some((p) => p.test(o)));
  };
}
