# CANAVO — Canteen Avatar Order

*From Order to Receipt in Seconds.* POS and business management for Indian canteens and food service: GST billing, kitchen tickets, tables, delivery, inventory, customers and loyalty, staff attendance, and reports. It runs on the web (desktop/tablet, installable as a PWA) and on Android/iOS.

All three phases of the master spec are implemented.

## Repository layout

```
packages/shared   GST engine, invoice numbering, RBAC, zod schemas for every module, receipt / ESC-POS formatter
apps/api          Express 5 + Prisma (PostgreSQL) + Socket.io REST API, background jobs — Swagger UI at /docs
apps/web          Next.js 14 POS + management web app (PWA, offline billing via IndexedDB)
apps/mobile       Expo SDK 51 app — POS, waiter tables, KOT, attendance, delivery agent, inventory, reports
```

All money is stored and computed as **integer paise** (₹1 = 100).

## Modules

| Module | Web | Mobile | Highlights |
|---|---|---|---|
| Auth & staff | ✓ | ✓ | OTP + password login, token rotation with reuse detection, lockout, RBAC (6 roles), forced logout on role change, encrypted Aadhaar |
| Attendance | ✓ | ✓ | GPS-geofenced clock-in with PIN/biometric, shifts (incl. overnight), late/early/overtime alerts, leave workflow, calendar, salary sheet, xlsx export |
| Outlets | ✓ | ✓ | Multi-outlet, per-outlet GST/tax settings, menu price/availability overrides, inter-outlet stock transfers, central overview dashboard |
| Menu | ✓ | – | Categories/sub-categories, variants, add-ons, veg/non-veg/egg, GST rate & HSN, time slots, CSV import, image upload |
| Offers | ✓ | chips | Combos, happy hour, buy X get Y, item & bill discounts, coupons with usage limits, personal birthday coupons |
| Billing / POS | ✓ | ✓ | Dine-in / takeaway / delivery / pre-order, live promotions preview, split payments, UPI QR (Razorpay), khata, offline queue, keyboard shortcuts |
| Tables | ✓ | ✓ | Drag-and-drop floor editor, running tabs with per-round KOTs, transfer, merge, split by seat / items / equal, waiter assignment, auto-close on payment |
| Kitchen (KOT/KDS) | ✓ | ✓ | Station routing, live display, timers, voids, pre-order hold & release, reprint |
| Receipts | ✓ | ✓ | Thermal 58/80 mm (Bluetooth ESC/POS), PDF, WhatsApp link / WATI |
| Delivery | ✓ | ✓ | Radius zones with fee/min order/ETA, agent assignment, status flow, agent app with live location, customer WhatsApp status |
| Reservations | ✓ | – | Table booking with capacity/overlap checks, pre-selected menu, advance payment, seat → tab |
| Inventory | ✓ | ✓ | Ingredients with units, recipes → automatic stock deduction per sale, purchases & vendor payments, wastage, stock audits, transfers, low-stock alerts, barcode lookup, food-cost costing |
| Customers & loyalty | ✓ | ✓ | Auto-created profiles, points earn/redeem, tiers, khata ledger & reminders, visit heatmap, blacklist |
| Reports | ✓ | summary | Sales, items, categories, peak-hour heatmap, GST, **GSTR-1 JSON**, profit/food cost, staff, customers, inventory, delivery — Excel + PDF export, scheduled email |
| Admin | ✓ | – | Audit log viewer, backups (daily auto + restore), full data export, notification preferences, IP whitelist |
| Notifications | bell | push | In-app, Expo push, SMS (MSG91), email (SMTP), WhatsApp |

## Quick start

Requires Node 20+ and Docker.

```bash
npm install
npm run build -w @canavo/shared
npm run db:up                      # Postgres 16 on localhost:5433
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run db:migrate                 # prisma migrate dev
npm run db:seed                    # demo outlet, staff, menu, tables, inventory, customers, offers, 30 days of history
npm run dev                        # API :4000 + web :3000
```

