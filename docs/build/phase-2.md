# Phase 2: Security and accounts

| | |
|---|---|
| Branch | `feat/market-leader` (commits `656a34d` … this commit) |
| Date | 2026-11-01 |
| Decisions applied | D2 Aadhaar: last 4 + consent by default · D7 clock-in: strict + selfie (as flags) · D13 email **or** SMS required in production · D16 httpOnly cookies with fallback |
| Tests | Unit **168** (shared 31, API 137) · Integration **77** on real Postgres as a non-superuser · Smoke **17** · Browser check **15/15** · typecheck (API, web, mobile) and lint clean |

## Summary

All 8 Phase 2 items are done.

- **Two-step login:** authenticator app plus recovery codes, for anyone who wants it. A hotel can require it for owners and managers.
- **Password links:** the platform never types or sees an owner's password. New owners get a "set your password" link; locked-out users get a reset link or use "Forgot password".
- **Signed-in devices:** you can sign out one device or all others, and the session ends immediately.
- **New passwords** must pass a policy.
- **The clock-in PIN** locks after 5 wrong tries.
- **Support access** is something the owner grants: read-only, time-limited, every screen logged, and the admin needs their own two-step login.
- **Aadhaar:** new entries keep only the last 4 digits, with a recorded consent. Full numbers are kept only by hotel opt-in.
- **Clock-in evidence:** fake GPS and weak GPS are recorded and flagged. A strict mode and a selfie mode are available per hotel.
- **Web sessions** move to httpOnly cookies where the domains allow it, and stay as before where they don't.
- **Production refuses to start** while demo logins exist.

**Behaviour changes for existing hotels:**
- New passwords need 10+ characters with letters and a number. Existing passwords keep working.
- A clock-in PIN locks for 15 minutes after 5 wrong tries.
- **New** Aadhaar entries keep the last 4 digits and need a consent tick. Hotels that already store full numbers stay on full (migration).
- The Super Admin sends owners links instead of typing their passwords.

Everything else that changes a rule sits behind a flag that is OFF for every hotel: `REQUIRE_2FA`, `STRICT_CLOCK_IN`, `CLOCK_IN_SELFIE`.

## What was built

| # | Item | What changed | Main files | Proven by |
|---|---|---|---|---|
| 2.1 | 2FA TOTP + recovery codes | RFC 6238 codes (no dependency; secret encrypted with `DATA_ENCRYPTION_KEY`; replay-proof with compare-and-set on the last step), plus 10 single-use recovery codes stored hashed. Login returns a 5-minute ticket signed with a separate key, and wrong codes count towards the account lockout. Owners reset staff 2FA; the platform resets owners'. `REQUIRE_2FA` flag. Web: login second step, Security card with QR. Mobile: login second step. | `lib/totp.ts`, `services/two-factor.ts`, `routes/auth.ts`, `components/account/TwoFactorCard.tsx`, `apps/mobile/app/login.tsx` | `totp.test.ts` (RFC vectors), `two-factor.test.ts` (8), browser check |
| 2.2 | Reset links (platform never knows the password) | One-time links: invite 72 h, reset 30 min. The token is in the URL fragment, so it never reaches logs. Single use, even when submitted twice; a new link cancels older ones; using one signs out every device. Sent by email, otherwise SMS. In development the link is logged and shown. Forgot-password and reset pages. The platform creates owners without a password and sends a reset link instead of setting one. Owners and managers can send reset links to staff. | `services/password-links.ts`, `routes/platform.ts`, `routes/staff.ts`, `app/forgot-password`, `app/reset-password` | `accounts.test.ts` (8) |
| 2.3 | Sessions, lockout, policy | Signed-in devices (device, IP, sign-in and last active), sign out one device or all others. A revoked session's access token stops working at once (`sid` claim checked on every request). Changing your password keeps this device. Password policy for every new password: 10+ characters, letters and a number, not common, no name/email/phone. Tight rate limit on password links. | `lib/tokens.ts`, `middleware/auth.ts`, `packages/shared/src/password.ts`, `components/account/*` | `accounts.test.ts`, `password.test.ts` |
| 2.4 | Consented support access | [ADR 0005](adr/0005-consented-support-access.md). The owner grants 1–72 h and can end it. The admin needs an active grant and their own 2FA. Read-only manager view, no export, no Aadhaar. Every request is logged for the owner. Banner in the app; platform list of active grants. | `routes/support.ts`, `middleware/auth.ts`, `components/settings/SupportAccessCard.tsx`, `components/platform/SupportGrantsCard.tsx` | `support-access.test.ts` (7), browser check |
| 2.5 | Aadhaar minimisation | Per-hotel `aadhaarMode` LAST4 (default) or FULL. Consent record: when, who recorded it, wording version. Owner can switch mode, reduce stored numbers to the last 4 (irreversible, needs a confirm word) and delete a record. Blocked in support views. The owner's data export also drops 2FA secrets, password/recovery tokens and idempotency records. | `routes/admin.ts`, `app/(app)/admin/staff-aadhaar/page.tsx`, `packages/shared/src/schemas-platform.ts` | `aadhaar.test.ts` (5) |
| 2.6 | Clock-in anti-spoofing | PIN lockout (5 tries → 15 min, manager notified). Every clock-in records GPS accuracy, the mock-location signal and flags; fake GPS notifies managers. `STRICT_CLOCK_IN` refuses fake GPS and fixes worse than ±50 m, with no geofence widening. `CLOCK_IN_SELFIE` requires a front-camera selfie uploaded through CANAVO. The register shows flags and the selfie. Face matching: design only (D7). | `services/attendance.ts`, `apps/mobile/src/attendance/*`, `components/attendance/DailyRegister.tsx` | `clock-in.test.ts` (7) |
| 2.7 | Tokens and deep links | [ADR 0006](adr/0006-web-session-cookies.md). httpOnly cookie sessions with a probe-based fallback; double-submit CSRF on refresh and logout; CORS credentials for allowed origins only. Mobile: SecureStore, as before. Scan found no token logging. No deep link carries a token (reset links open the web page), so verified app links aren't needed yet. The camera permission text now mentions the selfie (store review). | `lib/session-cookies.ts`, `apps/web/lib/api.ts`, `apps/mobile/app.config.ts` | `cookie-session.test.ts` (5), browser check |
| 2.8 | Production seed guard | The API refuses to start in production while any `@canavo.local` login is active (`ALLOW_DEMO_SEED=1` for throwaway demos). CI test that the demo seed refuses production. | `lib/demo-guard.ts`, `src/index.ts` | `demo-guard.test.ts` (4) |

