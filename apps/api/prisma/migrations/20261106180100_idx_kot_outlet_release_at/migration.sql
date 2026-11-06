-- QA Phase 7: the kitchen display asks for "recent tickets OR released pre-orders"; with an index on
-- each branch PostgreSQL ORs two small index scans instead of filtering every ticket of the outlet
-- (the status index cannot narrow it under row-level security). 25 ms -> 4 ms on the perf dataset.
-- Built CONCURRENTLY (own migration, outside a transaction) so KOTs keep flowing.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KotTicket_outletId_releaseAt_idx" ON "KotTicket"("outletId", "releaseAt");