If port 3000 is taken, run the web app with `npx next dev -p 3001` in `apps/web`, and add `http://localhost:3001` to `CORS_ORIGINS` in `apps/api/.env`.

Demo logins (password `Canavo@123`, staff PIN `1234`):

| Role | Email | Phone (OTP) |
|---|---|---|
| Super Admin (platform) | admin@canavo.local | 9876500000 |
| Business Owner (Demo Hotel) | owner@canavo.local | 9876500005 |
| Outlet Manager | manager@canavo.local | 9876500001 |
| Cashier | cashier@canavo.local | 9876500002 |
| Kitchen | kitchen@canavo.local | 9876500003 |
| Delivery | delivery@canavo.local | 9876500004 |
| Inventory Manager | inventory@canavo.local | 9876500006 |

In development, OTPs are printed in the API log and returned as `devCode`. Demo coupons: `WELCOME50`, `FEST10`.

**Mobile:**
1. Run `cd apps/mobile && npm install && cp .env.example .env`.
2. Set `EXPO_PUBLIC_API_URL` to your machine's LAN IP, then run `npx expo start`.

Bluetooth printing, camera scanning and real push notifications need a development build (`eas build --profile development -p android`). See [apps/mobile/README.md](apps/mobile/README.md) and [apps/mobile/STORE_RELEASE.md](apps/mobile/STORE_RELEASE.md).

## Multi-business (SaaS) model

CANAVO serves many client businesses from one installation. Each business's data is fully isolated.

```
Super Admin (platform operator)   — /platform console: onboard businesses, pick modules, suspend, create / reset OWNER accounts
 └─ Business (hotel / restaurant / shop) — enabled modules, its own menu, customers, stock, tax rates
     ├─ Business Owner             — every outlet, staff and setting of that business; creates managers and staff; exports its data
     └─ Outlet
         ├─ Outlet Manager         — the outlet, including GST & tax settings; creates cashier/kitchen/delivery/inventory staff
         └─ Cashier · Waiter / Captain · Kitchen · Delivery · Inventory staff · Accountant · Auditor (read-only)
                (owners can also define custom roles that narrow a built-in role)
```

- **Privacy:** the Super Admin can't open any hotel, unless its owner grants read-only support access (Settings → Support access). That access is time-limited and can be ended any time, and every screen viewed is shown to the owner.
  - It has only `platform:manage`, `admin:backup` and `audit:view`, no outlets, and no business context. `X-Outlet-Id` and `X-Business-Id` are refused or ignored for it.
  - In the platform console it sees account information only: hotel name and contact, status, modules, outlet names and owner accounts. It never sees sales, bills, staff, customers, Aadhaar or reports.
  - Its audit log shows platform actions only.
- **Who creates whom:**
  - The Super Admin creates owners. Each owner gets a link to set their own password, and the Super Admin can send a reset link. The platform never sets or sees a password.
  - The Owner creates managers and staff, but not another owner.
  - A Manager creates cashier, kitchen, delivery and inventory staff, but not managers or owners.
- **Staff Aadhaar:**
  - By default, only the last 4 digits are kept, with the staff member's recorded consent. A hotel can opt in to keeping full numbers, encrypted.
  - The Owner can view and reveal Aadhaar for anyone in the business.
  - A Manager can do so only for staff below them in their own outlets.
  - Every reveal is audited, and the Super Admin can't see Aadhaar, not even in a support view.
- **Backups and export:**
  - The Super Admin creates and restores whole-platform backups for disaster recovery. Backups can't be downloaded from the app.
  - Each Owner downloads its own business's data under Admin → Export data, as JSON or CSV. Passwords and Aadhaar are left out.

- **Isolation** is enforced in `apps/api/src/db.ts`: inside a request, every query on a business-owned model is automatically filtered by `businessId`.
- **Modules** are switched per business by the Super Admin: Billing, Kitchen (KOT), Tables, Delivery, Reservations, Inventory, Customers & Loyalty, Offers, Attendance and Reports. Logins, staff and settings are always on.
  - Dependencies are added automatically; for example, Tables needs Billing.
  - Disabled modules disappear from the web and mobile apps, and the API rejects them.
  - `/auth/me` returns each user's effective permissions (role ∩ modules).
