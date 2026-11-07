-- AlterTable
ALTER TABLE "DiningTable" ADD COLUMN     "qrToken" TEXT;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "publicSlug" TEXT,
ADD COLUMN     "storefront" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "ChannelRequest" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tableId" TEXT,
    "sessionId" TEXT,
    "orderId" TEXT,
    "items" JSONB NOT NULL,
    "kotIds" TEXT[],
    "customerName" TEXT,
    "customerPhone" TEXT,
    "notes" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "publicToken" TEXT NOT NULL,
    "payment" TEXT,
    "ip" TEXT,
    "rejectReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelRequest_orderId_key" ON "ChannelRequest"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelRequest_publicToken_key" ON "ChannelRequest"("publicToken");

-- CreateIndex
CREATE INDEX "ChannelRequest_outletId_status_createdAt_idx" ON "ChannelRequest"("outletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelRequest_tableId_createdAt_idx" ON "ChannelRequest"("tableId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_qrToken_key" ON "DiningTable"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_publicSlug_key" ON "Outlet"("publicSlug");

-- AddForeignKey
ALTER TABLE "ChannelRequest" ADD CONSTRAINT "ChannelRequest_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "ChannelRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ChannelRequest";
CREATE POLICY tenant_isolation ON "ChannelRequest" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
