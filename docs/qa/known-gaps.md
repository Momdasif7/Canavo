# Known gaps from the spec (QA Phase 16b)

Each gap has a test (passing, or `it.skip` with the reason), a priority with a reason, and a status:
**Done** (fixed by an earlier phase, verified), **Implemented now** (built in 16b), **Implemented (approved P2)** (built after
approval, 10 Nov 2026), or **Proposed P2 awaiting approval**.

Tests: `apps/api/test/integration/known-gaps.test.ts` (gaps 1–8, incl. the approved P2 gaps 3, 4, 7 and 8b), `apps/api/src/services/gstr1.test.ts` (+1 unit test),
`coupon-stacking.test.ts` (gap 4, 8 tests) and `business-purge.test.ts` (gap 8b, 9 tests).
Migration: `20261109200000_b2b_buyer_business_archive`. It adds 4 nullable `Order` columns and 3 nullable `Business` columns, plus the `BusinessStatus.ARCHIVED` value. Every step is additive and needs no backfill.
Migration `20261110100000_coupon_combinable_business_purge` (approved P2 gaps 4 and 8b): `Coupon.combinable` (default false),
3 nullable `Business` final-export columns and the platform-only `BusinessTombstone` table (forced RLS: platform/bypass only). Additive.

| # | Gap | Priority | Status |
|---|-----|----------|--------|
| 1 | Scheduler single-instance (pg-boss, many API instances) | P1 | Done (Phase 1.2) |
| 2 | GSTR-1 B2B / B2CL / CDNR / CDNUR | P1 | Implemented now |
| 3 | Delivery-partner GPS in the background | P2 | Implemented (approved P2) |
| 4 | One offer per bill / optional stacking | P2 | Done (rule tested); combinable coupons Implemented (approved P2) |
| 5 | Coupon GST treatment and gift cards | P0 check | Done (verified, no defect) |
| 6 | Tab split atomicity | P1 | Done (Phase 9) |
| 7 | Clock-in face match | P2 | Implemented (approved P2): manager-review fallback, no on-device matcher |
| 8 | Business archive / delete after retention | P1 archive, P2 delete | Archive implemented; delete after retention Implemented (approved P2) |

---

## 1. Scheduler single-instance: Done
Every API instance and the worker tick each job with `singletonKey = job name` and `singletonSeconds = window`
(`apps/api/src/jobs.ts`). pg-boss therefore keeps one job per window across all instances, and its queue gives one
worker at a time. `test/integration/jobs.test.ts` runs 3 runners (2 API instances + 1 worker) all ticking the same 1 s job for 6.5 s.
Each window runs once and never overlaps (`maxActive = 1`). Jobs that act on many businesses also skip any business that is not `ACTIVE`.
Report schedules have their own guard against sending twice (`jobs-platform.ts`). Nothing more to do.

## 2. GSTR-1 B2B, B2CL, CDNR, CDNUR: Implemented now (P1)
**Why P1:** a GST-registered buyer (a corporate canteen client, or a company paying for a team lunch) needs a B2B invoice
that shows its GSTIN (Rule 46(e)), and that invoice must appear in table 4 of the outlet's GSTR-1, or the buyer can't claim
input tax credit. This was a sales blocker for those customers, but it was not wrong money for B2C bills.

**What was built**
- **Bill:** new optional fields `buyerGstin` (checked for shape, state code and checksum), `buyerName` (required with a GSTIN),
  `buyerAddress` and `placeOfSupply` (a 2-digit state code). They are on `POST /orders`, on offline sync, and on table bills
  (`POST /tables/sessions/:id/bill`). The API refuses:
  - a buyer GSTIN when the outlet doesn't issue tax invoices (GST off, or composition scheme);
  - the outlet's own GSTIN as the buyer;
  - `interState: true` together with a place of supply in the outlet's own state.
- **Place of supply:** restaurant and catering service is supplied where it is performed (IGST Act s.12(4)). An out-of-state
  B2B buyer therefore still pays CGST + SGST, and POS stays the outlet's state. A `placeOfSupply` in another state (for
  example, outdoor catering there) makes the bill inter-state (IGST) and decides `interState`. Without it, the old flag is kept.
