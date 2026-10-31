/**
 * Field-level encryption for PII (e.g. Aadhaar) with AES-256-GCM.
 *
 * Ciphertext format: `v1:<iv b64>:<auth tag b64>:<ciphertext b64>`.
 * Key: env DATA_ENCRYPTION_KEY (32 bytes as 64 hex chars or base64). In
 * non-production a key is derived from JWT_ACCESS_SECRET with a warning.
 * Reads process.env directly (not ../env) so it is unit-testable without a full config.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  if (b.length === 32) return b;
  throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
}

let cachedKey: Buffer | undefined;
let warned = false;

export function dataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    cachedKey = parseKey(raw);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATA_ENCRYPTION_KEY is required in production");
    }
    const secret = process.env.JWT_ACCESS_SECRET ?? "canavo-dev-insecure-secret";
    if (!warned) {
      console.warn("[crypto] DATA_ENCRYPTION_KEY not set — deriving a development key from JWT_ACCESS_SECRET");
      warned = true;
    }
    cachedKey = createHash("sha256").update(`canavo-data-key:${secret}`).digest();
  }
  return cachedKey;
}

export function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptWith(key: Buffer, payload: string): string {
  const [version, iv, tag, ct] = payload.split(":");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export const encrypt = (plaintext: string) => encryptWith(dataKey(), plaintext);
export const decrypt = (payload: string) => decryptWith(dataKey(), payload);

// ---------- Aadhaar helpers ----------

/** Verhoeff checksum tables (UIDAI uses Verhoeff for the 12th Aadhaar digit). */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = digits.split("").reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][rev[i]]];
  return c === 0;
}

export const maskAadhaar = (aadhaar: string) => `XXXX-XXXX-${aadhaar.slice(-4)}`;
