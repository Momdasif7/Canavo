-- AlterTable
ALTER TABLE "ChannelOrder" ADD COLUMN     "foodReadyQueuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderHandover" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "packedAt" TIMESTAMP(3),
    "packedById" TEXT,
    "handedOverAt" TIMESTAMP(3),
    "handedOverById" TEXT,
    "riderName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderHandover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderHandover_orderId_key" ON "OrderHandover"("orderId");

-- CreateIndex
CREATE INDEX "OrderHandover_outletId_createdAt_idx" ON "OrderHandover"("outletId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "OrderHandover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderHandover" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderHandover";
CREATE POLICY tenant_isolation ON "OrderHandover" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
