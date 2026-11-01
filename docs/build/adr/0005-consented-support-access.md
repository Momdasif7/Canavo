# ADR 0005: Owner-consented, read-only support access

| | |
|---|---|
| Status | Accepted (Phase 2.4, 2026-11-01) |
| Changes | The 2026-10-25 rule "the Super Admin can't open any hotel". It still holds by default, and now has one exception the owner controls. |

## Context

The platform team can't see hotel data (privacy rule of 2026-10-25). Helping a hotel with a problem ("my report looks wrong", "the printer doesn't print") then depends on screenshots and phone calls. The brief asks for support access that the owner consents to.

## Decision

1. **The owner decides.** Settings → Support access lets the owner allow access for 2 h, 8 h, 24 h or 3 days (the API accepts 1–72 h), with an optional reason. Only one grant is active at a time, and the owner can end it at any moment.
2. **Read-only.** A support request is any request from a platform admin carrying `X-Support-Business`. It needs:
   - an active, unrevoked grant from that hotel's owner;
   - the platform admin's own two-step login turned on.

   The admin then acts as an **outlet manager of every outlet**. Every request that isn't a GET is refused, apart from the admin's own `/auth/*`. Owner-only areas stay closed: data export, support settings, Aadhaar, and changing the grant itself.
3. **Fully visible to the owner.** Every request (method and path) is written to the hotel's audit log as `support.view`. The owner sees the count and the full list under Settings → Support access.
4. **Visible to the admin.** A banner stays on every screen of the support view: hotel name, "read-only", when the permission ends, and that every screen is shown to the owner. "Exit support view" returns to the platform console.
5. **Tenancy.** A support request runs in that hotel's tenant context, so the row-level security of ADR 0001 confines it to that hotel. The grant check and the audit write use the platform client.

## Consequences

- The privacy promise to hotels becomes: "the CANAVO team sees nothing unless you allow it, and then only read-only, for as long as you choose, with every screen logged".
- Support is read-only, so the team can't fix data for a hotel. The owner or manager makes changes while on a call. A "write with approval" mode could come later, only if hotels ask for it.
- **Rollback:** remove the `X-Support-Business` branch in `middleware/auth.ts`. Grants then have no effect. `DROP TABLE "SupportGrant"` removes the table.