## Migrations

All additive. Each new table has row-level security, and the RLS coverage test passes.

| Migration | Change | Rollback |
|---|---|---|
| `20261101122456_sessions_password_links` | `RefreshToken.ip`, `.userAgent`, index `(userId, revokedAt)`; enum `PasswordTokenPurpose`; table `PasswordResetToken` (+ RLS) | `DROP TABLE "PasswordResetToken"; DROP TYPE "PasswordTokenPurpose"; ALTER TABLE "RefreshToken" DROP COLUMN "ip", DROP COLUMN "userAgent"; DROP INDEX "RefreshToken_userId_revokedAt_idx";` |
| `20261101123324_two_factor` | `User.totpSecretEnc`, `.totpEnabledAt`, `.totpLastStep`; table `RecoveryCode` (+ RLS) | `DROP TABLE "RecoveryCode"; ALTER TABLE "User" DROP COLUMN "totpSecretEnc", DROP COLUMN "totpEnabledAt", DROP COLUMN "totpLastStep";` |
| `20261101124318_support_grants` | table `SupportGrant` (+ RLS) | `DROP TABLE "SupportGrant";` |
| `20261101124850_aadhaar_minimisation` | enum `AadhaarMode`; `Business.aadhaarMode` (default LAST4); `User.aadhaarLast4`, consent columns. **Data step:** hotels that already store full numbers are set to FULL. It bypasses RLS explicitly, checked as a non-superuser. | `ALTER TABLE "User" DROP COLUMN "aadhaarLast4", DROP COLUMN "aadhaarConsentAt", DROP COLUMN "aadhaarConsentById", DROP COLUMN "aadhaarConsentVersion"; ALTER TABLE "Business" DROP COLUMN "aadhaarMode"; DROP TYPE "AadhaarMode";` Full numbers are untouched, so nothing is lost by rolling back. |
| `20261101125237_clock_in_anti_spoofing` | `StaffAttendance.clockInAccuracy`, `.clockInMocked`, `.clockInSelfieUrl`, `.clockInFlags` | `ALTER TABLE "StaffAttendance" DROP COLUMN "clockInAccuracy", DROP COLUMN "clockInMocked", DROP COLUMN "clockInSelfieUrl", DROP COLUMN "clockInFlags";` |
| `20261101125255_clock_in_pin_lockout` | `User.pinFailedAttempts`, `.pinLockedUntil` | `ALTER TABLE "User" DROP COLUMN "pinFailedAttempts", DROP COLUMN "pinLockedUntil";` |