- **Receipt (thermal + PDF):** prints "Bill to: name, address", "Buyer GSTIN" and the real place of supply (for example "29-Karnataka").
- **GSTR-1 builder (`services/gstr1.ts`):**
  - `b2b`: grouped by `ctin`, with `inum`, `idt` (dd-mm-yyyy IST), `val`, `pos`, `rchrg: N`, `inv_typ: R`, and items per rate.
  - `b2cl`: unregistered, inter-state, invoice value **> ₹1,00,000**, grouped by POS.
  - `cdnr`: credit notes on B2B invoices.
  - `cdnur` (`typ: B2CL`): credit notes on B2CL invoices.
  - Credit notes on B2CS bills still reduce `b2cs`.
  - `b2cs` now groups by POS too. HSN still covers all supplies, and totals are unchanged, so they still reconcile with `/reports/gst`.
  - The xlsx and pdf exports gain a "B2B, B2CL, CDNR, CDNUR" sheet.
- **Web:**
  - POS cart → Customer panel: "Buyer GSTIN (B2B, optional)" and "Buyer legal name", checked on the client too.
  - Table bill dialog: the same two fields.
  - Mobile is not changed. Mobile bills stay B2C until the same two fields are added there.

**B2CL threshold source:** Notification 12/2024-Central Tax (10 Jul 2024) amended FORM GSTR-1 tables 5 and 7. It lowered the
limit for invoice-wise reporting of inter-state supplies to unregistered persons from ₹2.5 lakh to ₹1 lakh, effective 1 Aug 2024
(GSTN advisory, 3 Sep 2024). The limit is `B2CL_LIMIT_PAISE`, and a bill of exactly ₹1,00,000 stays in B2CS.

**Not done (later):**
- Mobile POS fields.
- Editing the buyer after the bill is created (today: cancel and re-bill).
- E-invoicing (IRN) for B2B when turnover is above ₹5 cr (Phase 14 recommendation).
- The HSN B2B/B2C split of table 12 (GSTN phase III).
- Upload of the JSON through the GSTN offline tool (not verified, no portal access).

## 3. Delivery-partner GPS in the background: Implemented (approved P2)
**Before:** live location was foreground only (`useLiveLocation.ts`) and `ACCESS_BACKGROUND_LOCATION` was blocked.

**Built (migration `20261110090000_background_gps_face_check`):**
- **Per-outlet setting `Outlet.backgroundTracking`**, off by default (web: Settings → Delivery dispatch). `GET /delivery/me/status` returns it.
- **Mobile:** `src/delivery/backgroundLocation.ts` defines an `expo-task-manager` task at startup (imported from `app/_layout.tsx`) and calls
  `Location.startLocationUpdatesAsync` with Balanced accuracy, 30 s / 50 m, `pausesUpdatesAutomatically`. On low battery (< 20 %) or in
  low-power mode (`expo-battery`) it uses Low accuracy, 2 min / 200 m. Android runs it as a foreground service with the notification
  "Delivering N orders". iOS uses `UIBackgroundModes: location` and shows the blue indicator.
- **When it runs** (`useBackgroundLocation`, mounted in `PartnerPresenceProvider`): only when the outlet allows it, the partner is clocked in
  and on a run (from pickup until back at the outlet). It stops when the run ends, at clock-out, at sign-out, or when the server answers `stop`.
- **Permission flow:** a prominent in-app disclosure comes first (`BackgroundDisclosure`). Then the app asks for foreground and then background
  permission. If the partner refuses, or iOS grants only "While using", the app falls back to foreground-only (the existing hooks). "Not now"
  is remembered, and the presence card has an "Allow background sharing" button to change it later.
- **Offline batching:** fixes go into a SQLite queue (capped at 120) and are posted to the new `POST /delivery/me/location/batch`
  (at most 50 points, each with its own timestamp). The design said to reuse the single-point endpoints. That doesn't work for a batch whose
  points carry timestamps, so the new endpoint shares their logic (`reportPartnerLocation`, live map, `delivery:location` event).
- **Server validation / throttling** (`services/delivery-track.ts`):
  - **Refused (409 `{code, stop: true}`):** points from a partner who is not clocked in (`OFF_DUTY`), background points when the outlet
    setting is off (`BACKGROUND_OFF`), and background points when the partner is not on a run (`NOT_ON_RUN`).
  - **Dropped:** future points (more than 2 min ahead), stale points (more than 30 min old), fixes worse than 1 km, points less than 10 s
    after the last accepted one (also across batches), and jumps faster than 180 km/h.
  - Only the newest accepted point is applied. When it brings the partner back to the outlet, the reply is `backNow` + `stop`.
