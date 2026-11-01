# ADR 0003: Transactional outbox for realtime events and side effects

| | |
|---|---|
| Status | Accepted (Phase 1.3, 2026-11-01) |

## Context

Kitchen tickets, order/menu events, delivery announcements and push notifications were sent from memory after the database commit. Some paths used a `setTimeout` (300 ms / 1.5 s) as a stand-in for "after commit". Two failures were possible:
- If the process crashed between the commit and the send, the event was lost. This is one cause of "the order didn't reach the kitchen".
- If the transaction rolled back after a send, the screen showed something that never happened.

## Decision

Events are written to an **`OutboxEvent` row in the same transaction** as the change, using these helpers:

| Helper | Purpose |
|---|---|
| `outboxEmitOutlet(tx, outletId, event, payload)` | A Socket.io event to an outlet room. |
| `outboxEmitUser(tx, userId, event, payload)` | A Socket.io event to one user. |
| `outboxTask(tx, name, payload)` | A server-side task, registered in `src/outbox-tasks.ts` (kitchen alert, low-stock check, delivery announce, availability notify, external notify). |

**The publisher** runs in every API process:
- It claims batches with `FOR UPDATE SKIP LOCKED` and a lease, so several instances never deliver the same row twice.
- Each request kicks it right after commit, and it also polls every 1 s.
- Failed rows retry with backoff. After 8 attempts a row is marked `failedAt` (the dead letter).
- Delivered rows are purged hourly.
- Prometheus gauges show the pending and failed counts.

**The worker** has no sockets. `emitToOutlet`/`emitToUser` there fall back to writing outbox rows, and the API delivers them.

## Consequences

- **Delivery is at least once.** Clients already treat `kot:new` / `order:created` / `menu:changed` as "refresh", so a duplicate is harmless.
- Live updates gain about 0–20 ms after a kick, and up to 1 s when only the poll picks the event up.
- New side effects should go through `outboxTask`, not `setTimeout` or a bare emit, whenever they follow a database change.
- **Rollback:** the code path is the only consumer. Reverting the commit restores direct emits, and `DROP TABLE "OutboxEvent"` removes the table.
