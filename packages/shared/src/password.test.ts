import { describe, expect, it } from "vitest";
import { newPasswordSchema, passwordProblems } from "./password";

describe("password policy", () => {
  it("accepts 10+ characters with letters and a number", () => {
    expect(passwordProblems("Tiffin2026x")).toEqual([]);
    expect(newPasswordSchema.safeParse("masala dosa 42").success).toBe(true);
  });
  it("rejects short, letters-only, digits-only and common passwords", () => {
    expect(passwordProblems("abc123")).toContain("Use at least 10 characters");
    expect(passwordProblems("onlyletters")).toContain("Use letters and at least one number");
    expect(passwordProblems("1234567890")).toContain("Use letters and at least one number");
    expect(passwordProblems("Password123")).toContain("This password is too common");
    expect(passwordProblems("Canavo@123")).not.toEqual([]);
  });
  it("rejects passwords containing the user's name, email or phone", () => {
    expect(passwordProblems("ravikumar2026", ["Ravi Kumar"])).toContain("Don't use your name, email or phone number in the password");
    expect(passwordProblems("x9876543210y", [null, "9876543210"])).not.toEqual([]);
    expect(passwordProblems("deepak2026ok", ["x", "deepak@hotel.in"])).not.toEqual([]);
    expect(passwordProblems("Tiffin2026x", ["Al", "al@x.in"])).toEqual([]); // parts under 4 chars ignored
  });
});
