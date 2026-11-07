# HANDOFF — `wip/store-integrations` (Requests 1 + 2)

> **Status: WORK IN PROGRESS (≈ 60 %). Do not merge into `feat/market-leader` until the "Still to do" list is finished and tested.**
> Branched from `feat/market-leader` @ `cba9527`. Handed over 2026-11-07.

## The requests

1. **Each store manages its own integrations in the app, no `.env` editing.** An owner-only **Integrations** settings page holds:
   - **Razorpay**, with each store's own webhook URL and secret, so UPI/QR and online payments settle into that store's account;
   - **WhatsApp**, in the same place;
   - **Email** through the store's own SMTP;
   - **SMS** through the store's own MSG91.

   Each has a **Test connection** button. Keys are encrypted at rest, shown only masked (`rzp_live_••••4f2a`), owner-only and audited. The Super Admin, support views, exports and backups never see them, logs and errors never contain them, and one store's keys are never used for another. Platform-only secrets (database, JWT, encryption key, backups) stay in `.env`.
2. **WhatsApp templates.** The wording lives in Meta WhatsApp Manager (Meta approves it), so CANAVO stores only the template **name + language** per message purpose. Build a clearer per-store template page: variables with sample values, a local **preview**, a **test send** per template, and a link plus step-by-step guide to edit or approve the template in Meta (and WATI).

## Decisions already made (product owner)

- **No payment fallback.** A store without its own Razorpay keys has **no UPI QR and no online Razorpay payment**; it gets a message pointing to *Settings → Integrations*. Cash, card, khata and the other modes keep working. In development the mock QR stays (never a platform key).
- **Email and SMS do fall back** to the platform account (`.env`) when a store hasn't set its own, e.g. for password-reset links and OTP.
- **Owner-only:** managers and every other role get 403 on integrations.
- **No database migration.** Config is stored in the existing `Setting` table (scope = businessId), like WhatsApp.

## Done (API side, typecheck ✅, unit tests ✅ 57 shared + 179 api)

| Area | Where |
|---|---|
| Shared schemas / masking helpers | `packages/shared/src/integrations.ts` (+ tests) |
| Store config service: encrypt, mask, resolve store-vs-platform | `apps/api/src/services/integrations.ts` (+ tests) |
| Integrations API routes (owner-only, audited, test buttons rate-limited 10 / 15 min per store, SSRF-checked) | `apps/api/src/routes/integrations.ts`, mounted in `app.ts` |
| Per-store Razorpay keys + per-store webhook route with that store's secret; no platform payment fallback | `services/razorpay.ts`, `routes/public.ts`, `routes/storefront*.ts`, `services/storefront.ts` |
| Per-store SMTP (with platform fallback) | `services/mailer.ts`, `services/password-links.ts` |
| Per-store MSG91 (with platform fallback), secrets redacted from errors | `services/sms.ts` |
| WhatsApp: per-purpose template name + language, test send with sample values, Meta error redaction | `routes/admin.ts`, `services/whatsapp.ts` |
| Backups / export never expose secrets | `services/backup.ts` |
| API docs regenerated | `docs/api/openapi.json`, `docs/api/canavo.postman_collection.json` |
| **27 API tests** covering every privacy/security rule above (see below) | `apps/api/test/api/integrations.test.ts` |

API test titles in `integrations.test.ts`: platform admin refused; changes audited without secrets; no plaintext in DB, masked GET; blank secret keeps old one; bad input → 400; generic `/admin/settings` can't touch integration rows; support view 403; owner export without secrets; backup holds only ciphertext; A's bill uses A's key / B's uses B's; webhook secret only works on its own store's URL; store without Razorpay → QR refused, cash works; online ordering hides UPI until connected; dev keeps mock QR; Razorpay/SMTP/MSG91/Meta failures that echo keys are redacted (nothing logged); SMTP internal/metadata hosts refused, DNS-rebinding refused at connect time; WATI URL can't be internal; test buttons rate-limited; email/SMS fallback; removing an integration reverts to the fallback (Razorpay: none); WhatsApp per-purpose templates + test send.

## Still to do

1. **Run the API test suites** (needs a fresh test DB, see "How to run"): `test/api/integrations.test.ts` plus the existing suites this branch touched (`test/api/admin.test.ts`, `test/api/sweep-auth.test.ts`, `test/integration/storefront.test.ts`, anything under `test/api` for public/razorpay/storefront/uploads). They were written but **not yet run green on this branch**. Fix anything red.
2. **Web: Integrations page** (not started). For example, `apps/web/app/(app)/settings/integrations/page.tsx` plus components, linked from Settings and the nav, **owner-only**:
   - Razorpay card: key id, key secret, webhook secret; show the store's **own webhook URL** with a copy button;
   - SMTP card; MSG91 card;
   - WhatsApp: move or link the existing `settings/whatsapp` page so the settings aren't duplicated;
   - masked hints; blank secret = keep; **Test connection** per card with a clear result; "using platform fallback" / "not connected" states.
3. **Web: WhatsApp template page (Request 2)** (not started). Per purpose: template name, language, variables with sample values, local preview (labelled "the approved text in Meta is what's actually sent"), test send to a typed number, link + step-by-step Meta (and WATI) guide.
4. **Docs:** `README.md` Integrations section and env table; `apps/api/.env.example` comments marking Razorpay/SMTP/MSG91/WATI vars as *platform fallback* (and that Razorpay has none for payments).
5. `npm run lint`, `npm run build -w @canavo/web`, then a browser check at desktop and phone width.

## How to run

```bash
npm ci && npm run build -w @canavo/shared
npm run typecheck && npm test                    # unit
# API tests recreate their DB on every run — use your own DB name:
IT_DATABASE_URL="postgresql://canavo:canavo@localhost:5433/canavo_it_int?schema=public" \
IT_APP_DATABASE_URL="postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_it_int?schema=public" \
IT_INCLUDE="test/api/integrations.test.ts" npx vitest run -c vitest.integration.config.ts   # in apps/api
```
Never use real Razorpay/SMTP/MSG91/Meta credentials in tests: they mock `fetch` / the nodemailer transport.

## Merge notes

- Files also touched by `wip/online-ordering-delivery-mode`: `routes/storefront-public.ts`, `services/storefront.ts`, `openapi-extra.ts`, `docs/api/*`. Expect small conflicts there. Regenerate `docs/api/*` after merging (`npm run docs:api -w @canavo/api`) instead of hand-merging them.
- `env.ts` changed (new optional platform-fallback handling). No new required env vars.
