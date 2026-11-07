-- QA Phase 7: the staff report lists "anyone who billed at this outlet in the period" with a
-- per-staff EXISTS on Order(cashierId, createdAt); with no index on cashierId each check scanned the
-- outlet's bills (a year: 4.7 s -> 0.09 s on the perf dataset). Also covers the cashierId foreign key.
-- Built CONCURRENTLY (own migration, outside a transaction) so the Order table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_cashierId_createdAt_idx" ON "Order"("cashierId", "createdAt");
