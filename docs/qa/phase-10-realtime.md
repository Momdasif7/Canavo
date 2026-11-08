# QA Phase 10 — Real-time and notifications

Branch `agent/rt`. Tests: `apps/api/test/integration/realtime-qa.test.ts` (21 tests, real Express app + Socket.io +
socket.io-client against PostgreSQL with RLS). Already covered elsewhere (not redone): emits after commit / outbox,
web reload on reconnect (phase-9), Redis adapter (`redis-adapter.test.ts`).

## Checks

| # | Check | Result |
|---|-------|--------|
| 1 | No / empty / garbage / expired / tampered / foreign-secret / `alg:none` token refused | pass |
| 1 | Token of a signed-out session refused at handshake | **fail → fixed (rt-1)** |
| 1 | Logout, device sign-out, revoke-others, deactivation, tokenVersion bump end live sockets | **fail → fixed (rt-2)** |
| 1 | Suspended business: handshake refused, live sockets dropped by the re-check | **fail → fixed (rt-2)** |
| 1 | Cookie-session web login: in-memory access token works on the socket; cookie logout disconnects it | pass (after rt-2) |
| 2 | outletId spoofing (other outlet, other business) never joins the room; user room only | pass |
| 2 | Client-sent `join` / `subscribe` / `room:join` events ignored (server registers no client handlers) | pass |
| 2 | Owner: every outlet of own business, none of another; Super Admin: no outlet room | pass |
| 2 | Staff moved to another outlet stops receiving the old outlet's events | **fail → fixed (rt-3)** |
| 2 | Real bill: events only in that outlet; payloads scanned for hashes, tokens, other tenant ids, customer phone | pass |
| 3 | 1000 events to one outlet arrive in emit order; 15 sequential bills' `kot:new` in bill order | pass |
| 3 | Kitchen: 15 s poll (always on, so it is also the fallback when the socket can't connect), reload on `connect`, `visibilitychange`, `online` | pass (code review) |
| 4 | 200 kitchen sockets × burst of 100 bills (20 in flight) | pass — numbers below |
| 4 | After disconnect: no sockets, room members or engine clients left | pass |
| 5 | `outletManagers` / `outletStaff`: right roles, right outlet, never another business (RLS), no Super Admin | pass |
| 5 | Leave request: live `notification` to this hotel's manager + owner only (not requester, kitchen, other hotel) | pass |
| 5 | Push (Expo mocked): data = `{id, kind, link, outletId}` only, no secrets; `urgent` channel for urgent kinds | **fail → fixed (rt-4)** |
| 5 | `notifications.prefs` (business) respected: `kot.push=false` suppresses only kitchen pushes | pass |
| 5 | Every default deep link exists as a web route and maps to a mobile screen for the owner | pass |
| 5 | Read / unread / clear sync to the user's other tabs only; other users get 404 | API pass; **clients fixed (rt-5)** |

## Defects

| ID | Sev | Area | Defect | Fix |
|----|-----|------|--------|-----|
| rt-1 | P1 security | realtime.ts | Handshake checked tokenVersion but not the session (`sid`): a stolen access token kept opening sockets for up to 15 min after the device was signed out. | Handshake uses the same checks as `authenticate` (session live, business active). |
| rt-2 | P1 security | realtime.ts, tokens.ts, auth.ts | Auth ran only at connect: after logout, device sign-out, deactivation, password reset, role change or business suspension, an open socket kept receiving KOTs, bills, customer names/addresses indefinitely. | Sockets join `session:<sid>`; `forceLogout`, `revokeSession`, `revokeOtherSessions`, refresh-reuse revocation and `/auth/logout` call `disconnectSockets` (cross-instance via the adapter). A 60 s sweep re-checks every distinct identity (one query per login, not per socket) and disconnects invalid ones. |
| rt-3 | P2 | staff.ts | Changing a user's outlets left their socket in the old outlet room until reconnect. | `revalidateSockets(userId)` after an outlet change (sockets leave rooms they lost); the sweep also does it. |
| rt-4 | P2 | notify.ts | New QR / online orders (`channel.order`) were pushed on Android channel `default` (mobile treats them as urgent; a closed app didn't ring). Default link for `channel.*` missing; `defaultLink` matched loose prefixes (`kotX`). | `channel.order` added to `URGENT_KINDS`; `channel → /pos`; exact prefix match like the mobile app. |
| rt-5 | P3 | web NotificationsProvider, mobile NotificationsContext | `notification:read` with `read:false` (marked unread elsewhere) marked it *read* in other tabs/devices; `cleared` was ignored. | `read:false` → resync; `cleared` → drop read rows. |

## Load test (200 sockets, 100 bills, one laptop, API + DB + clients in one process)

| deliveries | missing | p50 | p95 | p99 | max | wall | server CPU | RSS delta |
|------------|---------|-----|-----|-----|-----|------|------------|-----------|
| 20 000 / 20 000 | 0 sockets | 352 ms | 706 ms | 818 ms | 821 ms | 2.6 s | 3.2 s | +17 MB |

Latency = client receive − KOT `createdAt`, so it includes the bill transaction and outbox hop under a 20-wide burst.

## Recommendations (no failing behaviour)
- Delivery partners sit in the outlet room and receive every `delivery:updated` (customer phone/address of all
  deliveries, agent phones) and `kot:new`; a per-role room (`outlet:<id>:board`) would trim PII to need.
- `reservation:updated` broadcasts the full row (guest phone) to kitchen/delivery sockets too.

## Not verified
- Real Expo/FCM delivery and Android channel behaviour on devices (push mocked at the HTTP boundary).
- Web kitchen with the socket blocked in a browser: no web test runner; logic verified in code (poll is unconditional).
- Mobile `tsc` (expo not installed in the worktree); mobile changes are 6 lines.
- Multi-instance disconnect via Redis: uses `io.in(room).disconnectSockets()`, which the adapter broadcasts; not run.

Runs: realtime-qa 21/21; integration 228/228 (32 files); test:api 792/792 (one flaky test fixed, below); test:db 11/11 files.
Also fixed: `test/api/storefront.test.ts` flaked about 1 run in 64 (the "mutated" QR token was unchanged when the real one ended in "A").
