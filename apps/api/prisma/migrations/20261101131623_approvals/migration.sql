-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('DISCOUNT', 'VOID', 'REFUND', 'CASH_PAYOUT');

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "approvalDiscountPercent" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "ApprovalLog" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "orderId" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalLog_outletId_createdAt_idx" ON "ApprovalLog"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalLog_orderId_idx" ON "ApprovalLog"("orderId");

-- AddForeignKey
ALTER TABLE "ApprovalLog" ADD CONSTRAINT "ApprovalLog_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "ApprovalLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApprovalLog";
CREATE POLICY tenant_isolation ON "ApprovalLog" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
