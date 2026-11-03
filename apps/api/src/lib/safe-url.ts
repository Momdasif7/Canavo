/**
 * Links staff paste into the menu (item photos, bulk import) are shown to every POS, QR and
 * storefront visitor and may be handed to aggregators that fetch them. Only plain http(s)
 * links to a public host are accepted: no javascript:/data:/file: schemes and no internal
 * addresses (loopback, private ranges, link-local / cloud metadata 169.254.169.254, *.internal).
 * Our own local uploads (PUBLIC_API_URL/uploads/files/…) stay allowed in development.
 */
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
