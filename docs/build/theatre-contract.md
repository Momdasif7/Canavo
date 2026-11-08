# Cinema seat ordering: API contract

This is the contract between the backend (agent th1) and the web app (agent th2). Both build against it in parallel. Any change must be written here first.

- **Shared zod schemas and types:** `packages/shared/src/schemas-theatre.ts`.
- **Module:** `THEATRE`, which requires `BILLING`, `TABLES` and `CHANNELS`.
- **Money:** amounts are integer paise.
- **Times:** ISO-8601 with offset; the outlet's timezone applies for day boundaries.

## Data model (owned by th1)

- **`DiningArea`:** new `kind` enum `FLOOR | SCREEN` (default `FLOOR`), `qrToken String? @unique` (the screen-level QR) and `code String?` (the screen code, set once at creation). A screen is an area with `kind = SCREEN`.
- **`DiningTable`:** new `seatRow String?` and `seatNumber Int?`. A seat is a table in a SCREEN area.
  - Its `label` is `<screenCode>-<row><number>`, e.g. `S2-F12`, unique per outlet as today.
  - The screen code is `S` followed by the smallest free number (S1, S2, …), stored in `DiningArea.code` when the screen is created and never changed, so seat labels stay valid when screens are renamed or reordered.
  - Seats keep `capacity` 1, `shape` SQUARE and get their own `qrToken` when created.
- **`ShowTime` (new, outlet-scoped, with RLS):** `id`, `outletId`, `areaId` (screen), `title`, `startsAt`, `intervalAt?`, `endsAt`, `orderCutoffMin` (default 15), `createdAt`, `updatedAt`. Indexed `(outletId, areaId, startsAt)`.
- **`ChannelRequest`:** new `seatTiming String?` (`NOW | INTERVAL | COUNTER`), `showTimeId String?` and `pickupToken Int?`. The pickup token runs per outlet per local day: 1, 2, 3… (COUNTER orders only). Also `readyAt` / `deliveredAt DateTime?` for the runner board stages, so the board works without the KOT module.
- **`KotTicket`:** new `header String?`, the big seat line (e.g. `SCREEN S2 · F12 · INTERVAL`). It is on every KOT in `GET /kot`, `kot:new` and `kot:updated`, and is the header line of the printed KOT. An INTERVAL badge = header contains `· INTERVAL` (held ones also carry `releaseAt`).
- **Theatre settings:** stored inside `Outlet.storefront` JSON under the key `theatre` (`theatreSettingsSchema`).

## Staff API

All routes require authentication, an outlet, `requireModule("THEATRE")` and the permission named per route.

