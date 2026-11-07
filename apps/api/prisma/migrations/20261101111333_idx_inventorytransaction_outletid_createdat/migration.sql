-- Phase 1 hot-path index. One statement per migration so Postgres can build it CONCURRENTLY (no write lock).
-- If a previous attempt left an INVALID index: DROP INDEX CONCURRENTLY "InventoryTransaction_outletId_createdAt_idx"; then re-run migrate deploy.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "InventoryTransaction_outletId_createdAt_idx" ON "InventoryTransaction"("outletId", "createdAt");
