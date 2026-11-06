-- QA Phase 7: voids in a period (daily close, exceptions report, outlets overview) filtered every bill
-- the outlet ever made (36k rows scanned for a day on the perf dataset, 26 ms -> 0.5 ms). Built
-- CONCURRENTLY (own migration, outside a transaction) so the Order table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_outletId_cancelledAt_idx" ON "Order"("outletId", "cancelledAt");
