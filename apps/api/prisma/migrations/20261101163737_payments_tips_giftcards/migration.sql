-- CreateEnum
CREATE TYPE "GiftCardTxnType" AS ENUM ('ISSUE', 'REDEEM', 'REFUND', 'ADJUST');

-- AlterEnum
ALTER TYPE "PaymentMode" ADD VALUE 'GIFT_CARD';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "authCode" TEXT,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "giftCardId" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settlementRef" TEXT,
ADD COLUMN     "tip" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "initialValue" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "soldMode" TEXT,
    "soldOutletId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "expiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardTxn" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "outletId" TEXT,
    "type" "GiftCardTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardTxn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_businessId_code_key" ON "GiftCard"("businessId", "code");

-- CreateIndex
CREATE INDEX "GiftCardTxn_giftCardId_idx" ON "GiftCardTxn"("giftCardId");

-- AddForeignKey
ALTER TABLE "GiftCardTxn" ADD CONSTRAINT "GiftCardTxn_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern)
ALTER TABLE "GiftCard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GiftCard" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "GiftCard";
CREATE POLICY tenant_isolation ON "GiftCard" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "GiftCardTxn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GiftCardTxn" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "GiftCardTxn";
CREATE POLICY tenant_isolation ON "GiftCardTxn" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "GiftCard" parent WHERE parent."id" = "GiftCardTxn"."giftCardId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "GiftCard" parent WHERE parent."id" = "GiftCardTxn"."giftCardId"));
