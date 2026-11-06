/**
 * Links staff paste into the menu (item photos, bulk import) are shown to every POS, QR and
 * storefront visitor and may be handed to aggregators that fetch them. Only plain http(s)
 * links to a public host are accepted: no javascript:/data:/file: schemes and no internal
 * addresses (loopback, private ranges, link-local / cloud metadata 169.254.169.254, *.internal).
 * Our own local uploads (PUBLIC_API_URL/uploads/files/…) stay allowed in development.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../env";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  if (v.startsWith("::ffff:")) return true; // hex-form IPv4-mapped
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

/** Is `host` (URL hostname, IPv6 without brackets) an internal / non-routable address or name? */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  const kind = isIP(h);
  if (kind === 4) return privateV4(h);
  if (kind === 6) return privateV6(h);
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes(".");
}

const ownHost = (() => {
  try {
    return new URL(env.PUBLIC_API_URL).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

/** null when the link is fine, else a reason to show the user. */
export function publicImageUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Image URL must be a full http:// or https:// link";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Image URL must start with http:// or https://";
  if (u.username || u.password) return "Image URL must not contain a user name or password";
  if (isInternalHost(u.hostname)) {
    // Photos uploaded to this API's own local storage (dev / single-server installs)
    if (ownHost && u.hostname.toLowerCase() === ownHost && /^(\/api)?\/uploads\/files\/[\w.-]+$/.test(u.pathname)) return null;
    return "Image URL must point to a public website, not an internal address";
  }
  return null;
}

// ---------- Outbound calls to a channel hub (QA BUG-048: SSRF) ----------

/** Link-local / cloud metadata: never a legitimate hub, in any environment. */
function metadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(h) === 4) return h.startsWith("169.254.");
  if (isIP(h) === 6) {
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1]!.startsWith("169.254.");
    // URL() writes IPv4-mapped addresses in hex: [::ffff:169.254.169.254] → ::ffff:a9fe:a9fe
    const hex = h.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
    if (hex) return parseInt(hex[1]!, 16) >> 8 === 169 && (parseInt(hex[1]!, 16) & 0xff) === 254;
    return /^fe[89ab]/.test(h) || h === "fd00:ec2::254";
  }
  return h === "metadata.google.internal" || h === "metadata";
}

/**
 * Where a manager may point the outlet's channel hub. Production: https to a public host only.
 * Development / test: loopback and private hosts are allowed (local fake hub), metadata never.
 * null when fine, else the reason.
 */
export function hubUrlError(raw: string, production = env.NODE_ENV === "production"): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Hub URL must be a full https:// link";
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !production)) return "Hub URL must start with https://";
  if (u.username || u.password) return "Hub URL must not contain a user name or password";
  if (metadataHost(u.hostname) || (production && isInternalHost(u.hostname))) return "Hub URL must point to the hub's public address, not an internal one";
  return null;
}

/**
 * fetch() for hub calls: re-checks the URL, resolves the host and refuses internal addresses
 * (a public name can resolve to 10.x / 169.254.x — DNS rebinding), and never follows redirects.
 */
export async function hubFetch(
  url: string,
  init: RequestInit,
  production = env.NODE_ENV === "production",
  resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((a) => a.address),
): Promise<Response> {
  const reason = hubUrlError(url, production);
  if (reason) throw new Error(reason);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.some((a) => metadataHost(a) || (production && isInternalHost(a)))) throw new Error("Hub address resolves to an internal network address");
  const res = await fetch(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error(`Hub answered with a redirect (${res.status}); enter its final address`);
  return res;
}

/** A hub's error for the user: only its JSON message / error field, short — never the raw body. */
export async function hubErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : "";
    return m.slice(0, 120);
  } catch {
    return "";
  }
}
