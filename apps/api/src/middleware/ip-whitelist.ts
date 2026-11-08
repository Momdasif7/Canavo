import type { NextFunction, Request, Response } from "express";
import { isIP } from "node:net";
import { platformPrisma } from "../db";
import { forbidden } from "../lib/http";

/** Strip IPv4-mapped IPv6 prefix ("::ffff:1.2.3.4" → "1.2.3.4"). */
export const normalizeIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

function v6ToBigInt(ip: string): bigint {
  let [head, tail] = ip.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].reduce((n, g) => (n << 16n) + BigInt(parseInt(g || "0", 16)), 0n);
}

/** Does `ip` match an entry (exact address or CIDR)? */
export function ipMatches(ipRaw: string, entry: string): boolean {
  const ip = normalizeIp(ipRaw.trim());
  const [base, bitsStr] = entry.trim().split("/");
  const fam = isIP(ip);
  if (fam === 0 || fam !== isIP(base)) return false;
  if (bitsStr === undefined) {
    return fam === 4 ? ip === base : v6ToBigInt(ip) === v6ToBigInt(base);
  }
  const bits = Number(bitsStr);
  if (fam === 4) {
    if (bits === 0) return true;
    const mask = (~0 << (32 - bits)) >>> 0;
    return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
  }
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (v6ToBigInt(ip) & mask) === (v6ToBigInt(base) & mask);
}

export const ipAllowed = (ip: string, list: string[]) => list.length === 0 || list.some((e) => ipMatches(ip, e));

/** The platform-wide list (a GLOBAL setting, read with the platform client: no tenant needed). */
export async function loadIpWhitelist(): Promise<string[]> {
  const s = await platformPrisma.setting.findUnique({ where: { scope_key: { scope: "GLOBAL", key: "security.ipWhitelist" } } });
  return Array.isArray(s?.value) ? (s.value as string[]) : [];
}

/**
 * When the GLOBAL `security.ipWhitelist` setting is a non-empty list, super-admin
 * requests from other IPs are rejected. Must run after `authenticate`.
 * (Uses req.ip, so `trust proxy` must be configured correctly behind a proxy.)
 */
export async function superAdminIpWhitelist(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "SUPER_ADMIN" && req.user?.role !== "PLATFORM_SUPPORT") return next();
  await assertPlatformIpAllowed(req);
  next();
}

/**
 * Every platform route (/admin, /platform) and support views check this (QA Phase 8, sec1-4:
 * it used to guard /admin only). Escape hatch when the list locks everyone out (the office IP
 * changed): delete the setting in the database, see docs/qa/phase-8/sec1.md.
 */
export async function assertPlatformIpAllowed(req: Request) {
  const list = await loadIpWhitelist();
  if (!ipAllowed(req.ip ?? "", list)) throw forbidden(`Super admin access is not allowed from ${normalizeIp(req.ip ?? "unknown")}`);
}
