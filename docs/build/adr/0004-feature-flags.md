# ADR 0004: Per-hotel feature flags, separate from modules

| | |
|---|---|
| Status | Accepted (Phase 1, 2026-11-01) |
| Decision refs | D11, D14 |

## Context

The brief requires that new behaviour ships **OFF for existing hotels**. Modules (`INVENTORY`, `DELIVERY`…) are what a hotel pays for. They're too coarse to switch on one new rule, such as automatic out-of-stock.

## Decision

- `Business.features` is a JSONB column, default `{}`.
- Known flags are declared once in `packages/shared/src/features.ts` (`FEATURES`). Each has a label, a description and the **modules it requires**.
- A flag is effective only when it's `true` for the business **and** all its required modules are enabled (`featureEnabled`). Unknown keys are dropped (`normalizeFeatures`).
- **Server.** `TenantContext.features` is loaded with the business on every request; use `featureOn("KEY")`. Jobs get it through `runForBusiness` / `runForOutlet`.
- **Client.** `GET /auth/me` returns the effective flags.
- **Control.** Only the platform Super Admin can toggle flags, under Platform → Business → Features. Each change is audited. Side effects of a change run in `services/features.ts`; for example, turning off `AUTO_STOCK_OUT` clears every automatic out-of-stock mark.

## Consequences

- Every new capability in Phases 2–12 that changes behaviour adds a `FEATURES` entry and checks `featureOn`. UI-only improvements with no rule change don't need a flag.
- The flag list and the hotels each flag is on for: [FEATURE_FLAGS.md](../FEATURE_FLAGS.md).
- **Rollback:** turn the flag off per hotel; this is instant and needs no deploy. The column can be dropped with `ALTER TABLE "Business" DROP COLUMN "features"` after reverting the code.
