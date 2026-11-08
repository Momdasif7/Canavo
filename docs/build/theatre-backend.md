# Cinema seat ordering: backend (agent th1)

Branch `agent/th1`. The API follows `docs/build/theatre-contract.md`. Additions made during the build are written into the contract.

## What changed

### Database

There are two migrations:

- `20261108120000_theatre_seat_ordering`
  - Adds the `AreaKind` enum.
  - `DiningArea` gets `kind`, `code` and `qrToken` (unique).
  - `DiningTable` gets `seatRow` and `seatNumber`.
  - `ChannelRequest` gets `seatTiming`, `showTimeId` and `pickupToken`, with indexes.
  - `KotTicket` gets `header`.
  - New table `ShowTime`: FKs to `Outlet` and `DiningArea`, both with cascade delete. It has FORCE row-level security with the standard `tenant_isolation` outlet policy.
  - CHECK constraints:
    - show times are ordered;
    - the cut-off is 0–120;
    - `seatTiming` is one of the allowed values;
    - `pickupToken` > 0;
    - `seatNumber` > 0.
- `20261108120100_theatre_runner_stages`
  - `ChannelRequest` gets `readyAt` and `deliveredAt`.

`prisma migrate diff` is empty against both migrations. `docs/qa/sql/tenant-integrity.sql` was regenerated; `ChannelRequest.showTimeId` is checked as a soft reference to `ShowTime`.

### Code

- **`src/services/theatre-kot.ts`:**
  - settings reader;
  - KOT header;
  - interval release time;
  - `fireSeatKots`: locks the request row, so the KOT fires only once even if payment and staff accept arrive together;
  - the `settleIfPaid` hook.
- **`src/services/theatre.ts`:**
  - screens and seats;
  - showtimes (an advisory lock per screen guards the overlap check);
  - the seat ordering window;
  - seat order placement;
  - pickup tokens (an advisory lock per outlet, highest number of the local day + 1);
  - board and stage moves;
  - guest tracking;
  - the unpaid-order expiry.
- **`src/routes/theatre.ts`:** the `/theatre` routes. Every route uses `requireModule("THEATRE")` plus `table:serve` or `table:manage`.
- **`src/routes/reports.ts`:**
  - Adds `GET /reports/theatre`, with JSON, xlsx and pdf output.
  - It is not added to `REPORT_KEYS`. Adding it there would change the web schedules page, which belongs to th2.
- **`src/routes/storefront-public.ts`:**
  - Seat branches on `GET`/`POST /public/t/:token[/orders]`.
  - New `POST /public/t/:token/orders/:orderToken/upi`.
  - New `GET /public/s/:screenToken`, behind the same rate limiter as the other public routes.
- **`src/services/storefront.ts`:**
  - `tableByToken` gates seats on THEATRE and on `seatOrdering` (or menu view).
  - `acceptRequest`: a seat branch that fires the KOTs if the order is already paid.
  - `rejectRequest`: emits the theatre event.
  - `issueUpi`: returns the QR's `mock` and `imageUrl` flags.
- **`src/services/billing.ts`:** `settleIfPaid` calls `onSeatOrderPaid` for QR orders. The webhook, cashier confirm and dev-simulate paths all release the KOT this way.
- **`src/routes/kot.ts`:**
  - The KOT `header` becomes the print header.
  - A KOT status change on a seat order emits `theatre:updated`.
  - New `emitKotsUpdated` keeps kitchen screens in step with board moves.
- **`src/jobs-service.ts`:**
  - The release job emits `theatre:updated` when held seat KOTs go out.
  - New job `theatre-unpaid-expiry`, every minute.
- **`src/routes/tables.ts` and `src/routes/storefront.ts`:**
  - SCREEN areas and seats are kept off the floor plan, the table list, the area list and the table QR list (unless `?includeScreens=1`).
  - Screens can't be edited through `/tables/areas`.
  - `PUT /storefront/settings` keeps the `theatre` key in the storefront JSON.
