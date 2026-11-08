# Cinema seat ordering: web UI (th2)

This is the web half of the THEATRE module, built against `docs/build/theatre-contract.md`. The backend is on `agent/th1` (see `theatre-backend.md`). The final backend (`8e60ea0`) is merged into `agent/th2`, and every check below ran against it.

## What changed

### Guest pages (no login)

**`/t/[token]` for a seat**
- `app/t/[token]/page.tsx` loads the page as before. When the response has `theatre`, it renders `components/theatre/SeatOrder.tsx` instead of the table view, and the table-order polling stops.
- **Look:** cinema mode (see below), a seat banner ("Screen 1 · F12"), and a show strip with the title, "Ordering closes in N min" and the interval time.
- **Flow:**
  - The existing Swiggy-style `StoreMenu` and `CartBar`.
  - A full-page cart step: lines, a note, optional name and phone, and the bill.
  - A timing step: three big radio cards. A disabled card says why: not offered during the show, "This show has no interval", too late for the interval (needs N minutes), or counter pickup off.
  - A UPI step with a "Pay with a UPI app on this phone" deep link, a dimmed QR for another phone, and "QR expired? Get a new one" (`POST /public/t/:token/orders/:orderToken/upi`).
  - Tracking: the stage, a 4-step bar, and the pickup token at 96 px for counter orders.
- **Order strips** above the menu show the last 3 orders on this seat, each with its stage, its token and a "Pay" button while unpaid.
- **Payment details:** they are kept per seat in localStorage. The page also uses the `upi` field from `GET /orders`, so the QR can be reopened.
- **Polling:** every 4 s while a payment is open, 8 s while an order is active, 30 s otherwise. It runs only while the page is visible, and there are no sockets on guest phones.

**`/s/[token]`:** dark. The guest picks a row (4-column grid of 64 px buttons), then a seat (56 px buttons), and goes to `/t/<seat>?c=1`.

**Cinema mode** (`components/theatre/cinema.ts`, `cinema-init.ts`, `globals.css` `html.cinema`)
- **Colours:** near-black surfaces, soft text, and a dim amber accent instead of the bright brand colour. Images are at 80 % brightness.
- **Cheap phones:** no backdrop blur, animations or transitions.
- **No interruptions:** no toasts, sounds or vibration; every message is inline. The `theme-color` meta is set dark.
- **No white flash:** an inline head script turns cinema mode on before the first paint for `/s/*` and for `/t/*?c=1`. Printed seat QR codes carry `?c=1`. A seat opened without the flag switches once the page loads.

### Staff pages

The nav has a new "Cinema" group (`components/layout/nav.ts`), gated on module THEATRE. Its pages show as tabs.

**Runner board** (`/theatre/board`, `table:serve`)
- **Layout:** tabs per screen with counts. Orders are grouped by row and sorted by seat.
- **Screen header:** the current show, "Interval in mm:ss" and "Orders close …".
- **Order cards:**
  - Big seat code, timing badge, stage, items, total, Paid / Awaiting UPI.
  - Held interval orders show "To kitchen in m:ss".
  - Buttons: **Ready** (PREPARING) and **Delivered** (READY).
- **UPI received:** a button for `payment:collect`. It finds the order's pending UPI payment and calls the existing `POST /orders/:id/payments/:paymentId/confirm`, for mock or no-webhook UPI.
- **Counter column:** pickup tokens at 48 px.
- **Live updates:**
  - The board reloads on the socket events `theatre:updated`, `kot:updated`, `kot:new`, `order:paid` and `connect`, debounced by 250 ms.
  - It polls every 15 s, and reloads when the tab becomes visible or the network returns.
  - It schedules a reload at the next interval release time.

**Screens & seats** (`/theatre`, `table:manage`)
- Screens list.
- Add, rename and delete a screen; a 409 shows its message.
- **Bulk seats dialog:**
  - Rows as `A-M` or `A, B, F-H`, plus "from" / "to" and a "leave out" list.
  - A live count of the new seats, checked with `seatBulkSchema`.
- **Seat map:** a seat grid with "Screen this way". A gap is a skipped seat.
- **Seat dialog:** the seat's QR, an "Open guest page" link and "Remove seat".
- "New screen QR" (rotate), with a confirmation step.

