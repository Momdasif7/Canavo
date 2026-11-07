-- CreateEnum
CREATE TYPE "CashShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAY_IN', 'PAY_OUT');

-- CreateTable
CREATE TABLE "CashShift" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "status" "CashShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" INTEGER NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedCash" INTEGER,
    "expectedCash" INTEGER,
    "variance" INTEGER,
    "denominations" JSONB,
    "note" TEXT,
    "summary" JSONB,

    CONSTRAINT "CashShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashShift_outletId_openedAt_idx" ON "CashShift"("outletId", "openedAt");

-- CreateIndex
CREATE INDEX "CashShift_outletId_status_idx" ON "CashShift"("outletId", "status");

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId");

-- AddForeignKey
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Only one open shift per outlet (one cash drawer)
CREATE UNIQUE INDEX "CashShift_one_open_per_outlet" ON "CashShift"("outletId") WHERE "status" = 'OPEN';

-- Row-level security (Phase 1.1 pattern)
ALTER TABLE "CashShift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashShift" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CashShift";
CREATE POLICY tenant_isolation ON "CashShift" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "CashMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashMovement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CashMovement";
CREATE POLICY tenant_isolation ON "CashMovement" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