- **OpenAPI:** `src/openapi-theatre.ts`. `docs/api` was regenerated.

## Decisions

- **Seat orders are QR `ChannelRequest`s with a bill created at once.**
  - The bill is a DINE_IN order with channel QR and table label `S1-A4`, and no KOT yet.
  - The guest pays a UPI QR: the store's own Razorpay, else the shared platform account, else a mock `upi://pay` intent that a cashier confirms.
  - The KOT goes out in the payment's own transaction once the order is paid, and accepted if the outlet confirms QR orders.
  - Rejecting a seat order uses the online-order path: the bill is voided, or credit-noted and refunded if paid.
- **No table sessions for seats.** The floor plan stays clean, and each order is its own prepaid bill.
- **Interval KOTs:** `releaseAt` = `intervalAt − intervalLeadMin`.
  - If that time has already passed, the KOT is released at once (`releaseAt` null). This keeps the existing release job's cursor rule ("releaseAt is always in the future at creation").
  - Verified: `GET /kot` hides held KOTs until `releaseAt`.
- **The screen code is stored** (`DiningArea.code`, the smallest free `S<n>`), so seat labels never go stale.
- **Show window:**
  - Ordering is open from `startsAt − 30 min` to `closesAt`.
  - The status reads INTERVAL for 15 minutes after `intervalAt`.
  - Seats ignore the dine-in accepting hours.
- **History is protected:**
  - A show with seat orders can't be deleted (409).
  - A screen with seat-order history can't be deleted (409).
  - A seat with history is deactivated rather than deleted.
  - These keep the reports and the tenant-integrity soft references intact.
- **Unpaid seat orders** are cancelled after 30 minutes (the Razorpay QR closes after 15), so they don't stay in Open bills.
- **Board stages:**
  - DELIVERED only from the runner board (`deliveredAt`).
  - READY from the board or when the kitchen marks all KOTs Ready.
  - Ready / Delivered also move the KOTs to Ready / Served on the kitchen display.

## Tests

`apps/api/test/api/theatre.test.ts` has 22 tests, all passing. `test/api/sweep-auth.test.ts` now allows the two new public routes. Last full runs: integration 207/207, test:api 782 (all green after the sweep-auth allowlist fix), test:db 10 files green, unit 56 + 160. They cover:

- the role matrix for all 17 staff routes;
- 403 when the module is off, and 404 on public routes when it is off;
- isolation between tenants, outlets and the super admin;
- bulk seats: idempotent, skip list, revival, limits, the 3,000-seat cap;
- showtimes: overlap, back-to-back shows, validation, parallel race;
- the seat page in each state: open, not yet, closed, no show, no interval ahead;
- prepay: UPI QR, no KOT before payment, KOT header after, print header;
- interval `releaseAt`, the hidden KOT and the board countdown;
- all timing refusals;
- pickup tokens with 8 orders in parallel;
- the confirm-first flow: paid then accepted, accepted then paid, rejected;
- the unpaid expiry;
- board grouping, stage moves and outbox `theatre:updated` events;
- report sums and the xlsx export;
- settings, including surviving a storefront save;
- screen QR rotation;
- restaurant tables unaffected.

## At merge

- Apply the migrations `20261108120000_theatre_seat_ordering` and `20261108120100_theatre_runner_stages` with `prisma migrate deploy`, then run `prisma generate`.
- No new environment variables.
- Payments use the existing Razorpay setup:
  - per store: Settings → Integrations, or `RAZORPAY_SHARED_ACCOUNT`;
  - without either, the mock QR is used and confirmed by the cashier.
- Rebuild `@canavo/shared` (theatre schemas, `THEATRE` module).

## Not verified

- Delivery of socket events in a browser. Only the outbox rows were checked.
- A real Razorpay QR or webhook (fake and mock only).
- A Razorpay payment that arrives after the 30-minute expiry: the bill would already be cancelled. This is unlikely because the QR closes after 15 minutes.