| Method and path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /theatre/screens` | `table:serve` | none | `Screen[]` (shape below) |
| `POST /theatre/screens` | `table:manage` | `screenSchema` | `Screen` (201) |
| `PATCH /theatre/screens/:id` | `table:manage` | `screenUpdateSchema` | `Screen` |
| `DELETE /theatre/screens/:id` | `table:manage` | none | 204. 409 if a seat has an open session or a pending request, or if the screen has seat orders in its history (rename it instead). |
| `POST /theatre/screens/:id/seats` | `table:manage` | `seatBulkSchema` | `{ created: number, skipped: number, total: number }`. Inactive seats in the range are reactivated (counted as created). At most 3,000 seats per screen (400). |
| `DELETE /theatre/seats/:id` | `table:manage` | none | 204. The seat is deactivated if it has history. |
| `POST /theatre/screens/:id/qr/rotate` | `table:manage` | none | `Screen`. Gives the screen a new `qrToken`; the old one stops working. |
| `GET /theatre/showtimes?date=YYYY-MM-DD&screenId=` | `table:serve` | none | `ShowTime[]` overlapping that local day |
| `POST /theatre/showtimes` | `table:manage` | `showTimeSchema` | `ShowTime` (201). 409 if it overlaps another show on the same screen. |
| `PATCH /theatre/showtimes/:id` | `table:manage` | `showTimeUpdateSchema` | `ShowTime` (same overlap rule) |
| `DELETE /theatre/showtimes/:id` | `table:manage` | none | 204. 409 if the show has seat orders (kept for the reports). |
| `GET /theatre/settings` | `table:serve` | none | `TheatreSettings` |
| `PATCH /theatre/settings` | `table:manage` | `theatreSettingsSchema.partial()` (unknown keys → 400) | `TheatreSettings` |
| `GET /theatre/board?screenId=` | `table:serve` | none | `RunnerBoard` (below) |
| `POST /theatre/orders/:requestId/ready` | `table:serve` | none | `BoardOrder` (the food is ready for a runner or the counter) |
| `POST /theatre/orders/:requestId/delivered` | `table:serve` | none | `BoardOrder` (handed over at the seat or counter) |
| `GET /reports/theatre?from=YYYY-MM-DD&to=YYYY-MM-DD` | `report:view` | `&format=json\|xlsx\|pdf` | `TheatreReport` (below); 403 without THEATRE. Defaults: `to` = today, `from` = to − 6 days. |

Board details: orders of the last 12 hours, not rejected; unpaid ones (`paid: false`, stage WAITING) only for 30 minutes after placing, so a cashier can confirm a mock UPI payment by hand (`POST /orders/:orderId/payments/:paymentId/confirm`); DELIVERED ones for 15 minutes. `ready` → 409 when unpaid, not yet accepted, held for the interval or already delivered; `ready` on a READY order returns it unchanged. Kitchen marking all KOTs READY also shows READY. Unpaid seat orders are cancelled automatically after 30 minutes (job `theatre-unpaid-expiry`).

Restaurant screens are unaffected: `GET /tables/floor` never shows SCREEN areas or seats; `GET /tables`, `GET /tables/areas` and `GET /storefront/tables` leave them out unless `?includeScreens=1`; `/tables/areas/:id` and `POST /tables` with a screen's `areaId` → 404.

```ts
type Screen = {
  id: string; name: string; code: string;           // code e.g. "S2"
  sortOrder: number; qrToken: string;               // screen QR: /s/<qrToken>
  seatCount: number;
  rows: { row: string; seats: { id: string; label: string; seatNumber: number; qrToken: string; active: boolean }[] }[];
  currentShow: ShowTime | null; nextShow: ShowTime | null;
};
type ShowTime = {
  id: string; screenId: string; screenName: string; title: string;
  startsAt: string; intervalAt: string | null; endsAt: string; orderCutoffMin: number;
  closesAt: string;                                 // endsAt - orderCutoffMin
  status: "UPCOMING" | "RUNNING" | "INTERVAL" | "ENDED";
};
type BoardOrder = {
  requestId: string; orderId: string | null; publicToken: string;
  screenId: string; screenName: string; seatLabel: string; row: string | null; seatNumber: number | null;
  timing: "NOW" | "INTERVAL" | "COUNTER"; pickupToken: number | null;
  stage: "WAITING" | "PREPARING" | "READY" | "DELIVERED";   // WAITING = interval order held until its KOT is released
  releaseAt: string | null;                         // when an interval order goes to the kitchen
  items: { name: string; quantity: number; notes?: string }[];
  total: number; paid: boolean; createdAt: string; customerName: string | null;
};
type RunnerBoard = {
  screens: { id: string; name: string; code: string; currentShow: ShowTime | null;
             rows: { row: string; orders: BoardOrder[] }[] }[];
  counter: BoardOrder[];                            // timing COUNTER, ordered by pickupToken
};
type TheatreReport = {
  from: string; to: string;
  totals: { orders: number; sales: number; avgOrder: number };
  byScreen: { screenId: string; name: string; orders: number; sales: number }[];
  byShow: { showTimeId: string; title: string; screenName: string; startsAt: string; orders: number; sales: number }[];
  byTiming: { timing: "NOW" | "INTERVAL" | "COUNTER"; orders: number; sales: number }[];
};
```

## Public API (guests, no login)

These follow the existing table-QR rate limits.

- **`GET /public/t/:token`:** unchanged for normal tables. When the table is a seat, the response adds:

  ```ts
  theatre: {
    seat: { label: string; screenName: string; screenCode: string; row: string; seatNumber: number };
    show: (ShowTime & { orderingOpen: boolean; reason?: string }) | null;   // reason: "No show on this screen now", "Ordering has closed for this show"
    options: { now: boolean; interval: boolean; counter: boolean };         // interval only if the show has an interval still ahead (minus lead time)
    settings: { intervalLeadMin: number };
  }
  ```

  Ordering is open while `seatOrdering` is on and now is between `startsAt − 30 min` and `closesAt`.
- **`GET /public/s/:screenToken`:** the screen-level QR, where the guest picks row and seat.
  - Returns `{ outletName, screen: { name, code }, show: ShowTime | null, rows: { row: string; seats: { label: string; seatNumber: number; token: string }[] }[] }`, active seats only.
  - The web page then goes to `/t/<token>`.
- **`POST /public/t/:token/orders` for a seat:**
  - **Body:** `seatOrderSchema` (`qrOrderSchema` plus `timing`).
  - **Payment:** always prepaid by UPI. The response is the same shape as the online-order response with a UPI QR (`{ token, status, upi: { qrPayload, imageUrl?, amount, mock }, … }`) plus `timing` and `pickupToken` (COUNTER only).
  - **Refused (409, clear message):**
    - ordering is closed;
    - INTERVAL is chosen but there is no interval ahead;
    - COUNTER is chosen while counter pickup is off;
    - NOW is chosen while delivery during the show is off.
  - **Kitchen release:**
    - **NOW and COUNTER:** the KOT goes out once payment is confirmed (and, if the outlet requires QR confirmation, accepted).
    - **INTERVAL:** the KOT is created with `releaseAt = intervalAt − intervalLeadMin`.
  - **KOT text:** the header reads `SCREEN <code> · <row><n> · NOW|INTERVAL|COUNTER #<token>`.
