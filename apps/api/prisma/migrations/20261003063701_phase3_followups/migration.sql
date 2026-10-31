-- DropIndex
DROP INDEX "Recipe_menuItemId_idx";

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "customerId" TEXT;

-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "acceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LoyaltyTransaction" ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "reference" TEXT,
    "createdById" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchasePayment_purchaseId_idx" ON "PurchasePayment"("purchaseId");

-- CreateIndex
CREATE INDEX "Recipe_menuItemId_variantId_idx" ON "Recipe"("menuItemId", "variantId");

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
