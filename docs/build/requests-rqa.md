# Product requests (rqa): per-store integrations, WhatsApp templates, data-leak protection

> "This is a SaaS product so I will be providing this to many stores; if they need to add .env of their Razorpay
> details, WhatsApp, Email services and all other required details, it needs to be changed to update via app, and
> check the security in data leakage protection for good privacy." / "How can I edit the WhatsApp template?"

## What changed

### 1. Settings → Integrations (per store, in the app)

Each business connects its **own** accounts. No `.env` and no redeploy per store.

| Integration | Owner enters | Used for | Fallback when the store has none |
|---|---|---|---|
| **Razorpay** | key ID, key secret, webhook secret | Counter / delivery UPI QR, online-order payments, automatic UPI refunds, webhook verification | Platform account **only** if `RAZORPAY_SHARED_ACCOUNT=true`; otherwise a plain UPI QR for the outlet's UPI ID (cashier confirms) |
| **Email (SMTP)** | host, port, user, password, from address/name | Scheduled reports, email notifications | Platform `SMTP_*`, else the file outbox |
| **SMS (MSG91)** | auth key, DLT sender ID, OTP + alert template IDs | Customer OTP on the store's online-ordering page, staff SMS alerts | Platform `MSG91_*` |
| **WhatsApp** | Meta (phone number ID + token) or WATI (URL + token), automatic messages | Receipts, khata reminders, wishes, delivery updates, staff alerts | Platform `WATI_*`, else click-to-chat |

- **Storage:** new table `BusinessIntegration` (one row per business and kind, `@@unique([businessId, kind])`), with
  FORCE row-level security like every hotel table, plus the application tenant filter (`BUSINESS_SCOPED_MODELS`).
  Non-secret settings in `config`; each secret encrypted separately with the existing helper (`lib/crypto.ts`,
  AES-256-GCM, `DATA_ENCRYPTION_KEY`) in `secrets`. Code: `apps/api/src/services/integrations.ts`.
- **WhatsApp migrated:** it was in the key-value `Setting` table (which has **no RLS**). Migration
  `20261107120000_business_integrations` copies each `whatsapp.config` row into a WHATSAPP integration (tokens copied
  as ciphertext — nothing decrypted in SQL) and deletes the old rows. Verified on a seeded scratch DB with a
  legacy row: provider, phone number ID, language, template name and token all carried over, and the page shows
  "Connected".
- **API** (`apps/api/src/routes/integrations.ts`, mounted at `/integrations`):
  - `GET /integrations`, `GET /integrations/:kind` (`razorpay | email | sms | whatsapp`)
  - `PUT /integrations/:kind`, `DELETE /integrations/:kind`
  - `POST /integrations/:kind/test`
  - `POST /integrations/razorpay/webhook-key` (new webhook URL)
  - `GET|PUT /integrations/whatsapp/templates`, `POST /integrations/whatsapp/templates/:purpose/test`
