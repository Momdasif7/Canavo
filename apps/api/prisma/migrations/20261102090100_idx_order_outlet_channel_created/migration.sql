-- Online orders board: today's channel orders per outlet. Built CONCURRENTLY (own migration,
-- outside a transaction) so the Order table stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_outletId_channel_createdAt_idx" ON "Order"("outletId", "channel", "createdAt");
