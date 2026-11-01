-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "SubsidyType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "CorporateStatementStatus" AS ENUM ('INVOICED', 'PAID');

-- CreateEnum
CREATE TYPE "WalletTxnType" AS ENUM ('TOPUP', 'SPEND', 'REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "MealTokenTxnType" AS ENUM ('PURCHASE', 'REDEEM', 'RESTORE', 'ADJUST');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMode" ADD VALUE 'CORPORATE';
ALTER TYPE "PaymentMode" ADD VALUE 'WALLET';
ALTER TYPE "PaymentMode" ADD VALUE 'MEAL_TOKEN';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "canteenMember" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cardUid" TEXT,
ADD COLUMN     "corporateAccountId" TEXT,
ADD COLUMN     "department" TEXT,
ADD COLUMN     "employeeCode" TEXT,
ADD COLUMN     "memberActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "walletBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "corporateAccountId" TEXT,
ADD COLUMN     "tokens" INTEGER;

-- CreateTable
CREATE TABLE "CorporateAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "gstin" TEXT,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "creditLimit" INTEGER NOT NULL DEFAULT 0,
    "dailyMealLimit" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorporateAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporateSubsidyRule" (
    "id" TEXT NOT NULL,
    "corporateAccountId" TEXT NOT NULL,
    "mealSlotId" TEXT,
    "type" "SubsidyType" NOT NULL,
    "value" INTEGER NOT NULL,
    "maxPerMeal" INTEGER,
    "maxPerDay" INTEGER,
    "slotMealLimit" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorporateSubsidyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporateStatement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "corporateAccountId" TEXT NOT NULL,
    "periodFrom" TEXT NOT NULL,
    "periodTo" TEXT NOT NULL,
    "meals" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "CorporateStatementStatus" NOT NULL DEFAULT 'INVOICED',
    "invoiceRef" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "CorporateStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTxn" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "outletId" TEXT,
    "type" "WalletTxnType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" TEXT,
    "orderId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealTokenAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mealSlotId" TEXT,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "value" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MealTokenAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealTokenTxn" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "outletId" TEXT,
    "type" "MealTokenTxnType" NOT NULL,
    "count" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" TEXT,
    "orderId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealTokenTxn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorporateAccount_businessId_name_key" ON "CorporateAccount"("businessId", "name");

-- CreateIndex
CREATE INDEX "CorporateSubsidyRule_corporateAccountId_idx" ON "CorporateSubsidyRule"("corporateAccountId");

-- CreateIndex
CREATE INDEX "CorporateStatement_corporateAccountId_periodFrom_idx" ON "CorporateStatement"("corporateAccountId", "periodFrom");

-- CreateIndex
CREATE INDEX "WalletTxn_customerId_createdAt_idx" ON "WalletTxn"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletTxn_outletId_createdAt_idx" ON "WalletTxn"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletTxn_orderId_idx" ON "WalletTxn"("orderId");

-- CreateIndex
CREATE INDEX "MealTokenAccount_customerId_idx" ON "MealTokenAccount"("customerId");

-- CreateIndex
CREATE INDEX "MealTokenTxn_accountId_idx" ON "MealTokenTxn"("accountId");

-- CreateIndex
CREATE INDEX "MealTokenTxn_outletId_createdAt_idx" ON "MealTokenTxn"("outletId", "createdAt");

-- CreateIndex
CREATE INDEX "MealTokenTxn_orderId_idx" ON "MealTokenTxn"("orderId");

-- CreateIndex
CREATE INDEX "Customer_businessId_employeeCode_idx" ON "Customer"("businessId", "employeeCode");

-- CreateIndex
CREATE INDEX "Customer_corporateAccountId_idx" ON "Customer"("corporateAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_cardUid_key" ON "Customer"("businessId", "cardUid");

-- CreateIndex
CREATE INDEX "Payment_corporateAccountId_createdAt_idx" ON "Payment"("corporateAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "CorporateAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateSubsidyRule" ADD CONSTRAINT "CorporateSubsidyRule_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "CorporateAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateStatement" ADD CONSTRAINT "CorporateStatement_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "CorporateAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealTokenAccount" ADD CONSTRAINT "MealTokenAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealTokenTxn" ADD CONSTRAINT "MealTokenTxn_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MealTokenAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Row-level security (Phase 1.1 pattern)
ALTER TABLE "CorporateAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CorporateAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CorporateAccount";
CREATE POLICY tenant_isolation ON "CorporateAccount" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "CorporateStatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CorporateStatement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CorporateStatement";
CREATE POLICY tenant_isolation ON "CorporateStatement" USING (canavo_rls_bypass() OR "businessId" = canavo_business()) WITH CHECK (canavo_rls_bypass() OR "businessId" = canavo_business());
ALTER TABLE "CorporateSubsidyRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CorporateSubsidyRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CorporateSubsidyRule";
CREATE POLICY tenant_isolation ON "CorporateSubsidyRule" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "CorporateAccount" parent WHERE parent."id" = "CorporateSubsidyRule"."corporateAccountId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "CorporateAccount" parent WHERE parent."id" = "CorporateSubsidyRule"."corporateAccountId"));
ALTER TABLE "WalletTxn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletTxn" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WalletTxn";
CREATE POLICY tenant_isolation ON "WalletTxn" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "WalletTxn"."customerId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "WalletTxn"."customerId"));
ALTER TABLE "MealTokenAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealTokenAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealTokenAccount";
CREATE POLICY tenant_isolation ON "MealTokenAccount" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "MealTokenAccount"."customerId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "MealTokenAccount"."customerId"));
ALTER TABLE "MealTokenTxn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealTokenTxn" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MealTokenTxn";
CREATE POLICY tenant_isolation ON "MealTokenTxn" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "MealTokenTxn"."customerId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "Customer" parent WHERE parent."id" = "MealTokenTxn"."customerId"));