- **Retention / privacy:** no location history is stored, as in the design. The server keeps only the latest point (in memory for the live
  map, and `User.lastLat/lastLng/lastLocationAt` for dispatch) and **clears both at clock-out**.

Tests: `known-gaps.test.ts` "gap 3" (6 tests). Mobile: `test/backgroundLocation.test.tsx` (14 tests).
**Needs a real device (dev-client / store build, not Expo Go):**
- the task keeps running with the screen locked or the app swiped away (Android foreground service; iOS background mode);
- the Android 11+ "Allow all the time" Settings round-trip;
- the iOS "Always" upgrade prompt;
- battery drain over a run;
- an iOS headless relaunch reading the session from the keychain while the phone is locked.

Store work is still needed: the Play background-location declaration with a review video, and a privacy-policy update (see `apps/mobile/STORE_RELEASE.md`).

## 4. One offer per bill: Done, combinable coupons Implemented (approved P2)
**Rule:** only the best-saving offer *or* coupon applies (`bestOffer` in `offer-engine.ts`). Loyalty points and the manual
discount still apply on top. Optional stacking **already exists for automatic offers**: offers flagged `combinable` (Phase 3.7)
apply on top, but only on items that no other offer has discounted.

**Covered by tests:**
- `test/integration/offers-combine.test.ts`: "One offer per bill" explanation, combinable stacking, and still one offer without combinable.
- `offer-engine` / `promotions` unit tests.

**Proposal (P2):** add a `combinable` flag on **coupons** too, so a coupon can stack on a combinable offer.
- The order would be: item offers, then the bill offer, then the coupon on the remaining pre-tax value.
- Add a per-business cap (`maxStackedDiscountPercent`, default 30 %) so stacked discounts can't push margins negative.
- The comparison panel would explain each step.

**Why P2:** this is a business-rule change, and it needs the owner to decide the cap.

**Implemented (approved P2):**
- `Coupon.combinable` (default **false**, so one offer *or* coupon per bill stays the rule). The owner opts a coupon in on
  Customers → Coupons ("Combine with offers"); the coupon list marks it "combines with offers".
- Cap: `maxStackedDiscountPercent` in the loyalty settings (Customers → Loyalty, default **30 %**). When a combinable coupon
  stacks, all promotions together may take at most that share of the pre-tax bill (after the manual discount); the
  **coupon** is cut to fit, offers keep their amounts.
- Order (`evaluatePromotions`, plan `STACK`): the best offer and combinable offers (item offers, then the bill offer), then the
  coupon on the **remaining pre-tax value**. Loyalty points come after, as before.
- Choice: stacking is used only when it saves more than both the best offer alone and the coupon alone. A **tie** keeps the
  single coupon (one promotion on the bill). If the offers already use the whole cap, the coupon isn't applied (and isn't
  used up) when the offer saves more; the POS shows why in the warnings and the comparison panel ("applied after the offers…",
  "cut to the stacking limit").
- GST is unchanged: every discount still lowers each line's taxable value before tax (`computeBill`), so GST is charged on
  the discounted value per line.
- Coupon limits (`usageLimit`, `perCustomerLimit`, personal coupons) work exactly as before under stacking; cancelling a bill
  gives the use back.
- Online ordering page: optional "Coupon code" at checkout (`couponCode` on `POST /public/o/:slug/orders`), same rules.
  Mobile POS: no coupon entry yet (unchanged).

Tests: `known-gaps.test.ts` "gap 4" (stacks on the best offer, GST per line on the reduced value) and `coupon-stacking.test.ts`
(default not combinable, order of application, cap, tie, cap already used, usage limits total/per customer + cancel, online).

## 5. Coupon GST treatment and gift cards: Done (verified, no defect)
- Item and bill discounts, offers, coupons and points all reduce the **taxable value before GST** (`computeBill` in
  `packages/shared/src/gst.ts`, which follows CGST s.15(3)(a): the discount is shown on the invoice).
