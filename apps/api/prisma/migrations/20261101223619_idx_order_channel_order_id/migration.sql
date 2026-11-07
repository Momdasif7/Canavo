-- Built CONCURRENTLY (own migration, outside a transaction) so the Order table stays writable.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Order_outletId_channel_channelOrderId_key" ON "Order"("outletId", "channel", "channelOrderId");