**Print** (`/theatre/print/[screenId]`, `?kind=poster`)
- **Preview:** white A4 sheets on screen.
- **Print:** while the page is open it sets `@page { size: A4; margin: 0 }`, and only the sheets print.
- **Seat sheets:** 12 per page (3 × 4), with a 15 mm seat label, a 38 mm QR and dashed cut lines.
- **Screen poster:** one A4 page with a 120 mm QR to `/s/<token>`.

**Showtimes** (`/theatre/showtimes`, `table:manage`)
- **Day picker:** previous / next / today.
- **Timeline per screen:** 08:00 to 02:00, with blocks, an interval marker and a red "now" line. Tap a block to edit.
- **List per screen:** status badge, times, interval and close time; edit and delete buttons.
- **Add / edit dialog:**
  - Fields: screen, title, date, start / interval / end, cut-off.
  - Times earlier than the start roll over to the next day.
  - Checked with `showTimeSchema`.
  - An overlap with a show of that day is shown before saving ("This overlaps “X” (4:08 pm–6:58 pm) on Screen 1"). The API's 409 is shown without its raw UTC timestamps.

**Kitchen display** (`app/(app)/kitchen/page.tsx`)
- Seat KOTs get a black seat bar, "S1 · G5", with a badge: **INTERVAL** (amber), **COUNTER #n** (blue) or **TO SEAT NOW**.
- The bar is parsed from `KotTicket.header`, with the order note as a fallback (`parseSeatHeader` in `lib/theatre.ts`).
- The order note drops the repeated header and the "UPI prepaid" text.

**Report** (`/reports/theatre`)
- A "Cinema" tab, shown only with THEATRE.
- Three KPI cards (orders, sales, average order), sales by screen (`RankedBars`), "When guests wanted it" (`ShareList`) and a by-show table.
- The shared date range and the Excel / PDF exports (the backend supports `format=xlsx|pdf`).

### Settings

- **Theatre settings card** (`components/theatre/TheatreSettingsCard.tsx`): on Settings → QR & online ordering, only with THEATRE. Options: seat ordering, deliver during the show, counter pickup, interval lead minutes (0–60). Read-only without `table:manage`.
- **Renamed QR settings:**
  - "QR table ordering" is now **"Order at table (dine-in QR)"**: "For guests sitting in your restaurant…; it goes on that table's bill and they pay when they leave."
  - "Online ordering page" is now **"Online ordering (delivery & pickup link)"**: "For customers who are not at a table: one web link…".
  - The settings tab and nav entry are now "QR & online ordering".
  - The Table QR codes page points to the renamed setting.

### Shared web code