- **Who sees what:**
  - Owner (`outlet:manage`): settings, masked hints, last test result, webhook URL. Edits, tests and removes.
  - Manager (`settings:outlet`): status only (configured, source, enabled, last test passed/failed). No hints, no
    host names, no webhook URL. Can read the WhatsApp template list.
  - Super Admin, platform support and **support views** (even with an owner's grant): 403 on everything under
    `/integrations` and on `/admin/whatsapp`.
- **Secrets are write-only.** Responses carry `{ set, hint }` only. The hint is `••••` plus the last 4 characters,
  and only for values of 8+ characters. Leaving a field empty keeps the stored value.
- **Audit:** `integration.create|update|delete|test|webhook_key_rotated`, `whatsapp.templates`,
  `whatsapp.template_test`. Each records who and which field **names** changed (`changed`, `secretsChanged`), never
  values.
- **Test connection**, rate-limited to 10 per 15 minutes per person and integration. Messages are redacted of the
  integration's secrets.
  - Razorpay: authenticated `GET /v1/payments?count=1`.
  - SMTP: connect, log in, and optionally send a test email.
  - SMS: one real SMS through the alert flow (or OTP) template.
  - WhatsApp: token check (Meta `GET /{phone-number-id}`, WATI contacts), or a test message to a phone.
- **SMTP safety (production):** host name only (no URL). Internal addresses (loopback, private ranges, link-local /
  metadata, `.internal`, `.local`, bare names) are refused when saving. At send/test time the host is resolved and
  refused if it points inside the network (DNS rebinding); the connection then goes to the checked IP, with the host
  name kept for TLS. Ports are limited to 25/465/587/2525. Development and tests allow localhost, so a fake SMTP
  server works.
- **Web:** `Settings → Integrations` (`apps/web/components/settings/IntegrationsPanel.tsx`) has one card per
  integration: status badges, masked values, a write-only form ("Saved (••••abcd) — leave empty to keep"),
  "Where do I find these?" help, Test connection, Remove, and an on/off switch. The Razorpay card also shows the
  store's webhook URL with Copy and New URL. Managers see a status list instead.

### 2. Razorpay per store everywhere

- `services/razorpay.ts`: `razorpayAccount(businessId)` returns the store's own keys, or the platform account only
  when `RAZORPAY_SHARED_ACCOUNT=true`, or null (mock UPI QR). Every call goes through it:
  - `createUpiQr`: counter (`orders.ts`), delivery (`delivery.ts`) and online orders (`services/storefront.ts`)
  - `refundPayment`: storefront auto-refunds
  - `upiReady` (`routes/storefront.ts`)
  - "test connection"
- **Webhooks:**
  - **New** `POST /webhooks/razorpay/:businessKey`. The key is 192 random bits (base64url) and picks the store; the
    signature is verified with **that store's** webhook secret. Payment and refund look-ups run inside that store's
    tenant context (RLS) and also check the business id. Unknown, disabled or secret-less keys get the same 401 as a
    bad signature, so nothing can be probed.
  - **Kept** `POST /webhooks/razorpay` for the platform's own account (`RAZORPAY_WEBHOOK_SECRET`). It now refuses to
    settle or refund for any store that has its own Razorpay account.
  - Webhook audit rows record `account: store|platform`.

### 3. Email / SMS per store

- `sendMail(mail, { scope })`:
  - default `business`: the store's SMTP (one cached transporter per store, rebuilt when its settings change), else
    the platform's.
  - `platform`: password links only.
  - Store SMTP errors are redacted.
- `sendSms` / `sendOtpSms(…, { scope })`:
  - The store's MSG91 account is used when it has the matching template (alert / OTP).
  - Staff login OTP (`auth.ts`) and password links are explicitly platform-level, since they are sent before or
    outside any store.
  - The customer OTP on a store's online-ordering page uses the store's account (it runs in that store's context).
  - `MSG91_BASE_URL` env was added (for tests / a proxy).

### 4. WhatsApp templates ("How can I edit the WhatsApp template?")

`Settings → WhatsApp templates` (`apps/web/components/settings/WhatsAppTemplates.tsx`):

- **How it works.** A step-by-step card explains that template **text** is created and approved (and later edited)
  in **Meta WhatsApp Manager → Message templates** (linked), or in WATI. CANAVO only picks the template and fills its
  variables.
- **One card per message type:** receipt, khata reminder, birthday, anniversary, delivery update, staff alert, test.
  Each card shows:
  - the Meta category (Utility / Marketing)
  - template name and language (empty means the default)
  - **the variables CANAVO sends, in order** (`{{1}}`, `{{2}}` …) with sample values, taken from a catalog in
    `services/whatsapp.ts` that is kept in sync with the senders
  - an optional copy of the approved text, used only for the preview, with a suggested text to start from
  - a **rendered WhatsApp-bubble preview**
  - **Send test** to a phone through the store's WhatsApp integration, using the sample values
- **Per business.** Templates are stored in the store's WHATSAPP integration config. Each type has its own language
  (new); the sender passes it to Meta.
- **Old setting retired.** The never-used System settings key `whatsapp.templates` lost its editor card, which is
  replaced by a pointer to the new page. The key stays valid in the API (in `@canavo/shared`) for compatibility.
- **Older endpoints.** `/admin/whatsapp` (GET/PUT/test) keeps working on the new storage but is now **owner-only**
  (it was `settings:outlet`, so managers could replace tokens).

### 5. Data-leak hardening outside the new feature

- Owner data export (`/admin/export`): the `secrets` and `webhookKey` columns are redacted. Before this change, the
  export also carried the WhatsApp token ciphertext through the `Setting` table.
- Structured logs (pino): `*.secret(s)`, `keySecret`, `webhookSecret`, `authKey`, `watiToken` and
  `metaAccessToken` are redacted.
- Razorpay QR / refund errors, MSG91 errors and SMTP errors are redacted of the account's secret before they reach
  logs, responses or stored test results.

## Decisions

- **D1 Razorpay fallback:** stores without their own keys use the platform's env account **only** when
  `RAZORPAY_SHARED_ACCOUNT=true` (default `false`); otherwise they get the mock path (plain UPI QR to the outlet's VPA,
  cashier confirmation). This way money never lands in the platform's account by accident. The old global webhook
  stays for the platform's own account during the transition, but never settles a store that has its own keys.
- **D2 SMS:** staff login OTP and password links stay platform-level. The customer OTP on the store's ordering page
  and staff alerts use the store's MSG91 account when it has the template.
- **D3 Email:** store SMTP is used for business mail (reports, notifications). Password links always use platform
  SMTP. A failing store SMTP throws a redacted error instead of silently falling back to the platform server, so
  misconfiguration shows up.
- **D4 Managers:** status only, no hints. Writes are owner-only, including WhatsApp, which managers could edit before.
- **D5 Support views get nothing**, not even masked hints.
- **D6 Webhook key:** separate from the business id (rotatable, unguessable). Every failure answers 401 the same way.
- **D7 Refunds** use the store's current account. A payment captured by the platform's shared account before the
  store added its own keys has to be refunded in the platform's dashboard (rare; documented).
- **D8 Kept in env (platform-only):** `DATABASE_URL`, JWT / receipt secrets, `DATA_ENCRYPTION_KEY`, backups S3,
  Cloudinary, Expo, Redis, metrics, and the platform's own SMTP / MSG91 / WATI / Razorpay accounts.

## How to use

1. Owner → Settings → **Integrations**. Fill in a card, Save, then use **Test connection**.
2. For Razorpay, copy the **webhook URL** into Razorpay → Webhooks, set the same webhook secret on both sides, and tick
   `qr_code.credited`, `refund.processed` and `refund.failed`.
3. Settings → **WhatsApp templates**: create the templates in Meta WhatsApp Manager following the on-page steps, enter
   their names and languages here, paste the text for the preview, Save, and use **Send test**.

## Tests

- **New: `apps/api/test/api/integrations.test.ts`** (31 tests). It runs against local fakes of Razorpay, MSG91, Meta
  and an SMTP server (EHLO / AUTH / DATA); all secrets are made up.
  - **Role matrix:** every new endpoint × 9 business roles. Super Admin gets 403 everywhere; unknown kind → 404.
  - **Validation:** 400s that never echo the input.
  - **Storage:** ciphertext only (`v1:`) in the database; hints match the last 4 characters; empty fields keep the
    stored secret; audit rows hold field names only, with the owner as actor.
  - **Managers** see exactly the status keys.
  - **Store B** sees nothing of A's, can't test or delete it, and B's webhook can't settle A's payments.
  - **Support view:** an owner-granted, 2FA admin gets 403 on every integration route.
  - **Test connection:** Razorpay checks with the store's own keys; SMTP logs in and sends from the store's address,
    and a wrong password isn't echoed; SMS checks with the store's key, and a wrong key echoed by the gateway is
    redacted; WhatsApp token check, test send, and redaction of a rejected token Meta echoes back.
  - **Scheduled report emails** go out through the store's SMTP (`via: "store"`).
  - **SMTP host rules,** including DNS-rebinding refusal.
  - **Razorpay QR codes** are created with each store's own keys; no keys means a mock QR.
  - **Webhook isolation:**
    - A's URL + A's secret on B's payment is ignored.
    - B's secret on A's URL → 401.
    - The platform route refuses a store with its own keys.
    - B's URL settles B's payment; A's settles A's.
    - Unknown or malformed keys → 401.
    - A rotated URL → 401.
    - A disabled integration's webhook → 401, and its QR codes fall back to mock.
  - **Templates:** catalog order and samples, preview, per-business, owner-only edits, send test uses the store's
    template name, language and parameter order, and bad input → 400. The older `/admin/whatsapp` works on the same
    storage and is owner-only.
  - **Sweep:** distinctive secrets are set for two stores, then **every GET route in the inventory** is called as
    owner and as manager; no secret, or 12-character prefix of one, appears.
  - **Owner export (JSON):** no secret and no `secrets` / `webhookKey` columns.
  - **Rows:** audit, notifications and outbox payloads are clean.
  - **Logs:** pino redaction is checked, and **all console/stdout/stderr output of the suite** is captured and contains
    no secret.
  - **Rate limit:** 429 after 10 tests; other kinds have their own budget.
- **Updated:**
  - `admin.test.ts`: `/admin/whatsapp` is now `outlet:manage`; storage assertion moved to `BusinessIntegration`.
  - `sweep-auth.test.ts`: the per-store webhook is on the public allowlist.
  - `integration/storefront.test.ts`: the env Razorpay path sets `RAZORPAY_SHARED_ACCOUNT`.
- OpenAPI index updated (`openapi.ts`, `openapi-extra.ts`); `docs/api` regenerated (397 operations).

## Screenshots

Taken with Playwright against a scratch API (4110) and web (3210) on a seeded DB with a migrated legacy WhatsApp
setup. Each page's HTML was also checked for the entered secrets: none found.
`/private/tmp/claude-503/-Users-asif-Desktop-CANAVO/d40cdc9d-f1c9-491c-ba87-a61f45e5096a/scratchpad/rqa/shots/`:

- `01-integrations-owner.png`
- `02-razorpay-saved-tested.png`
- `03-whatsapp-card.png`
- `04-templates-owner.png`
- `05-template-receipt-saved-test.png`
- `06-system-settings-moved.png`
- `07-integrations-phone.png`
- `08-templates-phone.png`
- `09-integrations-manager.png`
- `10-templates-manager.png`

## Not verified / follow-ups

- Real third-party accounts were never used. Razorpay, MSG91, Meta, WATI and SMTP were exercised against local fakes
  only, and WATI's credential-check endpoint (`/api/v1/getContacts`) was not tried against a real WATI.
- The mobile app was not touched. It has no integrations screen, which is fine because owners configure this on the web.
- The mock UPI fallback still uses `canavo@upi` when an outlet has no UPI ID (unchanged). Consider refusing a QR
  without a VPA.
- Old `whatsapp.templates` setting values (business scope) are not migrated: they were never used for sending.
