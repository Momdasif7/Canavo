-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('WRONG_ITEM', 'QUALITY', 'NOT_DELIVERED', 'OVERCHARGED', 'CUSTOMER_CHANGED_MIND', 'OTHER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundedAmount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fyStart" INTEGER NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "note" TEXT,
    "refundMode" "PaymentMode" NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "taxableValue" INTEGER NOT NULL,
    "cgst" INTEGER NOT NULL,
    "sgst" INTEGER NOT NULL,
    "igst" INTEGER NOT NULL,
    "cess" INTEGER NOT NULL DEFAULT 0,
    "otherTaxes" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteCounter" (
    "outletId" TEXT NOT NULL,
    "fyStart" INTEGER NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CreditNoteCounter_pkey" PRIMARY KEY ("outletId","fyStart")
);

-- CreateIndex
CREATE INDEX "CreditNote_outletId_createdAt_idx" ON "CreditNote"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditNote_orderId_idx" ON "CreditNote"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_outletId_number_key" ON "CreditNote"("outletId", "number");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): outlet of the current hotel
ALTER TABLE "CreditNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CreditNote";
CREATE POLICY tenant_isolation ON "CreditNote" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
ALTER TABLE "CreditNoteCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditNoteCounter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CreditNoteCounter";
CREATE POLICY tenant_isolation ON "CreditNoteCounter" USING (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[])) WITH CHECK (canavo_rls_bypass() OR "outletId" = ANY ((SELECT canavo_outlets())::text[]));
