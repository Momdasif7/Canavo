# QA Phase 12 — Mobile (Expo SDK 51, apps/mobile)

Branch `agent/mob`, 2026-11-08. No API / shared changes (root suites not affected).

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` (app + tests) | clean (was failing: `ignoreDeprecations: "6.0"` invalid on TS 5.3 → removed) |
| `npx expo export --platform android` | OK, Hermes bundle 5.02 MB |
| `npx expo export --platform ios` | OK, Hermes bundle 5.01 MB |
| `npm test` (jest-expo 51.0.4, RNTL 12.9) | **9 suites, 60 tests, green** (run twice, stable) |
| Maestro / Detox | not runnable without a device → flows written in `apps/mobile/e2e/*.yaml` |

Note: a fresh worktree needs `packages/shared` built (`dist/`) before export — Metro resolves `@canavo/shared` via `main`.

## Tests (apps/mobile/test)

| Suite | # | Covers |
|---|---|---|
| screens | 9 | Login OTP (digits only, request, dev code, resend timer, verify, wrong code), password (local validation, 2-step challenge → code), suspended reason, redirect; Payment cash change / short-by disabled / 409 error / already paid / offline load error |
| offlineQueue | 6 | enqueue idempotent on clientOrderId, kill/restart = persisted (real SQLite via `node:sqlite`), offline pass spends no attempts, lost response → same order (no duplicate), 409 paid = done, MAX_ATTEMPTS → failed → re-queue, backoff curve |
| offlineProvider | 1 | offline → queue 2 bills → online with server 500 → next try at 60 s not 30 s → flush, 2 orders |
| posCart | 9 | reducer merge/cap/points/coupon/clear, refresh re-price, paise GST bill + round-off, non-GST BILL, order body online vs offline (no promos/COD), cart restore + 24 h expiry |
| push | 9 | granted (both channels, token upload with auth, SecureStore), denied, already granted, emulator / no projectId, upload offline, iOS, logout unregister, urgent vs default channel ids incl. `channel.order`, local alert on urgent channel |
| location | 9 | live tracking granted/denied/iOS approximate/location services off/offline post/no deliveries; presence denied → retry, throttle 20 s / 15 m, background→foreground resume + onBack, clock-out stops |
| printer | 8 | ESC/POS control-char stripping (ESC p, GS V, NUL, C1), Devanagari kept, scan dedupe, connect once, disconnect → reconnect, still-off → error then recovers, no cutter, BT permission denied |
| socket | 4 | (re)connect → refetch handler + Live indicator, token refresh keeps socket, outlet switch re-binds listeners, logout stops events |
| apiSession | 5 | session persisted/restored, single-flight refresh on concurrent 401 with same Idempotency-Key, revoked → expired, offline refresh keeps session, suspended |

## Defects

| ID | Sev | Defect | Fix |
|---|---|---|---|
| mob-1 | High | Bluetooth printer switched off / out of range after connecting: `connect()` short-circuited on the cached address, so every later print failed until the app was restarted | `printLines` reconnects once and retries; a failed reconnect clears the cached address (`src/printing/bluetooth.ts`, `escposText` extracted) |
| mob-2 | High | Offline bill rejected 3× (e.g. transient server error ~90 s) became `failed` forever — no way to retry; cash already taken | `requeueFailed()` (back to pending / unpaid, attempts 0) + "Retry failed bills" on More |
| mob-3 | Med | Offline sync retried every 30 s regardless of server failures (no backoff) | sync pass extracted to `src/offline/sync.ts`; failed passes back off 30 s → 60 → 120 → 240 → 300 s cap, reset on success / reconnect; manual "Sync now" always runs |
| mob-4 | Med | Floor plan, table tab, partner home and notifications inbox did not refetch after a socket reconnect (events lost while down; table tab and inbox have no poll) | `useSocketReconnect` added in `tables.tsx`, `table/[sessionId].tsx`, `DeliveryHome.tsx`, `NotificationsContext.tsx` |
| mob-5 | Low | Push registration that failed transiently (token upload offline) was never retried in the session | registration retried on the next profile refresh when the result is `error` |
| mob-6 | Low | `tsconfig` `ignoreDeprecations: "6.0"` broke `tsc` on TS 5.3 | removed |

Known, not changed (by design / documented): location is foreground-only (no background task, Play policy — STORE_RELEASE.md); no battery-specific logic (High accuracy watch, 10 s / 20 m; OS throttles in power saver; a watch failure shows the error). No push-token rotation listener (token refreshed on next sign-in).

## Manual device tests for Phase 15

1. Login OTP with real SMS + Android SMS autofill / iOS one-time-code; biometric unlock if enabled.
2. Offline: airplane mode → 3 cash bills → force-stop → relaunch (still pending) → online → each bill once on the web, payments recorded (`e2e/03`).
3. Push on a real device (EAS projectId): allow / deny; KOT, order ready, delivery, `channel.order` ring on **Urgent** with app killed, backgrounded, screen locked, DND; tap opens the right screen; logout stops pushes.
4. Android 13+ prompt appears only after sign-in; channel names/importances in system settings.
5. Delivery partner: location deny / "only this time" / approximate (iOS) / precise; GPS off; battery saver; background 5 min → foreground resumes; outlet sees live dot and "back at outlet".
6. Bluetooth 58 mm and 80 mm ESC/POS printers: pair, test print, receipt with ₹ and Hindi item, KOT width, printer off/on mid-shift (mob-1), no-cutter model, guest note with control chars prints as text, cash drawer does not open.
7. Socket: toggle Wi-Fi ↔ mobile data on KOT, floor plan and online-orders screens; data catches up without manual refresh.
8. UPI QR scan with a real UPI app; split bill; COD.
9. Camera: attendance selfie, barcode scanner; geofenced clock-in.
10. Low-end Android (2-3 GB RAM): cold start, menu of 500 items, long shift memory; dark mode; font scaling 1.3×; tablets.
11. iOS build (system print dialog fallback, no Bluetooth printing).
