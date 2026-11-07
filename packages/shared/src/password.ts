import { z } from "zod";

/**
 * Password policy for every new password (Phase 2.3). Existing passwords keep working;
 * the policy applies when a password is set or changed.
 *  - 10–128 characters, at least one letter and one digit;
 *  - not a well-known password, and not the published demo password.
 */
export const PASSWORD_MIN = 10;

const COMMON = new Set(
  [
    "password1", "password12", "password123", "password1234", "passw0rd12", "qwerty1234", "qwertyuiop1",
    "1234567890", "12345678910", "abcd123456", "abc1234567", "iloveyou12", "welcome123", "welcome1234",
    "admin12345", "admin@1234", "canavo@123", "canavo1234", "india12345", "india@1234", "hotel12345",
    "letmein123", "changeme12", "monkey1234", "dragon1234", "football12", "sunshine12", "princess12",
  ].map((p) => p.toLowerCase()),
);

/** Problems with a proposed password (empty = acceptable). `context` = name, email, phone to keep out of it. */
export function passwordProblems(password: string, context: (string | null | undefined)[] = []): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters`);
  if (password.length > 128) problems.push("Use at most 128 characters");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) problems.push("Use letters and at least one number");
  if (COMMON.has(password.toLowerCase())) problems.push("This password is too common");
  const lower = password.toLowerCase();
  for (const c of context) {
    const part = (c ?? "").toLowerCase().split("@")[0]!.replace(/\s+/g, "");
    if (part.length >= 4 && lower.includes(part)) {
      problems.push("Don't use your name, email or phone number in the password");
      break;
    }
  }
  return problems;
}

/** zod schema for a new password (context-free checks; servers also call passwordProblems with the user's details). */
export const newPasswordSchema = z.string().superRefine((p, ctx) => {
  for (const message of passwordProblems(p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});
