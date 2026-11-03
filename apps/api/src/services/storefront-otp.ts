import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { CUSTOMER_OTP } from "@canavo/shared";
import { prisma } from "../db";
import { env, isProd } from "../env";
import { HttpError, badRequest } from "../lib/http";
import { sendOtpSms } from "./sms";

/**
 * Customer phone OTP for the online ordering page. Codes live in CustomerOtp (per outlet, RLS),
 * never in the staff OtpCode table, so a customer's code can't log anyone in. A correct code
 * returns a short-lived signed "verified phone" token the order request carries.
 * Call inside the outlet's tenant context.
 */

const hashCode = (outletId: string, phone: string, code: string) => crypto.createHash("sha256").update(`cust:${outletId}:${phone}:${code}`).digest("hex");

export async function requestCustomerOtp(outletId: string, phone: string, ip?: string) {
  const recent = await prisma.customerOtp.findFirst({ where: { outletId, phone }, orderBy: { createdAt: "desc" } });
  if (recent && Date.now() - recent.createdAt.getTime() < CUSTOMER_OTP.cooldownSeconds * 1000) {
    throw new HttpError(429, `Please wait ${CUSTOMER_OTP.cooldownSeconds} seconds before asking for another code`);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  // A new code replaces any earlier one.
  await prisma.customerOtp.updateMany({ where: { outletId, phone, consumed: false }, data: { consumed: true } });
  await prisma.customerOtp.create({
    data: { outletId, phone, codeHash: hashCode(outletId, phone, code), expiresAt: new Date(Date.now() + CUSTOMER_OTP.ttlSeconds * 1000), ip },
  });
  let sent = false;
  try {
    sent = await sendOtpSms(phone, code);
  } catch (e) {
    console.warn("[storefront-otp] SMS failed:", (e as Error).message);
    if (isProd) throw new HttpError(502, "Couldn't send the code — please try again");
  }
  const out: { ok: true; expiresIn: number; cooldown: number; devCode?: string } = { ok: true, expiresIn: CUSTOMER_OTP.ttlSeconds, cooldown: CUSTOMER_OTP.cooldownSeconds };
  if (!sent && !isProd) out.devCode = code;
  return out;
}

export async function verifyCustomerOtp(outletId: string, phone: string, code: string) {
  const otp = await prisma.customerOtp.findFirst({
    where: { outletId, phone, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw badRequest("The code has expired — ask for a new one");
  // Count the try BEFORE comparing, atomically (row-locked increment): guesses sent in parallel
  // can't all read the same attempt count, so at most maxAttempts codes are checked per OTP.
  const counted = await prisma.customerOtp
    .update({ where: { id: otp.id, consumed: false, attempts: { lt: CUSTOMER_OTP.maxAttempts } }, data: { attempts: { increment: 1 } }, select: { attempts: true } })
    .catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return null; // locked / used meanwhile
      throw e;
    });
  if (!counted) throw badRequest("Wrong code too many times — ask for a new one");
  const a = Buffer.from(otp.codeHash);
  const b = Buffer.from(hashCode(outletId, phone, code));
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    const { attempts } = counted;
    if (attempts >= CUSTOMER_OTP.maxAttempts) await prisma.customerOtp.updateMany({ where: { id: otp.id }, data: { consumed: true } });
    const left = CUSTOMER_OTP.maxAttempts - attempts;
    throw badRequest(left > 0 ? `Wrong code — ${left} ${left === 1 ? "try" : "tries"} left` : "Wrong code too many times — ask for a new one");
  }
  // Single use (a concurrent second verify of the same code loses).
  const { count } = await prisma.customerOtp.updateMany({ where: { id: otp.id, consumed: false }, data: { consumed: true } });
  if (!count) throw badRequest("The code has expired — ask for a new one");
  return { phoneToken: signPhoneToken(outletId, phone), expiresIn: CUSTOMER_OTP.tokenTtlSeconds };
}

// ---------- Verified-phone token: base64url(outletId.phone.exp).hmac ----------

const tokenKey = () => crypto.createHmac("sha256", env.RECEIPT_LINK_SECRET).update("canavo:customer-phone:v1").digest();

export function signPhoneToken(outletId: string, phone: string, ttlSeconds: number = CUSTOMER_OTP.tokenTtlSeconds) {
  const body = Buffer.from(`${outletId}.${phone}.${Math.floor(Date.now() / 1000) + ttlSeconds}`).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", tokenKey()).update(body).digest("base64url")}`;
}

/** True when the token proves `phone` was verified for this outlet and hasn't expired. */
export function phoneTokenValid(token: string | undefined, outletId: string, phone: string) {
  if (!token) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", tokenKey()).update(body).digest("base64url"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  const [o, p, exp] = Buffer.from(body, "base64url").toString("utf8").split(".");
  return o === outletId && p === phone && Number(exp) * 1000 > Date.now();
}
