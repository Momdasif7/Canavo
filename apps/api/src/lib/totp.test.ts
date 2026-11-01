import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, otpauthUri, totpAt, verifyTotp } from "./totp";

// RFC 6238 Appendix B (SHA-1 secret "12345678901234567890"); 8-digit vectors truncated to 6.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const vectors: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors", () => {
    for (const [t, code] of vectors) expect(totpAt(RFC_SECRET, Math.floor(t / 30))).toBe(code);
  });
  it("base32 round-trips", () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 9]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });
  it("accepts ±1 step of drift, rejects others, and refuses replays", () => {
    const now = 1111111111_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), step, now)).toBeNull(); // already used
    expect(verifyTotp(RFC_SECRET, "12345", null, now)).toBeNull();
  });
  it("builds an otpauth URI and readable recovery codes", () => {
    expect(otpauthUri("ABC", "owner@hotel.in")).toBe("otpauth://totp/CANAVO%3Aowner%40hotel.in?secret=ABC&issuer=CANAVO&algorithm=SHA1&digits=6&period=30");
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
  });
});
