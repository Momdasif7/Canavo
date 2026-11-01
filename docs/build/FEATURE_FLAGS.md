# Feature flags

Per-hotel switches for new behaviour. Every flag is **OFF** unless the Super Admin turns it on for a hotel (Platform → Business → Features). A flag only takes effect when the hotel also has the modules it requires. Design: [ADR 0004](adr/0004-feature-flags.md). Registry: `packages/shared/src/features.ts`.

| Flag | What it does | Requires | Added | On for |
|---|---|---|---|---|
| `AUTO_STOCK_OUT` | Menu items, or single sizes, whose ingredient stock can't cover one portion become unavailable on the POS, waiter, QR and kiosk menus. They come back when stock is received. Off: items stay sellable, and stock can go negative. | `INVENTORY` | Phase 1 (from the 2026-10-31 request) | Demo Hotel (D14) |
| `REQUIRE_2FA` | Owners and outlet managers must turn on two-step login before they can use the app (only Account → Security works until then). Other staff can still opt in. | none | Phase 2.1 | none |
| `STRICT_CLOCK_IN` | Clock-in refuses fake (mock) GPS locations and fixes worse than ±50 m, and no longer widens the outlet's allowed distance by the GPS error. Off: the old rule, but fake GPS and weak accuracy are still recorded and flagged for the manager. | `ATTENDANCE` | Phase 2.6 (D7) | none |
| `CLOCK_IN_SELFIE` | Staff take a front-camera selfie to clock in on the app. It is stored with the attendance record for the manager. No face matching. | `ATTENDANCE` | Phase 2.6 (D7) | none |

Not flags (they apply to everyone, because they are security fixes without a visible rule change for hotels):
- the clock-in PIN lockout (5 wrong tries → 15 minutes);
- the password policy for new passwords;
- sign-out per device;
- the production demo-login guard.

Aadhaar storage is a per-hotel setting (`Business.aadhaarMode`), not a flag. Existing hotels that store full numbers stay on FULL.

## Adding a flag

1. Add the key to `FEATURES`, with its label, description and `requires`.
2. Gate the server behaviour with `featureOn("KEY")`. Gate the UI with the flags returned by `/auth/me`.
3. Put any side effect of switching it on or off in `apps/api/src/services/features.ts`.
4. Test both states, and test that a missing required module means off.
5. Add a row to this table.
