import type { Op } from "./openapi";

/** Cinema seat ordering (module THEATRE; needs BILLING, TABLES, CHANNELS). Contract: docs/build/theatre-contract.md. Socket event theatre:updated { requestId?, action }. */
export const ops: Op[] = [
  // Screens and seats (table:serve reads, table:manage writes)
  ["get", "/theatre/screens", "Screens with seats by row, seat QR tokens, current / next show → Screen[]", "Cinema"],
  ["post", "/theatre/screens", "Create a screen (code S1, S2 … fixed for its life; own screen QR). Body: screenSchema → Screen", "Cinema"],
  ["patch", "/theatre/screens/{id}", "Rename / reorder a screen. Body: screenUpdateSchema → Screen", "Cinema"],
  ["delete", "/theatre/screens/{id}", "Delete a screen and its seats. 409 while a seat has an open tab or a waiting order, or when the screen has seat orders in its history", "Cinema"],
  ["post", "/theatre/screens/{id}/seats", "Bulk-add seats rows × from…to minus skip (idempotent; inactive seats in the range come back; at most 3,000 per screen). Body: seatBulkSchema → { created, skipped, total }", "Cinema"],
  ["post", "/theatre/screens/{id}/qr/rotate", "New screen QR token (old posters stop working) → Screen", "Cinema"],
  ["delete", "/theatre/seats/{id}", "Delete a seat (deactivated when it has history). 409 while it has an open tab / waiting order", "Cinema"],
  // Showtimes
  ["get", "/theatre/showtimes", "Shows overlapping a local day ?date=YYYY-MM-DD (default today) &screenId → ShowTime[]", "Cinema"],
  ["post", "/theatre/showtimes", "Add a show. 409 if it overlaps another show on the screen. Body: showTimeSchema → ShowTime", "Cinema"],
  ["patch", "/theatre/showtimes/{id}", "Edit a show (same overlap / time rules). Body: showTimeUpdateSchema → ShowTime", "Cinema"],
  ["delete", "/theatre/showtimes/{id}", "Delete a show; 409 when it has seat orders (kept for the reports)", "Cinema"],
  // Settings
  ["get", "/theatre/settings", "Theatre settings (seat ordering, interval lead minutes, counter pickup, deliver during show) → TheatreSettings", "Cinema"],
  ["patch", "/theatre/settings", "Change theatre settings. Body: theatreSettingsSchema (partial) → TheatreSettings", "Cinema"],
  // Runner board
  ["get", "/theatre/board", "Runner board ?screenId: seat orders by screen and row + counter pickups by token → RunnerBoard", "Cinema"],
  ["post", "/theatre/orders/{requestId}/ready", "Food ready for a runner / the counter (its KOTs → Ready). 409 unpaid, held for the interval, delivered → BoardOrder", "Cinema"],
  ["post", "/theatre/orders/{requestId}/delivered", "Handed over at the seat / counter (KOTs → Served) → BoardOrder", "Cinema"],
  ["get", "/reports/theatre", "Cinema seat orders ?from&to (local days) &format=json|xlsx|pdf → TheatreReport { totals, byScreen, byShow, byTiming }", "Reports"],
  // Guests (no login)
  ["get", "/public/s/{screenToken}", "Screen poster QR: outlet, screen, show and active seats by row (each with its seat QR token)", "Public ordering", false],
  ["post", "/public/t/{token}/orders/{orderToken}/upi", "Seat order: a fresh UPI QR when the first expired → { qrPayload, imageUrl, amount, mock }", "Public ordering", false],
];