- `lib/theatre.ts`:
  - Typed contract types and `theatreApi` (every staff route); `publicTheatre`.
  - `guestStage()`, which accepts both the board stages and the old table-order stages, and CANCELLED.
  - Countdown and clock helpers, and time-zone conversion (`zonedIso` / `zonedParts`; show times are entered in the outlet's time zone).
  - `parseRows`, `parseSeatHeader`.
- `Kot.header` added to `lib/types.ts`.

## Decisions

- **Seat page flow.** The seat page is a step flow on one page, not dialogs. Fewer overlays in the dark, a big fixed bottom button, and the back arrow always returns to the menu.
- **Cinema accent.** It replaces the brand colour on seat pages. A bright orange button lights up a dark hall. Business branding stays in the outlet name and logo-free header.
- **UPI QR panel.** It is a mid-grey panel (#d4d4d4), not white: still scannable, much less glare. On the guest's own phone the "Pay with a UPI app on this phone" deep link comes first.
- **`?c=1` on printed seat codes.** It removes the white flash before the page knows it is a seat. A code printed without it still works.
- **Unpaid orders on the board.** A dashed red border, "Waiting for payment" and no interval countdown, because the backend reports unpaid orders as stage WAITING.
- **The "UPI received" button.** It is the only way to settle mock UPI without the POS. It uses the existing cashier confirm endpoint, so it is audited like any manual UPI confirmation.
- **Print page.** It lives inside the app shell (with a back link) and uses the existing `.print-sheet` rule. The A4 `@page` rule is injected only while the page is mounted, so receipt / KOT printing keeps its roll size.

## Browser run

Run on the scratch API (:4150) and web (:3250, `next dev`) against `canavo_th2_dev` (migrate deploy and seed). CHANNELS and THEATRE were enabled for Demo Hotel by SQL on the scratch DB, because the seed doesn't include them. Outlet timezone Asia/Kolkata. Script: `scratchpad/pwcheck/th2-shots.js`.

Screenshots are in `docs/build/screens/theatre/`.

**Staff, desktop 1366×900**

| Screenshot | What it shows |
|---|---|
| `staff-01` | The settings page (renamed QR cards and the cinema card). Made through the UI: dine-in QR confirmation off, seat ordering on. |
| `staff-02` to `staff-04` | Empty state, "Add screen", the bulk form (A-M, 1–20, without A1 / A2 / F13), and the seat map: 257 seats. |
| `staff-05` | Seat QR dialog. |
| `staff-05b` | Deleting an unused screen. |
| `staff-06`, `staff-07` | Print preview on screen and with print media emulated. Chrome's PDF of the sheets had 22 A4 pages for 257 seats (12 per page). |
| `staff-08` | Poster. |
| `staff-09` to `staff-11` | Add show, overlap error, day view. |
| `staff-12` | Board with three unpaid orders (NOW, INTERVAL, COUNTER #2). |
| `staff-13` | After "UPI received": NOW in the kitchen, INTERVAL held ("To kitchen in 1:59"), counter token. |
| `staff-14` | Kitchen with seat badges (NOW, COUNTER). |
| `staff-14b` | A released interval KOT with the INTERVAL badge. |
| `staff-15`, `staff-16` | NOW → READY → DELIVERED. |
| `staff-17` | Counter order ready. |
| `staff-18`, `staff-19` | The interval order released by itself (it went to the kitchen at interval − 10 min; the board refreshed on time), then Ready and Delivered. |
| `staff-20` | Theatre report. |

**Guest, phone 390×844**

| Screenshot | What it shows |
|---|---|
| `guest-00`, `guest-01` | Dark seat page and menu. |
| `guest-02` | Cart. |
| `guest-03-timing-{now,interval,counter}` | The timing step for each choice. |
| `guest-04-upi-*` | The UPI step for each order. |
| `guest-05-track-*-unpaid` | Tracking before payment. |
| `guest-06` | Screen 2 show without an interval: the interval option is disabled with the reason. |
| `guest-07` to `guest-09` | Screen picker: row F, seat F7, then the seat page. |
| `guest-10`, `guest-11` | After payment: strips, then tracking with the big token "2". |
| `guest-12` | Final state. |

The full run was done twice. The first round ran on th1's earlier WIP; the second ran after merging th1's final commit, with the whole guest and board flow again.

## Checks

- `tsc --noEmit` passes for `apps/web` and `apps/api`.
- `npm run lint` passes; only the warnings that were already there.
- `npm test`: shared 56 and api 160 unit tests pass.
- Integration: 31 files, 207 tests pass. test:db: all 10 files pass. test:api: 781 of 782 passed in the full run; the one failure was `staff.test.ts` "public fields only". That test makes a random phone number, and this one contained `4321`, which the test's regex flags as a PIN. It fails by chance and has nothing to do with this branch: the file passes on a rerun (62/62).
- This branch adds no new tests: the web app has no test runner, and the browser run above is the check.

## Not verified / notes

- **Real Razorpay UPI.** Not tried, only mock UPI. A Razorpay QR image would show through the `imageUrl` / `img` path.
- **Real phones.** Not tried, only a Chrome mobile emulation: the dark look, touch sizes and speed on low-end Android.
- **Printing.** The A4 layout was checked through Chrome's PDF output; nothing was sent to a real printer.
- **Board on a tablet.** It wasn't checked at tablet width; on a narrow screen the counter column stacks under the seat orders.
- **Kitchen Ready column.** Counter and seat KOTs stay in the kitchen's Ready column after the runner marks them Delivered, until the kitchen marks them Served. That is the backend's split between the KOT and runner stages.
- **For the coordinator:**
  - Migrations come from th1 only.
  - Nothing changes on the web side for env.
  - The worktree `node_modules` is a real folder of symlinks (local Prisma client) and is untracked.