- Bill-level discounts are allocated to lines in proportion to their value, and each line is taxed at its own rate.
- ₹ discounts can be GST-inclusive (D1), but they are still converted to a pre-tax reduction.
- A gift card is a **payment mode** (`GIFT_CARD`), not a discount. Selling a card creates no tax invoice (it is a voucher, and GST
  is charged on the supply when the card is spent). Spending it changes neither the taxable value nor the GST of the bill.

New tests:
- "a coupon reduces each line's taxable value…": per line, taxable = gross − discount, and GST = 5 % of the reduced value.
- "paying with a gift card changes neither…".

## 6. Tab split atomicity: Done (Phase 9)
`test/integration/tab-split-atomic.test.ts`:
- A failure on the 2nd split bill rolls back the 1st.
- The same split succeeds as one unit.
- Invoice numbers are distinct.

Also covered by `test/db/concurrency.test.ts`. Green in this run.

## 7. Clock-in face match: Implemented (approved P2): manager-review fallback
**Design detail that is infeasible on Expo SDK 51:** the design asked for on-device matching (ML Kit face detection plus a MobileFaceNet-class
TFLite model). Managed Expo SDK 51 has no face-recognition module:
- `expo-face-detector` only detects faces, is deprecated, and is removed in SDK 52.
- TFLite or ML Kit needs third-party native modules (`react-native-fast-tflite`, vision-camera frame processors) plus a bundled model.
  Neither can be verified here.

So the design's own fallback is built: **a manager review queue with the photos side by side, plus a liveness-lite prompt.** The API already
accepts the on-device verdict `faceMatch: {matched, score}` (strict schema, so an embedding is refused with 400), so a later native build can
plug in a matcher without server changes.

**Built (same migration):**
- **Opt-in per business:** feature `CLOCK_IN_FACE_MATCH`, off by default, switched on by the platform admin like the other flags.
- **DPDP consent per staff member:** `GET /attendance/face/me` returns the notice (`FACE_CONSENT_NOTICE`) and its version.
  `POST /attendance/face/consent {version, refPhotoUrl}` records explicit consent to the **current** version (`User.faceConsentAt/Version`)
  and enrols the reference photo, which must be uploaded through CANAVO. An old version gets `409 CONSENT_OUTDATED`. Consent is audited
  (`attendance.face_consent`). `DELETE /attendance/face/consent` withdraws consent and deletes the reference photo.
- **Mobile:** the Attendance screen has a `FaceCheckCard` (notice → "I agree · take reference photo", retake, withdraw). The selfie screen shows
  a random liveness prompt ("Blink twice", "Turn your head slightly left", and so on). The capture button unlocks after 1.5 s, and the prompt
  is sent as `livenessPrompt`. The server stores it only if it is one of the known prompts.
- **Clock-in:** consented staff need a selfie even when `CLOCK_IN_SELFIE` is off. The record gets `faceCheck = PENDING_REVIEW`, or
  `MATCHED` / `MISMATCH` when the app sends a verdict (threshold 0.75). **It never blocks clock-in.** A mismatch adds the `FACE_MISMATCH`
  flag and notifies the managers. Staff who did not consent clock in as before (PIN + optional selfie), so consent is free.
- **Manager review:** web Attendance → "Face checks" tab (`GET /attendance/face/reviews`) shows the reference photo and the selfie side by
  side with the prompt. "Same person" / "Not them" calls `POST /attendance/:id/face-review`. A rejection adds the `FACE_REJECTED` flag;
  the record is never deleted. Each decision is audited.
