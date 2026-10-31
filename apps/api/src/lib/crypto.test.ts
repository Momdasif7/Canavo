import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, decryptWith, encrypt, encryptWith, maskAadhaar, parseKey, verhoeffValid } from "./crypto";

describe("AES-256-GCM field encryption", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptWith(key, "234567890124");
    const b = encryptWith(key, "234567890124");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(decryptWith(key, a)).toBe("234567890124");
    expect(decryptWith(key, b)).toBe("234567890124");
  });

  it("round-trips unicode", () => {
    expect(decryptWith(key, encryptWith(key, "नमस्ते ₹100"))).toBe("नमस्ते ₹100");
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const c = encryptWith(key, "secret");
    const parts = c.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    expect(() => decryptWith(key, parts.join(":"))).toThrow();
    expect(() => decryptWith(randomBytes(32), c)).toThrow();
    expect(() => decryptWith(key, "garbage")).toThrow();
  });

  it("parses hex and base64 keys", () => {
    const k = randomBytes(32);
    expect(parseKey(k.toString("hex")).equals(k)).toBe(true);
    expect(parseKey(k.toString("base64")).equals(k)).toBe(true);
    expect(() => parseKey("too-short")).toThrow();
  });

  it("encrypt/decrypt with the env-derived key", () => {
    process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(decrypt(encrypt("499112345677"))).toBe("499112345677");
  });
});

describe("Aadhaar helpers", () => {
  it("validates the Verhoeff checksum", () => {
    expect(verhoeffValid("234567890124")).toBe(true);
    expect(verhoeffValid("499112345677")).toBe(true);
    expect(verhoeffValid("234567890123")).toBe(false);
    expect(verhoeffValid("23456789012a")).toBe(false);
  });

  it("masks all but the last four digits", () => {
    expect(maskAadhaar("234567890124")).toBe("XXXX-XXXX-0124");
  });
});