- **GST** is set per outlet by the Manager or Owner, under Settings → GST & Taxes:
  - GST registered on/off. When off, the outlet issues plain bills with no tax and no GSTIN, charged at menu price.
  - Composition scheme, legal name, GSTIN and invoice prefix.
  - Custom tax rates with separate CGST, SGST and IGST percentages, cess, and named extra taxes (e.g. VAT), assigned per menu item.

## Who sees what

- **Bills** and **Settings** are only available to the Owner, Outlet Manager and Cashier. This uses the `bills:view` and `settings:view` permissions, enforced by the API.
  - Kitchen, Delivery and Inventory staff get only basic outlet details: no GSTIN, UPI ID or billing configuration.
- **Delivery partner portal** (web at `/delivery`, and the mobile app's Home / Deliveries / Cash / History tabs):
  - **Duty:** clock in at the outlet (GPS + PIN). Partners may clock out from anywhere.
  - **Upcoming deliveries** with Call and Navigate, and no payment options:
    - A **COD** order shows **"Collect ₹X cash"** and one button, **"Cash collected & delivered"**.
    - A prepaid order shows just **"Delivered"**.
  - **Cash handover:** cash still with the partner, the orders it came from, and the handovers recorded by the outlet.
  - **Dashboard and history.**
- **Cash on Delivery:** the cashier picks COD in the payment step, or with the delivery switch in the cart. The cash then counts against the delivery partner who collects it.
- **Delivery partners** page (managers): per partner, per day:
  - Clock-in/out, deliveries, cash collected, cash received, and **cash still to receive**.
  - **Manual "Record cash received"** entries (partial amounts OK) that can be edited or deleted, a day timeline, and CSV export.
  - Cash in hand = cash collected − cash received.
- **Delivery dispatch limit** (Settings → Outlet → "Max orders per delivery partner", default **2**):
  - A partner holds at most that many orders. While at the outlet, POS auto-assign gives them orders up to the limit, so two orders can go on one trip. Partners who already have one order are filled first.
  - Once a partner picks up an order (Out for delivery), they are **on a run**. They get no new orders until every picked-up order is delivered **and** they are back at the outlet.
  - **Back at the outlet** is detected automatically from the partner app's GPS: the app posts `/delivery/me/location` while the partner is on duty, and arrival within the attendance geofence counts.
    - Clocking in at the outlet also counts as back.
    - A manager can press **Mark back at outlet** if the partner's phone isn't sharing location.
  - Orders that nobody can take wait unassigned. Managers are told why, and the order is assigned the moment a partner is back (a job also retries every minute).
  - **Manual assignment** of a busy or away partner is refused for cashiers. Managers and owners see a warning and can **Assign anyway**.

## Share on every device (one link)

```bash
./scripts/share.sh           # app + API behind one port (8080) and a public https ngrok link
./scripts/share.sh --local   # no ngrok: devices on the same Wi-Fi open http://<this-computer-ip>:8080
```

- `scripts/gateway.mjs` serves the web app and the API on one address. The API is under `/api`, and live updates use `/socket.io`.
  - It listens on **8080** (for ngrok / Wi-Fi) and **3001** (the original local address); the web app itself runs internally on 3100.
- The web app is built with `NEXT_PUBLIC_API_URL=/api`, so it works on any address: localhost, LAN IP or ngrok.
- **One-time ngrok setup:** sign up at https://dashboard.ngrok.com, then run `ngrok config add-authtoken <YOUR_TOKEN>`.
- GPS clock-in and "use my location" need **https**, so phones should use the ngrok link rather than the LAN address.
- For the mobile app, set `EXPO_PUBLIC_API_URL=https://<your-ngrok-domain>/api`.

## Integrations

**Per store, in the app (Settings → Integrations, owner only).** Each business connects its own accounts — no `.env`
change and no redeploy per store:

| Integration | What the owner enters | Used for | Without it |
|---|---|---|---|
| Razorpay | Key ID, key secret, webhook secret (+ pastes the store's own webhook URL into Razorpay) | Counter / delivery UPI QR, online-order payments, automatic UPI refunds | Platform shared account if `RAZORPAY_SHARED_ACCOUNT=true`, else a plain `upi://pay` QR for the outlet's UPI ID that the cashier confirms |
| Email (SMTP) | Server, port, user, password, from address / name | Scheduled reports, email notifications | Platform `SMTP_*`, else written to `apps/api/storage/outbox` |
| SMS (MSG91) | Auth key, DLT sender ID, OTP and alert flow template IDs | Customer OTP on the store's online-ordering page, staff SMS alerts | Platform `MSG91_*`, else logged |
| WhatsApp | Meta Cloud API (phone number ID + token) or WATI (URL + token), automatic messages | Receipts, khata reminders, wishes, delivery updates, staff alerts | Platform `WATI_*`, else `wa.me` click-to-chat links |

Secrets are encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM), write-only (only "configured" and the last 4 characters
are ever shown), never logged, audited only by field name, left out of the owner's data export, and invisible to the
Super Admin, platform support and support views. Each integration has a **Test connection** button (rate limited).
Template names, languages, the variables CANAVO sends, a preview and a test send per message type are in
**Settings → WhatsApp templates** — template *text* is written and approved in Meta WhatsApp Manager.

**Platform-level, in `apps/api/.env`** (everything optional in development):

| Service | Variables | Without them |
|---|---|---|
| Platform SMS (staff login OTP, password links, fallback) | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `MSG91_ALERT_TEMPLATE_ID` | OTP/SMS logged; OTP returned as `devCode` |
| Platform Razorpay account (only with `RAZORPAY_SHARED_ACCOUNT=true`) | `RAZORPAY_KEY_ID/SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Stores without their own keys get a plain UPI QR |
| Platform WhatsApp fallback (WATI) | `WATI_API_URL`, `WATI_API_TOKEN` | `wa.me` click-to-chat links |
| Cloudinary | `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` | Images stored under `apps/api/storage/uploads` |
| Platform SMTP (password links, platform alerts, fallback) | `SMTP_HOST/PORT/USER/PASS/FROM` | Emails written to `apps/api/storage/outbox` |
| Expo push | `EXPO_ACCESS_TOKEN` (optional) | Push sent without an access token |
| Encryption of PII and store secrets | `DATA_ENCRYPTION_KEY` | Dev derives a key (warning); **required in production** |

Razorpay webhooks: each store pastes its own URL `POST {PUBLIC_API_URL}/webhooks/razorpay/<store key>` (shown on its
Integrations page). `POST {PUBLIC_API_URL}/webhooks/razorpay` remains for the platform's own account.

## Key behaviours

- **GST:**
  - Handles prices with or without GST included, CGST/SGST or IGST, and composition scheme (Bill of Supply, no tax).
  - Discounts reduce the taxable value. Service charge, delivery fee and packaging are taxed at each line's rate.
  - Rounds to the nearest rupee.
  - Invoice numbers follow the financial year (`INV-2026-00234`, ≤ 16 characters).
  - The server always recomputes the bill.
- **Promotions** are evaluated server-side in a fixed order: item offers by priority (a unit is never discounted twice), then the best bill offer, the coupon, and points. The POS shows the exact server preview before charging.
- **Bills** (Billing & orders → Bills):
  - Today / Yesterday / Last 7 days / This month / custom range, and Previous day / Next day.
  - Filters for payment mode (Cash, UPI, Card, Khata, COD), order type and status, plus search.
  - A summary strip shows collected money per mode, counting only successful payments. Export to Excel with the same filters.
  - Filters are kept in the URL.
- **Hotel branding:** for hotel users the sidebar shows the hotel's uploaded logo (Settings → logo) and business name, with initials when there's no logo. The platform console keeps the CANAVO branding.
- **WhatsApp** (Settings → Integrations → WhatsApp and Settings → WhatsApp templates, per hotel):
  - Choose the Meta WhatsApp Cloud API, WATI or none. Tokens are stored encrypted, masked when read back, and never logged.
  - Per message type (receipt, khata reminder, birthday, anniversary, delivery update, staff alert, test): approved template name and language, the variables CANAVO sends in order with sample values, a rendered preview, and a "Send test" button. The page explains, step by step, how to create / edit the template text in Meta WhatsApp Manager.
  - Optional automatic delivery updates to customers and staff alerts.
  - Every send falls back to a wa.me click-to-chat link when no provider is set or the provider fails.
- **Menu bulk upload** (Menu → Bulk upload):
  - Download the Excel template. It includes your GST rates, categories and stock items.
  - Fill in one row per item and upload it (.xlsx or .csv). A per-row preview shows New / Update / Error before anything is saved.
  - Category + item name matches update the existing item, so the sheet also works for bulk price changes. Missing categories and sub-categories are created.
  - **Sizes:** `Regular=15; Large=25`.
  - **Ingredients:** `Potato=0.08; Pav=1`, in each stock item's unit. They become the item's recipe.
  - **Defaults:** blank GST = 0%. New items default to GST 0% everywhere, and existing items keep their rate.
- **Menu photos:**
  - Uploaded photos load from whatever address the app is opened on (localhost, Wi-Fi IP or ngrok).
  - POS item cards show photos unless Settings → "Show item photos on POS" is off.
- **Kitchen tickets:**
  - The KOT paper width (58/80 mm) is set separately from the receipt width, per device.
  - The Kitchen screen refetches tickets after a reconnect or wake-up, and every 15 s. It shows a Live / Reconnecting indicator.
- **Inventory:**
  - Every sale deducts recipe ingredients; a variant's recipe overrides the item's. Cancelling a bill restores them.
  - Set the ingredients in the menu item form, in Inventory → Recipes (amounts per size), or in the bulk-upload sheet.
  - Inventory staff see stock reports (consumption, movement, valuation, wastage, purchases) only. Sales, profit, GST reports, the dashboard and food cost / margins are for the Owner and Manager only.
  - **Automatic out of stock:** when an ingredient at an outlet can't cover one portion, the menu items (or just the sizes) that use it show "Out of stock · <ingredient> ran out" on the POS and can't be billed.
    - They come back by themselves when stock is added (purchase, transfer, adjustment, audit, or a cancelled bill). Managers are notified both ways.
    - A manager's own "out of stock" switch is never undone by restocking.
    - Bills synced from offline devices are still accepted, because the sale already happened, so stock can still go negative and raises low-stock alerts.
  - Purchases update a weighted-average cost.
- **Dine-in tabs:** each round fires KOTs immediately and items are billed at the end. When the last bill is paid, the tab closes itself and its tickets leave the kitchen display.
- **Offline billing:** queued bills carry a client UUID, so syncing is idempotent.
- **Audit log:** records every billing, payment, stock, staff and settings change.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` / `typecheck` / `lint` / `test` | Turbo across shared, api and web (168 unit tests) |
| `npm run test:integration -w @canavo/api` | Real-Postgres integration suite (77 tests). Covers row-level security, atomic tab split, idempotency, outbox, jobs, Redis adapter, observability, delivery guards, password links, two-step login, support access, Aadhaar, clock-in and cookie sessions. Needs `IT_DATABASE_URL` (owner) or the local Docker DB; Redis tests use `IT_REDIS_URL`. |
| `npm run test:smoke -w @canavo/api` | API smoke suite against a running server (`SMOKE_API_URL`) |
| `npm run worker -w @canavo/api` | Run the background jobs in their own process (with `JOBS_MODE=worker` on the API) |
| `npm run backup:drill -w @canavo/api` | Backup → restore into a scratch DB → compare counts and money (staging only) |
| `npm run seed -w @canavo/api` | Seed demo data; each module's seed is idempotent |
| `docker build -f apps/api/Dockerfile -t canavo-api .` | Production API image (runs `prisma migrate deploy` on start) |

CI: [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Engineering notes

- **Tenant isolation, two layers:** the Prisma filter adds `businessId`, and PostgreSQL row-level security on 48 tables refuses other hotels' rows even if a query forgets its filter. See [ADR 0001](docs/build/adr/0001-row-level-security.md).
- **Events after a change** (KOTs, live updates, alerts) are written to an outbox in the same transaction and then delivered. A crash can't lose them. See [ADR 0003](docs/build/adr/0003-transactional-outbox.md).
- **Retries are safe:** the web and mobile apps send an `Idempotency-Key` on every change. A repeated request returns the first result.
- **Accounts:** two-step login (authenticator app and recovery codes), signed-in devices with per-device sign-out, and one-time password links. Nobody sets or sees another person's password. Account → Security.
- **Money integrity:** refunds are GST credit notes (own series), voids and refunds can require a manager's PIN, cash drawer shifts produce a Z-report, and Reports → Exceptions lists voids, refunds, big discounts and approvals.
- **Support access:** the CANAVO team sees no hotel data unless the owner allows it. Then it's read-only, time-limited and every screen is logged ([ADR 0005](docs/build/adr/0005-consented-support-access.md)).
- **New behaviour ships behind per-hotel feature flags,** OFF for existing hotels: [FEATURE_FLAGS.md](docs/build/FEATURE_FLAGS.md).
- **Build programme status:** [docs/build/ROADMAP_STATUS.md](docs/build/ROADMAP_STATUS.md).

## Deployment

The frontend, backend and database deploy separately. The step-by-step guide is [docs/deployment/DEPLOYMENT.md](docs/deployment/DEPLOYMENT.md).

- **Frontend:** Vercel with root `apps/web` ([vercel.json](apps/web/vercel.json)) and `NEXT_PUBLIC_API_URL` set to the API's URL.
- **Backend:** Render Docker web service ([render.yaml](render.yaml), [apps/api/Dockerfile](apps/api/Dockerfile)). Migrations run on start; the health check is `/ready`.
  - Set `CORS_ORIGINS` (wildcards like `https://*.vercel.app` work), `PUBLIC_API_URL` and `DATA_ENCRYPTION_KEY`.
  - Background jobs run on pg-boss in the separate **canavo-worker** service (`JOBS_MODE=worker`), or inside the API with `JOBS_MODE=embedded`. Several instances never double-run a job. Set `REDIS_URL` before running more than one API instance.
  - Connect as a normal (non-superuser) database role, so row-level security is enforced.
  - Create the first Super Admin with `npm run create-admin -w @canavo/api`. The demo seed refuses to run in production.
- **Database:** Render Postgres 16 (or Neon / Supabase / RDS via `DATABASE_URL`).
- **Mobile:** `eas build -p android --profile production`, then `eas submit`. Store listing steps are in [apps/mobile/STORE_RELEASE.md](apps/mobile/STORE_RELEASE.md). Publishing needs your Google Play and Apple developer accounts.

## Known limitations

- **Delivery agents can't record payments.** Cash on delivery is shown as due and settled at the counter.
- **Agent live location** is in memory only and uses foreground GPS only.
- **GSTR-1** covers B2CS, HSN and the document summary. B2B, B2CL and credit notes aren't generated, because buyer GSTINs aren't captured.
- **Face-recognition clock-in** isn't implemented; PIN and biometric are.
- **₹ discounts** (flat coupons, flat offers, points, flat manual discounts) reduce the pre-tax value by default, so "₹50 off" saves the customer about ₹52.50 including 5% GST. An outlet can switch to GST-inclusive ₹ discounts under Settings → Money controls (confirm with your CA).
- **GSTR-1 credit notes** reduce B2CS/HSN for B2C bills. CDNR/CDNUR sections and the credit-note line in the document summary come with buyer GSTIN capture (Phase 8.4).
