-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "cashSettledAt" TIMESTAMP(3),
ADD COLUMN     "cashSettledById" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "collectedById" TEXT;

-- CreateIndex
CREATE INDEX "Payment_collectedById_idx" ON "Payment"("collectedById");

