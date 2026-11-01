-- AlterEnum
ALTER TYPE "PaymentMode" ADD VALUE 'ONLINE';

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'HUB',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "storeOpen" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT NOT NULL,
    "externalStoreId" TEXT NOT NULL,
    "apiKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "commission" JSONB NOT NULL DEFAULT '{}',
    "lastMenuSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelItemMap" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,

    CONSTRAINT "ChannelItemMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelOrder" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceChannel" TEXT NOT NULL,
    "channelOrderId" TEXT NOT NULL,
    "orderId" TEXT,
    "status" TEXT NOT NULL,
    "pushedStatus" TEXT,
    "pushError" TEXT,
    "riderStatus" TEXT,
    "rider" JSONB,
    "channelTotal" INTEGER NOT NULL DEFAULT 0,
    "ourTotal" INTEGER NOT NULL DEFAULT 0,
    "mismatch" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_outletId_provider_key" ON "ChannelConnection"("outletId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelItemMap_outletId_menuItemId_key" ON "ChannelItemMap"("outletId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelItemMap_outletId_externalId_key" ON "ChannelItemMap"("outletId", "externalId");

-- CreateIndex
CREATE INDEX "ChannelOrder_outletId_createdAt_idx" ON "ChannelOrder"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelOrder_orderId_idx" ON "ChannelOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelOrder_outletId_sourceChannel_channelOrderId_key" ON "ChannelOrder"("outletId", "sourceChannel", "channelOrderId");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelItemMap" ADD CONSTRAINT "ChannelItemMap_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelOrder" ADD CONSTRAINT "ChannelOrder_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "ChannelConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ChannelConnection";
CREATE POLICY tenant_isolation ON "ChannelConnection" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "ChannelItemMap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelItemMap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ChannelItemMap";
CREATE POLICY tenant_isolation ON "ChannelItemMap" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "ChannelOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelOrder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ChannelOrder";
CREATE POLICY tenant_isolation ON "ChannelOrder" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