New environment variables (all in `render.yaml` and the `.env` examples):
- API: `WEB_APP_URL` (required in production), `AUTH_COOKIE_DOMAIN` (optional), `MSG91_ALERT_TEMPLATE_ID`.
- Web: `NEXT_PUBLIC_SESSION_MODE` (optional, default `auto`).

## Bugs found and fixed during Phase 2

| Id | Severity | What | Fix |
|---|---|---|---|
| (P2-a) | P1 | The worker ran the production config check but lacked SMTP/MSG91 settings. Since Phase 1 that also meant scheduled report emails and SMS alerts from the worker went to its local outbox folder instead of being sent. | `render.yaml`: the worker takes `WEB_APP_URL`, `SMTP_*`, `MSG91_*` and `EXPO_ACCESS_TOKEN` from canavo-api |
| (P2-b) | P1 | `forceLogout` used the tenant client, so the platform signing out an owner would fail under RLS (latent in the old reset-password route). | Uses the platform client |
| (P2-c) | P1 | The full-Aadhaar reveal is a GET, so a read-only support view could have used it. | Aadhaar is refused in support views (tested) |
| (P2-d) | P2 | The browser check found that `/auth/me` in a support view didn't carry the support header. | Platform console requests opt out explicitly (`support: false`) |
| (P2-e) | P2 | With SMS chosen but no MSG91 alert template, `sendSms` logs the message text, which would have put a live reset link in production logs. | The production check requires the template too, and links are never logged in production |

## Decisions and deviations (please confirm)

1. **Support access changes the 2026-10-25 rule** "the Super Admin can't open any hotel". It still holds by default. The exception exists only while the owner allows it, and it's read-only and logged.
2. **New Aadhaar entries default to last 4** in every hotel that doesn't already store full numbers (your D2 choice). Hotels with stored full numbers stay on full until the owner switches. Nothing existing was reduced; per your instruction, that needs a separate approval, and the owner now has a button for it.
3. **The platform no longer sets owner passwords.** The "Reset password" dialog became "Send reset link". New owners can sign in by phone OTP until they set a password.
4. **The PIN lockout and the password policy apply to everyone, without a flag.** They are security fixes; existing passwords keep working.
5. **Two-step login is opt-in.** I recommend turning `REQUIRE_2FA` on for real hotels, and I'd require it for Super Admins before go-live. Support access already requires it.
6. **Verified app links (Android/iOS) were not added.** No deep link carries a secret today, so they'd add store setup without a benefit. They become worth adding with customer-facing links (Phase 10).

## Risks

| Risk | Mitigation |
|---|---|
| A user loses both their phone and their recovery codes | The owner resets staff 2FA; the platform resets owners'. Audited, and forces sign-out. |
| Email or SMS isn't delivered, so a new owner can't set a password | Phone OTP login still works. The platform can re-send the link. Delivery failures show in the logs. |
| Cookie mode on a misconfigured domain | Probe-based fallback to storage mode. Rollback is `NEXT_PUBLIC_SESSION_MODE=storage`. |
| Selfie photos are personal data | Stored under unguessable names (or Cloudinary), visible to the managers who see attendance, and only collected when the hotel turns on the flag. Retention and deletion rules are left for the Phase 8/11 DPDP review. |
| Staff are blocked by strict GPS indoors | The flag is off by default; the error message tells them to move near a window. A manager can still mark attendance manually. |

## Could not verify (running list)

| Item | Why | Plan |
|---|---|---|
| Real email / SMS delivery of password links (SMTP, MSG91 DLT template) | No real credentials (rule 6) | Contract via dev logs and tests; send yourself a link on staging |
| Mock-location flag and the selfie camera on real Android/iOS phones | Need devices | Manual device checklist (QA Phase 15); the API side is covered by tests |
| Cookie sessions on real `app.` + `api.` custom domains over HTTPS | Need your domains | Tested on one origin through the gateway (browser) and with cookie headers (integration) |
| Authenticator apps other than the RFC algorithm | Same standard (RFC 6238); tested against the RFC vectors | Try Google/Microsoft Authenticator once on staging |
| Earlier items | Carried over | See phase-1.md |

## Next

Phase 3 (Money integrity) starts on your "continue". It needs D1, the coupon/flat-discount GST default (my recommendation: keep pre-tax, add an outlet setting, confirm with your CA). GSTIN capture for B2B invoices is added to Phase 3, as planned in Phase 0.