- **No biometric template** is computed, sent or stored anywhere. Only the two photos the person took are kept.
- **Retention:** the hourly job `attendance-selfies:purge` clears clock-in selfies older than 90 days and deletes the locally stored files
  (Cloudinary files follow Cloudinary's own retention rules).
- **Erasure:** no staff-erasure flow existed, so face data (consent and reference photo) is erased on withdrawal and when a staff member
  is deactivated (`PATCH /staff/:id` with status other than ACTIVE).

Tests: `known-gaps.test.ts` "gap 7" (7 tests). Mobile: `test/faceCheck.test.tsx` (7 tests).
**Needs a real device:** the front camera capture and the prompt timing, and reference-photo upload on a slow network. The privacy-policy
notice text needs legal review before the feature is switched on for a business.

## 8. Business archive: Implemented now (P1). Delete after retention: Implemented (approved P2)
**Why P1 (archive):** without it, a hotel that leaves can only be "suspended", which looks temporary. Its logins and storefront
must stop for good while its tax records are kept.

**What was built:**
- `POST /platform/businesses/:id/archive {confirmName, reason}`: super admin only (support users and owners get 403). It needs the
  exact business name (case-insensitive) and sets:
  - `status = ARCHIVED`, `archivedAt`, `archiveReason`;
  - `deleteAfter` = **1 April, 7 years after the end of the financial year the business was archived in** (IST). This is the later of
    GST (s.36 + Rule 56: 72 months from the due date of the annual return, 31 Dec after the FY) and income tax (Rule 6F: 6 years from the end of the assessment year).
  - Everyone in the business is signed out. Login, every API request and sockets refuse non-ACTIVE businesses, and the message says "closed (archived)".
  - The storefront and every job already skip non-ACTIVE businesses.
  - The action is audited.
- `POST /platform/businesses/:id/restore` sets the business back to ACTIVE and clears the archive fields. `PATCH` on an archived business returns 409.
- Data is untouched. Because the super admin can't download hotel data (privacy rule), the console tells the operator to have the
  owner export their data (`data:export`) *before* archiving.
- **Web:** Platform → business: an **Archive** button (type the name, then give a reason), an archived banner with the retention date,
  **Restore**, and an "Archived" filter and badge.

**Proposal (P2), delete after retention:**
- A monthly platform job lists businesses whose `deleteAfter` has passed.
- The super admin approves each one (a dry-run report of row counts per table).
- The owner gets an emailed final export link 30 days before.
- The purge runs with `app.bypass_rls`, deleting every business-scoped table in FK order (plus uploads in storage) in batches.
- It leaves a tombstone (`Business` row with name hash, dates and a deletion audit entry) and removes the business from backups as they age out.

**Why P2:** deletion is irreversible, it touches every table, and it needs an approved retention policy and legal sign-off.

**Implemented (approved P2), `services/business-purge.ts`:**
- **Final export first.** The daily `business-retention` platform job writes a CSV-zip export of every archived business that
  is within 30 days of `deleteAfter` (to `storage/exports`) and emails each owner a one-time-token link
  (`GET /public/business-export/:token`; only its SHA-256 is stored). The super admin can send it earlier
  (`POST /platform/businesses/:id/final-export`) but never receives the link or the file. Re-sending replaces the link; the
  first offer date is kept.
- **Dry run:** `GET /platform/businesses/:id/purge-preview`: row counts per table, `purgeFrom`, `canPurge` and blockers.
- **Approval:** `POST /platform/businesses/:id/purge {confirmName, confirmText: "DELETE"}` (super admin only). It is refused (409)
  for a business that isn't archived, **before `deleteAfter`**, and until 30 days after the final export was offered.
- **Purge (RLS bypassed):** a `BusinessTombstone` is written first. Then:
  - uploaded images referenced by the business's rows are deleted (local files; Cloudinary through its destroy API when configured);
  - every business-scoped table is deleted, children first, in batches of 500;
  - the `Business` row and its export file are deleted.
- **What is kept:** the tombstone (business id, SHA-256 of the name, created/archived/delete-after/export/approval/completed dates,
  row counts, files deleted/failed) and the platform audit entries (`platform.business.archive / final_export / purge`). Hotel
  user ids in platform audit rows are cleared.
- **Idempotent:** approving again returns the tombstone. The job resumes a purge that stopped half way, re-offers nothing, and
  never deletes a business that no super admin approved (it only lists them).
- **Web:** Platform → business (archived): a "Retention and deletion" card with the dates, blockers, "Email final export to
  owners" and "Delete permanently" (row counts, type the name and DELETE).
- Backups are not rewritten; the deleted business leaves them as they age out (`BACKUP_RETENTION`).

Tests: `business-purge.test.ts` (refused before retention / before the export notice, one-time link download, typed confirmation
and roles, full purge incl. files with tombstone + audit kept and other hotels untouched, idempotent approval, job notice once,
job resume, tombstones not visible to hotels) and `known-gaps.test.ts` "gap 8b".