- **`GET /public/t/:token/orders`:** for a seat, the orders of the current show on that seat: `{ id, token, createdAt, status, stage, timing, pickupToken, releaseAt, paid, rejectReason, total, items: { name, quantity }[], upi: { amount, qrPayload } | null }`. `stage` is the `BoardOrder` stage, or `CANCELLED` for a rejected / expired order. `upi` is the QR still to pay.
- **`POST /public/t/:token/orders/:orderToken/upi`** (seat orders): a fresh UPI QR when the first expired → `{ qrPayload, imageUrl, amount, mock }` (201); 409 if already paid / cancelled.
- **Seat page extras:** `GET /public/t/:token` for a seat has `ordering` (= `theatre.show.orderingOpen`), `notice` (e.g. "No show on this screen now"), `hours: null`. When there is no show, `theatre.show` is `null` and the reason is in `notice`. Not yet open: `show.reason` = "Ordering opens at HH:MM". Seat ordering off: "Seat ordering is off right now". Seats follow `seatOrdering`, not dine-in `qrOrdering`, and ignore the dine-in accepting hours.
- **Order response for a seat (201):** `{ id, token, status: "ACCEPTED" | "PENDING", timing, pickupToken: number | null, total, upi: { qrPayload, imageUrl: string | null, amount, mock } }`.

## Web pages (owned by th2)

| Page | Who | What |
|---|---|---|
| `/t/[token]` (seat) | Guest | Dark, quiet layout. The seat banner reads "Screen 2 · F12". Show strip: title, "Ordering closes in 25 min", interval time. The existing menu, cart and checkout, then a timing choice (3 big options; disabled ones explained), then UPI payment, then tracking (stage + pickup token large). |
| `/s/[token]` | Guest | Dark: pick row, then seat (a grid), then go to `/t/<seat token>`. |
| `/theatre` (nav "Cinema", module THEATRE) | Owner, manager | Screens list. Create a screen; bulk-add seats (rows A–M, seats 1–20, skip list); seat map grid; print QR sheets (all seats of a screen, A4, 12 per page, seat label large; plus the screen QR poster); rotate the screen QR. |
| `/theatre/showtimes` | Owner, manager | Day view per screen: add, edit, delete shows (title, start, interval, end, cut-off), overlap errors shown. |
| `/theatre/board` | Cashier, waiter, runner | Runner board: tabs per screen, orders grouped by row, interval orders show a countdown to release, Ready and Delivered buttons. Counter column: pickup tokens large. Live via socket events `theatre:updated` (th1 emits on every stage change) with a polling fallback. |
| Kitchen display | Kitchen | KOT cards for seat orders show the big seat line (from the KOT header) and an INTERVAL badge. |
| `/reports/theatre` | `report:view` | Totals, by screen, by show, by timing; date range like the other reports; Excel export if the reports kit supports it. |
| Settings | Owner | Theatre settings card: seat ordering on/off, interval lead minutes, counter pickup, deliver during show. Also rename the existing QR settings: **"Order at table (dine-in QR)"** and **"Online ordering (delivery & pickup link)"**, each with a one-line explanation, so table QR and online ordering are not confused. |
