# Cinema seat ordering: API contract

This is the contract between the backend (agent th1) and the web app (agent th2). Both build against it in parallel. Any change must be written here first.

- **Shared zod schemas and types:** `packages/shared/src/schemas-theatre.ts`.
- **Module:** `THEATRE`, which requires `BILLING`, `TABLES` and `CHANNELS`.
- **Money:** amounts are integer paise.
- **Times:** ISO-8601 with offset; the outlet's timezone applies for day boundaries.

## Data model (owned by th1)

- **`DiningArea`:** new `kind` enum `FLOOR | SCREEN` (default `FLOOR`) and `qrToken String? @unique`, the screen-level QR. A screen is an area with `kind = SCREEN`.
- **`DiningTable`:** new `seatRow String?` and `seatNumber Int?`. A seat is a table in a SCREEN area.
  - Its `label` is `<screenCode>-<row><number>`, e.g. `S2-F12`, unique per outlet as today.
  - The screen code is `S` followed by the screen's position (1, 2, …), or the area's own short code if one is set.
  - Seats keep `capacity` 1, `shape` SQUARE and get their own `qrToken` when created.
- **`ShowTime` (new, outlet-scoped, with RLS):** `id`, `outletId`, `areaId` (screen), `title`, `startsAt`, `intervalAt?`, `endsAt`, `orderCutoffMin` (default 15), `createdAt`, `updatedAt`. Indexed `(outletId, areaId, startsAt)`.
- **`ChannelRequest`:** new `seatTiming String?` (`NOW | INTERVAL | COUNTER`), `showTimeId String?` and `pickupToken Int?`. The pickup token runs per outlet per local day: 1, 2, 3…
- **Theatre settings:** stored inside `Outlet.storefront` JSON under the key `theatre` (`theatreSettingsSchema`).

## Staff API

All routes require authentication, an outlet, `requireModule("THEATRE")` and the permission named per route.

| Method and path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /theatre/screens` | `table:serve` | none | `Screen[]` (shape below) |
| `POST /theatre/screens` | `table:manage` | `screenSchema` | `Screen` (201) |
| `PATCH /theatre/screens/:id` | `table:manage` | `screenUpdateSchema` | `Screen` |
| `DELETE /theatre/screens/:id` | `table:manage` | none | 204. 409 if a seat has an open session or a pending request. |
| `POST /theatre/screens/:id/seats` | `table:manage` | `seatBulkSchema` | `{ created: number, skipped: number, total: number }` |
| `DELETE /theatre/seats/:id` | `table:manage` | none | 204. The seat is deactivated if it has history. |
| `POST /theatre/screens/:id/qr/rotate` | `table:manage` | none | `Screen`. Gives the screen a new `qrToken`; the old one stops working. |
| `GET /theatre/showtimes?date=YYYY-MM-DD&screenId=` | `table:serve` | none | `ShowTime[]` overlapping that local day |
| `POST /theatre/showtimes` | `table:manage` | `showTimeSchema` | `ShowTime` (201). 409 if it overlaps another show on the same screen. |
| `PATCH /theatre/showtimes/:id` | `table:manage` | `showTimeUpdateSchema` | `ShowTime` (same overlap rule) |
| `DELETE /theatre/showtimes/:id` | `table:manage` | none | 204 |
| `GET /theatre/settings` | `table:serve` | none | `TheatreSettings` |
| `PATCH /theatre/settings` | `table:manage` | `theatreSettingsSchema.partial()` | `TheatreSettings` |
| `GET /theatre/board?screenId=` | `table:serve` | none | `RunnerBoard` (below) |
| `POST /theatre/orders/:requestId/ready` | `table:serve` | none | `BoardOrder` (the food is ready for a runner or the counter) |
| `POST /theatre/orders/:requestId/delivered` | `table:serve` | none | `BoardOrder` (handed over at the seat or counter) |
| `GET /reports/theatre?from=YYYY-MM-DD&to=YYYY-MM-DD` | `report:view` | none | `TheatreReport` (below) |

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
- **`GET /public/t/:token/orders`:** adds `timing`, `pickupToken` and `stage` (as in `BoardOrder`) for seat orders.

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
